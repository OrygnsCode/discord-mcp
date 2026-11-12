import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuildMember,
  APIMessage,
  APIRole,
  APIWebhook,
} from "discord-api-types/v10";
import { DiscordAPIError, type REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import {
  getRoles,
  getBotUser,
  getChannels,
  invalidateGuildCaches,
  CHANNEL_TYPE_LABELS,
} from "../discord/guildData.js";
import {
  computeGuildPermissions,
  highestRolePosition,
  parsePermissionNames,
  describePermissions,
  listPermissionNames,
  PERMISSION_PRESETS,
  ALL_PERMISSIONS,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import {
  compileComponents,
  componentsParam,
  COMPONENTS_V2_FLAG,
  type ComponentBlock,
} from "../discord/components.js";
import { gateDestructive } from "../safety.js";
import { plainText, quoted } from "../discord/names.js";
import { channelLabel, grantLines, grantPhrase, grantsForRoleChange, grantsKey, hasGrants, type Scene } from "../discord/grants.js";
import { CONFIRM_STEPS, POWER_EXAMPLES, hiddenNote, holdersPhrase, loadScene, roleMemberCount } from "./grantGate.js";
import { roleHolders } from "../builder/executor.js";
import type { RecordEntry } from "../builder/records.js";
import { channelNow, changeData, recordChange, undoNote } from "./changes.js";
import { channelSettingsBody, channelSettingsContext, channelSettingsFields, hasChannelSettings } from "./channelSettings.js";
import { hasRoleAppearance, roleAppearanceBody, roleAppearanceFields } from "./roleAppearance.js";
import { savedImageBefore } from "../discord/images.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  digestMessage,
  ToolProblem,
  TEXT_BEARING_TYPES,
  THREAD_TYPES,
  botPermissions,
  requirePermissions,
  parseHexColor,
  embedsParam,
  embedFilesProblem,
  mapEmbeds,
  messageFileNames,
  confirmTokenParam,
  messageIdParam,
} from "./common.js";

// Management tools: the update and delete half of CRUD for channels and
// roles, plus message editing and pinning. The deletes run through the
// confirmation gate; the updates honor dry_run.

const P = PermissionFlagsBits;

// Pages of 50 pins read by list_pinned_messages: 250, the most a channel holds.
const MAX_PIN_PAGES = 5;

// The webhook that posted a message, with the token needed to edit it.
// Discord returns the token only for incoming webhooks and only to a bot
// that may manage webhooks there; the other kinds belong to someone else.
async function webhookForEdit(rest: REST, webhookId: string, postedAs: string): Promise<APIWebhook> {
  let hook: APIWebhook;
  try {
    hook = (await rest.get(Routes.webhook(webhookId))) as APIWebhook;
  } catch (err) {
    if (err instanceof DiscordAPIError && err.status === 404) {
      throw new ToolProblem(
        fail(
          `That message was posted by a webhook ("${postedAs}") that has since been deleted, ` +
            "so it can no longer be edited. Delete it and post a new one instead."
        )
      );
    }
    if (err instanceof DiscordAPIError && err.status === 403) {
      throw new ToolProblem(
        fail(
          `That message was posted by the webhook "${postedAs}". Editing it needs the ` +
            "Manage Webhooks permission in that channel, which the bot does not have."
        )
      );
    }
    throw err;
  }
  if (!hook.token) {
    throw new ToolProblem(
      fail(
        hook.type === 2
          ? "That message was crossposted from an announcement channel this one follows. " +
              "Only its original in the source server can be edited."
          : `That message was posted by "${postedAs}", a webhook that belongs to another app, ` +
              "so only that app can edit it."
      )
    );
  }
  return hook;
}

// Shared role resolution with the safety checks every role mutation needs:
// the role must exist, must not be integration-managed, must not be
// @everyone, and must sit below the bot's highest role.
async function resolveManageableRole(
  rest: Awaited<ReturnType<typeof enter>>["rest"],
  guildId: string,
  roleQuery: string
): Promise<{ role: APIRole; warnings: string[] }> {
  const roles = await getRoles(rest, guildId);
  const resolution = resolveOne(
    roleQuery,
    roles
      .filter((r) => r.id !== guildId)
      .map((r) => ({ id: r.id, name: r.name, type: "role" }))
  );
  if (!("match" in resolution)) {
    throw new ToolProblem(
      fail(`No single role matches "${roleQuery}".`, {
        candidates: "candidates" in resolution ? resolution.candidates : [],
      })
    );
  }
  const role = roles.find((r) => r.id === resolution.match.id);
  if (!role) {
    throw new ToolProblem(fail(`Role "${roleQuery}" disappeared mid-call.`));
  }
  if (role.managed) {
    throw new ToolProblem(
      fail(
        `${quoted(role.name)} is managed by an integration and cannot be changed ` +
          "manually."
      )
    );
  }

  const botUser = await getBotUser(rest);
  const botMember = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;
  const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
  requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");

  const warnings: string[] = [];
  const botTop = highestRolePosition(botMember.roles, roles);
  if (role.position > botTop) {
    throw new ToolProblem(
      fail(
        `The bot's highest role (position ${botTop}) is below ${quoted(role.name)} ` +
          `(position ${role.position}). Discord will reject this. Move the ` +
          "bot's role above the target role."
      )
    );
  }
  if (role.position === botTop) {
    warnings.push(
      "The target role shares the bot's highest position; Discord may " +
        "reject the change."
    );
  }
  return { role, warnings };
}

export function registerManageTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "update_channel",
    {
      title: "Update channel",
      description:
        "Edit a channel's name, topic, slowmode, NSFW flag, or category, a " +
        "voice channel's bitrate, user limit, region, and video quality, how " +
        "long its threads stay open, and a forum's default reaction, sort, " +
        "layout, post slowmode, and whether posts need a tag. Only passed " +
        "fields change. Pass category \"none\" to move a channel out of its " +
        "category. Supports dry_run.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(1024).optional(),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        nsfw: z.boolean().optional(),
        category: z.string().optional()
          .describe("Category name or ID, or \"none\" to remove."),
        ...channelSettingsFields,
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async (args) => {
      const { channel, guild, name, topic, slowmode_seconds, nsfw, category, dry_run, ...settingsInput } = args;
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);

      if (
        name === undefined &&
        topic === undefined &&
        slowmode_seconds === undefined &&
        nsfw === undefined &&
        category === undefined &&
        !hasChannelSettings(settingsInput)
      ) {
        return fail("Pass at least one field to change.");
      }
      let settings: { body: Record<string, unknown>; changes: string[] } = { body: {}, changes: [] };
      if (hasChannelSettings(settingsInput)) {
        const ctx = await channelSettingsContext(rest, guildId, settingsInput);
        const now = settingsInput.require_tag !== undefined ? await channelNow(rest, target.id) : undefined;
        const built = channelSettingsBody(settingsInput, target.type, {
          ...ctx,
          ...(now
            ? {
                currentFlags: Number(now.flags ?? 0),
                availableTags: (now.available_tags as Array<{ moderated?: boolean }> | undefined) ?? [],
              }
            : {}),
        });
        if (!built.ok) return fail(built.reason);
        settings = built;
      }
      if (topic !== undefined && (target.type === 2 || target.type === 13)) {
        return fail("Voice and stage channels have no topic.");
      }

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageChannels, "Manage Channels"]],
        `for ${channelLabel(target)}`
      );

      let parentId: string | null | undefined;
      if (category !== undefined) {
        if (category.toLowerCase() === "none") {
          parentId = null;
        } else {
          const parent = await resolveChannel(rest, guildId, category, [4]);
          parentId = parent.id;
        }
      }

      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (topic !== undefined) changes.push("topic");
      if (slowmode_seconds !== undefined)
        changes.push(`slowmode to ${slowmode_seconds}s`);
      if (nsfw !== undefined) changes.push(`nsfw to ${nsfw}`);
      if (parentId !== undefined)
        changes.push(parentId === null ? "out of its category" : "category");
      changes.push(...settings.changes);

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")} on ${channelLabel(target)}. ` +
            "Nothing was changed.",
          { executed: false }
        );
      }

      const body: Record<string, unknown> = {
        ...(name !== undefined ? { name } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(slowmode_seconds !== undefined
          ? { rate_limit_per_user: slowmode_seconds }
          : {}),
        ...(nsfw !== undefined ? { nsfw } : {}),
        ...(parentId !== undefined ? { parent_id: parentId } : {}),
        ...settings.body,
      };
      const before = (await channelNow(rest, target.id)) ?? (target as unknown as Record<string, unknown>);
      const after = (await rest.patch(Routes.channel(target.id), {
        body,
        reason: "Updated via discord-mcp",
      })) as Record<string, unknown> | undefined;
      invalidateGuildCaches(guildId);

      const recorded = await recordChange(rest, guildId, "update_channel", [
        {
          op: "updated",
          kind: target.type === 4 ? "category" : "channel",
          id: target.id,
          name: target.name ?? target.id,
          channelType: target.type,
          fields: Object.fromEntries(
            Object.keys(body).map((k) => [k, { before: before[k] ?? null, after: after?.[k] ?? body[k] }])
          ),
        },
      ]);
      return ok(
        `Updated ${channelLabel(target)}: ${changes.join(", ")}.` + undoNote(recorded),
        { id: target.id, changed: changes, ...changeData(recorded) },
        recorded.warning ? [recorded.warning] : []
      );
    })
  );

  server.registerTool(
    "delete_channel",
    {
      title: "Delete channel",
      description:
        "Delete a channel or category. Safe to call directly: the first " +
        "call deletes nothing and returns a preview plus a confirm_token, " +
        "and the deletion only happens when the call is repeated with that " +
        "token. When the user asks to delete something, call this and " +
        "relay the preview for their go-ahead instead of sending them to " +
        "do it manually in Discord; the gate exists exactly so deletion " +
        "can be approved through the conversation. Deleting a category " +
        "leaves its channels in place, uncategorized.",
      inputSchema: {
        channel: z.string().describe("Channel or category name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);
      const kind = CHANNEL_TYPE_LABELS[target.type] ?? `type ${target.type}`;
      // As a person reads it, since the confirmation dialog shows it too:
      // "the text channel #general", "the voice channel Lounge".
      const what =
        target.type === 4
          ? `the category ${quoted(target.name)}`
          : `the ${kind} channel ${target.type === 2 || target.type === 13 ? quoted(target.name) : `#${plainText(target.name)}`}`;

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageChannels, "Manage Channels"]],
        `for ${quoted(target.name)}`
      );

      let childNote = "";
      if (target.type === 4) {
        const children = (await getChannels(rest, guildId)).filter(
          (c) => c.parent_id === target.id
        );
        childNote =
          children.length > 0
            ? ` Its ${children.length} channel(s) survive and become uncategorized.`
            : "";
      }

      const gate = gateDestructive({
        tool: "delete_channel",
        args: { channel: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete ${what} (${target.id}).` +
          (target.type === 4
            ? childNote
            : " Every message in it is lost forever.") ,
        previewDetails: { id: target.id, name: target.name, type: kind },
      });
      if (gate) return gate;

      // A full copy first, for undo_change to recreate it from.
      const snapshot = (await channelNow(rest, target.id)) ?? (target as unknown as Record<string, unknown>);
      const children =
        target.type === 4
          ? (await getChannels(rest, guildId)).filter((c) => c.parent_id === target.id).map((c) => c.id)
          : [];
      let settings: string[] = [];
      try {
        const g = (await rest.get(Routes.guild(guildId))) as unknown as Record<string, unknown>;
        settings = ["system_channel_id", "afk_channel_id", "safety_alerts_channel_id"].filter((f) => g[f] === target.id);
      } catch {
        settings = [];
      }

      await rest.delete(Routes.channel(target.id), {
        reason: reason ?? "Deleted via discord-mcp",
      });
      invalidateGuildCaches(guildId);

      const entry: RecordEntry = {
        op: "deleted",
        kind: target.type === 4 ? "category" : "channel",
        id: target.id,
        name: target.name ?? target.id,
        snapshot,
        ...(target.type === 4 ? { children } : {}),
        settings,
        notes: target.type === 4 ? [] : ["Its messages, threads, pins, invites, and webhooks cannot be brought back."],
      };
      const recorded = await recordChange(rest, guildId, "delete_channel", [entry]);
      return ok(
        `Deleted ${what}.` + undoNote(recorded),
        { deleted: true, id: target.id, ...changeData(recorded) },
        recorded.warning ? [recorded.warning] : []
      );
    })
  );

  server.registerTool(
    "update_role",
    {
      title: "Update role",
      description:
        "Edit a role's name, color (solid, gradient, or holographic), icon, " +
        "hoist, mentionable flag, or permissions. Passing preset and/or " +
        "permissions replaces the " +
        "role's permission set with the named bundle plus listed names. " +
        "Only passed fields change. Supports dry_run. A permission change " +
        `that would give the role ${POWER_EXAMPLES}, or let it see channels ` +
        `it cannot see now, needs confirming: ${CONFIRM_STEPS}.`,
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        color: z.string().optional().describe("Hex color like #00b0f4."),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        preset: z.enum(["none", "member", "moderator", "admin"]).optional(),
        permissions: z.array(z.string()).optional(),
        ...roleAppearanceFields,
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      role,
      guild,
      name,
      color,
      hoist,
      mentionable,
      preset,
      permissions,
      secondary_color,
      holographic,
      icon_url,
      icon_emoji,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const { role: target, warnings } = await resolveManageableRole(
        rest,
        guildId,
        role
      );

      const changingPerms = preset !== undefined || permissions !== undefined;
      const look = { color, secondary_color, holographic, icon_url, icon_emoji };
      if (
        name === undefined &&
        color === undefined &&
        hoist === undefined &&
        mentionable === undefined &&
        !changingPerms &&
        !hasRoleAppearance(look)
      ) {
        return fail("Pass at least one field to change.");
      }
      const appearance = await roleAppearanceBody(rest, guildId, look, target);
      if (!appearance.ok) return fail(appearance.reason);

      let bits: bigint | undefined;
      if (changingPerms) {
        bits = PERMISSION_PRESETS[preset ?? "none"];
        if (permissions && permissions.length > 0) {
          const parsed = parsePermissionNames(permissions);
          if (parsed.unknown.length > 0) {
            return fail(
              `Unknown permission name(s): ${parsed.unknown.join(", ")}.`,
              { valid_names: listPermissionNames() }
            );
          }
          bits |= parsed.bits;
        }
        const botPerms = await botPermissions(rest, guildId);
        if (botPerms !== ALL_PERMISSIONS) {
          const beyond = bits & ~botPerms;
          if (beyond !== 0n) {
            return fail(
              "The new permission set includes permissions the bot itself " +
                `lacks: ${describePermissions(beyond).join(", ")}. Discord ` +
                "rejects that."
            );
          }
        }
      }

      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (color !== undefined) changes.push(`color to ${color}`);
      changes.push(...appearance.changes);
      if (hoist !== undefined) changes.push(`hoist to ${hoist}`);
      if (mentionable !== undefined) changes.push(`mentionable to ${mentionable}`);
      if (bits !== undefined)
        changes.push(`permissions (${describePermissions(bits).length} granted)`);

      // What the new permissions hand to whoever holds the role, alone or
      // next to another role.
      if (bits !== undefined) {
        const scene = await loadScene(rest, guildId);
        const changed: Scene = {
          ...scene,
          roles: scene.roles.map((r) => (r.id === target.id ? { ...r, permissions: bits!.toString() } : r)),
        };
        const grants = grantsForRoleChange(scene, changed, target.id);
        if (hasGrants(grants)) {
          const hidden = hiddenNote(rest, guildId, scene);
          const gate = gateDestructive({
            tool: "update_role",
            args: {
              role: target.id,
              name: name ?? null,
              color: color ?? null,
              hoist: hoist ?? null,
              mentionable: mentionable ?? null,
              secondary_color: secondary_color ?? null,
              holographic: holographic ?? null,
              icon_url: icon_url ?? null,
              icon_emoji: icon_emoji ?? null,
              permissions: bits.toString(),
              grants: grantsKey(grants),
            },
            dryRun: dry_run,
            confirmToken: confirm_token,
            previewSummary:
              `Would change the permissions of the role ${quoted(target.name)} so that people with it can ` +
              `${grantPhrase(grants)}.${holdersPhrase(await roleMemberCount(rest, guildId, target.id))}`,
            ...(hidden ? { note: hidden } : {}),
            dialogLines: grantLines(grants),
            previewDetails: {
              role: { id: target.id, name: target.name },
              changes,
              grants: grantLines(grants),
            },
          });
          if (gate) return gate;
        }
      }

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")} on ${quoted(target.name)}. ` +
            "Nothing was changed.",
          { executed: false },
          warnings
        );
      }

      const roleBody: Record<string, unknown> = {
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined && !appearance.setsColors ? { color: parseHexColor(color) } : {}),
        ...appearance.body,
        ...(hoist !== undefined ? { hoist } : {}),
        ...(mentionable !== undefined ? { mentionable } : {}),
        ...(bits !== undefined ? { permissions: bits.toString() } : {}),
      };
      const roleBefore = {
        ...(((await rest.get(Routes.guildRoles(guildId))) as Array<Record<string, unknown>>).find((r) => r.id === target.id) ??
          (target as unknown as Record<string, unknown>)),
      };
      // The icon is saved now: once replaced, Discord no longer serves it.
      Object.assign(roleBefore, await savedImageBefore("role", guildId, target.id, Object.keys(roleBody), roleBefore));
      const roleAfter = (await rest.patch(Routes.guildRole(guildId, target.id), {
        body: roleBody,
        reason: "Updated via discord-mcp",
      })) as Record<string, unknown> | undefined;
      invalidateGuildCaches(guildId);

      const recorded = await recordChange(rest, guildId, "update_role", [
        {
          op: "updated",
          kind: "role",
          id: target.id,
          name: target.name ?? target.id,
          fields: Object.fromEntries(
            Object.keys(roleBody).map((k) => [k, { before: roleBefore[k] ?? null, after: roleAfter?.[k] ?? roleBody[k] }])
          ),
        },
      ]);
      return ok(
        `Updated role ${quoted(target.name)}: ${changes.join(", ")}.` + undoNote(recorded),
        { id: target.id, changed: changes, ...changeData(recorded) },
        [...warnings, ...(recorded.warning ? [recorded.warning] : [])]
      );
    })
  );

  server.registerTool(
    "delete_role",
    {
      title: "Delete role",
      description:
        "Delete a role. Members holding it simply lose it; nothing else " +
        "changes. Safe to call directly: the first call deletes nothing " +
        "and returns a preview plus a confirm_token, and the deletion only " +
        "happens when the call is repeated with that token. Prefer this " +
        "gated flow over telling the user to delete the role manually.",
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ role, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const { role: target } = await resolveManageableRole(
        rest,
        guildId,
        role
      );

      const gate = gateDestructive({
        tool: "delete_role",
        args: { role: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the role ${quoted(target.name)} (position ` +
          `${target.position}). Members holding it lose it; channel ` +
          "overrides referencing it are removed.",
        previewDetails: { id: target.id, name: target.name },
      });
      if (gate) return gate;

      // A full copy first, for undo_change to recreate it from: its
      // settings, who has it, and its permission settings in channels.
      const roleSnapshot =
        ((await rest.get(Routes.guildRoles(guildId))) as Array<Record<string, unknown>>).find((r) => r.id === target.id) ??
        (target as unknown as Record<string, unknown>);
      let holders: { members: string[] | null; count: number | null; note?: string };
      try {
        const counts = (await rest.get(Routes.guildRoleMemberCounts(guildId))) as Record<string, number>;
        holders = (counts[target.id] ?? 0) === 0 ? { members: [], count: 0 } : await roleHolders(rest, guildId, target.id);
      } catch {
        holders = await roleHolders(rest, guildId, target.id);
      }
      const roleOverwrites = (await getChannels(rest, guildId)).flatMap((c) => {
        const o = (c.permission_overwrites ?? []).find((x) => x.id === target.id);
        return o ? [{ channel_id: c.id, allow: o.allow, deny: o.deny }] : [];
      });

      await rest.delete(Routes.guildRole(guildId, target.id), {
        reason: reason ?? "Deleted via discord-mcp",
      });
      invalidateGuildCaches(guildId);

      const recorded = await recordChange(rest, guildId, "delete_role", [
        {
          op: "deleted",
          kind: "role",
          id: target.id,
          name: target.name ?? target.id,
          snapshot: roleSnapshot,
          members: holders.members,
          memberCount: holders.count,
          overwrites: roleOverwrites,
          notes: [
            ...(roleSnapshot.icon ? ["Its icon image cannot be brought back."] : []),
            ...(holders.note ? [holders.note] : []),
          ],
        },
      ]);
      return ok(
        `Deleted the role ${quoted(target.name)}.` + undoNote(recorded),
        { deleted: true, id: target.id, ...changeData(recorded) },
        recorded.warning ? [recorded.warning] : []
      );
    })
  );

  server.registerTool(
    "edit_message",
    {
      title: "Edit message",
      description:
        "Edit a message the bot itself sent, or one posted through one of " +
        "the server's webhooks (that needs Manage Webhooks). Discord does " +
        "not allow editing anyone else's messages, no matter the permission " +
        "level. A message sent as a Components V2 layout stays one: edit it " +
        "with components, never with content or embeds.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        content: z.string().min(1).max(2000).optional(),
        embeds: embedsParam,
        components: componentsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, content, embeds, components }) => {
      // Everything decidable from the arguments alone is decided first, so a
      // malformed call costs no API requests.
      const layout = components as ComponentBlock[] | undefined;
      if (content === undefined && embeds === undefined && layout === undefined) {
        return fail("Pass content, embeds, or components to change.");
      }
      if (layout && (content !== undefined || embeds !== undefined)) {
        return fail(
          "components cannot be combined with content or embeds. A " +
            "Components V2 message renders neither."
        );
      }

      let compiled: ReturnType<typeof compileComponents> | undefined;
      if (layout) {
        compiled = compileComponents(layout);
        if (!compiled.ok) return fail(compiled.reason);
      }
      // An empty list is a real edit: it takes the embeds off.
      const cards = embeds !== undefined ? mapEmbeds(embeds) : undefined;

      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      const botUser = await getBotUser(rest);
      // A webhook's message is edited through the webhook itself, with its
      // token, which Discord hands to a bot that may manage webhooks.
      let hook: APIWebhook | undefined;
      if (message.webhook_id && message.author.id !== botUser.id) {
        hook = await webhookForEdit(rest, message.webhook_id, message.author.username);
      } else if (message.author.id !== botUser.id) {
        return fail(
          "That message was sent by " +
            `${quoted(message.author.global_name ?? message.author.username)}, not ` +
            "the bot. Discord only allows editing your own messages."
        );
      }

      // The Components V2 flag is decided when a message is sent and can
      // never be added or removed afterward, so the two kinds of message
      // are not interchangeable. Both mismatches are caught here, where the
      // message is already in hand, rather than left to a bare 400.
      const isV2 = ((message.flags ?? 0) & COMPONENTS_V2_FLAG) !== 0;
      if (isV2 && !layout) {
        return fail(
          "That message was sent as a Components V2 layout, so it renders " +
            "neither content nor embeds. Edit it with components instead."
        );
      }
      if (!isV2 && layout) {
        return fail(
          "That message was sent as an ordinary message, and Discord does " +
            "not allow adding the Components V2 flag to an existing " +
            "message. Send a new message with components and delete this one."
        );
      }

      // An edit sends no files, so a picture can only point at one the
      // message already has.
      const lost = embedFilesProblem(embeds, messageFileNames(message), {
        some: "Use one of those exact names, or an http or https link; an edit cannot add a file.",
        none: "An edit cannot add a file. Use an http or https link, or send a new message with the file.",
      });
      if (lost) return fail(`Nothing was changed. ${lost}`);

      const body = {
        ...(content !== undefined ? { content } : {}),
        ...(cards ? { embeds: cards } : {}),
        ...(compiled?.ok ? { components: compiled.components } : {}),
        // Discord works out an edited message's mentions afresh, and without
        // this it does so with its defaults, whatever the message was sent
        // with: an edit could turn plain text into an @everyone mention.
        // Edits mention nobody, like sends do unless asked.
        allowed_mentions: { parse: [] as string[] },
      };
      if (hook?.token) {
        // Messages in a thread are addressed through the thread's parent
        // webhook, with the thread named in the query. Components are
        // ignored unless asked for; ours are all non-interactive, which
        // Discord allows on any webhook.
        const query = new URLSearchParams();
        if (THREAD_TYPES.includes(target.type)) query.set("thread_id", target.id);
        if (compiled?.ok) query.set("with_components", "true");
        await rest.patch(Routes.webhookMessage(hook.id, hook.token, message_id), {
          body,
          query,
          auth: false,
        });
        return ok(`Edited the message ${hook.name ? quoted(hook.name) : "the webhook"} posted in ${channelLabel(target)}.`, {
          id: message_id,
          channel: { id: target.id, name: target.name },
          webhook: { id: hook.id, name: hook.name },
        });
      }

      await rest.patch(Routes.channelMessage(target.id, message_id), { body });

      return ok(`Edited the bot's message in ${channelLabel(target)}.`, {
        id: message_id,
        channel: { id: target.id, name: target.name },
      });
    })
  );

  server.registerTool(
    "pin_message",
    {
      title: "Pin message",
      description:
        "Pin a message in a channel. Needs the Pin Messages permission " +
        "(split from Manage Messages in 2026). Channels hold at most 50 pins.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.PinMessages, "Pin Messages"]],
        `in ${channelLabel(target)}`
      );

      await rest.put(Routes.channelMessagesPin(target.id, message_id), {
        reason: reason ?? "Pinned via discord-mcp",
      });
      return ok(`Pinned message ${message_id} in ${channelLabel(target)}.`, {
        pinned: true,
        id: message_id,
      });
    })
  );

  server.registerTool(
    "unpin_message",
    {
      title: "Unpin message",
      description: "Unpin a message. The message itself is untouched.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: messageIdParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.PinMessages, "Pin Messages"]],
        `in ${channelLabel(target)}`
      );

      await rest.delete(Routes.channelMessagesPin(target.id, message_id), {
        reason: reason ?? "Unpinned via discord-mcp",
      });
      return ok(`Unpinned message ${message_id} in ${channelLabel(target)}.`, {
        pinned: false,
        id: message_id,
      });
    })
  );

  server.registerTool(
    "list_pinned_messages",
    {
      title: "List pinned messages",
      description: "Pinned messages in a channel, newest pin first.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      // Discord hands pins out 50 at a time and a channel can hold 250, so
      // every page is read; the first used to be given as all of them.
      const items: Array<{ pinned_at: string; message: APIMessage }> = [];
      let before: string | undefined;
      let more = false;
      for (let page = 0; page < MAX_PIN_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: "50" });
        if (before) query.set("before", before);
        const result = (await rest.get(Routes.channelMessagesPins(target.id), { query })) as {
          items?: Array<{ pinned_at: string; message: APIMessage }>;
          has_more?: boolean;
        };
        const batch = result.items ?? [];
        items.push(...batch);
        more = result.has_more === true;
        const oldest = batch[batch.length - 1]?.pinned_at;
        if (!more || !oldest) break;
        before = oldest;
      }

      const pins = items.map((item) => ({
        pinned_at: item.pinned_at,
        ...digestMessage(item.message),
      }));

      return ok(
        `${pins.length} pinned message(s) in ${channelLabel(target)}` + (more ? ", the most recently pinned; there are more." : "."),
        {
          channel: { id: target.id, name: target.name },
          pins,
          more,
        }
      );
    })
  );

  server.registerTool(
    "set_voice_channel_status",
    {
      title: "Set voice channel status",
      description:
        "Set the short status line shown on a voice channel, a note about " +
        "what is happening in it right now, up to 500 characters. Pass an " +
        "empty status to clear it. This is the live status, not the topic. " +
        "Needs Set Voice Channel Status, Manage Channels, and Connect in " +
        "that channel.",
      inputSchema: {
        channel: z.string().describe("Voice channel name or ID."),
        guild: guildParam,
        status: z.string().max(500).describe("Status text. Empty clears it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, status }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, [2]);

      // Discord's rule: Set Voice Channel Status, plus Manage Channels for
      // anyone not connected to the channel, which is always the case for a
      // bot acting through this server. A denied Connect implicitly denies
      // Manage Channels in a voice channel, so Connect is needed too.
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [
          [P.SetVoiceChannelStatus, "Set Voice Channel Status"],
          [P.ManageChannels, "Manage Channels"],
          [P.Connect, "Connect"],
        ],
        `in ${channelLabel(target)}`
      );

      const clean = status.trim();
      await rest.put(`/channels/${target.id}/voice-status`, {
        body: { status: clean.length ? clean : null },
      });

      return ok(
        clean.length
          ? `Set the status of ${channelLabel(target)} to "${clean}".`
          : `Cleared the status of ${channelLabel(target)}.`,
        {
          channel: { id: target.id, name: target.name },
          status: clean.length ? clean : null,
        }
      );
    })
  );
}
