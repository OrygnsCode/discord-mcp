import { plainText, quoted } from "./names.js";
import { createHash } from "node:crypto";
import { PermissionFlagsBits } from "discord-api-types/v10";
import {
  ALL_PERMISSIONS,
  compareRolesLowToHigh,
  computeChannelPermissions,
  computeGuildPermissions,
  type OverwriteLite,
  type RoleLite,
} from "./preflight.js";

// What a change hands out: power over other people and the things they
// made, and access to channels someone cannot see now. Deletes, bans, and
// kicks already wait for the user's confirmation; these are the changes a
// misled model could make instead that are worse than a delete, since a
// new moderator can delete and ban by hand, outside any confirmation, and
// what someone read in a channel opened by mistake cannot be taken back.
// Kept pure, like preflight.ts, so it is tested without a network.

const P = PermissionFlagsBits;

// Power over other people, what they made, or the server itself. The
// member preset holds none of them, so ordinary roles never count.
export const POWER_PERMISSIONS =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageWebhooks |
  P.BanMembers |
  P.KickMembers |
  P.ModerateMembers |
  P.ManageMessages |
  P.ManageThreads |
  P.ManageGuildExpressions |
  P.ManageEvents |
  P.MentionEveryone |
  P.ManageNicknames |
  P.MuteMembers |
  P.DeafenMembers |
  P.MoveMembers;

// The ones that mean something in a single channel. The rest (ban, kick,
// time out, managing the server, nicknames, expressions) only ever apply
// server-wide, whatever a channel overwrite says.
export const CHANNEL_POWERS =
  P.ManageChannels |
  P.ManageRoles |
  P.ManageWebhooks |
  P.ManageMessages |
  P.ManageThreads |
  P.ManageEvents |
  P.MentionEveryone |
  P.MuteMembers |
  P.DeafenMembers |
  P.MoveMembers;

// The powers Discord limits by role order: they reach only members whose
// highest role is lower than the holder's.
export const HIERARCHY_PERMISSIONS =
  P.Administrator | P.ManageRoles | P.KickMembers | P.BanMembers | P.ModerateMembers | P.ManageNicknames;

// Plain words, scariest first. Ban, kick, and time out share an object and
// are said together: "ban, kick, and time out members".
const MEMBER_VERBS: Array<[bigint, string]> = [
  [P.BanMembers, "ban"],
  [P.KickMembers, "kick"],
  [P.ModerateMembers, "time out"],
];
const SERVER_WORDS: Array<[bigint, string]> = [
  [P.ManageGuild, "manage the server"],
  [P.ManageRoles, "manage roles"],
  [P.ManageChannels, "manage channels"],
  [P.ManageWebhooks, "manage webhooks"],
  [P.ManageMessages, "delete other people's messages"],
  [P.ManageThreads, "manage and delete threads"],
  [P.ManageGuildExpressions, "remove emojis, stickers, and sounds"],
  [P.ManageEvents, "manage events"],
  [P.MentionEveryone, "mention @everyone"],
  [P.ManageNicknames, "change other people's nicknames"],
  [P.MuteMembers, "server-mute people"],
  [P.DeafenMembers, "server-deafen people"],
  [P.MoveMembers, "move people between voice channels"],
];

// In one channel, Manage Roles and Manage Channels mean that channel.
const CHANNEL_WORDS: Array<[bigint, string]> = [
  [P.ManageRoles, "change its permissions"],
  [P.ManageChannels, "edit or delete it"],
  [P.ManageWebhooks, "manage its webhooks"],
  [P.ManageMessages, "delete other people's messages"],
  [P.ManageThreads, "manage and delete threads"],
  [P.ManageEvents, "manage events"],
  [P.MentionEveryone, "mention @everyone"],
  [P.MuteMembers, "server-mute people"],
  [P.DeafenMembers, "server-deafen people"],
  [P.MoveMembers, "move people between voice channels"],
];

export function describePowers(bits: bigint, scope: "server" | "channel" = "server"): string[] {
  if ((bits & P.Administrator) !== 0n) return ["administrator, which allows everything"];
  const pick = (words: Array<[bigint, string]>) => words.filter(([bit]) => (bits & bit) !== 0n).map(([, w]) => w);
  if (scope === "channel") return pick(CHANNEL_WORDS);
  const verbs = pick(MEMBER_VERBS);
  return [...(verbs.length ? [`${joinWords(verbs)} members`] : []), ...pick(SERVER_WORDS)];
}

export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

export interface ChannelLite {
  id: string;
  name?: string | null;
  type: number;
  parent_id?: string | null;
  permission_overwrites?: OverwriteLite[];
}

// A server as far as permissions go.
export interface Scene {
  guildId: string;
  ownerId?: string;
  roles: RoleLite[];
  channels: ChannelLite[];
}

// Whose permissions: a member (with their roles), or anyone holding these
// roles and nothing else (memberId absent), which is how a role, or
// everyone, is judged.
export interface Holder {
  memberId?: string;
  roleIds: string[];
}

export interface ChannelRef {
  id: string;
  name: string;
  type: number;
}

export interface Grants {
  // Powers gained server-wide. Administrator stands alone: it implies all.
  server: bigint;
  // Powers gained in single channels the holder could already see.
  channels: Array<ChannelRef & { bits: bigint }>;
  // Channels they could not see before and could after.
  see: ChannelRef[];
  // Channels they could see but not read back, and could read back after.
  history: ChannelRef[];
  // Voice and stage channels they could not join before and could after.
  join: ChannelRef[];
}

export function noGrants(server = 0n): Grants {
  return { server, channels: [], see: [], history: [], join: [] };
}

const VOICE_TYPES = new Set([2, 13]);

function refOf(c: ChannelLite): ChannelRef {
  return { id: c.id, name: c.name ?? c.id, type: c.type };
}

export function serverPermissionsOf(scene: Scene, holder: Holder): bigint {
  if (holder.memberId && holder.memberId === scene.ownerId) return ALL_PERMISSIONS;
  return computeGuildPermissions(holder.roleIds, scene.guildId, scene.roles);
}

// What the holder can do in a channel, with Discord's first implicit rule:
// without View Channel, nothing else there counts.
export function permissionsIn(scene: Scene, holder: Holder, channel: ChannelLite): bigint {
  if (holder.memberId && holder.memberId === scene.ownerId) return ALL_PERMISSIONS;
  const perms = computeChannelPermissions(
    holder.memberId ?? "",
    holder.roleIds,
    scene.guildId,
    scene.roles,
    channel.permission_overwrites ?? []
  );
  return (perms & P.ViewChannel) === 0n ? 0n : perms;
}

// What the holder gains going from one scene to the other. The scenes
// differ in the holder's roles, a role's permissions, or a channel's
// overwrites; `only` limits the channels looked at to the ones a change
// touches. Losses never count.
export function grantsBetween(
  before: { scene: Scene; holder: Holder },
  after: { scene: Scene; holder: Holder },
  only?: Iterable<string>
): Grants {
  const gb = serverPermissionsOf(before.scene, before.holder);
  if ((gb & P.Administrator) !== 0n || gb === ALL_PERMISSIONS) return noGrants();
  const ga = serverPermissionsOf(after.scene, after.holder);
  if ((ga & P.Administrator) !== 0n) return noGrants(P.Administrator);

  const server = ga & ~gb & POWER_PERMISSIONS;
  const wanted = only ? new Set(only) : undefined;
  const beforeById = new Map(before.scene.channels.map((c) => [c.id, c]));
  const grants = noGrants(server);

  for (const channel of after.scene.channels) {
    if (wanted && !wanted.has(channel.id)) continue;
    const prior = beforeById.get(channel.id);
    if (!prior) continue;
    const pb = permissionsIn(before.scene, before.holder, prior);
    const pa = permissionsIn(after.scene, after.holder, channel);
    if (pa === 0n) continue;

    if (pb !== 0n) {
      const power = pa & ~pb & CHANNEL_POWERS & ~server;
      if (power !== 0n) grants.channels.push({ ...refOf(channel), bits: power });
    }
    if (channel.type === 4) continue;

    if (VOICE_TYPES.has(channel.type)) {
      const joins = (perms: bigint) => (perms & P.Connect) !== 0n;
      if (joins(pa) && !joins(pb)) {
        grants.join.push(refOf(channel));
        continue;
      }
    }
    if (pb === 0n) {
      grants.see.push(refOf(channel));
    } else if ((pa & P.ReadMessageHistory) !== 0n && (pb & P.ReadMessageHistory) === 0n) {
      grants.history.push(refOf(channel));
    }
  }
  return grants;
}

// Several sets of grants as one: every power and every channel any of them
// holds.
export function unionGrants(list: Grants[]): Grants {
  const out = noGrants();
  const powers = new Map<string, ChannelRef & { bits: bigint }>();
  const merge = (into: ChannelRef[], from: ChannelRef[]) => {
    for (const c of from) if (!into.some((x) => x.id === c.id)) into.push(c);
  };
  for (const g of list) {
    out.server |= g.server;
    for (const c of g.channels) {
      const prior = powers.get(c.id);
      powers.set(c.id, prior ? { ...prior, bits: prior.bits | c.bits } : { ...c });
    }
    merge(out.see, g.see);
    merge(out.history, g.history);
    merge(out.join, g.join);
  }
  // A channel newly seen or joined is said once, as that; a server-wide
  // power is not repeated per channel.
  const opened = new Set([...out.see, ...out.join].map((c) => c.id));
  out.history = out.history.filter((c) => !opened.has(c.id));
  out.see = out.see.filter((c) => !out.join.some((x) => x.id === c.id));
  for (const c of powers.values()) {
    const bits = c.bits & ~out.server;
    if (bits !== 0n) out.channels.push({ ...c, bits });
  }
  return out;
}

// The role sets a change to a role is judged for: the role held alone (or,
// for @everyone, no roles at all), and held next to each other role in turn.
// Alone is not enough. In a server where being able to see channels comes
// from a "Member" role, someone holding only the changed role sees nothing
// before or after, so lifting @everyone's deny on a private channel looked
// like it opened it to no one, while every member could walk in. Roles that
// behave the same (the same permissions and the same overwrites everywhere)
// are judged once, which keeps a server with hundreds of color roles cheap.
// A combination of three or more roles that only together gain something is
// not found.
export function holderVariants(scene: Scene, fixed: string[]): string[][] {
  const signatures = new Map<string, string>();
  for (const role of scene.roles) {
    if (role.id === scene.guildId || fixed.includes(role.id)) continue;
    if ((BigInt(role.permissions) & P.Administrator) !== 0n) continue;
    const marks: string[] = [];
    for (const channel of scene.channels) {
      const o = (channel.permission_overwrites ?? []).find((x) => x.type === 0 && x.id === role.id);
      if (o) marks.push(`${channel.id}:${o.allow}:${o.deny}`);
    }
    const signature = `${role.permissions}|${marks.join(",")}`;
    if (!signatures.has(signature)) signatures.set(signature, role.id);
  }
  return [fixed, ...[...signatures.values()].map((other) => [...fixed, other])];
}

// What any of the holders gains between the two scenes.
export function grantsAcross(
  before: Scene,
  after: Scene,
  holders: Array<{ before: Holder; after: Holder }>,
  only?: Iterable<string>
): Grants {
  const wanted = only ? [...only] : undefined;
  return unionGrants(
    holders.map((h) => grantsBetween({ scene: before, holder: h.before }, { scene: after, holder: h.after }, wanted))
  );
}

// What changing a role (its permissions, or an overwrite for it) hands the
// people who hold it, alone or next to another role. `roleId` undefined
// means @everyone.
export function grantsForRoleChange(before: Scene, after: Scene, roleId: string | undefined, only?: Iterable<string>): Grants {
  const variants = holderVariants(before, roleId ? [roleId] : []);
  return grantsAcross(before, after, variants.map((roleIds) => ({ before: { roleIds }, after: { roleIds } })), only);
}

// What being given roles hands someone, whatever one other role they hold.
// `known` is the exact role sets of the people concerned, when they are
// known, and is used instead.
export function grantsForGivingRoles(scene: Scene, give: string[], known?: string[][]): Grants {
  const sets = known ?? holderVariants(scene, []).map((roleIds) => roleIds.filter((id) => !give.includes(id)));
  return grantsAcross(
    scene,
    scene,
    distinctSets(sets).map((roleIds) => ({ before: { roleIds }, after: { roleIds: [...new Set([...roleIds, ...give])] } }))
  );
}

// What losing a role hands someone: a role can deny, and taking it away
// lifts the denial. A "Quarantine" role that hides every channel is the
// usual case.
export function grantsForTakingRole(scene: Scene, take: string, known: string[][]): Grants {
  return grantsAcross(
    scene,
    scene,
    distinctSets(known).map((roleIds) => ({ before: { roleIds }, after: { roleIds: roleIds.filter((id) => id !== take) } }))
  );
}

// At most this many different role sets are judged one by one.
const MAX_ROLE_SETS = 300;

function distinctSets(sets: string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const set of sets) {
    const key = [...set].sort().join(",");
    if (!seen.has(key)) seen.set(key, set);
    if (seen.size >= MAX_ROLE_SETS) break;
  }
  return [...seen.values()];
}

export function hasPower(g: Grants): boolean {
  return g.server !== 0n || g.channels.length > 0;
}

export function hasAccess(g: Grants): boolean {
  return g.see.length + g.history.length + g.join.length > 0;
}

export function hasGrants(g: Grants): boolean {
  return hasPower(g) || hasAccess(g);
}

// A short, stable fingerprint, folded into the confirmation's arguments so a
// token minted for one set of grants cannot be spent after the server
// changed and the same call would grant something else.
export function grantsKey(g: Grants): string {
  const ids = (list: ChannelRef[]) => list.map((c) => c.id).sort();
  const body = JSON.stringify({
    s: g.server.toString(),
    c: g.channels.map((c) => [c.id, c.bits.toString()]).sort(),
    v: ids(g.see),
    h: ids(g.history),
    j: ids(g.join),
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

// A channel as a sentence names it. A text channel's name cannot hold a
// space or a quote mark, so the # is enough to mark where it ends; the
// other kinds are named freely by whoever made them, and go in quotes.
export function channelLabel(c: { name?: string | null; type?: number }): string {
  const type = Number(c.type ?? 0);
  if (type === 2) return `${quoted(c.name)} (voice)`;
  if (type === 13) return `${quoted(c.name)} (stage)`;
  if (type === 4) return `the category ${quoted(c.name)}`;
  if (type === 10 || type === 11 || type === 12) return `the thread ${quoted(c.name)}`;
  return `#${plainText(c.name)}`;
}

const MAX_NAMED = 8;

function nameList(list: ChannelRef[]): string {
  const named = list.slice(0, MAX_NAMED).map(channelLabel);
  if (list.length > MAX_NAMED) named.push(`${list.length - MAX_NAMED} more`);
  return joinWords(named);
}

// One line per kind of grant, for the dialog and the preview.
export function grantLines(g: Grants): string[] {
  const lines: string[] = [];
  if ((g.server & P.Administrator) !== 0n) {
    lines.push("Administrator: every permission, in every channel, whatever the channel settings say.");
  } else if (g.server !== 0n) {
    lines.push(`Server-wide: ${joinWords(describePowers(g.server))}.`);
  }
  for (const c of g.channels) {
    lines.push(`In ${channelLabel(c)}: ${joinWords(describePowers(c.bits, "channel"))}.`);
  }
  if (g.see.length) lines.push(`Can see ${nameList(g.see)}, hidden from them now.`);
  if (g.history.length) lines.push(`Can read the earlier messages in ${nameList(g.history)}.`);
  if (g.join.length) lines.push(`Can join ${nameList(g.join)}, closed to them now.`);
  return lines;
}

// What the grants let someone do, as a phrase that follows "lets them" or
// "would let people with it": "kick, ban, and time out members" or "see
// #mod-chat".
export function grantPhrase(g: Grants): string {
  const parts: string[] = [];
  if ((g.server & P.Administrator) !== 0n) {
    parts.push("do everything, as an administrator");
  } else if (g.server !== 0n) {
    parts.push(joinWords(describePowers(g.server)));
  }
  if (g.channels.length === 1) {
    const c = g.channels[0];
    parts.push(`${joinWords(describePowers(c.bits, "channel"))} in ${channelLabel(c)}`);
  } else if (g.channels.length > 1) {
    parts.push(`use moderator powers in ${g.channels.length} channels`);
  }
  const opened = [...g.see, ...g.join];
  if (opened.length === 1) {
    parts.push(`${g.join.length ? "join" : "see"} ${channelLabel(opened[0])}`);
  } else if (opened.length > 1) {
    parts.push(`see ${opened.length} channels hidden from them now`);
  }
  if (g.history.length) {
    parts.push(
      g.history.length === 1
        ? `read the earlier messages in ${channelLabel(g.history[0])}`
        : `read the earlier messages in ${g.history.length} channels`
    );
  }
  return joinWords(parts);
}

// --- role order ---

export interface RoleMove {
  id: string;
  position: number;
}

// The role order after a reorder, low to high, @everyone left out. Each
// listed role lands at the position asked for and the rest keep their order
// around it, as Discord does with a partial list; moves are placed lowest
// first so a later one does not push an earlier one off its spot.
export function simulateRoleOrder(roles: RoleLite[], guildId: string, moves: RoleMove[]): string[] {
  const order = roles
    .filter((r) => r.id !== guildId)
    .sort(compareRolesLowToHigh)
    .map((r) => r.id);
  const placed = [...moves].sort((a, b) => a.position - b.position);
  const moved = new Set(placed.map((m) => m.id));
  const rest = order.filter((id) => !moved.has(id));
  for (const move of placed) {
    const index = Math.max(0, Math.min(move.position - 1, rest.length));
    rest.splice(index, 0, move.id);
  }
  return rest;
}

export interface HierarchyFlip {
  risen: RoleLite;
  over: RoleLite;
  powers: bigint;
}

// Pairs whose order flips, where the role that ends up higher holds powers
// Discord limits by role order: its holders could then use them on members
// whose highest role is the one it passed.
export function hierarchyFlips(roles: RoleLite[], guildId: string, before: string[], after: string[]): HierarchyFlip[] {
  const at = (list: string[]) => new Map(list.map((id, i) => [id, i]));
  const b = at(before);
  const a = at(after);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const flips: HierarchyFlip[] = [];
  for (const risen of roles) {
    if (risen.id === guildId) continue;
    const own = BigInt(risen.permissions);
    const powers = (own & P.Administrator) !== 0n ? P.Administrator : own & HIERARCHY_PERMISSIONS;
    const rb = b.get(risen.id);
    const ra = a.get(risen.id);
    if (powers === 0n || rb === undefined || ra === undefined) continue;
    for (const [id, ob] of b) {
      const oa = a.get(id);
      if (id === risen.id || oa === undefined) continue;
      if (rb < ob && ra > oa) {
        const over = byId.get(id);
        if (over) flips.push({ risen, over, powers });
      }
    }
  }
  return flips;
}

export function describeHierarchyPowers(bits: bigint): string {
  if ((bits & P.Administrator) !== 0n) return "act on them as an administrator";
  const words: Array<[bigint, string]> = [
    [P.BanMembers, "ban"],
    [P.KickMembers, "kick"],
    [P.ModerateMembers, "time out"],
    [P.ManageRoles, "change the roles of"],
    [P.ManageNicknames, "rename"],
  ];
  return joinWords(words.filter(([bit]) => (bits & bit) !== 0n).map(([, w]) => w));
}
