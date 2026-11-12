import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuild, APIUser } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import { DiscordAPIError } from "@discordjs/rest";
import type { ServerConfig } from "../config.js";
import { getBotUser, invalidateGuildCaches, invalidateGuildList } from "../discord/guildData.js";
import { fetchImageAsDataUri } from "../discord/images.js";
import { fetchPublicUrl } from "../discord/fetchUrl.js";
import { dataDir } from "../home.js";
import { cancelSchedule, listSchedules } from "../scheduler.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { ok, fail } from "../envelope.js";
import {
  botParam,
  botPermissions,
  confirmTokenParam,
  enter,
  enterBot,
  guarded,
  guildParam,
  requirePermissions,
  ToolProblem,
} from "./common.js";

// The bot itself: how it looks, in one server or everywhere, and which
// servers it stays in.

const P = PermissionFlagsBits;

// Discord does not document a size cap for profile images; this server
// holds at most this much in memory for one.
const MAX_PROFILE_IMAGE_BYTES = 8 * 1024 * 1024;

const isNone = (v: string) => /^none$/i.test(v.trim());

// Discord answers too many avatar or banner changes in a short time with a
// form error rather than a rate limit, so it is put in words here.
async function profilePatch(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DiscordAPIError && /AVATAR_RATE_LIMIT|BANNER_RATE_LIMIT|too fast/i.test(err.message)) {
      throw new ToolProblem(
        fail(
          "Discord refused: the avatar or banner was changed too many times in a short while. " +
            "Nothing was changed. Try again later."
        )
      );
    }
    throw err;
  }
}

// A replaced avatar or banner is gone from Discord the moment it changes,
// so the one being replaced is saved to the data folder first. Returns the
// file path, or undefined when there was none or it could not be read.
async function saveReplacedImage(cdnPath: string, hash: string | null | undefined, label: string): Promise<string | undefined> {
  if (!hash) return undefined;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  const res = await fetchPublicUrl(`https://cdn.discordapp.com/${cdnPath}/${hash}.${ext}?size=4096`, MAX_PROFILE_IMAGE_BYTES);
  if (!res.ok || res.data.length === 0) return undefined;
  try {
    const dir = join(dataDir(), "replaced-images");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
    writeFileSync(file, res.data);
    return file;
  } catch {
    return undefined;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function registerBotProfileTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "update_bot_profile",
    {
      title: "Update bot profile",
      description:
        "Change how the bot looks. In one server (the default): its nickname, " +
        "avatar, banner, and bio there, shown only in that server, so one bot " +
        "can look different in each community. Everywhere (scope everywhere): " +
        "its username, avatar, and banner, for every server it is in. Images " +
        "come from public URLs; none removes a server-only one, so the global " +
        "one shows again. A replaced avatar or banner is saved to the data " +
        "folder first, since Discord does not keep it. Discord limits " +
        "username changes to about two an hour.",
      inputSchema: {
        scope: z.enum(["server", "everywhere"]).optional()
          .describe("server (default) changes it in one server only; everywhere changes the bot's own profile."),
        guild: guildParam,
        bot: botParam,
        nickname: z.string().max(32).optional()
          .describe("Server only: the name shown in that server, or none to show the username."),
        username: z.string().min(2).max(32).optional()
          .describe("Everywhere only: the bot's username."),
        avatar_url: z.string().optional()
          .describe("Public URL of the avatar image (png, jpeg, gif, webp), or none."),
        banner_url: z.string().optional()
          .describe("Public URL of the profile banner image, or none."),
        bio: z.string().max(190).optional()
          .describe("Server only: the About Me shown in that server, or none. The bot's own About Me is set in the Developer Portal."),
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ scope, guild, bot, nickname, username, avatar_url, banner_url, bio, dry_run }) => {
      const everywhere = scope === "everywhere";
      if ([nickname, username, avatar_url, banner_url, bio].every((v) => v === undefined)) {
        return fail("Pass at least one thing to change.");
      }
      if (everywhere && (nickname !== undefined || bio !== undefined)) {
        return fail(
          "nickname and bio belong to one server. Use scope server for them; the bot's own About Me " +
            "is set in the Developer Portal."
        );
      }
      if (!everywhere && username !== undefined) {
        return fail("username is the same in every server. Pass scope everywhere to change it, or nickname for one server.");
      }

      const body: Record<string, unknown> = {};
      const changes: string[] = [];
      for (const [field, url, label] of [
        ["avatar", avatar_url, "avatar"],
        ["banner", banner_url, "banner"],
      ] as const) {
        if (url === undefined) continue;
        if (isNone(url)) {
          body[field] = null;
          changes.push(everywhere ? `${label} removed` : `server ${label} removed`);
          continue;
        }
        const image = await fetchImageAsDataUri(url, MAX_PROFILE_IMAGE_BYTES);
        if (!image.ok) return fail(`The ${label}: ${image.error} Nothing was changed.`);
        body[field] = image.dataUri;
        changes.push(`new ${label}`);
      }
      if (nickname !== undefined) {
        body.nick = isNone(nickname) || nickname === "" ? null : nickname;
        changes.push(body.nick === null ? "nickname removed" : `nickname "${nickname}"`);
      }
      if (bio !== undefined) {
        body.bio = isNone(bio) || bio === "" ? null : bio;
        changes.push(body.bio === null ? "bio removed" : "bio");
      }
      if (username !== undefined) {
        body.username = username;
        changes.push(`username "${username}"`);
      }

      if (everywhere) {
        const { rest } = enterBot(config, bot);
        const me = await getBotUser(rest);
        if (dry_run) {
          return ok(`Dry run: would change ${me.username} everywhere: ${changes.join(", ")}. Nothing was changed.`, { executed: false });
        }
        const current = (await rest.get(Routes.user("@me"))) as APIUser;
        const saved: string[] = [];
        for (const field of ["avatar", "banner"] as const) {
          if (!(field in body)) continue;
          const file = await saveReplacedImage(`${field}s/${current.id}`, current[field], `bot-${field}`);
          if (file) saved.push(file);
        }
        const updated = (await profilePatch(() => rest.patch(Routes.user("@me"), { body }))) as APIUser;
        return ok(
          `Changed the bot's profile everywhere: ${changes.join(", ")}.` +
            (saved.length ? ` The image it replaced is saved at ${saved.join(" and ")}.` : ""),
          {
            scope: "everywhere",
            user: { id: updated.id, username: updated.username, avatar: updated.avatar ?? null, banner: updated.banner ?? null },
            changed: changes,
            ...(saved.length ? { replaced_images_saved: saved } : {}),
          }
        );
      }

      const { rest, guildId, guildName } = await enter(config, guild, bot);
      if (nickname !== undefined) {
        requirePermissions(await botPermissions(rest, guildId), [[P.ChangeNickname, "Change Nickname"]], "in this server");
      }
      if (dry_run) {
        return ok(`Dry run: would change the bot in ${quoted(guildName)}: ${changes.join(", ")}. Nothing was changed.`, { executed: false });
      }
      const saved: string[] = [];
      if ("avatar" in body || "banner" in body) {
        const me = await getBotUser(rest);
        const current = (await rest.get(Routes.guildMember(guildId, me.id))) as { avatar?: string | null; banner?: string | null };
        for (const field of ["avatar", "banner"] as const) {
          if (!(field in body)) continue;
          const file = await saveReplacedImage(`guilds/${guildId}/users/${me.id}/${field}s`, current[field], `bot-${field}-${guildId}`);
          if (file) saved.push(file);
        }
      }
      const member = (await profilePatch(() =>
        rest.patch(Routes.guildMember(guildId, "@me"), { body, reason: "Updated via discord-mcp" })
      )) as { nick?: string | null; avatar?: string | null; banner?: string | null };
      return ok(
        `Changed how the bot looks in ${quoted(guildName)}: ${changes.join(", ")}. Other servers are unchanged.` +
          (saved.length ? ` The image it replaced is saved at ${saved.join(" and ")}.` : ""),
        {
          scope: "server",
          server: { id: guildId, name: guildName },
          member: { nick: member.nick ?? null, avatar: member.avatar ?? null, banner: member.banner ?? null },
          changed: changes,
          ...(saved.length ? { replaced_images_saved: saved } : {}),
        }
      );
    })
  );

  server.registerTool(
    "leave_server",
    {
      title: "Leave server",
      description:
        "Make the bot leave a server. It can only come back through a new " +
        "invite from someone with Manage Server, and its own role there is " +
        "deleted. Always previews first and asks for confirmation. The " +
        "server must be named: this never falls back to the default one. " +
        "When two of your bots are in the server, bot says which one leaves.",
      inputSchema: {
        guild: z.string().min(1).describe("Server name or ID to leave."),
        bot: botParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, bot: botArg, confirm_token }) => {
      // Which bot leaves is never guessed: where two are in the server, the
      // caller names one.
      const { rest, guildId, guildName, bot } = await enter(config, guild, botArg, { shared: "ask" });
      const [info, me] = await Promise.all([
        rest.get(Routes.guild(guildId), {
          query: new URLSearchParams({ with_counts: "true" }),
        }) as Promise<APIGuild>,
        getBotUser(rest),
      ]);
      if (info.owner_id === me.id) {
        return fail(
          `The bot owns ${quoted(guildName)}, and Discord does not let an owner leave. ` +
            "Transfer ownership or delete the server in Discord instead."
        );
      }

      // Scheduled messages go out through the bot that scheduled them (the
      // default bot for ones from before 2.0). Once it has left they can
      // never be delivered, so leaving cancels them.
      const scheduled = listSchedules().filter(
        (s) => s.guild_id === guildId && (s.bot ? s.bot === bot.name : bot.isDefault)
      );
      const isDefaultServer = config.defaultGuild === guildId || config.defaultGuild === guildName;
      const members = info.approximate_member_count;
      const lines = [
        `It cannot come back unless someone with Manage Server invites it again.`,
        ...(scheduled.length > 0
          ? [`${plural(scheduled.length, "scheduled message")} for this server will be cancelled.`]
          : []),
        ...(isDefaultServer
          ? ["This is the default server in this setup, so calls that name no server will stop working."]
          : []),
      ];
      const gate = gateDestructive({
        tool: "leave_server",
        args: { guild: guildId, bot: bot.name },
        confirmToken: confirm_token,
        previewSummary:
          `Would make ${me.global_name ?? me.username} leave ${quoted(guildName)}` +
          (members !== undefined ? ` (${plural(members, "member")})` : "") +
          `. ${lines.join(" ")}`,
        dialogLines: [],
        previewDetails: {
          server: { id: guildId, name: guildName },
          ...(members !== undefined ? { members } : {}),
          scheduled_messages_cancelled: scheduled.length,
          default_server: isDefaultServer,
        },
      });
      if (gate) return gate;

      await rest.delete(Routes.userGuild(guildId));
      invalidateGuildList(rest);
      invalidateGuildCaches(guildId);
      let cancelled = 0;
      for (const s of scheduled) if (cancelSchedule(s.id)) cancelled++;

      return ok(
        `${me.global_name ?? me.username} left ${quoted(guildName)}.` +
          (cancelled > 0 ? ` Cancelled ${plural(cancelled, "scheduled message")} for it.` : ""),
        { left: true, server: { id: guildId, name: guildName }, scheduled_messages_cancelled: cancelled },
        isDefaultServer
          ? ["This was the default server. Set a new one, or name a server in each call."]
          : []
      );
    })
  );
}
