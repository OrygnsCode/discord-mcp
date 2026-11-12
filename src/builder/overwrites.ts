import { PermissionFlagsBits } from "discord-api-types/v10";

// The blueprint's visibility sugar (private_to, read_only, posting_roles)
// and the Discord permission overwrites behind it. Pure, so the exact bit
// math is unit tested without a server.
//
// Everything goes through one function, patchOverwrites, which changes an
// existing set of overwrites and touches only the bits the sugar is about.
// A new channel is a patch of an empty set, or of its category's set; an
// edit is a patch of what the channel has now. Everything else on a channel
// (member overwrites, a role allowed to add reactions, a muted role's deny)
// passes through untouched.
//
// Rules:
// - Private: @everyone is denied View Channel, the listed roles are allowed
//   it, and no other role overwrite grants it. Voice-like channels and
//   categories also gate Connect, since seeing a voice channel without
//   being able to join it is rarely what anyone means.
// - Public: @everyone's deny is lifted. Role allows stay, since on servers
//   that take View Channel away from @everyone at server level they are
//   how members get in at all.
// - Read-only: @everyone is denied the whole send family, the posting roles
//   get it back, and no other role overwrite grants it. Giving posting roles
//   back only sending once left thread creation denied to every role, so in
//   a read-only channel nobody but an admin could start a thread.
// - Open: @everyone's deny on the send family is lifted; role allows stay.
// - The bot itself always gets an allow overwrite when a restriction is
//   applied, so a build can never lock the bot out of what it just made.
// - Extras (a blueprint's `permissions`) set everything else for a listed
//   role: its bits outside the ones the rules above control on this channel
//   become exactly the listed ones. Roles not listed keep theirs.
// - Discord lets a bot allow or deny only permissions it has itself, and
//   refuses the whole overwrite otherwise. With `settable`, bits outside it
//   are left exactly as they were, so a bot missing one permission still
//   applies the rest instead of failing; the planner says what was left.

const P = PermissionFlagsBits;

export const SEND_FAMILY =
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.CreatePrivateThreads;

export type ChannelKind =
  | "text"
  | "voice"
  | "forum"
  | "stage"
  | "announcement"
  | "category";

export interface OverwriteSpec {
  id: string;
  // 0 for role, 1 for member.
  type: 0 | 1;
  allow: string;
  deny: string;
}

// The bits that gate seeing a channel of this kind.
export function gateBitsFor(kind: ChannelKind): bigint {
  return kind === "voice" || kind === "stage" || kind === "category"
    ? P.ViewChannel | P.Connect
    : P.ViewChannel;
}

export function gateBitsForType(type: number): bigint {
  return type === 2 || type === 13 || type === 4
    ? P.ViewChannel | P.Connect
    : P.ViewChannel;
}

// What a set of overwrites says in sugar terms, by role id. Private means
// @everyone is denied View Channel; the roles are those allowed it back.
// Read-only means @everyone is denied Send Messages; the posting roles are
// those allowed it back. A private channel with no roles is visible to
// admins only, which the sugar cannot name but this still reports.
export interface Sugar {
  private: boolean;
  privateRoles: string[];
  readOnly: boolean;
  postingRoles: string[];
}

export function readSugar(
  overwrites: ReadonlyArray<{ id: string; type: number; allow: string; deny: string }>,
  guildId: string
): Sugar {
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  const everyoneDeny = BigInt(everyone?.deny ?? 0);
  const isPrivate = (everyoneDeny & P.ViewChannel) !== 0n;
  const readOnly = (everyoneDeny & P.SendMessages) !== 0n;
  const privateRoles: string[] = [];
  const postingRoles: string[] = [];
  for (const o of overwrites) {
    if (o.type !== 0 || o.id === guildId) continue;
    const allow = BigInt(o.allow);
    if (isPrivate && (allow & P.ViewChannel) !== 0n) privateRoles.push(o.id);
    if (readOnly && (allow & P.SendMessages) !== 0n) postingRoles.push(o.id);
  }
  return { private: isPrivate, privateRoles, readOnly, postingRoles };
}

// What to change. A field left undefined is left as it is.
export interface SugarChange {
  privacy?: { private: boolean; roles: string[] };
  send?: { readOnly: boolean; postingRoles: string[] };
  // Per role id (the guild id for @everyone): the bits outside the ones
  // privacy and read-only control here.
  extras?: Array<{ id: string; allow: bigint; deny: bigint }>;
}

// The bits privacy and read-only control on a channel with these
// overwrites: the view gate when @everyone is denied View Channel, and the
// send family when it is denied Send Messages. Everything else is extras.
export function managedBits(
  overwrites: ReadonlyArray<{ id: string; type: number; allow: string; deny: string }>,
  guildId: string,
  gateBits: bigint
): bigint {
  const everyone = overwrites.find((o) => Number(o.type) === 0 && o.id === guildId);
  const deny = BigInt(everyone?.deny ?? 0);
  // Connect counts with the view gate on every kind of private channel:
  // Discord copies a private category's Connect onto the text channels
  // synced to it, where it means nothing, and it must not read as an extra.
  return (
    ((deny & P.ViewChannel) !== 0n ? gateBits | P.Connect : 0n) |
    ((deny & P.SendMessages) !== 0n ? SEND_FAMILY : 0n)
  );
}

// Each role's extras on a channel, by role id: its allow and deny outside
// the managed bits, where any are set. Member overwrites are not extras.
export function extrasOf(
  overwrites: ReadonlyArray<{ id: string; type: number; allow: string; deny: string }>,
  guildId: string,
  gateBits: bigint
): Map<string, { allow: bigint; deny: bigint }> {
  const managed = managedBits(overwrites, guildId, gateBits);
  const out = new Map<string, { allow: bigint; deny: bigint }>();
  for (const o of overwrites) {
    if (Number(o.type) !== 0) continue;
    const allow = BigInt(o.allow) & ~managed;
    const deny = BigInt(o.deny) & ~managed;
    if (allow !== 0n || deny !== 0n) out.set(o.id, { allow, deny });
  }
  return out;
}

export interface PatchResult {
  // The full set after the patch, in a stable order.
  overwrites: OverwriteSpec[];
  // Targets whose overwrite is new or changed, to PUT one at a time.
  puts: OverwriteSpec[];
  // Targets that had an overwrite and now have nothing left in it.
  deletes: string[];
}

export function patchOverwrites(
  base: ReadonlyArray<{ id: string; type: number; allow: string; deny: string }>,
  change: SugarChange,
  opts: { guildId: string; botUserId: string; gateBits: bigint; settable?: bigint }
): PatchResult {
  const { guildId, botUserId } = opts;
  const mask = opts.settable ?? ~0n;
  const gateBits = opts.gateBits & mask;
  const sendBits = SEND_FAMILY & mask;
  interface Entry { id: string; type: 0 | 1; allow: bigint; deny: bigint }
  const entries = new Map<string, Entry>();
  const original = new Map<string, { allow: bigint; deny: bigint }>();
  for (const o of base) {
    const entry: Entry = {
      id: o.id,
      type: o.type === 1 ? 1 : 0,
      allow: BigInt(o.allow),
      deny: BigInt(o.deny),
    };
    entries.set(o.id, entry);
    original.set(o.id, { allow: entry.allow, deny: entry.deny });
  }
  const get = (id: string, type: 0 | 1): Entry => {
    let e = entries.get(id);
    if (!e) {
      e = { id, type, allow: 0n, deny: 0n };
      entries.set(id, e);
    }
    return e;
  };
  const allowBits = (e: Entry, bits: bigint) => {
    e.allow |= bits;
    e.deny &= ~bits;
  };

  if (change.privacy) {
    const want = change.privacy;
    const everyone = get(guildId, 0);
    if (want.private) {
      everyone.deny |= gateBits;
      everyone.allow &= ~gateBits;
      const listed = new Set(want.roles);
      for (const e of entries.values()) {
        if (e.type !== 0 || e.id === guildId) continue;
        if (!listed.has(e.id)) e.allow &= ~gateBits;
      }
      for (const id of listed) allowBits(get(id, 0), gateBits);
      allowBits(get(botUserId, 1), gateBits);
    } else {
      everyone.deny &= ~gateBits;
    }
  }

  if (change.send) {
    const want = change.send;
    const everyone = get(guildId, 0);
    if (want.readOnly) {
      everyone.deny |= sendBits;
      everyone.allow &= ~sendBits;
      const listed = new Set(want.postingRoles);
      for (const e of entries.values()) {
        if (e.type !== 0 || e.id === guildId) continue;
        if (!listed.has(e.id)) e.allow &= ~sendBits;
      }
      for (const id of listed) allowBits(get(id, 0), sendBits);
      allowBits(get(botUserId, 1), sendBits);
    } else {
      everyone.deny &= ~sendBits;
    }
  }

  if (change.extras) {
    // Measured after privacy and read-only are applied, so extras never
    // touch the bits those just set.
    const now = [...entries.values()].map((e) => ({ id: e.id, type: e.type, allow: e.allow.toString(), deny: e.deny.toString() }));
    const free = ~managedBits(now, guildId, opts.gateBits) & mask;
    for (const x of change.extras) {
      const e = get(x.id, 0);
      e.allow = (e.allow & ~free) | (x.allow & free);
      e.deny = (e.deny & ~free) | (x.deny & free);
    }
  }

  // Deterministic order: everyone first, then roles by id, then members by
  // id with the bot last, and nothing that ended up empty.
  const ordered = [...entries.values()]
    .filter((e) => e.allow !== 0n || e.deny !== 0n)
    .sort((a, b) => {
      const rank = (e: Entry) =>
        e.id === guildId ? 0 : e.type === 0 ? 1 : e.id === botUserId ? 3 : 2;
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
    });
  const toSpec = (e: Entry): OverwriteSpec => ({
    id: e.id,
    type: e.type,
    allow: e.allow.toString(),
    deny: e.deny.toString(),
  });

  const puts: OverwriteSpec[] = [];
  for (const e of ordered) {
    const was = original.get(e.id);
    if (!was || was.allow !== e.allow || was.deny !== e.deny) puts.push(toSpec(e));
  }
  const deletes: string[] = [];
  for (const [id] of original) {
    const e = entries.get(id);
    if (e && e.allow === 0n && e.deny === 0n) deletes.push(id);
  }
  return { overwrites: ordered.map(toSpec), puts, deletes };
}

export interface VisibilityInput {
  kind: ChannelKind;
  // Undefined means not set, and the channel follows its category. An empty
  // list means visible to everyone.
  privateTo?: string[];
  readOnly?: boolean;
  postingRoles?: string[];
  inheritedPrivateTo?: string[];
}

export class UnknownRoleError extends Error {
  roleName: string;
  constructor(roleName: string) {
    super(`No role named "${roleName}" exists to build an overwrite for.`);
    this.roleName = roleName;
  }
}

// Naming @everyone in private_to asks to hide a channel from everyone and
// then show it to everyone. Discord resolves the overlap in favor of the
// allow, so the channel comes out fully public: the one outcome nobody
// asking for a private channel wants, arrived at silently. Refusing is the
// safer answer.
export class EveryoneRoleError extends Error {
  constructor(field: string) {
    super(
      `@everyone cannot be listed in ${field}. It would grant back the ` +
        "same access the restriction removes, leaving the channel open to " +
        "the whole server. List only the roles that should have access."
    );
  }
}

// Role names to ids for the sugar, refusing unknown names and @everyone.
export function roleIdsFor(
  names: string[],
  roleIdsByName: Map<string, string>,
  guildId: string,
  field: string
): string[] {
  return names.map((name) => {
    const id = roleIdsByName.get(name.toLowerCase());
    if (!id) throw new UnknownRoleError(name);
    // The default role's id is the guild id, whatever it happens to be
    // named, so this catches every spelling of it.
    if (id === guildId) throw new EveryoneRoleError(field);
    return id;
  });
}

// The sugar for a new channel with nothing to start from, by role name.
// Kept as the simple entry point the create_channel tool uses; it is a patch
// of an empty set.
export function compileOverwrites(
  input: VisibilityInput,
  roleIdsByName: Map<string, string>,
  guildId: string,
  botUserId: string
): OverwriteSpec[] {
  const ownPrivate = input.privateTo;
  const effectivePrivate =
    ownPrivate !== undefined && ownPrivate.length > 0
      ? ownPrivate
      : ownPrivate === undefined
        ? input.inheritedPrivateTo ?? []
        : [];
  const readOnly = input.readOnly ?? false;
  const postingRoles = input.postingRoles ?? [];

  if (effectivePrivate.length === 0 && !readOnly) return [];

  const change: SugarChange = {};
  if (effectivePrivate.length > 0) {
    change.privacy = {
      private: true,
      roles: roleIdsFor(effectivePrivate, roleIdsByName, guildId, "private_to"),
    };
  }
  if (readOnly) {
    change.send = {
      readOnly: true,
      postingRoles: roleIdsFor(postingRoles, roleIdsByName, guildId, "posting_roles"),
    };
  }
  return patchOverwrites([], change, {
    guildId,
    botUserId,
    gateBits: gateBitsFor(input.kind),
  }).overwrites;
}
