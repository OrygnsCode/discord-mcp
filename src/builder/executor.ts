import { Routes } from "discord-api-types/v10";
import type {
  APIRole,
  RESTPatchAPIGuildRolePositionsJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPostAPIGuildRoleJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { GuildChannelLite } from "../discord/guildData.js";
import {
  parsePermissionNames,
  PERMISSION_PRESETS,
  type RoleLite,
} from "../discord/preflight.js";
import { describeRateLimit } from "../discord/client.js";
import type { Blueprint } from "./blueprint.js";
import type { RecordEntry } from "./records.js";
import type { PlanStep, PrivacyApply, SendApply, StepChange } from "./planner.js";
import {
  gateBitsFor,
  gateBitsForType,
  patchOverwrites,
  roleIdsFor,
  UnknownRoleError,
  type ChannelKind,
  type OverwriteSpec,
  type SugarChange,
} from "./overwrites.js";
import { holdCandidates, stuckFrom, stuckWarning, withSyncedHeld, type ChannelLike, type Held } from "./categorySync.js";

// The executor walks a validated plan in dependency order: roles, then
// categories, then channels, creating first and editing after. If a step
// fails, execution stops and the report says exactly what now exists, what
// changed, what failed, and what was never attempted. Running the plan
// again later picks up the rest: created items are reused and finished
// edits no longer show up as differences.
//
// Edits change only what the step lists. A channel's settings go in one
// request, since Discord allows only about two name or topic changes per
// channel per 10 minutes; its permissions change one overwrite at a time,
// leaving every overwrite and bit the step does not mention as it was.
//
// Deletions come last in every plan, so a failure earlier leaves nothing
// deleted.
//
// Changing a category's overwrites one at a time makes Discord change the
// channels synced with it the same way. Those channels are held while the
// category changes (see categorySync.ts), so each changes only through its
// own step: one the plan shows.

type Overwrite = { id: string; type: number; allow: string; deny: string };

export interface StepResult {
  order: number;
  action: string;
  name: string;
  status: "created" | "reused" | "updated" | "deleted" | "failed" | "not_attempted";
  id?: string;
  error?: string;
  note?: string;
  changes?: StepChange[];
}

export interface BuildReport {
  results: StepResult[];
  created: number;
  reused: number;
  updated: number;
  deleted: number;
  failed: boolean;
  // Things that went imperfectly without stopping the build.
  warnings: string[];
  // How many roles this run created, and whether they were given explicit
  // positions afterward. When not, they share position 1 and the hierarchy
  // is held by creation order alone, which the client honors just the same.
  rolesCreated: number;
  stacked: boolean;
  // What the run did, for its build record and undo.
  record: RecordEntry[];
}

// The bulk reposition body for roles the build just created: first role in
// blueprint order goes lowest, at position 1, and the rest stack upward.
// Pure, so the shape is unit tested without a server.
export function stackPositions(
  createdRoleIds: string[]
): RESTPatchAPIGuildRolePositionsJSONBody {
  return createdRoleIds.map((id, i) => ({ id, position: i + 1 }));
}


// Who has a role, for undoing its deletion: up to HOLDER_CAP member ids and
// the total, read from the member list (Server Members intent), at most
// MEMBER_PAGES pages of 1,000.
const HOLDER_CAP = 100;
const MEMBER_PAGES = 10;

export async function roleHolders(
  rest: REST,
  guildId: string,
  roleId: string
): Promise<{ members: string[] | null; count: number | null; note?: string }> {
  const members: string[] = [];
  let count = 0;
  let after = "0";
  try {
    for (let page = 0; page < MEMBER_PAGES; page++) {
      const batch = (await rest.get(Routes.guildMembers(guildId), {
        query: new URLSearchParams({ limit: "1000", after }),
      })) as Array<{ user?: { id: string }; roles: string[] }>;
      for (const m of batch) {
        if (!m.user || !m.roles.includes(roleId)) continue;
        count += 1;
        if (members.length < HOLDER_CAP) members.push(m.user.id);
      }
      if (batch.length < 1000) {
        return {
          members,
          count,
          ...(count > HOLDER_CAP
            ? { note: `${count} members had it; undo gives it back to the first ${HOLDER_CAP}.` }
            : {}),
        };
      }
      after = batch[batch.length - 1]?.user?.id ?? after;
    }
    return {
      members,
      count: null,
      note: `Only the first ${MEMBER_PAGES * 1000} members were checked; undo gives it back to those found.`,
    };
  } catch {
    return {
      members: null,
      count: null,
      note: "Who had it could not be read (the bot may lack the Server Members intent), so undo cannot give it back to them.",
    };
  }
}

const BUILD_REASON = "discord-mcp build";
const EDIT_REASON = "discord-mcp edit";

export async function executePlan(
  rest: REST,
  guildId: string,
  botUserId: string,
  blueprint: Blueprint,
  steps: PlanStep[],
  liveRoles: RoleLite[],
  liveChannels: GuildChannelLite[],
  options: {
    // Permissions the bot may set in overwrites; undefined for an admin
    // bot, which may set any.
    settable?: bigint;
    // Server settings that point at channels, by Discord field name when
    // undo can restore them.
    channelUses?: Array<{ id: string; use: string; field?: string }>;
  } = {}
): Promise<BuildReport> {
  const settable = options.settable;
  const results: StepResult[] = [];
  const record: RecordEntry[] = [];
  // An update recorded as it goes, pushed even if the step then fails.
  let pending: (RecordEntry & { op: "updated" }) | undefined;
  // Where each channel sits as the run goes, for a deleted category's children.
  const parentOf = new Map<string, string | null>();
  for (const c of liveChannels) if (c.type !== 4) parentOf.set(c.id, c.parent_id ?? null);
  const deletedIds = new Set<string>();
  const warnings: string[] = [];
  // Roles this run created, in blueprint order, for the reposition at the end.
  const createdRoles: string[] = [];

  // Name-to-id maps, keyed lowercase: live names first, then blueprint
  // names of the items the plan reuses (which differ from the live name
  // when the plan renames them), then whatever this run creates.
  const roleIds = new Map<string, string>();
  for (const r of liveRoles) {
    if (r.name && !roleIds.has(r.name.toLowerCase())) roleIds.set(r.name.toLowerCase(), r.id);
  }
  const categoryIds = new Map<string, string>();
  for (const c of liveChannels) {
    if (c.type === 4 && c.name) categoryIds.set(c.name.toLowerCase(), c.id);
  }
  for (const s of steps) {
    if (!s.exists) continue;
    if (s.action === "create_role") roleIds.set(s.name.toLowerCase(), s.exists.id);
    if (s.action === "create_category") categoryIds.set(s.name.toLowerCase(), s.exists.id);
  }
  // Role keys from the planner: id:<id> for a role that existed when the
  // plan was made, new:<name> for one this run creates.
  const createdByName = new Map<string, string>();
  const resolveKey = (key: string): string => {
    if (key.startsWith("id:")) return key.slice(3);
    const id = createdByName.get(key.slice(4));
    if (!id) throw new UnknownRoleError(key.slice(4));
    return id;
  };

  // Current overwrites per channel, updated as the run changes them, so a
  // channel created inside a category starts from what the category has
  // at that moment.
  const overwritesOf = new Map<string, Overwrite[]>();
  for (const c of liveChannels) overwritesOf.set(c.id, c.permission_overwrites ?? []);
  const typeOf = new Map<string, number>(liveChannels.map((c) => [c.id, c.type]));
  const nameOf = new Map<string, string>(liveChannels.map((c) => [c.id, c.name ?? c.id]));
  // Every channel as this run knows it, for finding the ones synced with a
  // category it is about to change.
  const channelView = (): ChannelLike[] =>
    [...overwritesOf.keys()]
      .filter((id) => !deletedIds.has(id))
      .map((id) => ({
        id,
        type: typeOf.get(id) ?? 0,
        name: nameOf.get(id),
        parent_id: parentOf.get(id) ?? null,
        permission_overwrites: overwritesOf.get(id),
      }));
  const createdRoleNames: Array<{ id: string; name: string }> = [];

  // Category privacy as the blueprint lists it, for channels that follow it.
  const categoryPrivacy = new Map<string, string[] | null>();
  for (const cat of blueprint.categories ?? []) {
    if (cat.private_to !== undefined) categoryPrivacy.set(cat.name.toLowerCase(), cat.private_to);
  }

  // One overwrite at a time, keeping the known state current after each, so
  // a failure partway leaves an exact record of what is in place.
  async function applyOverwrites(
    channelId: string,
    change: SugarChange,
    gateBits: bigint,
    reason: string,
    onProgress?: (now: Overwrite[]) => void
  ) {
    const base = overwritesOf.get(channelId) ?? [];
    const patch = patchOverwrites(base, change, { guildId, botUserId, gateBits, settable });
    let now = [...base];
    for (const o of patch.puts) {
      await rest.put(Routes.channelPermission(channelId, o.id), {
        body: { type: o.type, allow: o.allow, deny: o.deny },
        reason,
      });
      now = [...now.filter((x) => x.id !== o.id), o];
      overwritesOf.set(channelId, now);
      onProgress?.(now);
    }
    for (const id of patch.deletes) {
      await rest.delete(Routes.channelPermission(channelId, id), { reason });
      now = now.filter((x) => x.id !== id);
      overwritesOf.set(channelId, now);
      onProgress?.(now);
    }
    overwritesOf.set(channelId, patch.overwrites);
    onProgress?.(patch.overwrites);
  }

  // A blueprint permissions list, by role name, as role ids and bits.
  function extrasByName(
    list: Array<{ role: string; allow?: string[]; deny?: string[] }>
  ): NonNullable<SugarChange["extras"]> {
    return list.map((x) => {
      const plain = x.role.trim().replace(/^@/, "").toLowerCase();
      const id = plain === "everyone" ? guildId : roleIds.get(x.role.toLowerCase());
      if (!id) throw new UnknownRoleError(x.role);
      return {
        id,
        allow: parsePermissionNames(x.allow ?? []).bits,
        deny: parsePermissionNames(x.deny ?? []).bits,
      };
    });
  }

  function privacyChange(names: string[] | null): SugarChange["privacy"] {
    return names === null
      ? { private: false, roles: [] }
      : { private: true, roles: roleIdsFor(names, roleIds, guildId, "private_to") };
  }

  // A hold that could not be let go leaves an empty overwrite on the
  // channel. It changes no permission; the record has it so undo takes it
  // off, and the result says so.
  const noteStuck = (stuck: Held[]): void => {
    for (const h of stuck) {
      const list = overwritesOf.get(h.channelId) ?? [];
      const withHold = [...list, { id: h.target.id, type: h.target.type, allow: "0", deny: "0" }];
      overwritesOf.set(h.channelId, withHold);
      record.push({ op: "updated", kind: "channel", id: h.channelId, name: h.name, channelType: typeOf.get(h.channelId), fields: {}, overwrites: { before: list, after: withHold } });
    }
    warnings.push(...stuckWarning(stuck));
  };

  let halted = false;

  for (const step of steps) {
    if (halted) {
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "not_attempted",
      });
      continue;
    }

    if (step.exists) {
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "reused",
        id: step.exists.id,
      });
      continue;
    }

    // What already went through for a step that then fails, so the report
    // can say so instead of leaving it to guesswork.
    let partial = "";
    try {
      if (step.action === "create_role") {
        const details = step.details as {
          preset: string;
          extra_permissions: string[];
          color: string | null;
          hoist: boolean;
          mentionable: boolean;
        };
        let bits = PERMISSION_PRESETS[details.preset] ?? 0n;
        bits |= parsePermissionNames(details.extra_permissions).bits;
        const body: RESTPostAPIGuildRoleJSONBody = {
          name: step.name,
          permissions: bits.toString(),
          hoist: details.hoist,
          mentionable: details.mentionable,
          ...(details.color
            ? { color: parseInt(details.color.replace(/^#/, ""), 16) }
            : {}),
        };
        const role = (await rest.post(Routes.guildRoles(guildId), {
          body,
          reason: BUILD_REASON,
        })) as APIRole;
        roleIds.set(step.name.toLowerCase(), role.id);
        createdByName.set(step.name.toLowerCase(), role.id);
        createdRoles.push(role.id);
        createdRoleNames.push({ id: role.id, name: step.name });
        record.push({ op: "created", kind: "role", id: role.id, name: step.name });
        results.push({ order: step.order, action: step.action, name: step.name, status: "created", id: role.id });
      } else if (step.action === "create_category") {
        const details = step.details as {
          private_to: string[] | null;
          permissions?: Array<{ role: string; allow?: string[]; deny?: string[] }> | null;
        };
        const catChange: SugarChange = {};
        if (details.private_to !== null) catChange.privacy = privacyChange(details.private_to);
        if (details.permissions) catChange.extras = extrasByName(details.permissions);
        const overwrites =
          catChange.privacy || catChange.extras
            ? patchOverwrites([], catChange, {
                guildId,
                botUserId,
                gateBits: gateBitsForType(4),
                settable,
              }).overwrites
            : [];
        const body: RESTPostAPIGuildChannelJSONBody = {
          name: step.name,
          type: 4 as never,
          ...(overwrites.length > 0 ? { permission_overwrites: overwrites as never } : {}),
        };
        const created = (await rest.post(Routes.guildChannels(guildId), {
          body,
          reason: BUILD_REASON,
        })) as GuildChannelLite;
        categoryIds.set(step.name.toLowerCase(), created.id);
        overwritesOf.set(created.id, created.permission_overwrites ?? overwrites);
        typeOf.set(created.id, 4);
        nameOf.set(created.id, step.name);
        record.push({ op: "created", kind: "category", id: created.id, name: step.name, channelType: 4 });
        results.push({ order: step.order, action: step.action, name: step.name, status: "created", id: created.id });
      } else if (step.action === "create_channel") {
        const details = step.details as {
          type: ChannelKind;
          type_code: number;
          category: string | null;
          topic: string | null;
          slowmode_seconds: number | null;
          nsfw: boolean;
          private_to: "inherit" | string[] | null;
          read_only: boolean | null;
          posting_roles: string[] | null;
          permissions?: Array<{ role: string; allow?: string[]; deny?: string[] }> | null;
        };
        const parentId = details.category
          ? categoryIds.get(details.category.toLowerCase())
          : undefined;
        if (details.category && !parentId) {
          throw new Error(
            `Parent category "${details.category}" was not created and does not exist.`
          );
        }

        // Start from the category's overwrites, which is what Discord does
        // itself for a channel created without any, and change only what
        // the blueprint sets. Sending a fresh set instead once dropped the
        // category's privacy whenever the channel set something of its own.
        const change: SugarChange = {};
        if (details.private_to !== "inherit") {
          change.privacy = privacyChange(details.private_to);
        } else if (details.category && categoryPrivacy.has(details.category.toLowerCase())) {
          change.privacy = privacyChange(categoryPrivacy.get(details.category.toLowerCase()) ?? null);
        }
        if (details.read_only !== null) {
          change.send = {
            readOnly: details.read_only,
            postingRoles: details.read_only
              ? roleIdsFor(details.posting_roles ?? [], roleIds, guildId, "posting_roles")
              : [],
          };
        }
        if (details.permissions) change.extras = extrasByName(details.permissions);
        const base = parentId ? overwritesOf.get(parentId) ?? [] : [];
        const overwrites: OverwriteSpec[] | null =
          change.privacy || change.send || change.extras
            ? patchOverwrites(base, change, { guildId, botUserId, gateBits: gateBitsFor(details.type), settable }).overwrites
            : null;

        const body: RESTPostAPIGuildChannelJSONBody = {
          name: step.name,
          type: details.type_code as never,
          ...(parentId ? { parent_id: parentId } : {}),
          ...(details.topic ? { topic: details.topic } : {}),
          ...(details.slowmode_seconds !== null
            ? { rate_limit_per_user: details.slowmode_seconds }
            : {}),
          ...(details.nsfw ? { nsfw: true } : {}),
          ...(overwrites !== null ? { permission_overwrites: overwrites as never } : {}),
        };
        const created = (await rest.post(Routes.guildChannels(guildId), {
          body,
          reason: BUILD_REASON,
        })) as GuildChannelLite;
        overwritesOf.set(created.id, created.permission_overwrites ?? overwrites ?? base);
        parentOf.set(created.id, parentId ?? null);
        typeOf.set(created.id, details.type_code);
        nameOf.set(created.id, step.name);
        record.push({ op: "created", kind: "channel", id: created.id, name: step.name, channelType: details.type_code });
        results.push({ order: step.order, action: step.action, name: step.name, status: "created", id: created.id });
      } else if (step.action === "update_role") {
        const id = step.id as string;
        const apply = (step.details.apply ?? {}) as Record<string, unknown>;
        const before = (liveRoles.find((r) => r.id === id) ?? {}) as unknown as Record<string, unknown>;
        const after = (await rest.patch(Routes.guildRole(guildId, id), {
          body: apply,
          reason: EDIT_REASON,
        })) as unknown as Record<string, unknown> | undefined;
        record.push({
          op: "updated",
          kind: "role",
          id,
          name: step.name,
          fields: Object.fromEntries(
            Object.keys(apply).map((k) => [k, { before: before[k] ?? null, after: after?.[k] ?? apply[k] }])
          ),
        });
        if (typeof apply.name === "string") roleIds.set(apply.name.toLowerCase(), id);
        results.push({ order: step.order, action: step.action, name: step.name, status: "updated", id, changes: step.changes });
      } else if (step.action === "update_category" || step.action === "update_channel") {
        const id = step.id as string;
        const apply = (step.details.apply ?? {}) as {
          name?: string;
          type?: number;
          topic?: string;
          rate_limit_per_user?: number;
          nsfw?: boolean;
          parent?: string;
          privacy?: PrivacyApply;
          send?: SendApply;
          extras?: Array<{ role: string; allow: string; deny: string }>;
        };
        const body: Record<string, unknown> = {};
        if (apply.name !== undefined) body.name = apply.name;
        if (apply.type !== undefined) body.type = apply.type;
        if (apply.topic !== undefined) body.topic = apply.topic;
        if (apply.rate_limit_per_user !== undefined) body.rate_limit_per_user = apply.rate_limit_per_user;
        if (apply.nsfw !== undefined) body.nsfw = apply.nsfw;
        if (apply.parent !== undefined) {
          const parentId = categoryIds.get(apply.parent.toLowerCase());
          if (!parentId) throw new Error(`Category "${apply.parent}" does not exist.`);
          body.parent_id = parentId;
        }
        // Recorded as it is applied, so a step that fails halfway still
        // leaves an exact account of what changed, for undo.
        const entry: RecordEntry & { op: "updated" } = {
          op: "updated",
          kind: step.action === "update_category" ? "category" : "channel",
          id,
          name: step.name,
          channelType: typeOf.get(id),
          fields: {},
        };
        pending = entry;
        if (Object.keys(body).length > 0) {
          const before = (liveChannels.find((c) => c.id === id) ?? {}) as unknown as Record<string, unknown>;
          const after = (await rest.patch(Routes.channel(id), { body, reason: EDIT_REASON })) as unknown as
            | Record<string, unknown>
            | undefined;
          for (const k of Object.keys(body)) {
            entry.fields[k] = { before: before[k] ?? null, after: after?.[k] ?? body[k] };
          }
          partial = ` Its ${Object.keys(body).map((k) => (k === "parent_id" ? "category" : k)).join(", ")} changed before that.`;
          if (step.action === "update_category" && apply.name) {
            categoryIds.set(apply.name.toLowerCase(), id);
          }
          if (body.parent_id !== undefined) parentOf.set(id, body.parent_id as string);
        }
        const change: SugarChange = {};
        if (apply.privacy) {
          change.privacy = { private: apply.privacy.private, roles: apply.privacy.roles.map(resolveKey) };
        }
        if (apply.send) {
          change.send = { readOnly: apply.send.readOnly, postingRoles: apply.send.postingRoles.map(resolveKey) };
        }
        if (apply.extras) {
          change.extras = apply.extras.map((x) => ({
            id: resolveKey(x.role),
            allow: BigInt(x.allow),
            deny: BigInt(x.deny),
          }));
        }
        if (change.privacy || change.send || change.extras) {
          const own = liveChannels.find((c) => c.id === id);
          const gateBits =
            step.action === "update_category" || apply.privacy?.gate === "category"
              ? gateBitsForType(4)
              : gateBitsForType(own?.type ?? 0);
          const before = overwritesOf.get(id) ?? [];
          entry.overwrites = { before, after: before };
          const applyChange = () =>
            applyOverwrites(id, change, gateBits, EDIT_REASON, (now) => {
              if (entry.overwrites) entry.overwrites.after = now;
            });
          if (step.action === "update_category") {
            const { stuck } = await withSyncedHeld(
              rest,
              id,
              channelView(),
              holdCandidates(guildId, botUserId, [...liveRoles, ...createdRoleNames]),
              applyChange
            );
            noteStuck(stuck);
          } else {
            await applyChange();
          }
        }
        record.push(entry);
        pending = undefined;
        results.push({ order: step.order, action: step.action, name: step.name, status: "updated", id, changes: step.changes });
      } else if (
        step.action === "delete_channel" ||
        step.action === "delete_category" ||
        step.action === "delete_role"
      ) {
        const id = step.id as string;
        // A full copy first, for undo to recreate from.
        let entry: RecordEntry;
        if (step.action === "delete_role") {
          const role = (liveRoles.find((r) => r.id === id) ?? { id, name: step.name }) as unknown as Record<string, unknown>;
          const holders = await roleHolders(rest, guildId, id);
          const overwrites: Array<{ channel_id: string; allow: string; deny: string }> = [];
          for (const [channelId, list] of overwritesOf) {
            if (deletedIds.has(channelId)) continue;
            const o = list.find((x) => x.id === id);
            if (o) overwrites.push({ channel_id: channelId, allow: o.allow, deny: o.deny });
          }
          entry = {
            op: "deleted",
            kind: "role",
            id,
            name: step.name,
            snapshot: role,
            members: holders.members,
            memberCount: holders.count,
            overwrites,
            notes: [
              ...(role.icon ? ["Its icon image cannot be brought back."] : []),
              ...(holders.note ? [holders.note] : []),
            ],
          };
        } else {
          const live = liveChannels.find((c) => c.id === id) as unknown as Record<string, unknown> | undefined;
          const uses = (options.channelUses ?? []).filter((u) => u.id === id);
          entry = {
            op: "deleted",
            kind: step.action === "delete_category" ? "category" : "channel",
            id,
            name: step.name,
            snapshot: { ...(live ?? { id, name: step.name }), permission_overwrites: overwritesOf.get(id) ?? [] },
            ...(step.action === "delete_category"
              ? { children: [...parentOf].filter(([child, parent]) => parent === id && !deletedIds.has(child)).map(([child]) => child) }
              : {}),
            settings: uses.filter((u) => u.field).map((u) => u.field as string),
            notes: [
              ...(step.action === "delete_channel"
                ? ["Its messages, threads, pins, invites, and webhooks cannot be brought back."]
                : []),
              ...uses.filter((u) => !u.field).map((u) => `Its place as the ${u.use} is not restored.`),
            ],
          };
        }
        const route =
          step.action === "delete_role" ? Routes.guildRole(guildId, id) : Routes.channel(id);
        let note: string | undefined;
        try {
          await rest.delete(route, { reason: EDIT_REASON });
        } catch (err) {
          // Already gone is the outcome the step wanted.
          const code = (err as { code?: number }).code;
          if (code !== 10003 && code !== 10011) throw err;
          note = "It was already gone.";
        }
        if (!note) record.push(entry);
        deletedIds.add(id);
        parentOf.delete(id);
        // Discord drops a deleted role's overwrites everywhere.
        if (step.action === "delete_role") {
          for (const [channelId, list] of overwritesOf) {
            if (list.some((o) => o.id === id)) overwritesOf.set(channelId, list.filter((o) => o.id !== id));
          }
        }
        results.push({
          order: step.order,
          action: step.action,
          name: step.name,
          status: "deleted",
          id,
          ...(note ? { note } : {}),
        });
      }
    } catch (err) {
      if (pending && (Object.keys(pending.fields).length > 0 || pending.overwrites)) {
        record.push(pending);
      }
      pending = undefined;
      // Holds the failed step could not let go are still on the channels.
      noteStuck(stuckFrom(err));
      const message =
        describeRateLimit(err) ??
        (err instanceof Error ? err.message : String(err));
      results.push({
        order: step.order,
        action: step.action,
        name: step.name,
        status: "failed",
        error: message + partial,
      });
      halted = true;
    }
  }

  // Discord parks every role created through the API at position 1, so a
  // batch of new roles ties, and the client breaks the tie by id, oldest
  // highest. Blueprints list roles highest first and steps run in that
  // order, so the top role gets the oldest id and the hierarchy is right the
  // moment the roles exist, with no extra permission. This reposition is the
  // finishing touch: distinct positions
  // in the same order, which reads more cleanly in the client and in an
  // export. It needs the bot's own role to sit above every position it
  // assigns, which a fresh server never satisfies, so a refusal is expected
  // there and costs nothing; the report records which way the order is held.
  let stacked = false;
  if (createdRoles.length > 0) {
    try {
      await rest.patch(Routes.guildRoles(guildId), {
        // Created top-down; the body wants lowest first.
        body: stackPositions([...createdRoles].reverse()),
        reason: BUILD_REASON,
      });
      stacked = true;
    } catch {
      stacked = false;
    }
  }

  return {
    results,
    created: results.filter((r) => r.status === "created").length,
    reused: results.filter((r) => r.status === "reused").length,
    updated: results.filter((r) => r.status === "updated").length,
    deleted: results.filter((r) => r.status === "deleted").length,
    failed: results.some((r) => r.status === "failed"),
    warnings,
    rolesCreated: createdRoles.length,
    stacked,
    record,
  };
}
