import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuildMember } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getChannels, getRoles, getBotUser, invalidateGuildCaches } from "../discord/guildData.js";
import { gatewayKeepsCacheFresh } from "../discord/gateway.js";
import { sameOverwriteList, type OverwriteLike } from "../builder/categorySync.js";
import { SEND_FAMILY } from "../builder/overwrites.js";
import { clearLock, getLock, saveLock } from "../discord/locks.js";
import type { RecordEntry } from "../builder/records.js";
import { channelNow, changeData, overwriteEntry, recordChange, undoNote } from "./changes.js";
import {
  ALL_PERMISSIONS,
  computeChannelPermissions,
  computeGuildPermissions,
  parsePermissionNames,
  describePermissions,
  listPermissionNames,
  type OverwriteLite,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import {
  grantsBetween,
  grantsForRoleChange,
  grantsKey,
  grantLines,
  grantPhrase,
  hasGrants,
  type Holder,
  type Scene,
  channelLabel,
} from "../discord/grants.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { CONFIRM_STEPS, POWER_EXAMPLES, loadScene, holdersPhrase, roleMemberCount } from "./grantGate.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  memberDisplayName,
  botPermissions,
  requirePermissions,
  discordMemberPermissions,
  confirmTokenParam,
} from "./common.js";

// Standalone channel permission management: read, set, and clear
// overwrites; lock and unlock a channel; and explain why an actor can or
// cannot do something. The builder compiles overwrites during a build;
// these tools manage them piecemeal afterward.

const P = PermissionFlagsBits;
// What a lock denies @everyone: sending, and starting threads. Discord lets
// someone start a thread in a channel they cannot send in (checked live),
// and a thread's name is as good as a message to someone flooding a channel.
const LOCK_BITS = SEND_FAMILY;
// What unlock_channel lifts from a channel no lock is on record for: the
// two denials every earlier version's lock added.
const OLD_LOCK_BITS = P.SendMessages | P.SendMessagesInThreads;

// Who can still post in a locked channel through permissions of their own
// on it, for the result to say. A role's or member's allow beats
// @everyone's deny.
function stillPosting(
  overwrites: Array<{ id: string; type: number; allow: string }>,
  guildId: string,
  roles: Array<{ id: string; name: string }>
): string {
  const allowed = overwrites.filter((o) => o.id !== guildId && (BigInt(o.allow) & P.SendMessages) !== 0n);
  const roleNames = allowed
    .filter((o) => o.type === 0)
    .map((o) => roles.find((r) => r.id === o.id)?.name ?? o.id);
  const members = allowed.filter((o) => o.type === 1).length;
  if (roleNames.length === 0 && members === 0) return "";
  const who = [
    roleNames.length > 0 ? `the role${roleNames.length === 1 ? "" : "s"} ${roleNames.join(", ")}` : "",
    members > 0 ? `${members} member${members === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return ` Their own permissions on this channel still let ${who.join(" and ")} post.`;
}

// What happens on a category, said where a model reads it before calling.
const CATEGORY_NOTE =
  "On a category, Discord also makes the same change in every channel inside " +
  "whose permissions match the category's exactly (synced), as the Discord app " +
  "does; the result names them. To keep such a channel as it is, change that " +
  "channel first, which stops it matching. get_channel_permissions says " +
  "whether a channel is synced.";

type ChannelRef = { id: string; type: number; name?: string | null; parent_id?: string | null };

// The one way a channel is named in a sentence (see channelLabel).
function channelWord(c: { type?: unknown; name?: unknown }): string {
  return channelLabel({ name: c.name === undefined || c.name === null ? "" : String(c.name), type: Number(c.type ?? 0) });
}

const overwritesOf = (c: Record<string, unknown> | undefined) =>
  (c?.permission_overwrites as OverwriteLike[] | undefined) ?? [];

// Changes one channel's overwrites and records the change. Discord applies
// a change to one of a category's overwrites to every channel synced with it
// (the same overwrites exactly), as the Discord app does; these tools keep
// that behavior, and record and name the channels that followed, so undo can
// put each one back. A synced channel edited on its own stops matching its
// category, which later changes to the category then skip; that is said too.
interface Followers {
  before: Record<string, unknown> | undefined;
  followers: Array<Record<string, unknown>>;
  parentBefore?: Record<string, unknown>;
}

// The channel as it is now and, for a category, the channels synced with it,
// read fresh: these are the ones a change to one of its overwrites reaches.
async function findFollowers(rest: REST, guildId: string, ch: ChannelRef): Promise<Followers> {
  const before = await channelNow(rest, ch.id);
  if (ch.type === 4) {
    if (!gatewayKeepsCacheFresh(rest)) invalidateGuildCaches(guildId);
    const children = (await getChannels(rest, guildId)).filter((c) => c.parent_id === ch.id && c.type !== 4);
    const now = await Promise.all(children.map((c) => channelNow(rest, c.id)));
    const followers = now.filter(
      (c): c is Record<string, unknown> => c !== undefined && sameOverwriteList(overwritesOf(c), overwritesOf(before))
    );
    return { before, followers };
  }
  return { before, followers: [], ...(ch.parent_id ? { parentBefore: await channelNow(rest, ch.parent_id) } : {}) };
}

async function editOverwrites(
  rest: REST,
  guildId: string,
  ch: ChannelRef,
  tool: string,
  write: () => Promise<void>,
  found?: Followers
): Promise<{ recorded: { changeId?: string }; followed: Array<{ id: string; name: string }>; notes: string[] }> {
  const { before, followers, parentBefore } = found ?? (await findFollowers(rest, guildId, ch));

  await write();
  invalidateGuildCaches(guildId);

  const after = await channelNow(rest, ch.id);
  const entries: RecordEntry[] = [];
  const own = overwriteEntry(before, after);
  if (own) entries.push(own);
  const followed: Array<{ id: string; name: string }> = [];
  for (const f of followers) {
    const fAfter = await channelNow(rest, String(f.id));
    const entry = overwriteEntry(f, fAfter);
    if (!entry) continue;
    entries.push(entry);
    followed.push({ id: String(f.id), name: String(f.name ?? f.id) });
  }
  const notes: string[] = [];
  if (followed.length > 0) {
    notes.push(
      `Discord applied the same change to the ${followed.length} channel(s) synced with it ` +
        `(the same permissions exactly): ${followers.filter((f) => followed.some((x) => x.id === f.id)).map(channelWord).join(", ")}.`
    );
  }
  if (
    parentBefore &&
    sameOverwriteList(overwritesOf(before), overwritesOf(parentBefore)) &&
    !sameOverwriteList(overwritesOf(after), overwritesOf(parentBefore))
  ) {
    notes.push(
      `It no longer matches the permissions of its category, ${quoted(String(parentBefore.name))}, so later changes to the category will not reach it.`
    );
  }
  const recorded = await recordChange(rest, guildId, tool, entries);
  return { recorded, followed, notes };
}

// Resolves a permission target to its overwrite id and type (0 role, 1
// member), accepting role or member references.
interface OverwriteTarget {
  id: string;
  type: 0 | 1;
  label: string;
  holder: Holder;
  // Who gets what, as a preview says it: "everyone", "people with the role
  // Helpers", or a member's name.
  who: string;
  roleId?: string;
}

async function resolveOverwriteTarget(
  rest: REST,
  guildId: string,
  ref: string
): Promise<OverwriteTarget> {
  const roles = await getRoles(rest, guildId);
  const roleMatch = resolveOne(
    ref,
    roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
  );
  if ("match" in roleMatch) {
    const id = roleMatch.match.id;
    const everyone = id === guildId;
    return {
      id,
      type: 0,
      label: everyone ? "role @everyone" : `role ${quoted(roleMatch.match.name)}`,
      // Used for a member target only; a role is judged across the role
      // sets its holders may have (see overwriteGrants).
      holder: { roleIds: everyone ? [] : [id] },
      who: everyone ? "everyone" : `people with the role ${quoted(roleMatch.match.name)}`,
      ...(everyone ? {} : { roleId: id }),
    };
  }
  const member = await resolveMember(rest, guildId, ref);
  if (member.user) {
    return {
      id: member.user.id,
      type: 1,
      label: `member ${quoted(memberDisplayName(member))}`,
      holder: { memberId: member.user.id, roleIds: member.roles },
      who: quoted(memberDisplayName(member)),
    };
  }
  throw new Error(`Could not resolve "${ref}" to a role or member.`);
}

// What replacing the target's overwrite on a channel, and on the channels
// synced with it, hands the target: powers there, or the channel itself.
// `next` is the target's new overwrite, or undefined when it is cleared.
async function overwriteGrants(
  rest: REST,
  guildId: string,
  ch: ChannelRef,
  target: OverwriteTarget,
  next: OverwriteLike | undefined,
  found: Followers
) {
  const scene = await loadScene(rest, guildId, { owner: target.type === 1 });
  // The channel as read just now, or as resolved if that read failed: the
  // check must never come out empty for want of it.
  const self = found.before ?? (ch as unknown as Record<string, unknown>);
  const touched = [self, ...found.followers];
  const fresh = new Map(touched.map((c) => [String(c.id), c]));
  const lite = (list: OverwriteLike[]): OverwriteLite[] =>
    list.map((o) => ({ id: o.id, type: Number(o.type), allow: String(o.allow), deny: String(o.deny) }));
  const replace = (list: OverwriteLite[]) => [...list.filter((o) => o.id !== target.id), ...(next ? lite([next]) : [])];
  const now: Scene = {
    ...scene,
    channels: scene.channels.map((c) => {
      const f = fresh.get(c.id);
      return f ? { ...c, permission_overwrites: lite(overwritesOf(f)) } : c;
    }),
  };
  const changed: Scene = {
    ...now,
    channels: now.channels.map((c) =>
      fresh.has(c.id) ? { ...c, permission_overwrites: replace(c.permission_overwrites ?? []) } : c
    ),
  };
  // A member is judged as they are. A role is judged held alone and next to
  // each other role, since what its holders can see often comes from another
  // role they all have.
  if (target.type === 1) {
    return grantsBetween({ scene: now, holder: target.holder }, { scene: changed, holder: target.holder }, fresh.keys());
  }
  return grantsForRoleChange(now, changed, target.roleId, fresh.keys());
}

// The confirmation for an overwrite change that hands out power or access;
// null when the change hands out neither and goes ahead as before.
async function gateOverwrite(
  rest: REST,
  guildId: string,
  ch: ChannelRef,
  tool: string,
  target: OverwriteTarget,
  next: OverwriteLike | undefined,
  found: Followers,
  confirmToken: string | undefined,
  what: string
) {
  const grants = await overwriteGrants(rest, guildId, ch, target, next, found);
  if (!hasGrants(grants)) return null;
  const follow = found.followers.length
    ? ` Discord makes the same change in the ${found.followers.length} channel(s) synced with it: ` +
      `${found.followers.map(channelWord).join(", ")}.`
    : "";
  const holders = target.roleId ? holdersPhrase(await roleMemberCount(rest, guildId, target.roleId)) : "";
  return gateDestructive({
    tool,
    args: {
      channel: ch.id,
      target: target.id,
      overwrite: next ? `${next.allow}/${next.deny}` : null,
      followers: found.followers.map((f) => String(f.id)).sort(),
      grants: grantsKey(grants),
    },
    confirmToken,
    previewSummary: `Would let ${target.who} ${grantPhrase(grants)}.${follow}${holders}`,
    note: what,
    dialogLines: grantLines(grants),
    previewDetails: { channel: { id: ch.id, name: ch.name }, target: target.who, grants: grantLines(grants) },
  });
}

export function registerPermissionTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "get_channel_permissions",
    {
      title: "Get channel permissions",
      description:
        "The permission overwrites on a channel, resolved into plain " +
        "language per role and member.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);
      const roles = await getRoles(rest, guildId);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));

      const overwrites = (target.permission_overwrites ?? []).map((ow) => ({
        target:
          ow.type === 0
            ? `role ${ow.id === guildId ? "@everyone" : roleNames.get(ow.id) ?? ow.id}`
            : `member ${ow.id}`,
        allow: describePermissions(BigInt(ow.allow)),
        deny: describePermissions(BigInt(ow.deny)),
      }));

      // Whether it follows its category: a change to one of the category's
      // permissions reaches every channel that matches them exactly.
      let synced: boolean | undefined;
      let parentName: string | undefined;
      if (target.parent_id && target.type !== 4) {
        const parent = await channelNow(rest, target.parent_id);
        if (parent) {
          synced = sameOverwriteList(target.permission_overwrites, overwritesOf(parent));
          parentName = String(parent.name ?? target.parent_id);
        }
      }
      return ok(
        `${overwrites.length} permission overwrite(s) on ${channelWord(target)}.` +
          (synced === true
            ? ` It matches the permissions of its category, ${parentName}, exactly (synced), so a change to the category's permissions reaches it too.`
            : synced === false
              ? ` It has permissions of its own, so changes to the permissions of its category, ${parentName}, do not reach it.`
              : ""),
        {
          channel: { id: target.id, name: target.name },
          overwrites,
          ...(synced !== undefined ? { synced_with_category: synced, category: parentName } : {}),
        }
      );
    })
  );

  server.registerTool(
    "set_channel_permissions",
    {
      title: "Set channel permissions",
      description:
        "Set a permission overwrite on a channel for one role or member: " +
        "which permissions are explicitly allowed and which are denied. " +
        "It replaces that role's or member's whole overwrite on the channel, " +
        "so list every permission it should keep, not only the new one; " +
        "get_channel_permissions shows the current one. Permission names " +
        "like manage_messages or send_messages. " + CATEGORY_NOTE + " A " +
        "change that would let someone see a channel they cannot see now, or " +
        `give them ${POWER_EXAMPLES} there, needs confirming: ${CONFIRM_STEPS}.`,
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        target: z.string().describe("Role or member name or ID."),
        allow: z.array(z.string()).optional().describe("Permissions to allow."),
        deny: z.array(z.string()).optional().describe("Permissions to deny."),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, target, allow, deny, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      if (!allow?.length && !deny?.length) {
        return fail("Pass allow and/or deny permission names.");
      }

      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${channelWord(ch)}`);

      const allowParsed = parsePermissionNames(allow ?? []);
      const denyParsed = parsePermissionNames(deny ?? []);
      const unknown = [...allowParsed.unknown, ...denyParsed.unknown];
      if (unknown.length > 0) {
        return fail(`Unknown permission name(s): ${unknown.join(", ")}.`, {
          valid_names: listPermissionNames(),
        });
      }

      const resolved = await resolveOverwriteTarget(rest, guildId, target);
      // The overwrite is replaced whole, so anything it had that the new one
      // does not list is gone. Said, since models tend to list only the change.
      const previous = (ch.permission_overwrites ?? []).find((o) => o.id === resolved.id);
      const droppedAllow = BigInt(previous?.allow ?? 0) & ~allowParsed.bits & ~denyParsed.bits;
      const droppedDeny = BigInt(previous?.deny ?? 0) & ~denyParsed.bits & ~allowParsed.bits;
      const dropped = [
        droppedAllow ? `no longer allows ${describePermissions(droppedAllow).join(", ")}` : "",
        droppedDeny ? `no longer denies ${describePermissions(droppedDeny).join(", ")}` : "",
      ].filter(Boolean);
      const found = await findFollowers(rest, guildId, ch);
      const next = {
        id: resolved.id,
        type: resolved.type,
        allow: allowParsed.bits.toString(),
        deny: denyParsed.bits.toString(),
      };
      const gate = await gateOverwrite(
        rest,
        guildId,
        ch,
        "set_channel_permissions",
        resolved,
        next,
        found,
        confirm_token,
        `It sets the overwrite for ${resolved.label} on ${channelWord(ch)}` +
          (dropped.length ? `, which ${dropped.join(" and ")} for them.` : ".")
      );
      if (gate) return gate;
      const { recorded, followed, notes } = await editOverwrites(rest, guildId, ch, "set_channel_permissions", async () => {
        await rest.put(Routes.channelPermission(ch.id, resolved.id), {
          body: {
            type: resolved.type,
            allow: allowParsed.bits.toString(),
            deny: denyParsed.bits.toString(),
          },
          reason: "Overwrite set via discord-mcp",
        });
      }, found);
      return ok(
        `Set the overwrite for ${resolved.label} on ${channelWord(ch)}.` +
          (dropped.length
            ? ` It replaced the whole overwrite, so it ${dropped.join(" and ")} for ${resolved.label}; ` +
              "set it again listing those too if that was not intended."
            : "") +
          (notes.length ? ` ${notes.join(" ")}` : "") +
          undoNote(recorded),
        {
          channel: { id: ch.id, name: ch.name },
          target: resolved.label,
          allow: describePermissions(allowParsed.bits),
          deny: describePermissions(denyParsed.bits),
          ...(dropped.length
            ? { removed: { allow: describePermissions(droppedAllow), deny: describePermissions(droppedDeny) } }
            : {}),
          ...(followed.length ? { followed_by_synced_channels: followed } : {}),
          ...changeData(recorded),
        }
      );
    })
  );

  server.registerTool(
    "clear_channel_permissions",
    {
      title: "Clear channel permissions",
      description:
        "Remove a role's or member's permission overwrite from a channel, " +
        "so their permissions there come from their roles and the other " +
        "overwrites. " + CATEGORY_NOTE + " Removing one that keeps someone " +
        "out (a private channel's denial for @everyone, say) needs " +
        `confirming, as does one whose removal gives ${POWER_EXAMPLES}: ${CONFIRM_STEPS}.`,
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        target: z.string().describe("Role or member name or ID."),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, target, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${channelWord(ch)}`);

      const resolved = await resolveOverwriteTarget(rest, guildId, target);
      const found = await findFollowers(rest, guildId, ch);
      const gate = await gateOverwrite(
        rest,
        guildId,
        ch,
        "clear_channel_permissions",
        resolved,
        undefined,
        found,
        confirm_token,
        `It removes the overwrite for ${resolved.label} on ${channelWord(ch)}.`
      );
      if (gate) return gate;
      const { recorded, followed, notes } = await editOverwrites(rest, guildId, ch, "clear_channel_permissions", async () => {
        await rest.delete(Routes.channelPermission(ch.id, resolved.id), {
          reason: "Overwrite cleared via discord-mcp",
        });
      }, found);
      return ok(
        `Cleared the overwrite for ${resolved.label} on ${channelWord(ch)}.` +
          (notes.length ? ` ${notes.join(" ")}` : "") +
          undoNote(recorded),
        {
          cleared: true,
          ...(followed.length ? { followed_by_synced_channels: followed } : {}),
          ...changeData(recorded),
        }
      );
    })
  );

  server.registerTool(
    "lock_channel",
    {
      title: "Lock channel",
      description:
        "Lock a channel by denying everyone the ability to send messages " +
        "and start threads. Roles and members with their own permission to " +
        "post on the channel keep it, so moderators set up that way keep " +
        "access; the result names them. Reverse with unlock_channel, which " +
        "puts back exactly what the lock changed.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [0, 5, 15]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${channelWord(ch)}`);

      // Discord lets a bot deny only permissions it holds in the server.
      const held = await botPermissions(rest, guildId);
      const lockable = LOCK_BITS & held;
      if ((lockable & P.SendMessages) === 0n) {
        return fail(
          `The bot does not have Send Messages in this server, and Discord lets a bot deny only permissions it holds, so it cannot lock ${channelLabel(ch)}.`
        );
      }
      const overwrites = ch.permission_overwrites ?? [];
      const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
      const allowNow = BigInt(everyone?.allow ?? 0);
      const denyNow = BigInt(everyone?.deny ?? 0);
      // An allow beats a deny inside one overwrite, so an allowance left in
      // place would leave the channel open however much is denied.
      const unallowed = allowNow & lockable;
      const denied = lockable & ~denyNow;
      const others = stillPosting(overwrites, guildId, await getRoles(rest, guildId));
      const left = LOCK_BITS & ~lockable;
      const leftNote =
        left !== 0n
          ? ` The bot lacks ${describePermissions(left).join(", ")} itself, so it could not deny that.`
          : "";

      if (unallowed === 0n && denied === 0n) {
        // Closed already. Remembered as a lock that changed nothing, so a
        // later unlock leaves it closed instead of opening a channel that
        // was read-only on purpose. An earlier lock's record is kept:
        // saveLock adds to it.
        saveLock(guildId, ch.id, { denied: 0n, unallowed: 0n });
        return ok(
          `${channelLabel(ch)} was already closed to posting, so nothing was changed, and unlock_channel will leave it closed.` + others + leftNote,
          { locked: true, changed: false, channel: { id: ch.id, name: ch.name } }
        );
      }

      const { recorded, notes } = await editOverwrites(rest, guildId, ch, "lock_channel", async () => {
        await rest.put(Routes.channelPermission(ch.id, guildId), {
          body: { type: 0, allow: (allowNow & ~lockable).toString(), deny: (denyNow | lockable).toString() },
          reason: reason ?? "Locked via discord-mcp",
        });
        // Remembered the moment Discord accepts it. The bookkeeping after
        // this can fail on its own, and a lock nobody remembers cannot be
        // undone exactly.
        saveLock(guildId, ch.id, { denied, unallowed });
      });
      return ok(
        `Locked ${channelLabel(ch)}; everyone is denied sending messages and starting threads.` +
          (unallowed !== 0n
            ? " Everyone had been allowed to post here by the channel's own permissions; that is off while it is locked, and unlock_channel puts it back."
            : "") +
          others +
          leftNote +
          (notes.length ? ` ${notes.join(" ")}` : "") +
          undoNote(recorded),
        {
          locked: true,
          changed: true,
          channel: { id: ch.id, name: ch.name },
          ...changeData(recorded),
        }
      );
    })
  );

  server.registerTool(
    "unlock_channel",
    {
      title: "Unlock channel",
      description:
        "Reverse lock_channel: lift the denials the lock added and put back " +
        "what it took off, leaving alone anything that was denied before the " +
        "lock. A channel that was read-only before it was locked stays " +
        "read-only. On a channel no lock is on record for, it would remove " +
        "everyone's denial on sending, which may be there on purpose, so " +
        `that needs confirming: ${CONFIRM_STEPS}.`,
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, reason, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [0, 5, 15]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${channelWord(ch)}`);

      const everyone = (ch.permission_overwrites ?? []).find(
        (o) => o.type === 0 && o.id === guildId
      );
      const allowNow = BigInt(everyone?.allow ?? 0);
      const denyNow = BigInt(everyone?.deny ?? 0);
      const lock = getLock(guildId, ch.id);

      // What to lift and what to give back. With a lock on record, exactly
      // what that lock changed, where it is still in place. Without one,
      // the denials every earlier version's lock added.
      let lift: bigint;
      let giveBack = 0n;
      if (lock) {
        lift = lock.denied & denyNow;
        // The allowance goes back only if the lock's denial is still whole:
        // if someone lifted part of it by hand, the channel is theirs now.
        if (lift === lock.denied) giveBack = lock.unallowed & ~allowNow;
      } else {
        lift = OLD_LOCK_BITS & denyNow;
      }

      if (lift === 0n && giveBack === 0n) {
        if (lock) clearLock(guildId, ch.id);
        const closed = (denyNow & P.SendMessages) !== 0n && (allowNow & P.SendMessages) === 0n;
        return ok(
          lock && closed
            ? `${channelLabel(ch)} was closed to posting before it was locked, so it stays closed. To open it to everyone, use set_channel_permissions.`
            : `${channelLabel(ch)} is not locked, so nothing was changed.`,
          { locked: closed, changed: false, channel: { id: ch.id, name: ch.name } }
        );
      }

      // With no lock on record, nothing says this denial came from a lock: a
      // rules or announcements channel is closed the same way, on purpose.
      // Lifting it opens the channel to everyone, so the user is asked.
      if (!lock) {
        const gate = gateDestructive({
          tool: "unlock_channel",
          args: { channel: ch.id, lift: lift.toString() },
          confirmToken: confirm_token,
          previewSummary:
            `No lock made here is on record for ${channelLabel(ch)}, so the denial on sending that everyone has there ` +
            "may be on purpose, as on a rules or announcements channel. Would remove it: everyone it holds " +
            `back could post in ${channelLabel(ch)}.`,
          previewDetails: { channel: { id: ch.id, name: ch.name }, lock_on_record: false },
        });
        if (gate) return gate;
      }

      const { recorded, notes } = await editOverwrites(rest, guildId, ch, "unlock_channel", async () => {
        await rest.put(Routes.channelPermission(ch.id, guildId), {
          body: { type: 0, allow: (allowNow | giveBack).toString(), deny: (denyNow & ~lift).toString() },
          reason: reason ?? "Unlocked via discord-mcp",
        });
        if (lock) clearLock(guildId, ch.id);
      });
      const stillDenied = ((denyNow & ~lift) & P.SendMessages) !== 0n && ((allowNow | giveBack) & P.SendMessages) === 0n;
      return ok(
        `Unlocked ${channelLabel(ch)}.` +
          (giveBack !== 0n ? " Everyone's own permission to post here, which the lock had taken off, is back." : "") +
          (stillDenied ? " Everyone is still denied sending there by a denial from before the lock." : "") +
          (!lock
            ? " No lock was on record for it here, so the denial may have been there on purpose; everyone it held back can post there now."
            : "") +
          (notes.length ? ` ${notes.join(" ")}` : "") +
          undoNote(recorded),
        {
          locked: stillDenied,
          changed: true,
          channel: { id: ch.id, name: ch.name },
          ...changeData(recorded),
        }
      );
    })
  );

  server.registerTool(
    "explain_permissions",
    {
      title: "Explain permissions",
      description:
        "Answer whether an actor (the bot, or a member) has a given " +
        "permission, server-wide or in a channel, and explain the result " +
        "through the role and overwrite chain. The answer is Discord's own " +
        "permission check when Discord gives one, so it includes the implicit " +
        "rules (a missing View Channel cancels what depends on it).",
      inputSchema: {
        actor: z.string().describe('A member name or ID, or "bot".'),
        permission: z.string().describe("Permission name, like manage_messages."),
        guild: guildParam,
        channel: z.string().optional()
          .describe("Check in this channel instead of server-wide."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ actor, permission, guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);

      const parsed = parsePermissionNames([permission]);
      if (parsed.unknown.length > 0) {
        return fail(`Unknown permission "${permission}".`, {
          valid_names: listPermissionNames(),
        });
      }
      const wanted = parsed.bits;

      let actorId: string;
      let actorRoleIds: string[];
      let actorLabel: string;
      if (actor.toLowerCase() === "bot") {
        const botUser = await getBotUser(rest);
        const botMember = (await rest.get(
          Routes.guildMember(guildId, botUser.id)
        )) as APIGuildMember;
        actorId = botUser.id;
        actorRoleIds = botMember.roles;
        actorLabel = "the bot";
      } else {
        const member = await resolveMember(rest, guildId, actor);
        if (!member.user) return fail(`Could not load member "${actor}".`);
        actorId = member.user.id;
        actorRoleIds = member.roles;
        actorLabel = memberDisplayName(member);
      }

      let local: bigint;
      let scope: string;
      let overwrites: OverwriteLite[] = [];
      let channelId: string | undefined;
      if (channel) {
        const ch = await resolveChannel(rest, guildId, channel);
        overwrites = (ch.permission_overwrites ?? []) as OverwriteLite[];
        local = computeChannelPermissions(actorId, actorRoleIds, guildId, roles, overwrites);
        scope = `in ${channelLabel(ch)}`;
        channelId = ch.id;
      } else {
        local = computeGuildPermissions(actorRoleIds, guildId, roles);
        scope = "server-wide";
      }

      // The owner has every permission whatever their roles say. The
      // calculation from roles does not know that: as the fallback it
      // answered no for an owner, and as the explanation it credited a role.
      const isOwner =
        ((await rest.get(Routes.guild(guildId))) as { owner_id?: string }).owner_id === actorId;
      if (isOwner) local = ALL_PERMISSIONS;

      // Discord's own answer when it gives one; the local calculation
      // explains it and is the fallback (see discordMemberPermissions).
      const fromDiscord = await discordMemberPermissions(rest, guildId, actorId, channelId);
      const effective = fromDiscord ?? local;
      const has = (effective & wanted) === wanted;
      const localHas = (local & wanted) === wanted;
      const isAdmin =
        (computeGuildPermissions(actorRoleIds, guildId, roles) & P.Administrator) !== 0n;

      let reason: string;
      if (has && isOwner) {
        reason = "They own the server, and the owner has every permission.";
      } else if (has && isAdmin) {
        reason = "Administrator grants every permission.";
      } else if (has) {
        reason = `A role or channel overwrite grants ${permission} ${scope}.`;
      } else if (localHas && channel) {
        // The roles and overwrites grant it, yet Discord says no: one of its
        // implicit rules applies.
        reason =
          `The roles and overwrites grant ${permission}, but Discord's own check says no: ` +
          "in a channel, missing View Channel (or Connect, in a voice or stage channel) " +
          "cancels the permissions that depend on it.";
      } else {
        reason =
          `No role grants ${permission}` +
          (channel ? " and no channel overwrite adds it" : "") +
          (channel ? ", or an overwrite denies it." : ".");
      }

      return ok(
        `${actor.toLowerCase() === "bot" ? actorLabel : quoted(actorLabel)} ${has ? "has" : "does not have"} ${permission} ${scope}. ${reason}`,
        {
          actor: actorLabel,
          permission,
          scope,
          allowed: has,
          administrator: isAdmin,
          ...(isOwner ? { owner: true } : {}),
          source: fromDiscord !== undefined ? "discord" : "local calculation",
        }
      );
    })
  );
}
