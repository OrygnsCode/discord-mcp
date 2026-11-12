import type { GuildChannelLite } from "../discord/guildData.js";
import type { RoleLite } from "../discord/preflight.js";
import type { Blueprint } from "./blueprint.js";
import {
  bindBlueprint,
  compareCategory,
  compareChannel,
  compareRole,
  roleRefs,
} from "./compare.js";

// Drift detection: how a live server differs from a blueprint. The basis
// for config-as-code workflows: export a design, change things, diff to
// see exactly what moved. Built on the same matching and comparison the
// planner uses, so a diff and a plan never disagree.
//
// A diff reads the blueprint as the whole truth: a setting the blueprint
// leaves out is compared with its default. That is what drift means for a
// saved export. A plan with update_existing is more careful and changes
// only the settings a blueprint item lists.

export interface DiffChange {
  kind: "role" | "category" | "channel";
  name: string;
  fields: string[];
}

export interface DiffResult {
  in_sync: boolean;
  missing: { roles: string[]; categories: string[]; channels: string[] };
  changed: DiffChange[];
  extra: { roles: string[]; categories: string[]; channels: string[] };
}

export function diffBlueprint(
  blueprint: Blueprint,
  channels: GuildChannelLite[],
  roles: RoleLite[],
  guildId: string
): DiffResult {
  const result: DiffResult = {
    in_sync: true,
    missing: { roles: [], categories: [], channels: [] },
    changed: [],
    extra: { roles: [], categories: [], channels: [] },
  };
  const bindings = bindBlueprint(blueprint, channels, roles, guildId);
  const refs = roleRefs(bindings, roles, guildId);
  const liveCategoryNames = new Map(
    channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? ""])
  );
  const bound = new Set<string>();

  for (const b of bindings.roles) {
    if (!b.live) {
      result.missing.roles.push(b.bp.name);
      continue;
    }
    bound.add(b.live.id);
    const fields = compareRole(b).filter((d) => d.differs).map((d) => d.field);
    if (fields.length > 0) result.changed.push({ kind: "role", name: b.bp.name, fields });
  }
  for (const b of bindings.categories) {
    if (!b.live) {
      result.missing.categories.push(b.bp.name);
      continue;
    }
    bound.add(b.live.id);
    const fields = compareCategory(b, refs, guildId).filter((d) => d.differs).map((d) => d.field);
    if (fields.length > 0) result.changed.push({ kind: "category", name: b.bp.name, fields });
  }
  for (const b of bindings.channels) {
    if (!b.live) {
      result.missing.channels.push(b.bp.name);
      continue;
    }
    bound.add(b.live.id);
    const fields = compareChannel(b, blueprint, bindings.categories, liveCategoryNames, refs, guildId)
      .filter((d) => d.differs)
      .map((d) => d.field);
    if (fields.length > 0) result.changed.push({ kind: "channel", name: b.bp.name, fields });
  }

  // Extras: live items no blueprint item matched. @everyone and roles an
  // integration manages are never blueprint material, so never extra.
  for (const r of roles) {
    if (r.id === guildId || r.managed || bound.has(r.id)) continue;
    result.extra.roles.push(r.name ?? r.id);
  }
  for (const c of channels) {
    if (bound.has(c.id)) continue;
    if (c.type === 4) result.extra.categories.push(c.name ?? c.id);
    else result.extra.channels.push(c.name ?? c.id);
  }

  result.in_sync =
    result.missing.roles.length === 0 &&
    result.missing.categories.length === 0 &&
    result.missing.channels.length === 0 &&
    result.changed.length === 0;
  return result;
}
