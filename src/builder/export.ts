import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildChannelLite } from "../discord/guildData.js";
import {
  compareRolesLowToHigh,
  describePermissions,
  type RoleLite,
} from "../discord/preflight.js";
import type { Blueprint, BlueprintChannel } from "./blueprint.js";
import { gateBitsForType, managedBits, readSugar } from "./overwrites.js";

// Snapshot a live server into a blueprint: the inverse of the build
// executor. Permission overwrites get decompiled back into the
// blueprint's visibility sugar (private_to, read_only, posting_roles);
// anything the sugar cannot express is captured approximately and
// reported as a warning instead of silently dropped. Pure, so the exact
// inversion rules are unit tested.

const P = PermissionFlagsBits;

// Discord's own limit on a role name.
const ROLE_NAME_MAX = 100;

const TYPE_NAMES: Record<number, BlueprintChannel["type"]> = {
  0: "text",
  2: "voice",
  5: "announcement",
  13: "stage",
  15: "forum",
};

interface Visibility {
  // Whether @everyone is denied View Channel. Private with no roles listed
  // means only admins can see it.
  private: boolean;
  privateTo: string[];
  readOnly: boolean;
  postingRoles: string[];
  leftovers: boolean;
  // Each role's bits outside privacy and read-only, by role id.
  extras: Map<string, { name: string; allow: bigint; deny: bigint }>;
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const lower = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => lower.has(x.toLowerCase()));
}

function sameOverwrites(a: GuildChannelLite, b: GuildChannelLite): boolean {
  const key = (c: GuildChannelLite) =>
    (c.permission_overwrites ?? []).map((o) => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort().join("|");
  return key(a) === key(b);
}

function sameVisibility(a: Visibility, b: Visibility): boolean {
  return a.private === b.private && (!a.private || setEquals(a.privateTo, b.privateTo));
}

// Decompiles one channel's overwrites into the sugar, with the same reading
// the planner uses (readSugar). The bot's own member overwrite is the
// build's self-allow and is ignored; anything else the sugar cannot carry
// (member overwrites, other bits, a role allowed in where nothing denies)
// flags the leftovers warning, since a rebuild would drop it.
function readVisibility(
  channel: GuildChannelLite,
  guildId: string,
  roleNames: Map<string, string>,
  botUserId: string | undefined
): Visibility {
  const overwrites = channel.permission_overwrites ?? [];
  const sugar = readSugar(overwrites, guildId);
  // The bits privacy and read-only control here; everything else a role
  // has is an extra, exported in `permissions`.
  const managed = managedBits(overwrites, guildId, gateBitsForType(channel.type));
  const out: Visibility = {
    private: sugar.private,
    privateTo: [],
    readOnly: sugar.readOnly,
    postingRoles: [],
    leftovers: false,
    extras: new Map(),
  };

  for (const ow of overwrites) {
    const allow = BigInt(ow.allow);
    const deny = BigInt(ow.deny);

    // The build's own self-allow is not part of the design. Any other
    // member's overwrite cannot be named in a blueprint.
    if (ow.type === 1) {
      if (botUserId && ow.id === botUserId) continue;
      out.leftovers = true;
      continue;
    }

    const name = ow.id === guildId ? "@everyone" : roleNames.get(ow.id);
    if (!name) {
      // A role an integration manages, which a blueprint does not define.
      out.leftovers = true;
      continue;
    }
    if (ow.id !== guildId) {
      // A role denied something privacy or read-only controls (a muted role
      // in a read-only channel, say) has no place in the sugar.
      if ((deny & managed) !== 0n) out.leftovers = true;
      if (sugar.private && (allow & P.ViewChannel) !== 0n) out.privateTo.push(name);
      if (sugar.readOnly && (allow & P.SendMessages) !== 0n) out.postingRoles.push(name);
    } else if ((allow & managed) !== 0n) {
      out.leftovers = true;
    }
    const extraAllow = allow & ~managed;
    const extraDeny = deny & ~managed;
    if (extraAllow !== 0n || extraDeny !== 0n) {
      out.extras.set(ow.id, { name, allow: extraAllow, deny: extraDeny });
    }
  }
  return out;
}

function extrasList(
  vis: Visibility,
  alsoClear: Visibility | undefined
): Array<{ role: string; allow?: string[]; deny?: string[] }> {
  const list: Array<{ role: string; allow?: string[]; deny?: string[] }> = [];
  for (const x of vis.extras.values()) {
    list.push({
      role: x.name,
      ...(x.allow ? { allow: describePermissions(x.allow) } : {}),
      ...(x.deny ? { deny: describePermissions(x.deny) } : {}),
    });
  }
  // A channel built inside a category starts from the category's settings,
  // so a role with extras there but none here is listed empty, which clears
  // them; otherwise a rebuild would give it the category's.
  for (const [id, x] of alsoClear?.extras ?? []) {
    if (!vis.extras.has(id)) list.push({ role: x.name });
  }
  return list.sort((a, b) => a.role.localeCompare(b.role));
}

export function exportBlueprint(
  channels: GuildChannelLite[],
  roles: RoleLite[],
  guildId: string,
  options: { botUserId?: string; name?: string; includeIds?: boolean } = {}
): { blueprint: Blueprint; warnings: string[] } {
  const warnings: string[] = [];
  // Ids let an edited export rename things instead of creating new ones.
  // A blueprint meant for other servers can leave them out.
  const withId = (id: string) => (options.includeIds === false ? {} : { id });

  // Roles the blueprint will actually define: everything except @everyone
  // and integration-managed ones, highest first. That is the order the
  // server settings show and the order a build creates them, which is what
  // carries the hierarchy: Discord parks every new role at position 1 and
  // the client ranks tied roles by id, oldest highest, so the top role has
  // to be created first. The comparator applies that same tie rule here, so
  // a server whose roles all share a position still exports in the order
  // people actually see.
  const exportable = roles
    .filter((r) => r.id !== guildId && !r.managed)
    .sort((a, b) => compareRolesLowToHigh(b, a));

  // Discord lets two roles share a name. A blueprint cannot, because every
  // reference in private_to and posting_roles is by name, so a duplicate is
  // both unbuildable and ambiguous. Later collisions get a numeric suffix,
  // reported rather than applied silently.
  const roleNames = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of exportable) {
    const base = r.name ?? "unnamed";
    let candidate = base;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      const suffix = ` ${n}`;
      candidate = base.slice(0, ROLE_NAME_MAX - suffix.length) + suffix;
      n += 1;
    }
    if (candidate !== base) {
      warnings.push(
        `More than one role is named "${base}"; exported the lower one as ` +
          `"${candidate}" so channel permissions can tell them apart. Applying ` +
          "this export with update_existing renames it to match."
      );
    }
    taken.add(candidate.toLowerCase());
    roleNames.set(r.id, candidate);
  }

  // Only exported roles are resolvable by name. An overwrite for @everyone
  // is handled separately, and one for a managed role now falls through to
  // the leftovers warning instead of producing a private_to entry naming a
  // role the blueprint never defines.
  const exportedRoles = exportable.map((r) => {
    const extra = r as RoleLite & {
      color?: number;
      hoist?: boolean;
      mentionable?: boolean;
    };
    return {
      ...withId(r.id),
      name: roleNames.get(r.id) as string,
      permissions: describePermissions(BigInt(r.permissions)),
      ...(extra.color
        ? { color: `#${extra.color.toString(16).padStart(6, "0")}` }
        : {}),
      ...(extra.hoist ? { hoist: true } : {}),
      ...(extra.mentionable ? { mentionable: true } : {}),
    };
  });

  const byPosition = (a: GuildChannelLite, b: GuildChannelLite) =>
    (a.position ?? 0) - (b.position ?? 0);

  function exportChannel(
    c: GuildChannelLite,
    parentVisibility?: Visibility,
    parent?: GuildChannelLite
  ): BlueprintChannel | null {
    const typeName = TYPE_NAMES[c.type];
    if (!typeName) {
      warnings.push(
        `Channel "${c.name}" has a type the blueprint cannot express ` +
          `(type ${c.type}); skipped.`
      );
      return null;
    }
    const vis = readVisibility(c, guildId, roleNames, options.botUserId);
    if (vis.leftovers) {
      warnings.push(
        `Channel "${c.name}" has permission overwrites beyond the ` +
          "blueprint's visibility model; captured approximately."
      );
    }
    // A child whose privacy matches its category's is left unmarked, which
    // is how a blueprint says "follows the category". One that differs says
    // so: its roles, [] for admins only, or null for a public channel in a
    // private category, which unmarked would make private on a rebuild.
    const inheritsPrivacy =
      parentVisibility !== undefined && sameVisibility(vis, parentVisibility);
    const privacy = inheritsPrivacy
      ? {}
      : vis.private
        ? { private_to: vis.privateTo }
        : parentVisibility?.private
          ? { private_to: null }
          : {};

    return {
      ...withId(c.id),
      name: c.name ?? "unnamed",
      ...(typeName !== "text" ? { type: typeName } : {}),
      ...(c.topic && c.type !== 2 && c.type !== 13 ? { topic: c.topic } : {}),
      ...(c.rate_limit_per_user
        ? { slowmode_seconds: c.rate_limit_per_user }
        : {}),
      ...(c.nsfw ? { nsfw: true } : {}),
      ...privacy,
      ...(vis.readOnly ? { read_only: true } : {}),
      ...(vis.postingRoles.length > 0 ? { posting_roles: vis.postingRoles } : {}),
      ...(() => {
        // A channel synced to its category (the same overwrites exactly)
        // follows it, extras included, and says nothing of its own.
        if (parent && sameOverwrites(c, parent)) return {};
        const list = extrasList(vis, parentVisibility);
        return list.length > 0 ? { permissions: list } : {};
      })(),
    };
  }

  const categories = channels
    .filter((c) => c.type === 4)
    .sort(byPosition)
    .map((cat) => {
      const catVis = readVisibility(cat, guildId, roleNames, options.botUserId);
      if (catVis.leftovers) {
        warnings.push(
          `Category "${cat.name}" has permission overwrites beyond the ` +
            "blueprint's visibility model; captured approximately."
        );
      }
      return {
        ...withId(cat.id),
        name: cat.name ?? "unnamed",
        ...(catVis.private ? { private_to: catVis.privateTo } : {}),
        ...(catVis.extras.size > 0 ? { permissions: extrasList(catVis, undefined) } : {}),
        channels: channels
          .filter((c) => c.parent_id === cat.id)
          .sort(byPosition)
          .map((c) => exportChannel(c, catVis, cat))
          .filter((c): c is BlueprintChannel => c !== null),
      };
    });

  const topLevel = channels
    .filter((c) => c.type !== 4 && !c.parent_id)
    .sort(byPosition)
    .map((c) => exportChannel(c))
    .filter((c): c is BlueprintChannel => c !== null);

  const blueprint: Blueprint = {
    ...(options.name ? { name: options.name } : {}),
    ...(exportedRoles.length > 0 ? { roles: exportedRoles } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(topLevel.length > 0 ? { channels: topLevel } : {}),
  };
  return { blueprint, warnings };
}
