import { z } from "zod";
import { createHash } from "node:crypto";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuildChannel,
  APIGuildMember,
  APIRole,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import {
  getRoles,
  getChannels,
  getBotUser,
  invalidateGuildCaches,
  CHANNEL_TYPE_LABELS,
  type GuildChannelLite,
} from "../discord/guildData.js";
import {
  computeGuildPermissions,
  highestRolePosition,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import { describeRateLimit } from "../discord/client.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import {
  channelLabel,
  describeHierarchyPowers,
  grantLines,
  grantPhrase,
  grantsForGivingRoles,
  grantsForTakingRole,
  hasGrants,
  type HierarchyFlip,
  hierarchyFlips,
  joinWords,
  noGrants,
  simulateRoleOrder,
} from "../discord/grants.js";
import { loadScene } from "./grantGate.js";
import type { RecordEntry } from "../builder/records.js";
import { changeData, recordChange, undoNote } from "./changes.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  botPermissions,
  requirePermissions,
  confirmTokenParam,
} from "./common.js";

// Structural conveniences: cloning channels and roles, reordering, single
// channel detail, announcement following, and a filtered bulk role apply.

const P = PermissionFlagsBits;

// One line per role that rises: who it passes, and what its holders could
// then do to the people whose highest role is one of those.
function flipLines(flips: HierarchyFlip[]): string[] {
  const byRisen = new Map<string, HierarchyFlip[]>();
  for (const f of flips) byRisen.set(f.risen.id, [...(byRisen.get(f.risen.id) ?? []), f]);
  return [...byRisen.values()].map((group) => {
    const risen = group[0].risen;
    const over = group.map((f) => quoted(String(f.over.name ?? f.over.id)));
    return (
      `${quoted(risen.name)} moves above ${joinWords(over)}, so people with ${quoted(risen.name)} could ` +
      `${describeHierarchyPowers(group[0].powers)} people whose highest role is ` +
      `${over.length === 1 ? over[0] : "one of those"}.`
    );
  });
}

export function registerStructureTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "get_channel",
    {
      title: "Get channel",
      description:
        "Full detail for one channel: type, topic, category, slowmode, " +
        "NSFW flag, and a count of its permission overwrites.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      const channels = await getChannels(rest, guildId);
      const parent = ch.parent_id
        ? channels.find((c) => c.id === ch.parent_id)
        : undefined;
      return ok(
        `${channelLabel(ch)}: ${CHANNEL_TYPE_LABELS[ch.type] ?? `type ${ch.type}`}` +
          (parent ? ` in ${quoted(parent.name)}` : "") +
          ".",
        {
          id: ch.id,
          name: ch.name,
          type: CHANNEL_TYPE_LABELS[ch.type] ?? `type ${ch.type}`,
          category: parent ? { id: parent.id, name: parent.name } : null,
          topic: ch.topic ?? null,
          slowmode_seconds: ch.rate_limit_per_user ?? 0,
          nsfw: ch.nsfw ?? false,
          position: ch.position ?? 0,
          overwrite_count: (ch.permission_overwrites ?? []).length,
        }
      );
    })
  );

  server.registerTool(
    "clone_channel",
    {
      title: "Clone channel",
      description:
        "Copy a channel's settings and permission overwrites into a new " +
        "channel in the same category.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID to copy."),
        guild: guildParam,
        new_name: z.string().min(1).max(100).optional()
          .describe("Name for the copy. Defaults to the original plus -copy."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, new_name }) => {
      const { rest, guildId } = await enter(config, guild);
      const src = await resolveChannel(rest, guildId, channel);
      if (src.type === 4) return fail("Clone categories with create_channel instead.");

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], "in this server");

      const full = src as GuildChannelLite & {
        bitrate?: number;
        user_limit?: number;
      };
      const created = (await rest.post(Routes.guildChannels(guildId), {
        body: {
          name: new_name ?? `${src.name}-copy`,
          type: src.type,
          ...(src.parent_id ? { parent_id: src.parent_id } : {}),
          ...(src.topic ? { topic: src.topic } : {}),
          ...(src.rate_limit_per_user
            ? { rate_limit_per_user: src.rate_limit_per_user }
            : {}),
          ...(src.nsfw ? { nsfw: true } : {}),
          ...(full.bitrate ? { bitrate: full.bitrate } : {}),
          ...(full.user_limit ? { user_limit: full.user_limit } : {}),
          ...(src.permission_overwrites
            ? { permission_overwrites: src.permission_overwrites }
            : {}),
        },
        reason: "Cloned via discord-mcp",
      })) as APIGuildChannel;
      invalidateGuildCaches(guildId);
      const recorded = await recordChange(rest, guildId, "clone_channel", [
        { op: "created", kind: created.type === 4 ? "category" : "channel", id: created.id, name: created.name ?? "", channelType: created.type },
      ]);
      return ok(`Cloned ${quoted(src.name)} into ${quoted(created.name)}.` + undoNote(recorded), {
        id: created.id,
        name: created.name,
        ...changeData(recorded),
      });
    })
  );

  server.registerTool(
    "clone_role",
    {
      title: "Clone role",
      description: "Copy a role's permissions, color, and settings into a new role.",
      inputSchema: {
        role: z.string().describe("Role name or ID to copy."),
        guild: guildParam,
        new_name: z.string().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ role, guild, new_name }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const resolution = resolveOne(
        role,
        roles
          .filter((r) => r.id !== guildId)
          .map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const src = roles.find((r) => r.id === resolution.match.id) as APIRole;

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const created = (await rest.post(Routes.guildRoles(guildId), {
        body: {
          name: new_name ?? `${src.name} copy`,
          permissions: src.permissions,
          color: src.color,
          hoist: src.hoist,
          mentionable: src.mentionable,
        },
        reason: "Cloned via discord-mcp",
      })) as APIRole;
      invalidateGuildCaches(guildId);
      const recorded = await recordChange(rest, guildId, "clone_role", [
        { op: "created", kind: "role", id: created.id, name: created.name },
      ]);
      return ok(`Cloned role ${quoted(src.name)} into ${quoted(created.name)}.` + undoNote(recorded), {
        id: created.id,
        name: created.name,
        ...changeData(recorded),
      });
    })
  );

  server.registerTool(
    "reorder_channels",
    {
      title: "Reorder channels",
      description:
        "Move channels to new positions, and optionally into a different " +
        "category, in one call.",
      inputSchema: {
        guild: guildParam,
        moves: z
          .array(
            z.object({
              channel: z.string().describe("Channel name or ID."),
              position: z.number().int().min(0),
              category: z.string().optional()
                .describe("Move under this category, or none for top level."),
            })
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, moves }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], "in this server");

      const body = [];
      for (const move of moves) {
        const ch = await resolveChannel(rest, guildId, move.channel);
        const entry: Record<string, unknown> = { id: ch.id, position: move.position };
        if (move.category !== undefined) {
          entry.parent_id =
            move.category.toLowerCase() === "none"
              ? null
              : (await resolveChannel(rest, guildId, move.category, [4])).id;
        }
        body.push(entry);
      }
      await rest.patch(Routes.guildChannels(guildId), {
        body,
        reason: "Reordered via discord-mcp",
      });
      invalidateGuildCaches(guildId);
      return ok(`Reordered ${moves.length} channel(s).`, { moved: moves.length });
    })
  );

  server.registerTool(
    "reorder_roles",
    {
      title: "Reorder roles",
      description:
        "Move roles to new hierarchy positions in one call. Higher " +
        "positions sit higher in the list and outrank lower ones. Moving a " +
        "role that can ban, kick, time out, rename, or change roles above a " +
        "role it was below lets its holders do that to the people with the " +
        "other role, so that needs confirming: the first call changes " +
        "nothing and returns a preview and a confirm_token, and repeating " +
        "the call with the token makes the change.",
      inputSchema: {
        guild: guildParam,
        moves: z
          .array(
            z.object({
              role: z.string().describe("Role name or ID."),
              position: z.number().int().min(1),
            })
          )
          .min(1),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, moves, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const body = [];
      for (const move of moves) {
        const resolution = resolveOne(
          move.role,
          roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
        );
        if (!("match" in resolution)) {
          return fail(`No single role matches "${move.role}".`);
        }
        body.push({ id: resolution.match.id, position: move.position });
      }

      // A role with powers Discord limits by role order, moving above a role
      // it was below, lets its holders use them on the people with that role.
      const orderBefore = simulateRoleOrder(roles, guildId, []);
      const flips = hierarchyFlips(roles, guildId, orderBefore, simulateRoleOrder(roles, guildId, body));
      const flipKey = (list: HierarchyFlip[]) => list.map((f) => `${f.risen.id}>${f.over.id}`).sort();
      if (flips.length > 0) {
        const lines = flipLines(flips);
        const gate = gateDestructive({
          tool: "reorder_roles",
          args: {
            moves: [...body].sort((a, b) => a.id.localeCompare(b.id)),
            flips: flipKey(flips),
          },
          confirmToken: confirm_token,
          previewSummary:
            lines.length === 1
              ? `Would reorder the roles: ${lines[0]}`
              : `Would reorder the roles so that ${lines.length} roles with moderator powers rise above roles they are below now.`,
          dialogLines: lines.length === 1 ? [] : lines,
          previewDetails: { moves: body, flips: lines },
        });
        if (gate) return gate;
      }

      await rest.patch(Routes.guildRoles(guildId), {
        body,
        reason: "Reordered via discord-mcp",
      });
      invalidateGuildCaches(guildId);

      // Said if Discord placed the roles differently than predicted and a
      // role with such powers passed one it was not shown passing.
      const warnings: string[] = [];
      try {
        const now = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
        const seen = new Set(flipKey(flips));
        const unseen = hierarchyFlips(roles, guildId, orderBefore, simulateRoleOrder(now, guildId, [])).filter(
          (f) => !seen.has(`${f.risen.id}>${f.over.id}`)
        );
        if (unseen.length) {
          warnings.push(`Discord placed the roles differently than expected: ${flipLines(unseen).join(" ")}`);
        }
      } catch {
        // The check is a courtesy; the reorder itself went through.
      }
      return ok(`Reordered ${moves.length} role(s).`, { moved: moves.length }, warnings);
    })
  );

  server.registerTool(
    "follow_announcement_channel",
    {
      title: "Follow announcement channel",
      description:
        "Subscribe a channel to an announcement channel, so crossposted " +
        "messages from the source appear in the target.",
      inputSchema: {
        guild: guildParam,
        source: z.string().describe("Announcement channel name or ID to follow."),
        target: z.string().describe("Channel where its posts should appear."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, source, target }) => {
      const { rest, guildId } = await enter(config, guild);
      const src = await resolveChannel(rest, guildId, source, [5]);
      const dest = await resolveChannel(rest, guildId, target, [0, 5]);
      const perms = await botPermissions(rest, guildId, dest);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], `in ${channelLabel(dest)}`);

      await rest.post(Routes.channelFollowers(src.id), {
        body: { webhook_channel_id: dest.id },
        reason: "Followed via discord-mcp",
      });
      return ok(`${channelLabel(dest)} now follows announcements from ${channelLabel(src)}.`, {
        source: src.id,
        target: dest.id,
      });
    })
  );

  server.registerTool(
    "bulk_update_roles",
    {
      title: "Bulk update roles",
      description:
        "Add or remove a role across every member matching a filter. " +
        "Safe to call directly: the first call returns the affected count " +
        "and a confirm_token; repeating the call with the token applies " +
        "the change. Walks up to 3000 members and reports if it hits the cap.",
      inputSchema: {
        guild: guildParam,
        action: z.enum(["assign", "remove"]),
        role: z.string().describe("Role name or ID."),
        filter: z
          .object({
            has_role: z.string().optional().describe("Members holding this role."),
            is_bot: z.boolean().optional(),
            joined_before: z.string().optional().describe("ISO date."),
            joined_after: z.string().optional().describe("ISO date."),
          })
          .optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, action, role, filter, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const botUser = await getBotUser(rest);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`);
      }
      const targetRole = roles.find((r) => r.id === resolution.match.id) as APIRole;
      if (targetRole.id === guildId) {
        return fail("@everyone is held by every member already and cannot be given or taken.");
      }
      if (targetRole.managed) {
        return fail(`${quoted(targetRole.name)} belongs to an integration and cannot be given or taken by hand.`);
      }
      const botTop = highestRolePosition(botMember.roles, roles);
      // Discord lets a bot hand out only roles strictly below its highest.
      if (targetRole.position >= botTop) {
        return fail(
          `${quoted(targetRole.name)} is not below the bot's highest role, so the bot ` +
            "cannot manage it. Move the bot's role higher."
        );
      }

      let hasRoleId: string | undefined;
      if (filter?.has_role) {
        const hr = resolveOne(
          filter.has_role,
          roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
        );
        if (!("match" in hr)) return fail(`No single role matches "${filter.has_role}".`);
        hasRoleId = hr.match.id;
      }
      // A date that does not parse must stop here: compared against NaN,
      // every member would pass the filter.
      const before = filter?.joined_before ? Date.parse(filter.joined_before) : undefined;
      const after = filter?.joined_after ? Date.parse(filter.joined_after) : undefined;
      for (const [name, value] of [["joined_before", before], ["joined_after", after]] as const) {
        if (value !== undefined && Number.isNaN(value)) {
          return fail(`${name} is not a date. Use ISO 8601, like 2026-11-01 or 2026-11-01T18:00:00Z.`);
        }
      }

      // Walk members up to the cap, applying filters.
      const matched: APIGuildMember[] = [];
      let walkAfter: string | undefined;
      let hitCap = false;
      for (let page = 0; page < 3; page += 1) {
        const params = new URLSearchParams({ limit: "1000" });
        if (walkAfter) params.set("after", walkAfter);
        const batch = (await rest.get(Routes.guildMembers(guildId), {
          query: params,
        })) as APIGuildMember[];
        for (const m of batch) {
          if (!m.user) continue;
          if (filter?.is_bot !== undefined && (m.user.bot ?? false) !== filter.is_bot) continue;
          if (hasRoleId && !m.roles.includes(hasRoleId)) continue;
          const joined = m.joined_at ? new Date(m.joined_at).getTime() : 0;
          if (before !== undefined && joined >= before) continue;
          if (after !== undefined && joined <= after) continue;
          const alreadyHas = m.roles.includes(targetRole.id);
          if (action === "assign" && alreadyHas) continue;
          if (action === "remove" && !alreadyHas) continue;
          matched.push(m);
        }
        if (batch.length < 1000) break;
        walkAfter = batch[batch.length - 1]?.user?.id;
        if (page === 2) hitCap = true;
      }

      const warnings = hitCap
        ? ["Stopped after scanning 3000 members; larger servers need paging."]
        : [];

      // What the change hands the members it touches, judged from the
      // roles each of them holds: a role given can carry powers or open
      // channels, and a role taken away can lift a denial. Said in the
      // preview so it is not approved as a number of members alone.
      let grants = noGrants();
      if (matched.length > 0) {
        const scene = await loadScene(rest, guildId);
        const held = matched.map((m) => m.roles);
        grants =
          action === "assign"
            ? grantsForGivingRoles(scene, [targetRole.id], held)
            : grantsForTakingRole(scene, targetRole.id, held);
      }
      const gate = gateDestructive({
        tool: "bulk_update_roles",
        // Bound to the members themselves, not their number: a different
        // filter that happens to match as many people is a different action.
        args: {
          guild: guildId,
          action,
          role: targetRole.id,
          members: createHash("sha256").update(matched.map((m) => m.user?.id ?? "").sort().join(",")).digest("hex"),
        },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would ${action} the role ${quoted(targetRole.name)} ` +
          `${action === "assign" ? "to" : "from"} ${matched.length} member(s).` +
          (hasGrants(grants)
            ? action === "assign"
              ? ` The role lets them ${grantPhrase(grants)}.`
              : ` Without it they can ${grantPhrase(grants)}.`
            : ""),
        ...(hasGrants(grants) ? { dialogLines: grantLines(grants) } : {}),
        previewDetails: {
          action,
          role: targetRole.name,
          count: matched.length,
          sample: matched.slice(0, 10).map((m) => m.user?.username),
          ...(hasGrants(grants) ? { grants: grantLines(grants) } : {}),
        },
      });
      if (gate) return gate;

      let done = 0;
      let failedCount = 0;
      let firstFailure: string | undefined;
      // Only members whose roles actually changed are recorded, so undo never
      // takes a role from someone who already had it.
      const changedMembers: RecordEntry[] = [];
      for (const m of matched) {
        if (!m.user) continue;
        const had = m.roles.includes(targetRole.id);
        try {
          if (action === "assign") {
            await rest.put(Routes.guildMemberRole(guildId, m.user.id, targetRole.id), {
              reason: "Bulk role via discord-mcp",
            });
          } else {
            await rest.delete(Routes.guildMemberRole(guildId, m.user.id, targetRole.id), {
              reason: "Bulk role via discord-mcp",
            });
          }
          done += 1;
          if ((action === "assign") !== had) {
            changedMembers.push({
              op: "member_role",
              change: action === "assign" ? "added" : "removed",
              member: m.user.id,
              memberName: m.nick ?? m.user.global_name ?? m.user.username,
              role: targetRole.id,
              name: targetRole.name,
            });
          }
        } catch (err) {
          // One member failing (they left mid-run, say) must not stop the
          // rest, but it is counted and said, never passed off as done. A
          // rate limit that will not clear soon stops the run.
          const limited = describeRateLimit(err);
          failedCount += 1;
          firstFailure ??= limited ?? (err instanceof Error ? err.message : String(err));
          if (limited) break;
        }
      }

      const recorded = await recordChange(rest, guildId, "bulk_update_roles", changedMembers);
      const notDone = matched.length - done;
      const summary =
        `${action === "assign" ? "Assigned" : "Removed"} ${quoted(targetRole.name)} ` +
        `${action === "assign" ? "to" : "from"} ${done} of ${matched.length} member(s).` +
        (notDone > 0 ? ` ${notDone} were not changed; the first error was: ${firstFailure}` : "") +
        undoNote(recorded);
      const data = { action, role: targetRole.name, affected: done, failed: notDone, ...changeData(recorded) };
      const notes = [...warnings, ...(recorded.warning ? [recorded.warning] : [])];
      return done === 0 && failedCount > 0 ? fail(summary, data) : ok(summary, data, notes);
    })
  );
}
