import { z } from "zod";
import { quoted } from "../discord/names.js";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuild, APIGuildMember } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getBotUser, getChannels, getRoles, CHANNEL_TYPE_LABELS, type GuildChannelLite } from "../discord/guildData.js";
import { gatewayKeepsCacheFresh } from "../discord/gateway.js";
import { ALL_PERMISSIONS } from "../discord/preflight.js";
import {
  CHANNEL_POWERS,
  channelLabel,
  describePowers,
  joinWords,
  permissionsIn,
  POWER_PERMISSIONS,
  type Scene,
  serverPermissionsOf,
} from "../discord/grants.js";
import {
  auditServer,
  channelAccessByRole,
  countBySeverity,
  type AuditInput,
  type AuditRole,
} from "../discord/audit.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  hiddenChannelSummary,
  memberDisplayName,
  THREAD_TYPES,
  resolveChannel,
  resolveMember,
} from "./common.js";

// Security reads: a whole-server review, who can reach one channel, and
// what one member can reach. Nothing here changes anything.

const P = PermissionFlagsBits;

// Reads that need a permission the bot may not have come back undefined,
// and the report lists what it could not check.
async function maybe<T>(read: Promise<unknown>): Promise<T | undefined> {
  try {
    return (await read) as T;
  } catch {
    return undefined;
  }
}

async function freshRoles(rest: REST, guildId: string): Promise<AuditRole[]> {
  return (await (gatewayKeepsCacheFresh(rest) ? getRoles(rest, guildId) : rest.get(Routes.guildRoles(guildId)))) as AuditRole[];
}

// Every member, a thousand at a time, up to a cap. Needs the Server Members
// intent; undefined when Discord refuses.
const MEMBER_PAGE = 1000;
const MAX_MEMBER_PAGES = 10;
async function allMembers(rest: REST, guildId: string): Promise<{ members: APIGuildMember[]; complete: boolean } | undefined> {
  const members: APIGuildMember[] = [];
  let after = "0";
  try {
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const batch = (await rest.get(Routes.guildMembers(guildId), {
        query: new URLSearchParams({ limit: String(MEMBER_PAGE), after }),
      })) as APIGuildMember[];
      members.push(...batch);
      if (batch.length < MEMBER_PAGE) return { members, complete: true };
      after = batch[batch.length - 1]?.user?.id ?? after;
    }
    return { members, complete: false };
  } catch {
    return undefined;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function registerAuditTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "audit_server_security",
    {
      title: "Audit server security",
      description:
        "Review a server's security the way an attacker would look at it, and " +
        "list findings from high to low with a fix for each: powers held by " +
        "everyone or by everyday roles, roles that can raise their own power " +
        "through Manage Roles, bots with Administrator, powerful roles offered in " +
        "onboarding or handed out by invites, 2FA for moderators, verification, " +
        "the media filter, AutoMod, webhooks, and permanent invites. Read only; " +
        "it changes nothing.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId, guildName } = await enter(config, guild);
      const [info, roles, channels, me] = await Promise.all([
        rest.get(Routes.guild(guildId), { query: new URLSearchParams({ with_counts: "true" }) }) as Promise<APIGuild>,
        freshRoles(rest, guildId),
        getChannels(rest, guildId),
        getBotUser(rest),
      ]);
      const [counts, botMember, onboarding, invites, webhooks, automod] = await Promise.all([
        maybe<Record<string, number>>(rest.get(Routes.guildRoleMemberCounts(guildId))),
        maybe<APIGuildMember>(rest.get(Routes.guildMember(guildId, me.id))),
        maybe<AuditInput["onboarding"]>(rest.get(Routes.guildOnboarding(guildId))),
        maybe<AuditInput["invites"]>(rest.get(Routes.guildInvites(guildId))),
        maybe<AuditInput["webhooks"]>(rest.get(Routes.guildWebhooks(guildId))),
        maybe<AuditInput["automodRules"]>(rest.get(Routes.guildAutoModerationRules(guildId))),
      ]);
      const hidden = hiddenChannelSummary(rest, guildId, channels);
      const report = auditServer({
        guildId,
        guildName,
        ownerId: info.owner_id,
        memberCount: info.approximate_member_count,
        verificationLevel: info.verification_level,
        explicitContentFilter: info.explicit_content_filter,
        mfaLevel: info.mfa_level,
        roles,
        channels,
        roleCounts: counts,
        botUserId: me.id,
        botRoleIds: botMember?.roles ?? [],
        onboarding,
        invites,
        webhooks,
        automodRules: automod,
        hiddenChannels: hidden.count,
      });
      const by = countBySeverity(report.findings);
      const top = report.findings.find((f) => f.severity === "high") ?? report.findings.find((f) => f.severity === "medium");
      const summary =
        `Security review of ${quoted(guildName)}: ${by.high} high, ${by.medium} medium, ${by.low} low, ` +
        `and ${plural(by.info, "note")}.` +
        (top ? ` Most serious: ${top.title}.` : " Nothing serious found.") +
        (report.unchecked.length > 0 ? ` Not checked: ${joinWords(report.unchecked)}.` : "");
      return ok(summary, {
        server: { id: guildId, name: guildName, members: info.approximate_member_count },
        counts: by,
        findings: report.findings,
        checked: report.checked,
        not_checked: report.unchecked,
      });
    })
  );

  server.registerTool(
    "get_channel_access",
    {
      title: "Get channel access",
      description:
        "Who can see and use a channel: @everyone, each role that can see it " +
        "(with how many members hold it, whether they can post or join, and any " +
        "powers there), members with their own overwrite, and the owner. With " +
        "include_members, also checks every member one by one, which is exact " +
        "where roles combine. Read only.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        include_members: z.boolean().optional()
          .describe("Check each member and list who can see it (up to 100 names). Needs the Server Members intent."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, include_members }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);
      if (THREAD_TYPES.includes(target.type)) {
        return fail(
          `${quoted(target.name)} is a thread. Threads follow their parent channel's permissions, and a private ` +
            "thread also needs its members added; ask about the parent channel, and list_thread_members for who is in it."
        );
      }
      const [info, roles, counts] = await Promise.all([
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
        freshRoles(rest, guildId),
        maybe<Record<string, number>>(rest.get(Routes.guildRoleMemberCounts(guildId))),
      ]);
      const scene: Scene = { guildId, ownerId: info.owner_id, roles, channels: [target] };
      const byRole = channelAccessByRole(scene, target, counts);
      const label = channelLabel(target);
      const voice = target.type === 2 || target.type === 13;
      const seeing = byRole.roles.filter((r) => r.see && !r.admin);
      const admins = byRole.roles.filter((r) => r.admin);

      // Members with their own overwrite, named.
      const memberOverwrites = (target.permission_overwrites ?? []).filter((o) => Number(o.type) === 1);
      const personal = await Promise.all(
        memberOverwrites.slice(0, 10).map(async (o) => {
          const m = await maybe<APIGuildMember>(rest.get(Routes.guildMember(guildId, o.id)));
          const perms = m ? permissionsIn(scene, { memberId: o.id, roleIds: m.roles }, target) : undefined;
          return {
            id: o.id,
            name: m ? memberDisplayName(m) : "(not in the server)",
            ...(perms !== undefined ? { see: perms !== 0n } : {}),
          };
        })
      );

      let exact: { can_see: number; checked: number; complete: boolean; names: string[] } | undefined;
      let exactNote: string | undefined;
      if (include_members) {
        const listed = await allMembers(rest, guildId);
        if (!listed) {
          exactNote = "Members could not be listed one by one; the bot may lack the Server Members intent.";
        } else {
          const who = listed.members.filter((m) => m.user && permissionsIn(scene, { memberId: m.user.id, roleIds: m.roles }, target) !== 0n);
          exact = {
            can_see: who.length,
            checked: listed.members.length,
            complete: listed.complete,
            names: who.slice(0, 100).map((m) => memberDisplayName(m)),
          };
          if (!listed.complete) exactNote = `Only the first ${listed.members.length} members were checked.`;
        }
      }

      const verb = voice ? "join" : "post";
      const parts: string[] = [];
      if (byRole.everyone.see) {
        parts.push(`Everyone can see ${label}` + (byRole.everyone.post ? ` and ${verb}` : `, but not ${verb}`));
      } else {
        parts.push(
          `${label} is private: ` +
            (seeing.length > 0
              ? `${joinWords(seeing.slice(0, 6).map((r) => quoted(r.name) + (r.members !== undefined ? ` (${r.members})` : "")))}` +
                (seeing.length > 6 ? ` and ${seeing.length - 6} more roles` : "") +
                " can see it"
              : "no role below Administrator can see it")
        );
      }
      if (admins.length > 0) {
        parts.push(`anyone with ${joinWords(admins.slice(0, 4).map((r) => quoted(r.name)))}${admins.length > 4 ? " and other roles" : ""} (Administrator) sees everything`);
      }
      if (personal.length > 0) parts.push(`${plural(memberOverwrites.length, "member")} ${memberOverwrites.length === 1 ? "has" : "have"} a personal overwrite`);
      if (exact) parts.push(`checked one by one, ${exact.can_see} of ${exact.checked} members can see it`);

      return ok(
        parts.join("; ") + ".",
        {
          channel: { id: target.id, name: target.name, type: CHANNEL_TYPE_LABELS[target.type] ?? `type ${target.type}` },
          everyone: { see: byRole.everyone.see, [verb]: byRole.everyone.post, powers: byRole.everyone.powers },
          roles: seeing.map((r) => ({
            id: r.id,
            name: r.name,
            [verb]: r.post,
            ...(r.powers.length ? { powers: r.powers } : {}),
            ...(r.members !== undefined ? { members: r.members } : {}),
          })),
          administrator_roles: admins.map((r) => ({ id: r.id, name: r.name, ...(r.members !== undefined ? { members: r.members } : {}) })),
          members_with_overwrites: personal,
          owner_id: info.owner_id,
          ...(exact ? { members: exact } : {}),
        },
        [
          ...(byRole.everyone.see || exact
            ? []
            : ["Roles are judged one at a time; someone holding two roles can get what neither gives alone. include_members checks exactly."]),
          ...(memberOverwrites.length > 10 ? [`Only the first 10 of ${memberOverwrites.length} personal overwrites are named.`] : []),
          ...(exactNote ? [exactNote] : []),
        ]
      );
    })
  );

  server.registerTool(
    "get_member_access",
    {
      title: "Get member access",
      description:
        "What one member can reach across the server: their server-wide " +
        "powers, every channel they can see (and whether they can post or join " +
        "there), channels where they hold extra powers, and how many channels " +
        "are closed to them. Read only. For why one permission is or is not " +
        "there, use explain_permissions.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ member, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveMember(rest, guildId, member);
      const [info, roles, channels] = await Promise.all([
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
        freshRoles(rest, guildId),
        getChannels(rest, guildId),
      ]);
      const userId = target.user?.id ?? "";
      const scene: Scene = { guildId, ownerId: info.owner_id, roles, channels };
      const holder = { memberId: userId, roleIds: target.roles };
      const server = serverPermissionsOf(scene, holder);
      const isOwner = userId === info.owner_id;
      const isAdmin = server === ALL_PERMISSIONS;
      const name = memberDisplayName(target);
      const categories = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? c.id]));

      const visible: Array<{ id: string; name: string; type: string; category?: string; post?: boolean; join?: boolean; powers?: string[] }> = [];
      let closed = 0;
      const closedNames: string[] = [];
      for (const c of channels) {
        if (c.type === 4) continue;
        const here = permissionsIn(scene, holder, c as GuildChannelLite);
        if (here === 0n) {
          closed++;
          if (closedNames.length < 50) closedNames.push(c.name ?? c.id);
          continue;
        }
        const voice = c.type === 2 || c.type === 13;
        const extra = isAdmin ? 0n : here & CHANNEL_POWERS & ~server;
        visible.push({
          id: c.id,
          name: c.name ?? c.id,
          type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
          ...(c.parent_id && categories.has(c.parent_id) ? { category: categories.get(c.parent_id) } : {}),
          ...(voice ? { join: (here & P.Connect) !== 0n } : { post: (here & P.SendMessages) !== 0n }),
          ...(extra !== 0n ? { powers: describePowers(extra, "channel") } : {}),
        });
      }
      const powers = describePowers(server & POWER_PERMISSIONS);
      const extraChannels = visible.filter((v) => v.powers);
      const hidden = hiddenChannelSummary(rest, guildId, channels);

      const summary =
        `${quoted(name)}` +
        (isOwner ? " owns the server and" : isAdmin ? " has Administrator and" : "") +
        ` can see ${visible.length} of ${visible.length + closed} channels` +
        (powers.length > 0 && !isAdmin ? `, and server-wide can ${joinWords(powers)}` : "") +
        (extraChannels.length > 0 ? `; extra powers in ${plural(extraChannels.length, "channel")}` : "") +
        ".";
      return ok(
        summary,
        {
          member: { id: userId, name, owner: isOwner, administrator: isAdmin },
          server_powers: powers,
          channels: visible,
          closed: { count: closed, names: closedNames },
        },
        [
          ...(hidden.count ? [`${plural(hidden.count, "channel")} hidden from the bot could not be checked.`] : []),
          ...(closed > closedNames.length ? [`Only the first ${closedNames.length} closed channels are named.`] : []),
        ]
      );
    })
  );
}
