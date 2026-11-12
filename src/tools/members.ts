import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuildMember, APIRole } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getRoles, getBotUser } from "../discord/guildData.js";
import {
  computeGuildPermissions,
  computeChannelPermissions,
  highestRolePosition,
  describePermissions,
  ALL_PERMISSIONS,
} from "../discord/preflight.js";
import { voiceMembersIn, hasGuildVoiceData } from "../discord/voiceState.js";
import { resolveOne } from "../discord/resolve.js";
import { ok, fail } from "../envelope.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { channelLabel, grantLines, grantPhrase, grantsBetween, grantsKey, hasGrants, permissionsIn } from "../discord/grants.js";
import { CONFIRM_STEPS, hiddenNote, loadScene } from "./grantGate.js";
import { changeData, recordChange, undoNote } from "./changes.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  discordMemberPermissions,
  resolveMember,
  memberDisplayName,
  botPermissions,
  requirePermissions,
  confirmTokenParam,
} from "./common.js";

// Member administration: nickname and voice state edits, removing a role,
// effective-permission inspection, and who is in a voice channel.

const P = PermissionFlagsBits;

export function registerMemberTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "update_member",
    {
      title: "Update member",
      description:
        "Edit a member's nickname or voice state. Voice changes (server " +
        "mute, server deafen, move to another voice channel) only apply " +
        "while the member is connected to voice. Role changes go through " +
        "assign_role and remove_role. Moving someone into a voice channel " +
        "they cannot join themselves lets them hear it, and lifting a server " +
        "mute or deafen undoes what a moderator did, so those need " +
        "confirming: the first call changes nothing and returns a preview " +
        "and a confirm_token, and repeating the call with the token makes " +
        "the change. Everything else, muting and deafening included, " +
        "happens at once.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        nickname: z.string().max(32).optional()
          .describe("New nickname, or empty string to clear it."),
        server_mute: z.boolean().optional(),
        server_deafen: z.boolean().optional(),
        move_to_voice: z.string().optional()
          .describe("Voice channel name or ID to move the member into."),
        reason: z.string().max(400).optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      member,
      guild,
      nickname,
      server_mute,
      server_deafen,
      move_to_voice,
      reason,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      if (
        nickname === undefined &&
        server_mute === undefined &&
        server_deafen === undefined &&
        move_to_voice === undefined
      ) {
        return fail("Pass at least one field to change.");
      }

      const botUser = await getBotUser(rest);
      const isSelf = target.user.id === botUser.id;

      // The bot changing its own nickname goes through the current-member
      // endpoint and needs only Change Nickname; the general member-modify
      // endpoint refuses a self nickname. Voice state on the bot itself is
      // meaningless since the bot is not in voice.
      if (isSelf && nickname !== undefined) {
        requirePermissions(
          await botPermissions(rest, guildId),
          [[P.ChangeNickname, "Change Nickname"]],
          "in this server"
        );
        await rest.patch(Routes.guildMember(guildId, "@me"), {
          body: { nick: nickname },
          reason: reason ?? "Updated via discord-mcp",
        });
        return ok(
          `Updated the bot's nickname` +
            (nickname === "" ? " (cleared)." : ` to "${nickname}".`),
          {
            member: { id: botUser.id, name: "the bot" },
            changed: [nickname === "" ? "nickname cleared" : `nickname to "${nickname}"`],
          }
        );
      }

      const perms = await botPermissions(rest, guildId);
      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      if (nickname !== undefined) {
        requirePermissions(perms, [[P.ManageNicknames, "Manage Nicknames"]], "in this server");
        body.nick = nickname;
        changes.push(nickname === "" ? "nickname cleared" : `nickname to ${quoted(nickname)}`);
      }
      if (server_mute !== undefined) {
        requirePermissions(perms, [[P.MuteMembers, "Mute Members"]], "in this server");
        body.mute = server_mute;
        changes.push(server_mute ? "server muted" : "server unmuted");
      }
      if (server_deafen !== undefined) {
        requirePermissions(perms, [[P.DeafenMembers, "Deafen Members"]], "in this server");
        body.deaf = server_deafen;
        changes.push(server_deafen ? "server deafened" : "server undeafened");
      }
      // What waits for the user, each with the change it accounts for.
      const who = quoted(memberDisplayName(target));
      const asks: Array<{ says: string; change: string }> = [];
      let movedInto: { id: string; name?: string | null } | undefined;
      if (move_to_voice !== undefined) {
        requirePermissions(perms, [[P.MoveMembers, "Move Members"]], "in this server");
        const channel = await resolveChannel(rest, guildId, move_to_voice, [2, 13]);
        body.channel_id = channel.id;
        movedInto = channel;
        const change = `moved to ${quoted(channel.name)}`;
        changes.push(change);

        // The bot can move someone into a channel they could not join on
        // their own; there they hear and see what goes on.
        const scene = await loadScene(rest, guildId, { owner: true });
        const theirs = permissionsIn(scene, { memberId: target.user.id, roleIds: target.roles }, channel);
        if ((theirs & P.Connect) === 0n) {
          asks.push({
            says: `move ${who} into ${channelLabel(channel)}, which they cannot join themselves, so they would hear what is said there`,
            change,
          });
        }
      }
      // A server mute or deafen is something a moderator put on the member.
      // Putting one on happens at once; taking one off is the moderator's
      // decision undone, like lifting a timeout.
      if (server_mute === false && target.mute === true) {
        asks.push({ says: `lift the server mute on ${asks.length ? "them" : who}, so they can speak in voice again`, change: "server unmuted" });
      }
      if (server_deafen === false && target.deaf === true) {
        asks.push({ says: `lift the server deafen on ${asks.length ? "them" : who}, so they can hear voice again`, change: "server undeafened" });
      }
      if (asks.length > 0) {
        const others = changes.filter((c) => !asks.some((a) => a.change === c));
        const gate = gateDestructive({
          tool: "update_member",
          args: {
            member: target.user.id,
            channel: movedInto?.id ?? null,
            nickname: nickname ?? null,
            server_mute: server_mute ?? null,
            server_deafen: server_deafen ?? null,
          },
          confirmToken: confirm_token,
          previewSummary:
            `Would ${asks.map((a) => a.says).join(", and ")}` +
            (others.length > 0 ? `, and make these changes too: ${others.join(", ")}.` : "."),
          previewDetails: {
            member: { id: target.user.id, name: memberDisplayName(target) },
            ...(movedInto ? { channel: { id: movedInto.id, name: movedInto.name } } : {}),
            changes,
          },
        });
        if (gate) return gate;
      }

      await rest.patch(Routes.guildMember(guildId, target.user.id), {
        body,
        reason: reason ?? "Updated via discord-mcp",
      });
      return ok(`Updated ${quoted(memberDisplayName(target))}: ${changes.join(", ")}.`, {
        member: { id: target.user.id, name: memberDisplayName(target) },
        changed: changes,
      });
    })
  );

  server.registerTool(
    "disconnect_member",
    {
      title: "Disconnect member from voice",
      description:
        "Remove a member from whatever voice channel they are in. They " +
        "stay in the server; only the voice connection ends.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ member, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.MoveMembers, "Move Members"]], "in this server");

      await rest.patch(Routes.guildMember(guildId, target.user.id), {
        body: { channel_id: null },
        reason: reason ?? "Disconnected via discord-mcp",
      });
      return ok(`Disconnected ${quoted(memberDisplayName(target))} from voice.`, {
        member: { id: target.user.id, name: memberDisplayName(target) },
      });
    })
  );

  server.registerTool(
    "list_voice_members",
    {
      title: "List voice members",
      description:
        "Who is currently in a voice or stage channel, with their mute " +
        "and deafen state. This reads the live voice presence the gateway " +
        "tracks, so it reflects the time since this server connected.",
      inputSchema: {
        channel: z.string().describe("Voice or stage channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, [2, 13]);

      const warnings: string[] = [];
      if (!hasGuildVoiceData(guildId)) {
        warnings.push(
          "The gateway has not yet reported voice state for this server; " +
            "results may be incomplete until it has been connected briefly."
        );
      }

      const members = voiceMembersIn(guildId, target.id);
      return ok(
        `${members.length} member(s) in ${channelLabel(target)}.`,
        {
          channel: { id: target.id, name: target.name },
          members: members.map((m) => ({
            id: m.user_id,
            name: m.nick ?? m.username ?? m.user_id,
            muted: m.self_mute || m.server_mute,
            deafened: m.self_deaf || m.server_deaf,
          })),
        },
        warnings
      );
    })
  );

  server.registerTool(
    "remove_role",
    {
      title: "Remove role",
      description:
        "Take a role away from a member. Preflights the bot's role " +
        "hierarchy so a failure is an explanation, not a 403. Usually done at " +
        "once. A role can also hold someone back (one that hides channels " +
        "from whoever has it, such as a quarantine role); taking that away " +
        `lets them in, so it needs confirming: ${CONFIRM_STEPS}.`,
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ member, role, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const [target, roles, botUser] = await Promise.all([
        resolveMember(rest, guildId, member),
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);
      if (!target.user) return fail(`Could not load member "${member}".`);

      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const targetRole = roles.find((r) => r.id === resolution.match.id) as APIRole;
      if (!target.roles.includes(targetRole.id)) {
        return ok(
          `${quoted(memberDisplayName(target))} does not have ${quoted(targetRole.name)}. ` +
            "Nothing to do.",
          { already_absent: true }
        );
      }
      if (targetRole.managed) {
        return fail(`${quoted(targetRole.name)} is integration-managed and cannot be removed manually.`);
      }

      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");
      const botTop = highestRolePosition(botMember.roles, roles);
      const warnings: string[] = [];
      if (targetRole.position > botTop) {
        return fail(
          `The bot's highest role (position ${botTop}) is below ` +
            `${quoted(targetRole.name)} (position ${targetRole.position}). Discord ` +
            "will reject this. Move the bot's role higher."
        );
      }
      if (targetRole.position === botTop) {
        warnings.push(
          "The target role shares the bot's highest position; Discord may " +
            "reject the change."
        );
      }

      // A role can deny as well as allow. Without it, the member may see
      // channels the role hid from them, or regain a power it took away.
      const scene = await loadScene(rest, guildId, { owner: true });
      const grants = grantsBetween(
        { scene, holder: { memberId: target.user.id, roleIds: target.roles } },
        { scene, holder: { memberId: target.user.id, roleIds: target.roles.filter((id) => id !== targetRole.id) } }
      );
      if (hasGrants(grants)) {
        const hidden = hiddenNote(rest, guildId, scene);
        const gate = gateDestructive({
          tool: "remove_role",
          args: { member: target.user.id, role: targetRole.id, grants: grantsKey(grants) },
          dryRun: dry_run,
          confirmToken: confirm_token,
          previewSummary:
            `Would take the role ${quoted(targetRole.name)} from ${quoted(memberDisplayName(target))}. ` +
            `That role holds them back: without it they can ${grantPhrase(grants)}.`,
          ...(hidden ? { note: hidden } : {}),
          dialogLines: grantLines(grants),
          previewDetails: {
            member: { id: target.user.id, name: memberDisplayName(target) },
            role: { id: targetRole.id, name: targetRole.name },
            grants: grantLines(grants),
          },
        });
        if (gate) return gate;
      } else if (dry_run) {
        return ok(
          `Dry run: would take ${quoted(targetRole.name)} from ${quoted(memberDisplayName(target))}. Nothing was changed.`,
          { executed: false },
          warnings
        );
      }

      const hadIt = target.roles.includes(targetRole.id);
      await rest.delete(
        Routes.guildMemberRole(guildId, target.user.id, targetRole.id),
        { reason: reason ?? "Removed via discord-mcp" }
      );
      const recorded = hadIt
        ? await recordChange(rest, guildId, "remove_role", [
            {
              op: "member_role",
              change: "removed",
              member: target.user.id,
              memberName: memberDisplayName(target),
              role: targetRole.id,
              name: targetRole.name,
            },
          ])
        : {};
      return ok(
        `Removed ${quoted(targetRole.name)} from ${quoted(memberDisplayName(target))}.` + undoNote(recorded),
        {
          member: { id: target.user.id, name: memberDisplayName(target) },
          role: { id: targetRole.id, name: targetRole.name },
          ...changeData(recorded),
        },
        [...warnings, ...("warning" in recorded && recorded.warning ? [recorded.warning] : [])]
      );
    })
  );

  server.registerTool(
    "get_member_permissions",
    {
      title: "Get member permissions",
      description:
        "The effective permissions a member has, server-wide or in a " +
        "specific channel once role and overwrite resolution is applied, " +
        "in plain language. Uses Discord's own permission check when Discord " +
        "gives one, which includes its implicit rules; source says which.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        channel: z.string().optional()
          .describe("Resolve permissions in this channel instead of server-wide."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ member, guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);
      const [target, roles, guildData] = await Promise.all([
        resolveMember(rest, guildId, member),
        getRoles(rest, guildId),
        rest.get(Routes.guild(guildId)) as Promise<{ owner_id?: string }>,
      ]);
      if (!target.user) return fail(`Could not load member "${member}".`);

      let local: bigint;
      let scope: string;
      let channelId: string | undefined;
      if (channel) {
        const ch = await resolveChannel(rest, guildId, channel);
        local = computeChannelPermissions(
          target.user.id,
          target.roles,
          guildId,
          roles,
          ch.permission_overwrites ?? []
        );
        scope = `in ${channelLabel(ch)}`;
        channelId = ch.id;
      } else {
        local = computeGuildPermissions(target.roles, guildId, roles);
        scope = "server-wide";
      }
      // The owner has every permission whatever their roles say, which the
      // calculation from roles does not know.
      if (guildData.owner_id === target.user.id) local = ALL_PERMISSIONS;

      // Discord's own answer when it gives one; the local calculation is
      // the fallback (see discordMemberPermissions).
      const fromDiscord = await discordMemberPermissions(rest, guildId, target.user.id, channelId);
      const bits = fromDiscord ?? local;
      const isAdmin = (bits & P.Administrator) !== 0n || bits === ALL_PERMISSIONS;
      return ok(
        `${quoted(memberDisplayName(target))} ${scope}: ` +
          (isAdmin
            ? "administrator (every permission)."
            : `${describePermissions(bits).length} permission(s).`),
        {
          member: { id: target.user.id, name: memberDisplayName(target) },
          scope,
          administrator: isAdmin,
          permissions: describePermissions(bits),
          source: fromDiscord !== undefined ? "discord" : "local calculation",
        }
      );
    })
  );
}
