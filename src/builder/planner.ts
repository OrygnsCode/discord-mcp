import { plainText, quoted } from "../discord/names.js";
import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildChannelLite } from "../discord/guildData.js";
import {
  computeChannelPermissions,
  describePermissions,
  highestRolePosition,
  parsePermissionNames,
  PERMISSION_PRESETS,
  ALL_PERMISSIONS,
  type RoleLite,
} from "../discord/preflight.js";
import {
  normalizedChannelName,
  type Blueprint,
  type BlueprintRolePermission,
  DISCORD_LIMITS,
} from "./blueprint.js";
import {
  bindBlueprint,
  channelKey,
  compareCategory,
  compareChannel,
  compareRole,
  familyOfKind,
  isDefaultValue,
  liveSend,
  livePrivacy,
  privacyEquals,
  privacyFrom,
  roleRefs,
  displayPrivacy,
  TYPE_CODES,
  typeName,
  type FieldDiff,
  type Privacy,
  type RoleRefs,
  displayExtras,
  extrasEqual,
  extrasFrom,
  liveExtras,
  type Extras,
} from "./compare.js";
import { gateBitsFor, gateBitsForType, SEND_FAMILY } from "./overwrites.js";

// The planner. Takes a blueprint plus a snapshot of the live server and
// produces either an ordered, executable plan or a list of everything
// wrong with the request. Pure: no network, no side effects, fully unit
// testable. Every edge case caught here is a Discord 400 that never
// happens and a half-built server that never exists.
//
// By default a plan only adds: anything the blueprint names that already
// exists is reused as it is. With updateExisting, existing items are
// brought in line with the blueprint, under one rule: an item changes only
// the settings the blueprint lists for it. A hand-written {name: "Mod"}
// therefore changes nothing about Mod, rather than stripping its
// permissions. To clear a setting, list it empty.

const P = PermissionFlagsBits;

// Discord structural limits, shared with the schema caps in blueprint.ts.
// The planner checks them against existing counts plus what the blueprint
// adds, which is the check that catches a real overflow.
const MAX_CHANNELS_PER_GUILD = DISCORD_LIMITS.channelsPerGuild;
const MAX_ROLES_PER_GUILD = DISCORD_LIMITS.rolesPerGuild;
const MAX_CHANNELS_PER_CATEGORY = DISCORD_LIMITS.channelsPerCategory;

// Channel types that only work when the guild has the COMMUNITY feature.
// Verified empirically against the live API in June 2026: forum channels
// create fine on a plain server, while announcement and stage channels
// come back 400 (codes 50035 and 50024) until Community is enabled.
const COMMUNITY_ONLY_TYPES = new Set(["announcement", "stage"]);

// Permissions worth a second look when a role gains them.
const SENSITIVE =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageWebhooks |
  P.BanMembers |
  P.KickMembers |
  P.ModerateMembers |
  P.ManageMessages |
  P.MentionEveryone;

// Settings a blueprint can leave out on purpose. Name, type, and placement
// are structure, not settings, and are never reported as kept.
const KEEPABLE = new Set([
  "permissions",
  "color",
  "hoist",
  "mentionable",
  "topic",
  "slowmode",
  "nsfw",
  "private_to",
  "read_only",
  "posting_roles",
]);

export type StepAction =
  | "create_role"
  | "create_category"
  | "create_channel"
  | "update_role"
  | "update_category"
  | "update_channel"
  | "delete_channel"
  | "delete_category"
  | "delete_role";

export interface StepChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface PlanStep {
  order: number;
  action: StepAction;
  name: string;
  // The live item an update step changes.
  id?: string;
  // Set on a create step when the entity already exists and is reused.
  exists?: { id: string; note: string };
  details: Record<string, unknown>;
  // Update steps: each change, before and after.
  changes?: StepChange[];
  // Update steps: settings this item has on the server that the blueprint
  // does not list, and which therefore stay as they are.
  kept?: string[];
  // Changes that loosen access or grant powerful permissions.
  risks?: string[];
  // A create step that gives @everyone, or a role already on the server,
  // something powerful in the new channel or category. People hold those
  // already, so this hands power out the moment it is built; a role the
  // same blueprint creates has no members yet and hands out nothing.
  hands_out?: string[];
}

export interface LiveState {
  channels: GuildChannelLite[];
  roles: RoleLite[];
  guildFeatures: string[];
  botPermissions: bigint;
  // Channels that exist but are hidden from the bot (no View Channel), which
  // Discord leaves out of `channels`. Only id, type, position, and parent are
  // known. Undefined when unknown (no gateway data for this bot).
  hiddenChannels?: Array<{ id: string; type: number; parent_id: string | null }>;
  // Needed for editing existing items: whose overwrites to check and where
  // the bot sits in the role hierarchy.
  guildId?: string;
  botUserId?: string;
  botRoleIds?: string[];
  // What server settings point at which channels, for deletions: deleting
  // the system messages channel clears that setting, and Discord refuses to
  // delete the rules or updates channel of a Community server at all.
  channelUses?: Array<{ id: string; use: string; required: boolean; field?: string }>;
  // Members per role, from Discord's member-counts endpoint. A role it
  // leaves out has none. Undefined when the count could not be read.
  roleMemberCounts?: Record<string, number>;
}

// Items to delete, by name or id. A separate list from the blueprint on
// purpose: a saved design never carries deletions to another server, and
// leaving something out of a blueprint never deletes it.
export interface RemoveRequest {
  roles?: string[];
  categories?: string[];
  channels?: string[];
}

export interface PlanOptions {
  updateExisting?: boolean;
  remove?: RemoveRequest;
}

export interface PlanResult {
  steps: PlanStep[];
  warnings: string[];
  errors: string[];
}

// Privacy and send settings an update step applies, by role key (see
// compare.ts). gate says whose bits gate viewing: the channel's own kind,
// or the category's when a synced channel follows its category.
export interface PrivacyApply {
  private: boolean;
  roles: string[];
  gate: "channel" | "category";
}
export interface SendApply {
  readOnly: boolean;
  postingRoles: string[];
}

function overwritesEqual(
  a: GuildChannelLite["permission_overwrites"],
  b: GuildChannelLite["permission_overwrites"]
): boolean {
  const key = (o: { id: string; type: number; allow: string; deny: string }) =>
    `${o.id}:${o.type}:${o.allow}:${o.deny}`;
  const left = (a ?? []).map(key).sort();
  const right = (b ?? []).map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

function permissionNames(bits: bigint): string {
  return describePermissions(bits).join(", ");
}

function loosening(before: Privacy, after: Privacy, refs: RoleRefs): string | null {
  if (before === null) return null;
  if (after === null) return "becomes visible to everyone";
  const added = after.filter((k) => !before.includes(k));
  return added.length > 0
    ? `becomes visible to ${added.map((k) => quoted(refs.display(k))).join(", ")}`
    : null;
}

export function buildPlan(
  blueprint: Blueprint,
  live: LiveState,
  options: PlanOptions = {}
): PlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: PlanStep[] = [];
  let order = 1;
  const hidden = live.hiddenChannels;
  const update = options.updateExisting === true;

  const roles = blueprint.roles ?? [];
  const categories = blueprint.categories ?? [];
  const topLevel = blueprint.channels ?? [];

  const removing =
    (options.remove?.roles?.length ?? 0) +
    (options.remove?.categories?.length ?? 0) +
    (options.remove?.channels?.length ?? 0);
  if (roles.length === 0 && categories.length === 0 && topLevel.length === 0 && removing === 0) {
    return {
      steps: [],
      warnings: [],
      errors: ["The blueprint is empty. Provide roles, categories, or channels, or items to remove."],
    };
  }

  const guildId =
    live.guildId ?? live.roles.find((r) => r.name === "@everyone")?.id ?? "";
  const bindings = bindBlueprint(
    blueprint,
    live.channels,
    live.roles,
    guildId,
    new Set((hidden ?? []).map((h) => h.id))
  );
  errors.push(...bindings.errors);
  warnings.push(...bindings.notes);
  if (bindings.ambiguous.length > 0) {
    if (update) {
      for (const a of bindings.ambiguous) {
        errors.push(
          `${a} Which one to change is a guess, so the plan stops. Use the id ` +
            "from export_server_blueprint for that item."
        );
      }
    } else {
      for (const a of bindings.ambiguous) {
        warnings.push(`${a} The first one is reused.`);
      }
    }
  }
  const refs = roleRefs(bindings, live.roles, guildId);

  // Known role names: blueprint roles plus live roles. private_to and
  // posting_roles may reference either.
  function checkRoleRefs(refsList: string[] | null | undefined, where: string): void {
    for (const ref of refsList ?? []) {
      if (!refs.key(ref)) {
        errors.push(
          `${where} references role "${ref}", which is neither in the ` +
            "blueprint nor on the server. Add the role or fix the name."
        );
      }
    }
  }

  // A blueprint item's permissions list: unknown names and anything that
  // contradicts its own visibility settings are errors (those bits belong to
  // private_to, read_only, and posting_roles), and powerful grants are risks.
  // Per label: the grants among its risks that go to people who exist.
  const handedOut = new Map<string, string[]>();
  function checkExtras(
    list: BlueprintRolePermission[] | undefined,
    label: string,
    gate: bigint,
    privacy: Privacy,
    readOnly: boolean,
    posting: string[]
  ): string[] {
    if (!list) return [];
    const parsed = extrasFrom(list, refs, guildId);
    for (const r of parsed.unknownRoles) {
      errors.push(`${label} sets permissions for role "${r}", which is neither in the blueprint nor on the server.`);
    }
    if (parsed.unknownPermissions.length > 0) {
      errors.push(`${label} uses unknown permission name(s): ${[...new Set(parsed.unknownPermissions)].join(", ")}.`);
    }
    for (const r of parsed.overlaps) {
      errors.push(`${label} both allows and denies the same permission for ${r}.`);
    }
    const everyoneKey = `id:${guildId}`;
    const managed = (privacy !== null ? gate : 0n) | (readOnly ? SEND_FAMILY : 0n);
    const risks: string[] = [];
    for (const [key, bits] of parsed.extras) {
      const who = key === everyoneKey ? "@everyone" : quoted(refs.display(key));
      const sugarAllow =
        (privacy !== null && privacy.includes(key) ? gate : 0n) |
        (readOnly && posting.includes(key) ? SEND_FAMILY : 0n);
      const sugarDeny = key === everyoneKey ? managed : 0n;
      const badAllow = bits.allow & managed & ~sugarAllow;
      const badDeny = bits.deny & managed & ~sugarDeny;
      if (badAllow !== 0n || badDeny !== 0n) {
        errors.push(
          `${label} ` +
            [badAllow ? `allows ${permissionNames(badAllow)}` : "", badDeny ? `denies ${permissionNames(badDeny)}` : ""]
              .filter(Boolean)
              .join(" and ") +
            ` for ${who}, which private_to, read_only, and posting_roles decide there. Change those instead.`
        );
      }
      const powerful = bits.allow & ~managed & SENSITIVE;
      if (powerful !== 0n) {
        risks.push(`${who} gets ${permissionNames(powerful)} here`);
        // "id:" keys are roles on the server, @everyone among them.
        if (key.startsWith("id:")) {
          handedOut.set(label, [...(handedOut.get(label) ?? []), `${who} gets ${permissionNames(powerful)}`]);
        }
      }
    }
    return risks;
  }
  // The listed roles whose extras differ from a live item's, as an apply
  // entry and a change to show.
  function extrasUpdate(
    existing: GuildChannelLite,
    diff: FieldDiff | undefined
  ): { apply: Array<{ role: string; allow: string; deny: string }>; shown: StepChange; bits: bigint; risks: string[] } | null {
    if (!diff || !diff.listed) return null;
    const want = diff.wantRaw as Extras;
    const now = liveExtras(existing, guildId);
    const changed = [...want.keys()].filter((k) => !extrasEqual(now, want, [k]));
    if (changed.length === 0) return null;
    let bits = 0n;
    const risks: string[] = [];
    for (const k of changed) {
      const w = want.get(k) ?? { allow: 0n, deny: 0n };
      bits |= w.allow | w.deny | (now.get(k)?.allow ?? 0n) | (now.get(k)?.deny ?? 0n);
      const gained = w.allow & ~(now.get(k)?.allow ?? 0n) & SENSITIVE;
      if (gained !== 0n) risks.push(`${k === `id:${guildId}` ? "@everyone" : quoted(refs.display(k))} gets ${permissionNames(gained)} here`);
    }
    return {
      apply: changed.map((k) => ({
        role: k,
        allow: String(want.get(k)?.allow ?? 0n),
        deny: String(want.get(k)?.deny ?? 0n),
      })),
      shown: {
        field: "permissions",
        before: displayExtras(now, refs, guildId, changed),
        after: displayExtras(want, refs, guildId, changed),
      },
      bits,
      risks,
    };
  }

  // Permission preflight: what the whole plan needs from the bot.
  const isAdmin = live.botPermissions === ALL_PERMISSIONS;
  const allBpChannels = [
    ...topLevel,
    ...categories.flatMap((c) => c.channels),
  ];
  // A permissions list is written as overwrites, and overwrites need
  // Manage Roles as much as privacy does. Left out, a bot without it passed
  // planning and failed on the first such channel, mid-build.
  const needsRoles =
    roles.length > 0 ||
    allBpChannels.some(
      (c) =>
        (c.private_to !== undefined && c.private_to !== null) ||
        c.read_only === true ||
        (c.permissions?.length ?? 0) > 0
    ) ||
    categories.some(
      (c) => (c.private_to !== undefined && c.private_to !== null) || (c.permissions?.length ?? 0) > 0
    );
  if (!isAdmin) {
    if (allBpChannels.length > 0 || categories.length > 0) {
      if ((live.botPermissions & P.ManageChannels) === 0n) {
        errors.push(
          "The bot lacks Manage Channels, which this blueprint needs for " +
            "creating channels and categories."
        );
      }
    }
    if (needsRoles && (live.botPermissions & P.ManageRoles) === 0n) {
      errors.push(
        "The bot lacks Manage Roles, which this blueprint needs for " +
          "creating roles and setting channel visibility and permissions."
      );
    }
  }

  // What the bot can do in one existing channel, for edits. Administrator
  // bypasses overwrites; otherwise the channel's own overwrites decide.
  const botTop =
    live.botRoleIds !== undefined
      ? highestRolePosition(live.botRoleIds, live.roles)
      : null;
  function botCan(channel: GuildChannelLite): bigint {
    if (isAdmin || !live.botUserId || !live.botRoleIds) return live.botPermissions;
    return computeChannelPermissions(
      live.botUserId,
      live.botRoleIds,
      guildId,
      live.roles,
      channel.permission_overwrites ?? []
    );
  }
  function checkChannelEdit(
    channel: GuildChannelLite,
    label: string,
    scalarChange: boolean,
    overwriteBits: bigint
  ): void {
    if (isAdmin) return;
    const can = botCan(channel);
    if (scalarChange && (can & P.ManageChannels) === 0n) {
      errors.push(`The bot lacks Manage Channels in ${label}, so it cannot edit it.`);
    }
    if (overwriteBits !== 0n) {
      if ((can & P.ManageRoles) === 0n) {
        errors.push(`The bot lacks Manage Roles in ${label}, so it cannot change who can see or post there.`);
      }
      // Discord only lets a bot allow or deny permissions it has itself.
      // Without View Channel there is no privacy to set at all; anything
      // else missing is left as it is and said so.
      const missing = overwriteBits & ~can;
      if ((missing & P.ViewChannel) !== 0n) {
        errors.push(
          `The bot lacks View Channel in ${label}, so it cannot change who can see it.`
        );
      } else if (missing !== 0n) {
        const names = permissionNames(missing);
        warnings.push(
          `The bot lacks ${names} in ${label}, so it cannot change that part of who can ` +
            `see or post there. Give the bot's role ${names} to apply the change fully.`
        );
      }
    }
  }

  // Roles: duplicates inside the blueprint, permission validity, then the
  // create or reuse step for each.
  const seenRoleNames = new Set<string>();
  const roleUpdates: PlanStep[] = [];
  bindings.roles.forEach((binding) => {
    const role = binding.bp;
    const lower = role.name.toLowerCase();
    if (seenRoleNames.has(lower)) {
      errors.push(`The blueprint defines the role "${role.name}" twice.`);
      return;
    }
    seenRoleNames.add(lower);

    let bits = PERMISSION_PRESETS[role.preset ?? "none"];
    if (role.permissions && role.permissions.length > 0) {
      const parsed = parsePermissionNames(role.permissions);
      if (parsed.unknown.length > 0) {
        errors.push(
          `Role "${role.name}" uses unknown permission name(s): ` +
            parsed.unknown.join(", ") +
            "."
        );
      }
      bits |= parsed.bits;
    }

    const existing = binding.live;
    if (!existing && !isAdmin) {
      const beyond = bits & ~live.botPermissions;
      if (beyond !== 0n) {
        errors.push(
          `Role "${role.name}" would grant permissions the bot itself ` +
            "lacks, which Discord rejects."
        );
      }
    }
    const createRisks =
      !existing && (bits & SENSITIVE) !== 0n
        ? [`grants ${permissionNames(bits & SENSITIVE)}`]
        : [];

    steps.push({
      order: order++,
      action: "create_role",
      name: role.name,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: update
                ? "Exists; any changes are listed in an update_role step."
                : "A role with this name already exists; it will be reused, not recreated.",
            },
          }
        : {}),
      details: {
        preset: role.preset ?? "none",
        extra_permissions: role.permissions ?? [],
        color: role.color ?? null,
        hoist: role.hoist ?? false,
        mentionable: role.mentionable ?? false,
      },
      ...(createRisks.length > 0 ? { risks: createRisks } : {}),
    });

    if (!update || !existing) return;
    const diffs = compareRole(binding);
    const changes = diffs.filter((d) => d.listed && d.differs);
    noteKept(binding.by === "id", `Role "${role.name}"`, diffs);
    if (changes.length === 0) return;

    const label = `role "${existing.name}"`;
    if ((existing as RoleLite & { managed?: boolean }).managed) {
      errors.push(
        `The ${label} is managed by an integration (a bot or a subscription), and ` +
          "Discord does not allow editing it."
      );
      return;
    }
    if (botTop !== null && existing.position >= botTop) {
      errors.push(
        `The ${label} sits at or above the bot's highest role, so Discord will not ` +
          "let the bot edit it. Move the bot's role above it first."
      );
      return;
    }
    const apply: Record<string, unknown> = {};
    const risks: string[] = [];
    for (const c of changes) {
      if (c.field === "name") apply.name = role.name;
      if (c.field === "permissions") {
        const want = c.wantRaw as bigint;
        const gained = want & ~BigInt(existing.permissions);
        if (!isAdmin && (gained & ~live.botPermissions) !== 0n) {
          errors.push(
            `The ${label} would gain ${permissionNames(gained & ~live.botPermissions)}, ` +
              "which the bot itself lacks, and Discord rejects that."
          );
        }
        if ((gained & SENSITIVE) !== 0n) {
          risks.push(`gains ${permissionNames(gained & SENSITIVE)}`);
        }
        apply.permissions = want.toString();
      }
      if (c.field === "color") {
        apply.color = role.color ? parseInt(role.color.replace(/^#/, ""), 16) : 0;
      }
      if (c.field === "hoist") apply.hoist = role.hoist;
      if (c.field === "mentionable") apply.mentionable = role.mentionable;
    }
    roleUpdates.push({
      order: 0,
      action: "update_role",
      name: role.name,
      id: existing.id,
      details: { apply },
      changes: changes.map(({ field, before, after }) => ({ field, before, after })),
      ...keptFor(diffs),
      ...(risks.length > 0 ? { risks } : {}),
    });
  });

  // Role count limit, counting only roles that will actually be created.
  const newRoleCount = steps.filter(
    (s) => s.action === "create_role" && !s.exists
  ).length;
  if (live.roles.length + newRoleCount > MAX_ROLES_PER_GUILD) {
    errors.push(
      `This plan would put the server over Discord's ${MAX_ROLES_PER_GUILD} ` +
        "role limit."
    );
  }
  for (const s of roleUpdates) steps.push({ ...s, order: order++ });

  // Settings the server has but the blueprint left out. They stay as they
  // are. From an export (bound by id) a missing setting usually means it was
  // deleted in order to clear it, so that case also says how to clear one.
  // Only settings a whole description of the item would have listed
  // differently: a value the item would have anyway (a default, or what its
  // category gives it) is not worth a word.
  function unlisted(diffs: FieldDiff[]): FieldDiff[] {
    return diffs.filter(
      (d) => !d.listed && d.differs && KEEPABLE.has(d.field) && !isDefaultValue(d.field, d.before)
    );
  }
  function noteKept(byId: boolean, label: string, diffs: FieldDiff[]): void {
    if (!update || !byId) return;
    const left = unlisted(diffs);
    if (left.length === 0) return;
    warnings.push(
      `${label} has ${left.map((d) => d.field).join(", ")} set on the server but not in ` +
        "the blueprint, so they stay as they are. To clear one, list it empty " +
        '(topic "", slowmode_seconds 0, private_to null, read_only false, color null).'
    );
  }
  function keptFor(diffs: FieldDiff[]): { kept?: string[] } {
    const left = unlisted(diffs);
    return left.length > 0 ? { kept: left.map((d) => d.field) } : {};
  }

  // Categories: duplicates, the channel-per-category limit, create or
  // reuse, and edits.
  const liveCategoryNames = new Map(
    live.channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? ""])
  );
  const seenCategoryNames = new Set<string>();
  const categoryUpdates: PlanStep[] = [];
  // Categories whose privacy changes, with what it changes to, so synced
  // channels inside can follow.
  const categoryPrivacyChange = new Map<string, Privacy>();
  const categoryExtrasChange = new Map<string, NonNullable<ReturnType<typeof extrasUpdate>>>();
  bindings.categories.forEach((binding) => {
    const cat = binding.bp;
    const lower = cat.name.toLowerCase();
    if (seenCategoryNames.has(lower)) {
      errors.push(`The blueprint defines the category "${cat.name}" twice.`);
      return;
    }
    seenCategoryNames.add(lower);
    checkRoleRefs(cat.private_to, `Category "${cat.name}"`);

    if (cat.channels.length > MAX_CHANNELS_PER_CATEGORY) {
      errors.push(
        `Category "${cat.name}" holds ${cat.channels.length} channels; ` +
          `Discord allows ${MAX_CHANNELS_PER_CATEGORY} per category.`
      );
    }
    const existing = binding.live;
    const catPrivacy: Privacy =
      cat.private_to !== undefined
        ? privacyFrom(cat.private_to, refs).privacy
        : existing
          ? livePrivacy(existing, guildId)
          : null;
    const catExtraRisks = checkExtras(cat.permissions, `Category "${cat.name}"`, gateBitsForType(4), catPrivacy, false, []);

    steps.push({
      order: order++,
      action: "create_category",
      name: cat.name,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: update
                ? "Exists; any changes are listed in an update_category step."
                : "A category with this name already exists; new channels will be placed inside it.",
            },
          }
        : {}),
      details: { private_to: cat.private_to ?? null, permissions: cat.permissions ?? null },
      ...(!existing && catExtraRisks.length > 0 ? { risks: catExtraRisks } : {}),
      ...(!existing && handedOut.has(`Category "${cat.name}"`) ? { hands_out: handedOut.get(`Category "${cat.name}"`) } : {}),
    });

    if (!update || !existing) return;
    const diffs = compareCategory(binding, refs, guildId);
    const changes = diffs.filter((d) => d.listed && d.differs);
    noteKept(binding.by === "id", `Category "${cat.name}"`, diffs);
    if (changes.length === 0) return;

    const apply: Record<string, unknown> = {};
    const risks: string[] = [];
    let overwriteBits = 0n;
    for (const c of changes) {
      if (c.field === "name") apply.name = cat.name;
      if (c.field === "private_to") {
        const want = c.wantRaw as Privacy;
        apply.privacy = {
          private: want !== null,
          roles: want ?? [],
          gate: "category",
        } satisfies PrivacyApply;
        overwriteBits |= gateBitsForType(4);
        categoryPrivacyChange.set(existing.id, want);
        const loose = loosening(livePrivacy(existing, guildId), want, refs);
        if (loose) risks.push(`${loose}; a channel in it changes only through a step of its own in this plan`);
      }
    }
    const catExtras = extrasUpdate(existing, diffs.find((d) => d.field === "permissions"));
    if (catExtras) {
      apply.extras = catExtras.apply;
      overwriteBits |= catExtras.bits;
      risks.push(...catExtras.risks);
      categoryExtrasChange.set(existing.id, catExtras);
    }
    checkChannelEdit(existing, `the category ${quoted(existing.name)}`, apply.name !== undefined, overwriteBits);
    categoryUpdates.push({
      order: 0,
      action: "update_category",
      name: cat.name,
      id: existing.id,
      details: { apply },
      changes: [
        ...changes.filter((c) => c.field !== "permissions").map(({ field, before, after }) => ({ field, before, after })),
        ...(catExtras ? [catExtras.shown] : []),
      ],
      ...keptFor(diffs),
      ...(risks.length > 0 ? { risks } : {}),
    });
  });
  for (const s of categoryUpdates) steps.push({ ...s, order: order++ });

  // Channels: normalized-name duplicates inside the blueprint, type and
  // feature checks, option sanity, then create or reuse and edits.
  const seenChannelNames = new Set<string>();
  const channelUpdates = new Map<string, PlanStep>();
  // Where each channel ends up, for the per-category limit.
  const movedInto = new Map<string, number>();
  const createdInto = new Map<string, number>();
  const hasCommunity = live.guildFeatures.includes("COMMUNITY");

  bindings.channels.forEach((binding) => {
    const channel = binding.bp;
    const category =
      binding.categoryIndex === null ? undefined : categories[binding.categoryIndex];
    const existing = binding.live;
    // An entry without a type is text when new, and the kind of channel it
    // matched when it exists, so editing a voice channel by id needs no type.
    const kind = channel.type ?? (existing ? typeName(existing.type) ?? "text" : "text");
    const normalized = normalizedChannelName(channel.name, kind);
    const family = familyOfKind(kind);
    const collisionKey = channelKey(channel.name, kind);

    if (seenChannelNames.has(collisionKey)) {
      errors.push(
        `Two blueprint ${family} channels collapse to the same name ` +
          `"${normalized}" after Discord's renaming rules. Rename one of them.`
      );
      return;
    }
    seenChannelNames.add(collisionKey);

    // Only creating or converting needs Community; an existing announcement
    // channel the plan leaves alone does not.
    const becomesKind = !existing || typeName(existing.type) !== kind;
    if (COMMUNITY_ONLY_TYPES.has(kind) && !hasCommunity && becomesKind) {
      errors.push(
        `Channel "${channel.name}" is a ${kind} channel, which needs the ` +
          "server to have Community enabled (Server Settings, Enable " +
          "Community). Enable it or use a text channel."
      );
    }

    if (channel.topic && (kind === "voice" || kind === "stage")) {
      warnings.push(
        `Channel "${channel.name}" is ${kind}; Discord has no topics ` +
          "there, so the topic will be dropped."
      );
    }
    const liveReadOnly = existing ? liveSend(existing, guildId).readOnly : false;
    const effectiveReadOnly =
      channel.read_only ?? (update && existing ? liveReadOnly : false);
    if ((channel.posting_roles?.length ?? 0) > 0 && !effectiveReadOnly) {
      errors.push(
        `Channel "${channel.name}" sets posting_roles without read_only. ` +
          "posting_roles only makes sense for read_only channels."
      );
    }
    checkRoleRefs(channel.private_to, `Channel "${channel.name}"`);
    checkRoleRefs(channel.posting_roles, `Channel "${channel.name}"`);
    const parentLive = category
      ? bindings.categories.find((b) => b.bp === category)?.live
      : undefined;
    const chanPrivacy: Privacy =
      channel.private_to !== undefined
        ? privacyFrom(channel.private_to, refs).privacy
        : existing
          ? livePrivacy(existing, guildId)
          : category && category.private_to !== undefined
            ? privacyFrom(category.private_to, refs).privacy
            : parentLive
              ? livePrivacy(parentLive, guildId)
              : null;
    const chanPosting =
      channel.posting_roles !== undefined
        ? privacyFrom(channel.posting_roles, refs).privacy ?? []
        : existing
          ? liveSend(existing, guildId).posting
          : [];
    const chanExtraRisks = checkExtras(
      channel.permissions,
      `Channel "${channel.name}"`,
      gateBitsFor(kind) | P.Connect,
      chanPrivacy,
      effectiveReadOnly,
      chanPosting
    );

    if (!existing && category) {
      createdInto.set(category.name.toLowerCase(), (createdInto.get(category.name.toLowerCase()) ?? 0) + 1);
    }

    steps.push({
      order: order++,
      action: "create_channel",
      name: normalized,
      ...(existing
        ? {
            exists: {
              id: existing.id,
              note: update
                ? "Exists; any changes are listed in an update_channel step."
                : "A channel with this name already exists and will be left untouched.",
            },
          }
        : {}),
      details: {
        type: kind,
        type_code: TYPE_CODES[kind],
        category: category?.name ?? null,
        topic:
          kind === "voice" || kind === "stage" ? null : channel.topic ?? null,
        slowmode_seconds: channel.slowmode_seconds ?? null,
        nsfw: channel.nsfw ?? false,
        // Undefined and null mean different things (follow the category,
        // visible to everyone), so both survive into the step.
        private_to: channel.private_to === undefined ? "inherit" : channel.private_to,
        read_only: channel.read_only ?? null,
        posting_roles: channel.posting_roles ?? null,
        permissions: channel.permissions ?? null,
      },
      ...(!existing && chanExtraRisks.length > 0 ? { risks: chanExtraRisks } : {}),
      ...(!existing && handedOut.has(`Channel "${channel.name}"`) ? { hands_out: handedOut.get(`Channel "${channel.name}"`) } : {}),
    });

    if (!update || !existing) return;
    const diffs = compareChannel(
      binding,
      blueprint,
      bindings.categories,
      liveCategoryNames,
      refs,
      guildId
    );
    // A channel listed inside a category that sets its privacy or permissions
    // follows them unless it sets its own: that is how a blueprint reads (an
    // export leaves a channel's privacy out when it matches its category's).
    // A channel synced to that category follows below, with the category's
    // change, which keeps it synced. One with permissions of its own (a
    // read-only channel, say) is not synced, so it follows here.
    const bpCategoryBinding =
      binding.categoryIndex === null ? undefined : bindings.categories[binding.categoryIndex];
    const syncedToItsCategory =
      bpCategoryBinding?.live !== undefined &&
      existing.parent_id === bpCategoryBinding.live.id &&
      overwritesEqual(existing.permission_overwrites, bpCategoryBinding.live.permission_overwrites);
    const followsPrivacy =
      category !== undefined && category.private_to !== undefined && channel.private_to === undefined && !syncedToItsCategory;
    const followsExtras =
      category !== undefined && category.permissions !== undefined && channel.permissions === undefined && !syncedToItsCategory;

    // Leaving out what a channel follows is not keeping it, and a synced
    // channel matches its category, so neither is worth a "kept" note. A
    // channel with permissions of its own in a category that does not set
    // them keeps its own, and the note says so.
    const ownDiffs = diffs.filter(
      (d) =>
        !(d.field === "private_to" && (followsPrivacy || syncedToItsCategory)) &&
        !(d.field === "permissions" && (followsExtras || syncedToItsCategory))
    );
    noteKept(binding.by === "id", `Channel "${channel.name}"`, ownDiffs);
    if (binding.by === "id" && binding.categoryIndex === null && existing.parent_id) {
      warnings.push(
        `Channel "${channel.name}" is at the top level of the blueprint but inside ` +
          `${liveCategoryNames.get(existing.parent_id) ?? "a category"} on the server. ` +
          'A blueprint does not move channels out of categories; use update_channel with category "none".'
      );
    }
    const changes = diffs.filter(
      (d) => d.listed && d.differs && !["private_to", "read_only", "posting_roles", "permissions"].includes(d.field)
    );
    const apply: Record<string, unknown> = {};
    const shown: StepChange[] = [];
    const risks: string[] = [];
    let scalar = false;
    let overwriteBits = 0n;

    for (const c of changes) {
      if (c.field === "name") {
        apply.name = normalized;
        scalar = true;
      } else if (c.field === "type") {
        const from = typeName(existing.type);
        const to = channel.type ?? "text";
        const convertible =
          (from === "text" && to === "announcement") ||
          (from === "announcement" && to === "text");
        if (!convertible) {
          errors.push(
            `Channel "${channel.name}" is ${from ?? "another type"} on the server; Discord ` +
              `can only switch text and announcement channels, not ${from ?? "it"} to ${to}.`
          );
          continue;
        }
        if (to === "announcement" && !hasCommunity) continue; // reported above
        apply.type = TYPE_CODES[to];
        scalar = true;
      } else if (c.field === "topic") {
        apply.topic = channel.topic ?? "";
        scalar = true;
      } else if (c.field === "slowmode") {
        apply.rate_limit_per_user = channel.slowmode_seconds ?? 0;
        scalar = true;
      } else if (c.field === "nsfw") {
        apply.nsfw = channel.nsfw ?? false;
        scalar = true;
      } else if (c.field === "category") {
        if (!category) continue;
        apply.parent = category.name;
        scalar = true;
        movedInto.set(category.name.toLowerCase(), (movedInto.get(category.name.toLowerCase()) ?? 0) + 1);
      }
      shown.push({ field: c.field, before: c.before, after: c.after });
    }

    // Privacy, when listed or followed. Synced channels following a category
    // are handled below, with the category's change.
    const privacyDiff = diffs.find((d) => d.field === "private_to");
    if (privacyDiff && (privacyDiff.listed || followsPrivacy) && privacyDiff.differs) {
      const want = privacyDiff.wantRaw as Privacy;
      apply.privacy = { private: want !== null, roles: want ?? [], gate: "channel" } satisfies PrivacyApply;
      overwriteBits |= gateBitsForType(existing.type);
      shown.push({ field: "private_to", before: privacyDiff.before, after: privacyDiff.after });
      const loose = loosening(livePrivacy(existing, guildId), want, refs);
      if (loose) risks.push(loose);
    }

    // Read-only and posting roles, only when one of them is listed. A
    // listed posting_roles on a channel that is already read-only keeps it
    // read-only.
    if (channel.read_only !== undefined || channel.posting_roles !== undefined) {
      const now = liveSend(existing, guildId);
      const wantReadOnly = channel.read_only ?? now.readOnly;
      const wantPosting = wantReadOnly
        ? channel.posting_roles !== undefined
          ? privacyFrom(channel.posting_roles, refs).privacy ?? []
          : now.posting
        : [];
      const readOnlyChanges = wantReadOnly !== now.readOnly;
      const postingChanges = wantReadOnly && !privacyEquals(now.posting, wantPosting);
      if (readOnlyChanges || postingChanges) {
        apply.send = { readOnly: wantReadOnly, postingRoles: wantPosting } satisfies SendApply;
        overwriteBits |= SEND_FAMILY;
        if (readOnlyChanges) {
          shown.push({ field: "read_only", before: now.readOnly, after: wantReadOnly });
          if (!wantReadOnly) risks.push("no longer read-only");
        }
        if (postingChanges) {
          shown.push({
            field: "posting_roles",
            before: now.posting.map((k) => refs.display(k)),
            after: wantPosting.map((k) => refs.display(k)),
          });
          const added = wantPosting.filter((k) => !now.posting.includes(k));
          if (added.length > 0 && now.readOnly) {
            risks.push(`${added.map((k) => quoted(refs.display(k))).join(", ")} can now post`);
          }
        }
      }
    }

    const extrasDiffOf = diffs.find((d) => d.field === "permissions");
    const chanExtras = extrasUpdate(
      existing,
      extrasDiffOf && followsExtras ? { ...extrasDiffOf, listed: true } : extrasDiffOf
    );
    if (chanExtras) {
      apply.extras = chanExtras.apply;
      overwriteBits |= chanExtras.bits;
      shown.push(chanExtras.shown);
      risks.push(...chanExtras.risks);
    }

    if (Object.keys(apply).length === 0) return;
    checkChannelEdit(existing, `#${plainText(existing.name)}`, scalar, overwriteBits);
    channelUpdates.set(existing.id, {
      order: 0,
      action: "update_channel",
      name: normalized,
      id: existing.id,
      details: {
        apply,
        ...((followsPrivacy && apply.privacy) || (followsExtras && apply.extras)
          ? { follows_category: category?.name }
          : {}),
      },
      changes: shown,
      ...keptFor(ownDiffs),
      ...(risks.length > 0 ? { risks } : {}),
    });
  });

  // Synced channels follow their category, as they do in Discord: each
  // channel whose overwrites match its category's exactly and that does not
  // set its own privacy in the blueprint gets a step of its own here. Discord
  // would make the same change by itself when the category's overwrites
  // change one at a time, but the executor holds synced channels while it
  // changes a category (see categorySync.ts), so that every channel that
  // changes is one this plan shows, and one the blueprint keeps as it is
  // stays that way.
  if (categoryPrivacyChange.size > 0) {
    const ownPrivacy = new Set(
      bindings.channels
        .filter((b) => b.live && b.bp.private_to !== undefined)
        .map((b) => b.live!.id)
    );
    const listedIds = new Set(bindings.channels.flatMap((b) => (b.live ? [b.live.id] : [])));
    for (const [catId, want] of categoryPrivacyChange) {
      const parent = live.channels.find((c) => c.id === catId);
      if (!parent) continue;
      const hiddenInside = (hidden ?? []).filter((h) => h.parent_id === catId).length;
      if (hiddenInside > 0) {
        warnings.push(
          `${hiddenInside} channel(s) in ${quoted(parent.name)} are hidden from the bot, so they keep ` +
            "their current permissions when the category's privacy changes."
        );
      }
      // Channels in it with permissions of their own that the blueprint does
      // not list keep their visibility, which is easy to assume otherwise.
      const keepOwn: string[] = [];
      for (const child of live.channels.filter((c) => c.parent_id === catId)) {
        if (ownPrivacy.has(child.id)) continue;
        if (!overwritesEqual(child.permission_overwrites, parent.permission_overwrites)) {
          if (!listedIds.has(child.id) && !privacyEquals(livePrivacy(child, guildId), want)) {
            keepOwn.push(child.type === 2 || child.type === 13 ? `${quoted(child.name)} (${child.type === 2 ? "voice" : "stage"})` : `#${plainText(child.name)}`);
          }
          continue;
        }
        const existingStep = channelUpdates.get(child.id);
        // One the plan moves to another category is leaving: it keeps the
        // permissions it has (the executor holds it while this category
        // changes) unless the blueprint says otherwise where it lands.
        if (existingStep && (existingStep.details.apply as Record<string, unknown>).parent !== undefined) continue;
        const step: PlanStep = existingStep ?? {
          order: 0,
          action: "update_channel",
          name: child.name ?? child.id,
          id: child.id,
          details: { apply: {} },
          changes: [],
        };
        const apply = step.details.apply as Record<string, unknown>;
        if (apply.privacy) continue;
        apply.privacy = { private: want !== null, roles: want ?? [], gate: "category" } satisfies PrivacyApply;
        step.changes = [
          ...(step.changes ?? []),
          {
            field: "private_to",
            before: displayPrivacy(livePrivacy(child, guildId), refs),
            after: displayPrivacy(want, refs),
          },
        ];
        step.details = { ...step.details, follows_category: liveCategoryNames.get(catId) ?? catId };
        checkChannelEdit(child, `#${plainText(child.name)}`, false, gateBitsForType(4));
        channelUpdates.set(child.id, step);
      }
      if (keepOwn.length > 0) {
        const one = keepOwn.length === 1;
        warnings.push(
          `In ${quoted(parent.name)}, ${keepOwn.join(", ")} ${one ? "has permissions of its" : "have permissions of their"} own ` +
            `and ${one ? "is" : "are"} not in the blueprint, so ${one ? "it keeps its" : "they keep their"} current visibility ` +
            `when the category's changes. List ${one ? "it" : "them"} in the category to change ${one ? "it" : "them"} too.`
        );
      }
    }
  }
  if (categoryExtrasChange.size > 0) {
    const ownExtras = new Set(
      bindings.channels.filter((b) => b.live && b.bp.permissions !== undefined).map((b) => b.live!.id)
    );
    for (const [catId, change] of categoryExtrasChange) {
      const parent = live.channels.find((c) => c.id === catId);
      if (!parent) continue;
      for (const child of live.channels.filter((c) => c.parent_id === catId)) {
        if (ownExtras.has(child.id)) continue;
        if (!overwritesEqual(child.permission_overwrites, parent.permission_overwrites)) continue;
        // As above: a channel on its way out of this category does not follow it.
        const leaving = channelUpdates.get(child.id);
        if (leaving && (leaving.details.apply as Record<string, unknown>).parent !== undefined) continue;
        const step: PlanStep = leaving ?? {
          order: 0,
          action: "update_channel",
          name: child.name ?? child.id,
          id: child.id,
          details: { apply: {} },
          changes: [],
        };
        const apply = step.details.apply as Record<string, unknown>;
        if (apply.extras) continue;
        apply.extras = change.apply;
        step.changes = [...(step.changes ?? []), change.shown];
        step.details = { ...step.details, follows_category: liveCategoryNames.get(catId) ?? catId };
        checkChannelEdit(child, `#${plainText(child.name)}`, false, change.bits);
        channelUpdates.set(child.id, step);
      }
    }
  }
  for (const s of channelUpdates.values()) steps.push({ ...s, order: order++ });

  // Deletions, last of all: if anything before them fails, nothing has been
  // deleted. Channels go first, then categories (whose remaining channels
  // Discord leaves without a category), then roles, once nothing the plan
  // touches refers to them.
  if (removing > 0) {
    const deletions = planDeletions();
    for (const s of deletions) steps.push({ ...s, order: order++ });
  }

  function planDeletions(): PlanStep[] {
    const out: PlanStep[] = [];
    const req = options.remove ?? {};
    const bound = new Map<string, string>();
    for (const b of bindings.roles) if (b.live) bound.set(b.live.id, `role "${b.bp.name}"`);
    for (const b of bindings.categories) if (b.live) bound.set(b.live.id, `category "${b.bp.name}"`);
    for (const b of bindings.channels) if (b.live) bound.set(b.live.id, `channel "${b.bp.name}"`);
    const seen = new Set<string>();
    const hiddenNote =
      hidden === undefined
        ? " It may also exist but be hidden from the bot, which only the default bot's gateway connection can tell."
        : hidden.length > 0
          ? ` ${hidden.length} channel(s) are hidden from the bot and cannot be removed by it.`
          : "";

    function resolve<T extends { id: string; name?: string | null }>(
      kind: string,
      ref: string,
      pool: T[],
      others: Array<{ kind: string; items: Array<{ id: string }> }>,
      alsoMatches?: (item: T, ref: string) => boolean
    ): T | undefined {
      const hashed = ref.trim().startsWith("#");
      const wanted = ref.trim().replace(/^[#@]/, "");
      if (/^\d{17,20}$/.test(wanted)) {
        const hit = pool.find((x) => x.id === wanted);
        if (hit) return hit;
        const elsewhere = others.find((o) => o.items.some((x) => x.id === wanted));
        errors.push(
          elsewhere
            ? `"${ref}" in remove.${kind}s is a ${elsewhere.kind}, not a ${kind}.`
            : `There is no ${kind} with the id ${wanted} on this server.${kind === "channel" || kind === "category" ? hiddenNote : ""}`
        );
        return undefined;
      }
      // An exact name wins; ignoring case is the fallback. Text names are
      // lowercase and voice names keep their case, so "general" is the text
      // channel and "General" the voice one. A leading # means a text one.
      const lower = wanted.toLowerCase();
      const candidates = hashed
        ? pool.filter((x) => {
            const t = (x as { type?: number }).type;
            return t !== 2 && t !== 13;
          })
        : pool;
      const exact = candidates.filter((x) => (x.name ?? "") === wanted);
      const matches =
        exact.length > 0
          ? exact
          : candidates.filter(
              (x) => (x.name ?? "").toLowerCase() === lower || (alsoMatches?.(x, wanted) ?? false)
            );
      if (matches.length > 1) {
        errors.push(
          `${matches.length} ${kind}s are named "${wanted}" (ids ${matches.map((m) => m.id).join(", ")}). ` +
            "Removing one is a guess, so the plan stops. List the id instead."
        );
        return undefined;
      }
      if (matches.length === 0) {
        errors.push(`There is no ${kind} named "${wanted}" on this server.${kind === "channel" || kind === "category" ? hiddenNote : ""}`);
        return undefined;
      }
      return matches[0];
    }

    function claim(id: string, label: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      const inBlueprint = bound.get(id);
      if (inBlueprint) {
        errors.push(`${label} is listed for removal but is also the blueprint's ${inBlueprint}. Keep one.`);
        return false;
      }
      return true;
    }

    const liveRoles = live.roles.filter((r) => r.id !== guildId);
    const liveCategories = live.channels.filter((c) => c.type === 4);
    const liveChannels = live.channels.filter((c) => c.type !== 4);
    const usesOf = (id: string) => (live.channelUses ?? []).filter((u) => u.id === id);

    // Channels.
    const removedChannelIds = new Set<string>();
    for (const ref of req.channels ?? []) {
      const c = resolve("channel", ref, liveChannels, [
        { kind: "category", items: liveCategories },
        { kind: "role", items: liveRoles },
      ], (x, wanted) => x.type !== 2 && x.type !== 13 && x.name === normalizedChannelName(wanted, "text"));
      if (!c || !claim(c.id, `#${plainText(c.name)}`)) continue;
      removedChannelIds.add(c.id);
      const label = `#${plainText(c.name)}`;
      const uses = usesOf(c.id);
      const required = uses.filter((u) => u.required);
      if (required.length > 0) {
        errors.push(
          `${label} is this server's ${required.map((u) => u.use).join(" and ")}, which Discord ` +
            "requires while Community is on, so it refuses to delete it. Choose another channel " +
            "for that in Server Settings first."
        );
        continue;
      }
      if (!isAdmin && (botCan(c) & P.ManageChannels) === 0n) {
        errors.push(`The bot lacks Manage Channels in ${label}, so it cannot delete it.`);
      }
      const hasMessages = Boolean((c as GuildChannelLite & { last_message_id?: string | null }).last_message_id);
      const loses = [
        hasMessages
          ? "its messages, threads, pins, invites, and webhooks, for good"
          : "the channel itself (it has never had a message)",
        ...uses.map((u) => `its place as the ${u.use}, which is left unset`),
      ];
      if (uses.length > 0) {
        warnings.push(`Deleting ${label} clears the server's ${uses.map((u) => u.use).join(", ")} setting.`);
      }
      out.push({
        order: 0,
        action: "delete_channel",
        name: c.name ?? c.id,
        id: c.id,
        details: { type: typeName(c.type) ?? `type ${c.type}`, loses },
        ...(hasMessages ? { risks: ["its messages are deleted for good"] } : {}),
      });
    }

    // Categories.
    const movedOut = new Set(
      [...channelUpdates.values()]
        .filter((s) => (s.details.apply as Record<string, unknown>).parent !== undefined)
        .map((s) => s.id)
    );
    for (const ref of req.categories ?? []) {
      const c = resolve("category", ref, liveCategories, [
        { kind: "channel", items: liveChannels },
        { kind: "role", items: liveRoles },
      ]);
      if (!c || !claim(c.id, `the category ${quoted(c.name)}`)) continue;
      if (!isAdmin && (botCan(c) & P.ManageChannels) === 0n) {
        errors.push(`The bot lacks Manage Channels in the category ${quoted(c.name)}, so it cannot delete it.`);
      }
      const leftBehind = live.channels
        .filter((x) => x.parent_id === c.id && !removedChannelIds.has(x.id) && !movedOut.has(x.id))
        .map((x) => x.name ?? x.id);
      const hiddenInside = (hidden ?? []).filter((h) => h.parent_id === c.id).length;
      out.push({
        order: 0,
        action: "delete_category",
        name: c.name ?? c.id,
        id: c.id,
        details: {
          loses: ["the category; the channels in it are not deleted"],
          ...(leftBehind.length > 0 || hiddenInside > 0
            ? {
                left_without_category: [
                  ...leftBehind,
                  ...(hiddenInside > 0 ? [`${hiddenInside} channel(s) hidden from the bot`] : []),
                ],
              }
            : {}),
        },
      });
    }

    // Roles.
    const referenced = new Set<string>();
    const noteRefs = (names: string[] | null | undefined) => {
      for (const n of names ?? []) {
        const k = refs.key(n);
        if (k) referenced.add(k);
      }
    };
    // A permissions list names roles too. Without these, a role could be
    // given permissions on a channel and deleted by the same plan.
    const listed = (list: BlueprintRolePermission[] | undefined) => list?.map((x) => x.role);
    for (const cat of categories) {
      noteRefs(cat.private_to);
      noteRefs(listed(cat.permissions));
      for (const ch of cat.channels) {
        noteRefs(ch.private_to);
        noteRefs(ch.posting_roles);
        noteRefs(listed(ch.permissions));
      }
    }
    for (const ch of topLevel) {
      noteRefs(ch.private_to);
      noteRefs(ch.posting_roles);
      noteRefs(listed(ch.permissions));
    }
    const roleRemovals: PlanStep[] = [];
    for (const ref of req.roles ?? []) {
      const r = resolve("role", ref, liveRoles, [
        { kind: "channel", items: liveChannels },
        { kind: "category", items: liveCategories },
      ]);
      if (!r || !claim(r.id, `the role ${quoted(r.name)}`)) continue;
      const label = `the role ${quoted(r.name)}`;
      if (referenced.has(`id:${r.id}`)) {
        errors.push(`${label} is listed for removal but the blueprint still gives it access somewhere. Keep one.`);
        continue;
      }
      if ((r as RoleLite & { managed?: boolean }).managed) {
        errors.push(`${label} is managed by an integration (a bot or a subscription); Discord does not allow deleting it.`);
        continue;
      }
      if (botTop !== null && r.position >= botTop) {
        errors.push(`${label} sits at or above the bot's highest role, so Discord will not let the bot delete it.`);
        continue;
      }
      if (!isAdmin && (live.botPermissions & P.ManageRoles) === 0n) {
        errors.push(`The bot lacks Manage Roles, so it cannot delete ${label}.`);
      }
      const members = live.roleMemberCounts === undefined ? null : live.roleMemberCounts[r.id] ?? 0;
      const overwriteCount = live.channels.filter(
        (c) => !removedChannelIds.has(c.id) && (c.permission_overwrites ?? []).some((o) => o.id === r.id)
      ).length;
      const loses = [
        members === null
          ? "the role, from everyone who has it (the member count could not be read)"
          : members === 0
            ? "the role (nobody has it)"
            : `the role, from ${members} member${members === 1 ? "" : "s"}`,
        ...(overwriteCount > 0
          ? [`its permission settings in ${overwriteCount} channel${overwriteCount === 1 ? "" : "s"}`]
          : []),
      ];
      roleRemovals.push({
        order: 0,
        action: "delete_role",
        name: r.name ?? r.id,
        id: r.id,
        details: { loses },
        ...(members !== 0 ? { risks: [members === null ? "removed from everyone who has it" : `removed from ${members} member${members === 1 ? "" : "s"}`] } : {}),
      });
    }

    const channelSteps = out.filter((s) => s.action === "delete_channel");
    const categorySteps = out.filter((s) => s.action === "delete_category");
    return [...channelSteps, ...categorySteps, ...roleRemovals];
  }

  // An empty private_to means admins only. That is the literal reading and
  // the only way an export can carry such a channel, but an AI filling in an
  // empty list may have meant "no restriction", so say it out loud.
  const adminsOnly = steps
    .filter((s) => {
      if (s.action === "create_category" || s.action === "create_channel") {
        if (s.exists) return false;
        const p = s.details.private_to;
        return Array.isArray(p) && p.length === 0;
      }
      const privacy = (s.details.apply as Record<string, unknown> | undefined)?.privacy as PrivacyApply | undefined;
      return privacy !== undefined && privacy.private && privacy.roles.length === 0;
    })
    .map((s) => s.name);
  if (adminsOnly.length > 0) {
    warnings.push(
      `${adminsOnly.join(", ")} will be visible to admins only, because private_to is empty. ` +
        "Use private_to null to make a channel visible to everyone."
    );
  }

  // New channels get overwrites too, and the same rule applies to them.
  if (!isAdmin) {
    const newOnes = steps.filter((s) => s.action === "create_channel" && !s.exists);
    let needed = 0n;
    for (const s of newOnes) {
      if (s.details.read_only === true) needed |= SEND_FAMILY;
    }
    const missing = needed & ~live.botPermissions;
    if (missing !== 0n) {
      const names = permissionNames(missing);
      const one = describePermissions(missing).length === 1;
      warnings.push(
        `The bot lacks ${names}, so read-only channels this plan creates cannot take ` +
          `${one ? "it" : "them"} away from everyone. Give the bot's role ${names} to apply read-only fully.`
      );
    }
  }

  // Per-category limit, counting channels already there, hidden ones too
  // (their parent is one of the fields Discord does not obfuscate), plus
  // everything this plan creates or moves in.
  for (const binding of bindings.categories) {
    const lower = binding.bp.name.toLowerCase();
    const incoming = (createdInto.get(lower) ?? 0) + (movedInto.get(lower) ?? 0);
    if (incoming === 0) continue;
    const existingChildren = binding.live
      ? live.channels.filter((c) => c.parent_id === binding.live!.id).length +
        (hidden ?? []).filter((c) => c.parent_id === binding.live!.id).length
      : 0;
    if (existingChildren + incoming > MAX_CHANNELS_PER_CATEGORY) {
      errors.push(
        `Category "${binding.bp.name}" ${binding.live ? `has ${existingChildren} channels; adding` : "would get"} ` +
          `${incoming} more would pass the ${MAX_CHANNELS_PER_CATEGORY} per category limit.`
      );
    }
  }

  // Renames must not land on a name something else keeps. Discord allows
  // two channels or roles with one name, but every later blueprint and
  // name lookup would then have to guess between them.
  if (update) {
    const renamed = steps.filter(
      (s) => s.action.startsWith("update_") && (s.details.apply as Record<string, unknown>).name !== undefined
    );
    for (const s of renamed) {
      const wanted = String((s.details.apply as Record<string, unknown>).name);
      const newName = wanted.toLowerCase();
      let clash: string | undefined;
      if (s.action === "update_role") {
        clash = live.roles.find(
          (r) => r.id !== s.id && r.id !== guildId && (r.name ?? "").toLowerCase() === newName && !renamed.some((o) => o.id === r.id)
        )?.name ?? undefined;
      } else {
        const self = live.channels.find((c) => c.id === s.id);
        const sameNamespace = (c: GuildChannelLite) =>
          s.action === "update_category"
            ? c.type === 4
            : c.type !== 4 && self !== undefined && familyOfKind(typeName(c.type) ?? "text") === familyOfKind(typeName(self.type) ?? "text");
        clash = live.channels.find(
          (c) => c.id !== s.id && sameNamespace(c) && (c.name ?? "").toLowerCase() === newName && !renamed.some((o) => o.id === c.id)
        )?.name ?? undefined;
      }
      if (clash) {
        errors.push(
          `Renaming ${s.action === "update_role" ? "the role" : s.action === "update_category" ? "the category" : "the channel"} ` +
            `to "${wanted}" would give it the same name as an existing one. Rename or remove that one too.`
        );
      }
    }
  }

  // Total channel limit: live channels plus everything actually new.
  const newChannelCount = steps.filter(
    (s) =>
      (s.action === "create_channel" || s.action === "create_category") &&
      !s.exists
  ).length;
  const liveChannelCount = live.channels.length + (hidden?.length ?? 0);
  if (liveChannelCount + newChannelCount > MAX_CHANNELS_PER_GUILD) {
    errors.push(
      `This plan would put the server over Discord's ` +
        `${MAX_CHANNELS_PER_GUILD} channel limit.`
    );
  }

  // Name clashes are checked against the channels the bot can see. A channel
  // hidden from it cannot be compared, so one the blueprint names that
  // already exists among them would be created a second time.
  if (hidden === undefined) {
    warnings.push(
      "Channels hidden from the bot could not be checked for name clashes: whether any " +
        "exist is only known through the gateway connection of the default bot."
    );
  } else if (hidden.length > 0) {
    warnings.push(
      `${hidden.length} channel(s) in this server are hidden from the bot (no View ` +
        "Channel), so their names are unknown. A blueprint channel that already exists " +
        "among them would be created again. Give the bot View Channel on them first if " +
        "that matters."
    );
  }

  return { steps, warnings, errors };
}
