import type { GuildChannelLite } from "../discord/guildData.js";
import {
  describePermissions,
  parsePermissionNames,
  PERMISSION_PRESETS,
  type RoleLite,
} from "../discord/preflight.js";
import {
  normalizedChannelName,
  type Blueprint,
  type BlueprintCategory,
  type BlueprintChannel,
  type BlueprintRole,
  type BlueprintRolePermission,
} from "./blueprint.js";
import { extrasOf, gateBitsForType, readSugar } from "./overwrites.js";

// One place that decides which live item a blueprint item means and how
// the two differ. The planner, diff_blueprint, and the check after a build
// all use it, so they can never disagree about what changed. Pure.
//
// Binding: an item that carries an id (exports include them) binds to the
// live item with that id, so a different name is a rename. Without an id,
// or with an id this server does not have, it binds by name, the way
// builds always have. Channel names only collide within a family: Discord
// keeps text and voice namespaces separate, and treating them as one once
// matched a blueprint's text general to the server's voice General.

export type ChannelTypeName = "text" | "voice" | "forum" | "stage" | "announcement";

export const TYPE_CODES: Record<ChannelTypeName, number> = {
  text: 0,
  voice: 2,
  announcement: 5,
  stage: 13,
  forum: 15,
};

export function typeName(code: number): ChannelTypeName | null {
  switch (code) {
    case 0: return "text";
    case 2: return "voice";
    case 5: return "announcement";
    case 13: return "stage";
    case 15: return "forum";
    default: return null;
  }
}

export function familyOfKind(kind: string | undefined): "voice" | "text" {
  return kind === "voice" || kind === "stage" ? "voice" : "text";
}

export function familyOfType(type: number): "voice" | "text" {
  return type === 2 || type === 13 ? "voice" : "text";
}

export function channelKey(name: string, kind: string | undefined): string {
  return `${familyOfKind(kind)}:${normalizedChannelName(name, kind).toLowerCase()}`;
}

function liveChannelKey(c: GuildChannelLite): string {
  return `${familyOfType(c.type)}:${(c.name ?? "").toLowerCase()}`;
}

export type BoundBy = "id" | "name";

export interface RoleBinding {
  bp: BlueprintRole;
  live?: RoleLite;
  by?: BoundBy;
}

export interface CategoryBinding {
  bp: BlueprintCategory;
  live?: GuildChannelLite;
  by?: BoundBy;
}

export interface ChannelBinding {
  bp: BlueprintChannel;
  // Index into categories, or null for a top-level channel.
  categoryIndex: number | null;
  live?: GuildChannelLite;
  by?: BoundBy;
}

export interface Bindings {
  roles: RoleBinding[];
  categories: CategoryBinding[];
  channels: ChannelBinding[];
  // Problems that make the blueprint unusable as written.
  errors: string[];
  // A name that matched more than one live item. Bound to the first.
  ambiguous: string[];
  // Ids this server does not have, matched by name instead.
  notes: string[];
}

export function bindBlueprint(
  blueprint: Blueprint,
  channels: GuildChannelLite[],
  roles: RoleLite[],
  guildId: string,
  hiddenIds: ReadonlySet<string> = new Set()
): Bindings {
  const out: Bindings = {
    roles: [],
    categories: [],
    channels: [],
    errors: [],
    ambiguous: [],
    notes: [],
  };

  // Roles. @everyone is never a blueprint role: it has no name to match by
  // and no place in the hierarchy to create.
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const rolesByName = new Map<string, RoleLite[]>();
  for (const r of roles) {
    if (r.id === guildId || !r.name) continue;
    const key = r.name.toLowerCase();
    rolesByName.set(key, [...(rolesByName.get(key) ?? []), r]);
  }
  for (const bp of blueprint.roles ?? []) {
    if (bp.name.trim().toLowerCase().replace(/^@/, "") === "everyone") {
      out.errors.push(
        `A blueprint role cannot be named "${bp.name}": that is the default role every member has.`
      );
      out.roles.push({ bp });
      continue;
    }
    if (bp.id) {
      if (bp.id === guildId) {
        out.errors.push(
          `Role "${bp.name}" carries the id of @everyone, which a blueprint cannot edit.`
        );
        out.roles.push({ bp });
        continue;
      }
      const live = rolesById.get(bp.id);
      if (live) {
        out.roles.push({ bp, live, by: "id" });
        continue;
      }
      out.notes.push(`Role "${bp.name}" has an id this server does not have; matched by name.`);
    }
    const matches = rolesByName.get(bp.name.toLowerCase()) ?? [];
    if (matches.length > 1) {
      out.ambiguous.push(
        `${matches.length} roles are named "${bp.name}" (ids ${matches.map((m) => m.id).join(", ")}).`
      );
    }
    out.roles.push(matches[0] ? { bp, live: matches[0], by: "name" } : { bp });
  }

  // Categories.
  const channelsById = new Map(channels.map((c) => [c.id, c]));
  const categoriesByName = new Map<string, GuildChannelLite[]>();
  for (const c of channels) {
    if (c.type !== 4) continue;
    const key = (c.name ?? "").toLowerCase();
    categoriesByName.set(key, [...(categoriesByName.get(key) ?? []), c]);
  }
  for (const bp of blueprint.categories ?? []) {
    if (bp.id) {
      const live = channelsById.get(bp.id);
      if (live && live.type === 4) {
        out.categories.push({ bp, live, by: "id" });
        continue;
      }
      if (live) {
        out.errors.push(`Category "${bp.name}" carries the id of a channel, not a category.`);
        out.categories.push({ bp });
        continue;
      }
      if (hiddenIds.has(bp.id)) {
        out.errors.push(
          `Category "${bp.name}" (${bp.id}) is hidden from the bot, so it cannot be compared or edited. Give the bot View Channel there first.`
        );
        out.categories.push({ bp });
        continue;
      }
      out.notes.push(`Category "${bp.name}" has an id this server does not have; matched by name.`);
    }
    const matches = categoriesByName.get(bp.name.toLowerCase()) ?? [];
    if (matches.length > 1) {
      out.ambiguous.push(
        `${matches.length} categories are named "${bp.name}" (ids ${matches.map((m) => m.id).join(", ")}).`
      );
    }
    out.categories.push(matches[0] ? { bp, live: matches[0], by: "name" } : { bp });
  }

  // Channels.
  const channelsByKey = new Map<string, GuildChannelLite[]>();
  for (const c of channels) {
    if (c.type === 4) continue;
    const key = liveChannelKey(c);
    channelsByKey.set(key, [...(channelsByKey.get(key) ?? []), c]);
  }
  const blueprintChannels: Array<{ bp: BlueprintChannel; categoryIndex: number | null }> = [
    ...(blueprint.channels ?? []).map((bp) => ({ bp, categoryIndex: null })),
    ...(blueprint.categories ?? []).flatMap((cat, i) =>
      cat.channels.map((bp) => ({ bp, categoryIndex: i }))
    ),
  ];
  for (const { bp, categoryIndex } of blueprintChannels) {
    if (bp.id) {
      const live = channelsById.get(bp.id);
      if (live && live.type !== 4) {
        if (familyOfType(live.type) !== familyOfKind(bp.type ?? typeName(live.type) ?? "text")) {
          out.errors.push(
            `Channel "${bp.name}" carries the id of a ${typeName(live.type) ?? "different"} ` +
              `channel but says ${bp.type ?? "text"}. Discord cannot turn a voice channel ` +
              "into a text one or back; remove one and create the other."
          );
          out.channels.push({ bp, categoryIndex });
          continue;
        }
        out.channels.push({ bp, categoryIndex, live, by: "id" });
        continue;
      }
      if (live) {
        out.errors.push(`Channel "${bp.name}" carries the id of a category, not a channel.`);
        out.channels.push({ bp, categoryIndex });
        continue;
      }
      if (hiddenIds.has(bp.id)) {
        out.errors.push(
          `Channel "${bp.name}" (${bp.id}) is hidden from the bot, so it cannot be compared or edited. Give the bot View Channel there first.`
        );
        out.channels.push({ bp, categoryIndex });
        continue;
      }
      out.notes.push(`Channel "${bp.name}" has an id this server does not have; matched by name.`);
    }
    const matches = channelsByKey.get(channelKey(bp.name, bp.type)) ?? [];
    if (matches.length > 1) {
      out.ambiguous.push(
        `${matches.length} ${familyOfKind(bp.type)} channels are named "${normalizedChannelName(bp.name, bp.type)}" ` +
          `(ids ${matches.map((m) => m.id).join(", ")}).`
      );
    }
    out.channels.push(
      matches[0] ? { bp, categoryIndex, live: matches[0], by: "name" } : { bp, categoryIndex }
    );
  }

  // One live item, one blueprint item. Two entries meaning the same channel
  // (an id rename plus an entry under the old name) would make the result
  // depend on which ran last.
  const seen = new Map<string, string>();
  const claim = (id: string | undefined, label: string) => {
    if (!id) return;
    const prior = seen.get(id);
    if (prior) {
      out.errors.push(
        `${prior} and ${label} both refer to the same live item (${id}). Keep one.`
      );
    } else {
      seen.set(id, label);
    }
  };
  for (const b of out.roles) claim(b.live?.id, `role "${b.bp.name}"`);
  for (const b of out.categories) claim(b.live?.id, `category "${b.bp.name}"`);
  for (const b of out.channels) claim(b.live?.id, `channel "${b.bp.name}"`);

  return out;
}

// Role references in private_to and posting_roles are names. Comparing
// them needs one key per role that survives renames: the live id when the
// name resolves to a role that exists, or the name of a role this blueprint
// will create. Blueprint names win over live names, so a role renamed in
// the blueprint is referred to by its new name.
export interface RoleRefs {
  key(name: string): string | null;
  display(key: string): string;
}

export function roleRefs(bindings: Bindings, roles: RoleLite[], guildId: string): RoleRefs {
  const byName = new Map<string, string>();
  for (const r of roles) {
    if (r.id === guildId || !r.name) continue;
    const lower = r.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, `id:${r.id}`);
  }
  const displayNames = new Map<string, string>();
  for (const r of roles) if (r.name) displayNames.set(`id:${r.id}`, r.name);
  for (const b of bindings.roles) {
    const key = b.live ? `id:${b.live.id}` : `new:${b.bp.name.toLowerCase()}`;
    byName.set(b.bp.name.toLowerCase(), key);
    displayNames.set(key, b.bp.name);
  }
  return {
    key: (name) => byName.get(name.toLowerCase()) ?? null,
    display: (key) => displayNames.get(key) ?? key.replace(/^(id|new):/, ""),
  };
}

// Privacy in one comparable shape: null is visible to everyone, an array is
// private to those role keys (empty: admins only).
export type Privacy = string[] | null;

export function privacyEquals(a: Privacy, b: Privacy): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function livePrivacy(c: GuildChannelLite, guildId: string): Privacy {
  const sugar = readSugar(c.permission_overwrites ?? [], guildId);
  return sugar.private ? sugar.privateRoles.map((id) => `id:${id}`) : null;
}

export function liveSend(c: GuildChannelLite, guildId: string): { readOnly: boolean; posting: string[] } {
  const sugar = readSugar(c.permission_overwrites ?? [], guildId);
  return {
    readOnly: sugar.readOnly,
    posting: sugar.readOnly ? sugar.postingRoles.map((id) => `id:${id}`) : [],
  };
}

// A blueprint privacy list as keys. Unresolvable names come back in
// `unknown` for the caller to report; they are left out of the keys.
export function privacyFrom(
  names: string[] | null,
  refs: RoleRefs
): { privacy: Privacy; unknown: string[] } {
  if (names === null) return { privacy: null, unknown: [] };
  const unknown: string[] = [];
  const keys: string[] = [];
  for (const n of names) {
    const k = refs.key(n);
    if (k) keys.push(k);
    else unknown.push(n);
  }
  return { privacy: keys, unknown };
}

export function displayPrivacy(p: Privacy, refs: RoleRefs): string | string[] {
  if (p === null) return "everyone";
  if (p.length === 0) return "admins only";
  return p.map((k) => refs.display(k));
}

// One setting of one item. `listed` says whether the blueprint sets it;
// `after` is what the blueprint wants, or the default when it is not listed.
export interface FieldDiff {
  field: string;
  listed: boolean;
  before: unknown;
  after: unknown;
  differs: boolean;
  // Comparable forms, for the planner and the binding hash.
  wantRaw?: unknown;
}

function scalar(field: string, listed: boolean, before: unknown, after: unknown): FieldDiff {
  return { field, listed, before, after, differs: before !== after };
}

export function roleWantBits(bp: BlueprintRole): bigint {
  let bits = PERMISSION_PRESETS[bp.preset ?? "none"] ?? 0n;
  if (bp.permissions?.length) bits |= parsePermissionNames(bp.permissions).bits;
  return bits;
}

function colorInt(c: string | null | undefined): number {
  return c ? parseInt(c.replace(/^#/, ""), 16) : 0;
}

function colorHex(n: number): string | null {
  return n ? `#${n.toString(16).padStart(6, "0")}` : null;
}

export function compareRole(b: RoleBinding): FieldDiff[] {
  const { bp, live } = b;
  if (!live) return [];
  const extra = live as RoleLite & { color?: number; hoist?: boolean; mentionable?: boolean };
  const out: FieldDiff[] = [];
  out.push({
    field: "name",
    listed: b.by === "id",
    before: live.name,
    after: bp.name,
    differs: b.by === "id" && bp.name !== live.name,
  });
  const liveBits = BigInt(live.permissions);
  const wantBits = roleWantBits(bp);
  out.push({
    field: "permissions",
    listed: bp.preset !== undefined || bp.permissions !== undefined,
    before: describePermissions(liveBits),
    after: describePermissions(wantBits),
    differs: liveBits !== wantBits,
    wantRaw: wantBits,
  });
  out.push(scalar("color", bp.color !== undefined, colorHex(extra.color ?? 0), colorHex(colorInt(bp.color))));
  out.push(scalar("hoist", bp.hoist !== undefined, extra.hoist ?? false, bp.hoist ?? false));
  out.push(scalar("mentionable", bp.mentionable !== undefined, extra.mentionable ?? false, bp.mentionable ?? false));
  return out;
}

export function compareCategory(
  b: CategoryBinding,
  refs: RoleRefs,
  guildId: string
): FieldDiff[] {
  const { bp, live } = b;
  if (!live) return [];
  const out: FieldDiff[] = [];
  out.push({
    field: "name",
    listed: b.by === "id",
    before: live.name,
    after: bp.name,
    differs: b.by === "id" && bp.name !== live.name,
  });
  const before = livePrivacy(live, guildId);
  const want = privacyFrom(bp.private_to === undefined ? null : bp.private_to, refs).privacy;
  out.push({
    field: "private_to",
    listed: bp.private_to !== undefined,
    before: displayPrivacy(before, refs),
    after: displayPrivacy(want, refs),
    differs: !privacyEquals(before, want),
    wantRaw: want,
  });
  out.push(extrasDiff(live, bp.permissions, bp.permissions !== undefined, refs, guildId));
  return out;
}

export function compareChannel(
  b: ChannelBinding,
  blueprint: Blueprint,
  categoryBindings: CategoryBinding[],
  liveCategoryNames: Map<string, string>,
  refs: RoleRefs,
  guildId: string
): FieldDiff[] {
  const { bp, live } = b;
  if (!live) return [];
  const out: FieldDiff[] = [];
  const liveType = typeName(live.type) ?? "text";
  const wantType = bp.type ?? "text";
  const isVoiceLike = liveType === "voice" || liveType === "stage";

  // An entry without a type is the kind of channel it matched, so a voice
  // channel's name keeps its case and spaces.
  const wantName = normalizedChannelName(bp.name, bp.type ?? liveType);
  out.push({
    field: "name",
    listed: b.by === "id",
    before: live.name,
    after: wantName,
    differs: b.by === "id" && wantName !== live.name,
  });
  out.push(scalar("type", bp.type !== undefined, liveType, wantType));

  // Placement: a channel listed under a category belongs in it. A top-level
  // entry says where it belongs only when the whole blueprint is the truth,
  // which is how diff reads it.
  const bpCategory =
    b.categoryIndex === null ? null : blueprint.categories?.[b.categoryIndex] ?? null;
  const liveParentName = live.parent_id ? liveCategoryNames.get(live.parent_id) ?? null : null;
  const wantParentId =
    b.categoryIndex === null ? null : categoryBindings[b.categoryIndex]?.live?.id ?? null;
  const parentDiffers =
    b.categoryIndex === null
      ? live.parent_id != null
      : wantParentId === null || wantParentId !== live.parent_id;
  out.push({
    field: "category",
    listed: b.categoryIndex !== null,
    before: liveParentName,
    after: bpCategory?.name ?? null,
    differs: parentDiffers,
  });

  if (!isVoiceLike) {
    out.push(scalar("topic", bp.topic !== undefined, live.topic ?? "", bp.topic ?? ""));
  }
  out.push(scalar("slowmode", bp.slowmode_seconds !== undefined, live.rate_limit_per_user ?? 0, bp.slowmode_seconds ?? 0));
  out.push(scalar("nsfw", bp.nsfw !== undefined, live.nsfw ?? false, bp.nsfw ?? false));

  // Privacy. Not listed, a channel follows its blueprint category's listed
  // privacy, or is visible to everyone.
  const before = livePrivacy(live, guildId);
  const inherited =
    bpCategory && bpCategory.private_to !== undefined ? bpCategory.private_to : null;
  const wantNames = bp.private_to !== undefined ? bp.private_to : inherited;
  const want = privacyFrom(wantNames, refs).privacy;
  out.push({
    field: "private_to",
    listed: bp.private_to !== undefined,
    before: displayPrivacy(before, refs),
    after: displayPrivacy(want, refs),
    differs: !privacyEquals(before, want),
    wantRaw: want,
  });

  const send = liveSend(live, guildId);
  const wantReadOnly = bp.read_only ?? false;
  out.push(scalar("read_only", bp.read_only !== undefined, send.readOnly, wantReadOnly));
  const wantPosting = privacyFrom(bp.posting_roles ?? [], refs).privacy ?? [];
  out.push({
    field: "posting_roles",
    listed: bp.posting_roles !== undefined,
    before: send.posting.map((k) => refs.display(k)),
    after: wantPosting.map((k) => refs.display(k)),
    differs: wantReadOnly && !privacyEquals(send.posting, wantPosting),
    wantRaw: wantPosting,
  });
  out.push(
    extrasDiff(
      live,
      bp.permissions !== undefined ? bp.permissions : bpCategory?.permissions,
      bp.permissions !== undefined,
      refs,
      guildId
    )
  );
  return out;
}

// --- extras: a blueprint's permissions list ---

export type Extras = Map<string, { allow: bigint; deny: bigint }>;

// The role key for a permissions entry, where @everyone is allowed.
export function extraRoleKey(name: string, refs: RoleRefs, guildId: string): string | null {
  const plain = name.trim().replace(/^@/, "").toLowerCase();
  if (plain === "everyone") return `id:${guildId}`;
  return refs.key(name);
}

// A blueprint permissions list as role keys and bits. What does not resolve
// comes back for the caller to report.
export function extrasFrom(
  list: BlueprintRolePermission[] | undefined,
  refs: RoleRefs,
  guildId: string
): { extras: Extras; unknownRoles: string[]; unknownPermissions: string[]; overlaps: string[] } {
  const extras: Extras = new Map();
  const unknownRoles: string[] = [];
  const unknownPermissions: string[] = [];
  const overlaps: string[] = [];
  for (const entry of list ?? []) {
    const key = extraRoleKey(entry.role, refs, guildId);
    if (!key) {
      unknownRoles.push(entry.role);
      continue;
    }
    const allow = parsePermissionNames(entry.allow ?? []);
    const deny = parsePermissionNames(entry.deny ?? []);
    unknownPermissions.push(...allow.unknown, ...deny.unknown);
    if ((allow.bits & deny.bits) !== 0n) overlaps.push(entry.role);
    const prior = extras.get(key);
    extras.set(key, {
      allow: (prior?.allow ?? 0n) | allow.bits,
      deny: (prior?.deny ?? 0n) | deny.bits,
    });
  }
  return { extras, unknownRoles, unknownPermissions, overlaps };
}

export function liveExtras(c: GuildChannelLite, guildId: string): Extras {
  const out: Extras = new Map();
  for (const [id, bits] of extrasOf(c.permission_overwrites ?? [], guildId, gateBitsForType(c.type))) {
    out.set(`id:${id}`, bits);
  }
  return out;
}

export function extrasEqual(a: Extras, b: Extras, only?: Iterable<string>): boolean {
  const keys = only ? [...only] : [...new Set([...a.keys(), ...b.keys()])];
  return keys.every((k) => {
    const x = a.get(k) ?? { allow: 0n, deny: 0n };
    const y = b.get(k) ?? { allow: 0n, deny: 0n };
    return x.allow === y.allow && x.deny === y.deny;
  });
}

export function displayExtras(x: Extras, refs: RoleRefs, guildId: string, only?: Iterable<string>) {
  const keys = only ? [...only] : [...x.keys()];
  return keys
    .map((k) => {
      const bits = x.get(k) ?? { allow: 0n, deny: 0n };
      return {
        role: k === `id:${guildId}` ? "@everyone" : refs.display(k),
        ...(bits.allow ? { allow: describePermissions(bits.allow) } : {}),
        ...(bits.deny ? { deny: describePermissions(bits.deny) } : {}),
      };
    })
    .sort((p, q) => p.role.localeCompare(q.role));
}

function extrasDiff(
  live: GuildChannelLite,
  list: BlueprintRolePermission[] | undefined,
  listed: boolean,
  refs: RoleRefs,
  guildId: string
): FieldDiff {
  const before = liveExtras(live, guildId);
  const want = extrasFrom(list, refs, guildId).extras;
  return {
    field: "permissions",
    listed,
    before: displayExtras(before, refs, guildId),
    after: displayExtras(want, refs, guildId),
    differs: !extrasEqual(before, want),
    wantRaw: want,
  };
}


// The value a field holds when nothing set it, for telling a blueprint that
// left a setting out from one that set it on purpose.
export function isDefaultValue(field: string, value: unknown): boolean {
  switch (field) {
    case "topic": return value === "" || value === null;
    case "slowmode": return value === 0;
    case "nsfw":
    case "hoist":
    case "mentionable":
    case "read_only": return value === false;
    case "color": return value === null;
    case "private_to": return value === "everyone";
    case "posting_roles":
    case "permissions": return Array.isArray(value) && value.length === 0;
    default: return false;
  }
}
