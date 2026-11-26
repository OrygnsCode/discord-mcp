import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIEmoji, APIGuild, APISticker, APISoundboardSound } from "discord-api-types/v10";
import { soundSlots, stickerSlots } from "../discord/limits.js";
import { DiscordAPIError, type REST } from "@discordjs/rest";
import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import { describeRateLimit } from "../discord/client.js";
import { recordChange, undoNote, changeData } from "./changes.js";
import type { RecordEntry } from "../builder/records.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import {
  fetchBinary,
  fetchAudioAsDataUri,
  loadAsset,
  toDataUri,
  captureSound,
  captureSticker,
  AUDIO_TYPES,
  MAX_STICKER_BYTES,
  MAX_SOUND_BYTES,
  STICKER_TYPES,
} from "../discord/images.js";
import { resolveEmojiInput } from "../discord/emoji.js";
import { resolveOne, noSingleMatch } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  ToolProblem,
  botPermissions,
  requirePermissions,
  confirmTokenParam,
  dryRunParam,
} from "./common.js";

// Stickers and soundboard sounds. Two different upload mechanics:
// stickers go up as multipart form files, soundboard sounds as base64
// data URIs, both fetched from URLs and validated against Discord's
// documented limits before anything is sent.

const P = PermissionFlagsBits;

const STICKER_FORMATS: Record<number, string> = {
  1: "png",
  2: "apng",
  3: "lottie",
  4: "gif",
};

function stickerDigest(s: APISticker) {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    tags: s.tags,
    format: STICKER_FORMATS[s.format_type] ?? `type ${s.format_type}`,
    available: s.available ?? true,
  };
}

function soundDigest(s: APISoundboardSound) {
  return {
    id: s.sound_id,
    name: s.name,
    volume: s.volume,
    emoji: s.emoji_name ?? s.emoji_id ?? null,
    available: s.available ?? true,
  };
}

async function resolveSticker(
  rest: REST,
  guildId: string,
  query: string
): Promise<APISticker> {
  const stickers = (await rest.get(Routes.guildStickers(guildId))) as APISticker[];
  const resolution = resolveOne(
    query,
    stickers.map((s) => ({ id: s.id, name: s.name, type: "sticker" }))
  );
  if ("match" in resolution) {
    const found = stickers.find((s) => s.id === resolution.match.id);
    if (found) return found;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No sticker matching "${query}" in this server.`)
      : fail(`Multiple stickers match "${query}". Pick one by ID.`, { candidates })
  );
}

async function resolveSound(
  rest: REST,
  guildId: string,
  query: string
): Promise<APISoundboardSound> {
  const result = (await rest.get(Routes.guildSoundboardSounds(guildId))) as {
    items: APISoundboardSound[];
  };
  const sounds = result.items ?? [];
  const resolution = resolveOne(
    query,
    sounds.map((s) => ({ id: s.sound_id, name: s.name, type: "sound" }))
  );
  if ("match" in resolution) {
    const found = sounds.find((s) => s.sound_id === resolution.match.id);
    if (found) return found;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No soundboard sound matching "${query}" in this server.`)
      : fail(`Multiple sounds match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerExpressionTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "list_stickers",
    {
      title: "List stickers",
      description: "Custom stickers in the server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const stickers = (await rest.get(Routes.guildStickers(guildId))) as APISticker[];
      return ok(`${stickers.length} custom sticker(s).`, {
        stickers: stickers.map(stickerDigest),
      });
    })
  );

  server.registerTool(
    "create_sticker",
    {
      title: "Create sticker",
      description:
        "Upload a custom sticker from an image URL. Discord requires png, " +
        "apng, or gif at 320x320 pixels and up to 512 KB. Servers start " +
        "with five sticker slots; boosts add more.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(30).describe("The sticker's name, 2 to 30 characters."),
        description: z.string().max(100).optional()
          .describe("Empty or 2-100 characters."),
        tags: z.string().min(1).max(200)
          .describe("Comma separated keywords, or one emoji name for autocomplete."),
        image_url: z.string().url().optional()
          .describe("Public http or https link to the image file itself."),
        image_file: z.string().min(1).optional()
          .describe("A png or gif file in the local files folder (DISCORD_MCP_FILES_DIR), by name, instead of a link. Only that folder is read, and only when it is set."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, description, tags, image_url, image_file }) => {
      const { rest, guildId } = await enter(config, guild);
      if ((image_url === undefined) === (image_file === undefined)) {
        return fail("Pass image_url or image_file, one of them.");
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.CreateGuildExpressions, "Create Expressions"]],
        "in this server"
      );

      // A full server is said before anything is fetched or sent.
      const [server, stickers] = await Promise.all([
        (rest.get(Routes.guild(guildId)) as Promise<APIGuild>).catch(() => undefined),
        (rest.get(Routes.guildStickers(guildId)) as Promise<APISticker[]>).catch(() => undefined),
      ]);
      const stickerLimit = server ? stickerSlots(server.premium_tier, server.features as string[]) : null;
      if (stickerLimit !== null && stickers && stickers.length >= stickerLimit) {
        return fail(
          `All ${stickerLimit} sticker slots are in use (boost level ${server?.premium_tier ?? 0}), so nothing was uploaded. ` +
            "Delete one first, or boost the server for more.",
          { slots: { used: stickers.length, limit: stickerLimit } }
        );
      }

      const image = await loadAsset({ url: image_url, file: image_file }, MAX_STICKER_BYTES, STICKER_TYPES, "sticker", 320);
      if (!image.ok) return fail(image.error);

      const extension = image.contentType === "image/gif" ? "gif" : "png";
      const sticker = (await rest.post(Routes.guildStickers(guildId), {
        appendToFormData: true,
        body: {
          name,
          description: description ?? "",
          tags,
        },
        files: [
          {
            key: "file",
            name: `sticker.${extension}`,
            contentType: image.contentType,
            data: image.data,
          },
        ],
        reason: "Created via discord-mcp",
      })) as APISticker;

      const recorded = await recordChange(rest, guildId, "create_sticker", [{ op: "created", kind: "sticker", id: sticker.id, name: sticker.name }]);
      return ok(
        `Created the sticker ${quoted(sticker.name)}.` + undoNote(recorded),
        { ...stickerDigest(sticker), ...changeData(recorded) },
        [...(image.note ? [image.note] : []), ...(recorded.warning ? [recorded.warning] : [])]
      );
    })
  );

  server.registerTool(
    "update_sticker",
    {
      title: "Update sticker",
      description: "Rename a sticker or change its description and tags.",
      inputSchema: {
        sticker: z.string().describe("Sticker name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(30).optional().describe("New name, 2 to 30 characters."),
        description: z.string().max(100).optional().describe("New description, up to 100 characters."),
        tags: z.string().min(1).max(200).optional().describe("A word or standard emoji Discord uses to suggest the sticker."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ sticker, guild, name, description, tags }) => {
      const { rest, guildId } = await enter(config, guild);
      if (name === undefined && description === undefined && tags === undefined) {
        return fail("Pass at least one field to change.");
      }
      const found = await resolveSticker(rest, guildId, sticker);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const updated = (await rest.patch(Routes.guildSticker(guildId, found.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
        },
        reason: "Updated via discord-mcp",
      })) as APISticker;
      return ok(`Updated the sticker ${quoted(updated.name)}.`, stickerDigest(updated));
    })
  );

  server.registerTool(
    "delete_sticker",
    {
      title: "Delete sticker",
      description:
        "Delete a custom sticker, or several at once with stickers. Safe to " +
        "call directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes them.",
      inputSchema: {
        sticker: z.string().optional().describe("Sticker name or ID."),
        stickers: z.array(z.string()).min(1).max(60).optional()
          .describe("Several stickers to delete together, by name or ID, instead of sticker."),
        guild: guildParam,
        dry_run: dryRunParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ sticker, stickers: many, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      if ((sticker === undefined) === (many === undefined)) {
        return fail("Pass sticker for one sticker, or stickers for several, not both and not neither.");
      }
      if (many !== undefined) {
        const all = (await rest.get(Routes.guildStickers(guildId))) as APISticker[];
        return deleteSeveral(rest, guildId, many, all.map((s) => ({ id: s.id, name: s.name, raw: s })), STICKER_KIND, dry_run, confirm_token);
      }
      const found = await resolveSticker(rest, guildId, sticker as string);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_sticker",
        args: { sticker: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: `Would delete the sticker ${quoted(found.name)}.`,
        previewDetails: stickerDigest(found),
      });
      if (gate) return gate;

      const done = await deleteRecorded(rest, guildId, [{ id: found.id, name: found.name, raw: found }], STICKER_KIND);
      if (done.stopped) return fail(`Discord refused to delete the sticker ${quoted(found.name)}: ${done.stopped.why}`);
      return ok(`Deleted the sticker ${quoted(found.name)}.` + undoNote(done.recorded), { deleted: true, id: found.id, ...changeData(done.recorded) }, done.notes);
    })
  );

  server.registerTool(
    "list_soundboard_sounds",
    {
      title: "List soundboard sounds",
      description: "Custom soundboard sounds in the server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const result = (await rest.get(Routes.guildSoundboardSounds(guildId))) as {
        items: APISoundboardSound[];
      };
      const sounds = result.items ?? [];
      return ok(`${sounds.length} soundboard sound(s).`, {
        sounds: sounds.map(soundDigest),
      });
    })
  );

  server.registerTool(
    "create_soundboard_sound",
    {
      title: "Create soundboard sound",
      description:
        "Upload a soundboard sound from an audio URL: mp3 or ogg, up to " +
        "512 KB and 5.2 seconds. Servers start with eight sound slots; " +
        "boosts add more.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(32).describe("The sound's name, 2 to 32 characters."),
        sound_url: z.string().url().optional()
          .describe("Public http or https link to the sound file itself."),
        sound_file: z.string().min(1).optional()
          .describe("A sound file in the local files folder (DISCORD_MCP_FILES_DIR), by name, instead of a link. Only that folder is read, and only when it is set."),
        volume: z.number().min(0).max(1).optional()
          .describe("Playback volume. Default 1."),
        emoji: z.string().optional()
          .describe("An emoji to show with the sound."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, sound_url, sound_file, volume, emoji }) => {
      const { rest, guildId } = await enter(config, guild);
      if ((sound_url === undefined) === (sound_file === undefined)) {
        return fail("Pass sound_url or sound_file, one of them.");
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.CreateGuildExpressions, "Create Expressions"]],
        "in this server"
      );

      // A full server is said before anything is fetched or sent.
      const [server, current] = await Promise.all([
        (rest.get(Routes.guild(guildId)) as Promise<APIGuild>).catch(() => undefined),
        (rest.get(Routes.guildSoundboardSounds(guildId)) as Promise<{ items: APISoundboardSound[] }>).catch(() => undefined),
      ]);
      const soundLimit = server ? soundSlots(server.premium_tier, server.features as string[]) : null;
      if (soundLimit !== null && current && current.items.length >= soundLimit) {
        return fail(
          `All ${soundLimit} soundboard slots are in use (boost level ${server?.premium_tier ?? 0}), so nothing was uploaded. ` +
            "Delete a sound first, or boost the server for more.",
          { slots: { used: current.items.length, limit: soundLimit } }
        );
      }

      const loaded = await loadAsset({ url: sound_url, file: sound_file }, MAX_SOUND_BYTES, AUDIO_TYPES, "sound");
      if (!loaded.ok) return fail(loaded.error);
      // Discord wants audio/mp3 spelled audio/mpeg in the data URI.
      const audio = { dataUri: toDataUri(loaded.contentType === "audio/mp3" ? "audio/mpeg" : loaded.contentType, loaded.data) };

      let emojiFields: Record<string, string> = {};
      if (emoji) {
        const guildEmojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
        const resolved = resolveEmojiInput(emoji, guildEmojis);
        if (!resolved.ok) return fail(resolved.reason);
        emojiFields = resolved.custom
          ? { emoji_id: resolved.api.split(":")[1] }
          : { emoji_name: resolved.api };
      }

      const sound = (await rest.post(Routes.guildSoundboardSounds(guildId), {
        body: {
          name,
          sound: audio.dataUri,
          ...(volume !== undefined ? { volume } : {}),
          ...emojiFields,
        },
        reason: "Created via discord-mcp",
      })) as APISoundboardSound;

      const recorded = await recordChange(rest, guildId, "create_soundboard_sound", [{ op: "created", kind: "sound", id: sound.sound_id, name: sound.name }]);
      return ok(
        `Created the soundboard sound ${quoted(sound.name)}.` + undoNote(recorded),
        { ...soundDigest(sound), ...changeData(recorded) },
        recorded.warning ? [recorded.warning] : []
      );
    })
  );

  server.registerTool(
    "update_soundboard_sound",
    {
      title: "Update soundboard sound",
      description: "Rename a soundboard sound or change its volume.",
      inputSchema: {
        sound: z.string().describe("Sound name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(32).optional().describe("New name, 2 to 32 characters."),
        volume: z.number().min(0).max(1).optional().describe("Playback volume from 0 to 1, where 1 is full volume."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ sound, guild, name, volume }) => {
      const { rest, guildId } = await enter(config, guild);
      if (name === undefined && volume === undefined) {
        return fail("Pass name or volume to change.");
      }
      const found = await resolveSound(rest, guildId, sound);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const updated = (await rest.patch(
        Routes.guildSoundboardSound(guildId, found.sound_id),
        {
          body: {
            ...(name !== undefined ? { name } : {}),
            ...(volume !== undefined ? { volume } : {}),
          },
          reason: "Updated via discord-mcp",
        }
      )) as APISoundboardSound;
      return ok(`Updated the sound ${quoted(updated.name)}.`, soundDigest(updated));
    })
  );

  server.registerTool(
    "delete_soundboard_sound",
    {
      title: "Delete soundboard sound",
      description:
        "Delete a soundboard sound, or several at once with sounds. Safe to " +
        "call directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes them.",
      inputSchema: {
        sound: z.string().optional().describe("Sound name or ID."),
        sounds: z.array(z.string()).min(1).max(60).optional()
          .describe("Several sounds to delete together, by name or ID, instead of sound."),
        guild: guildParam,
        dry_run: dryRunParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ sound, sounds: many, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      if ((sound === undefined) === (many === undefined)) {
        return fail("Pass sound for one sound, or sounds for several, not both and not neither.");
      }
      if (many !== undefined) {
        const all = ((await rest.get(Routes.guildSoundboardSounds(guildId))) as { items: APISoundboardSound[] }).items ?? [];
        return deleteSeveral(rest, guildId, many, all.map((s) => ({ id: s.sound_id, name: s.name, raw: s })), SOUND_KIND, dry_run, confirm_token);
      }
      const found = await resolveSound(rest, guildId, sound as string);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_soundboard_sound",
        args: { sound: found.sound_id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: `Would delete the soundboard sound ${quoted(found.name)}.`,
        previewDetails: soundDigest(found),
      });
      if (gate) return gate;

      const done = await deleteRecorded(rest, guildId, [{ id: found.sound_id, name: found.name, raw: found }], SOUND_KIND);
      if (done.stopped) return fail(`Discord refused to delete the sound ${quoted(found.name)}: ${done.stopped.why}`);
      return ok(`Deleted the sound ${quoted(found.name)}.` + undoNote(done.recorded), { deleted: true, id: found.sound_id, ...changeData(done.recorded) }, done.notes);
    })
  );
}

// What differs between deleting several stickers and several sounds.
interface SeveralKind {
  tool: string;
  one: string;
  many: string;
  argName: string;
  route: (guildId: string, id: string) => `/${string}`;
  // Discord's "unknown" code for one that is already gone.
  gone: number;
  // Its file, saved before it goes, and the record that lets undo bring it back.
  capture: (raw: unknown) => Promise<string | undefined>;
  entry: (raw: unknown, file: string | null) => RecordEntry;
}
const STICKER_KIND: SeveralKind = {
  tool: "delete_sticker",
  one: "sticker",
  many: "stickers",
  argName: "stickers",
  route: (g, id) => Routes.guildSticker(g, id),
  gone: 10060,
  capture: (raw) => captureSticker((raw as APISticker).id, Number((raw as APISticker).format_type)),
  entry: (raw, file) => {
    const x = raw as APISticker;
    return { op: "deleted", kind: "sticker", id: x.id, name: x.name, description: x.description ?? "", tags: x.tags ?? "", file };
  },
};
const SOUND_KIND: SeveralKind = {
  tool: "delete_soundboard_sound",
  one: "sound",
  many: "sounds",
  argName: "sounds",
  route: (g, id) => Routes.guildSoundboardSound(g, id),
  gone: 10097,
  capture: (raw) => captureSound((raw as APISoundboardSound).sound_id),
  entry: (raw, file) => {
    const x = raw as APISoundboardSound;
    return { op: "deleted", kind: "sound", id: x.sound_id, name: x.name, volume: x.volume ?? null, emojiId: x.emoji_id ?? null, emojiName: x.emoji_name ?? null, file };
  },
};

// Files saved per change for undo, at most (stickers and sounds are 512 KB
// at most each).
const UNDO_FILE_BUDGET = 8 * 1024 * 1024;

// Deletes stickers or sounds in order, saving each file first (Discord
// keeps nothing of a deleted one), and records what went so undo_change can
// recreate it. Stops at the first refusal other than "already gone".
async function deleteRecorded(
  rest: REST,
  guildId: string,
  list: Array<{ id: string; name: string; raw: unknown }>,
  kind: SeveralKind
): Promise<{ deleted: string[]; gone: string[]; stopped?: { at: number; why: string }; recorded: { changeId?: string; warning?: string }; notes: string[] }> {
  const deleted: string[] = [];
  const gone: string[] = [];
  const entries: RecordEntry[] = [];
  let budget = UNDO_FILE_BUDGET;
  let unsaved = 0;
  let stopped: { at: number; why: string } | undefined;
  for (const [i, x] of list.entries()) {
    const file = budget > 0 ? await kind.capture(x.raw) : undefined;
    try {
      await rest.delete(kind.route(guildId, x.id), { reason: "Deleted via discord-mcp" });
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === kind.gone) {
        gone.push(x.name);
        continue;
      }
      stopped = { at: i, why: (describeRateLimit(err) ?? (err instanceof Error ? err.message : String(err))).replace(/\.?$/, ".") };
      break;
    }
    deleted.push(x.name);
    if (file) budget -= file.length;
    else unsaved += 1;
    entries.push(kind.entry(x.raw, file ?? null));
  }
  const recorded = await recordChange(rest, guildId, kind.tool, entries);
  const notes = [
    ...(recorded.warning ? [recorded.warning] : []),
    ...(unsaved > 0 ? [`The file of ${unsaved === 1 ? `1 ${kind.one}` : `${unsaved} ${kind.many}`} could not be saved, so undo_change cannot bring ${unsaved === 1 ? "it" : "them"} back.`] : []),
  ];
  return { deleted, gone, ...(stopped ? { stopped } : {}), recorded, notes };
}

// Several stickers or sounds under one preview and one confirm_token, as
// delete_emoji does with emojis. Every name has to pick out one before
// anything is shown, and a refusal partway says what was and was not done.
async function deleteSeveral(
  rest: REST,
  guildId: string,
  names: string[],
  items: Array<{ id: string; name: string; raw: unknown }>,
  kind: SeveralKind,
  dryRun: boolean | undefined,
  confirmToken: string | undefined
): Promise<CallToolResult | InputRequiredResult> {
  const candidates = items.map((x) => ({ id: x.id, name: x.name, type: kind.one }));
  const picked = new Map<string, string>();
  const problems: string[] = [];
  for (const query of names) {
    const resolution = resolveOne(query, candidates);
    if ("match" in resolution) picked.set(resolution.match.id, resolution.match.name);
    else problems.push(noSingleMatch(kind.one, kind.many, query, resolution));
  }
  if (problems.length > 0) {
    return fail(`Nothing was deleted: ${problems.length} of the ${names.length} names did not pick out one ${kind.one}. ${problems.join(" ")}`, {
      unresolved: problems.length,
    });
  }
  const perms = await botPermissions(rest, guildId);
  requirePermissions(perms, [[P.ManageGuildExpressions, "Manage Expressions"]], "in this server");

  const list = [...picked.entries()].map(([id, name]) => ({ id, name }));
  const shown = list.map((x) => quoted(x.name));
  const gate = gateDestructive({
    tool: kind.tool,
    args: { [kind.argName]: list.map((x) => x.id).sort() },
    dryRun,
    confirmToken,
    previewSummary: `Would delete ${list.length} ${list.length === 1 ? kind.one : kind.many}: ${shown.join(", ")}.`,
    dialogSummary: `Would delete ${list.length} ${list.length === 1 ? kind.one : kind.many}.`,
    dialogLines: shown,
    previewDetails: { [kind.argName]: list },
  });
  if (gate) return gate;

  const done = await deleteRecorded(rest, guildId, list.map((x) => ({ ...x, raw: items.find((y) => y.id === x.id)?.raw })), kind);
  if (done.stopped) {
    const left = list.slice(done.stopped.at);
    return fail(
      `Deleted ${done.deleted.length} of ${list.length} ${kind.many}, then Discord refused ${quoted(left[0].name)}: ${done.stopped.why} ` +
        `Not deleted: ${left.map((y) => quoted(y.name)).join(", ")}.` + undoNote(done.recorded),
      { deleted: done.deleted, already_gone: done.gone, not_deleted: left.map((y) => y.id), ...changeData(done.recorded) }
    );
  }
  return ok(
    `Deleted ${done.deleted.length} ${done.deleted.length === 1 ? kind.one : kind.many}` +
      (done.gone.length > 0 ? `; ${done.gone.length} had already been deleted (${done.gone.map((n) => quoted(n)).join(", ")})` : "") +
      "." + undoNote(done.recorded),
    { deleted: done.deleted.length, already_gone: done.gone.length, ...changeData(done.recorded) },
    done.notes
  );
}
