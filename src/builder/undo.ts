import { quoted } from "../discord/names.js";
import { Routes } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { GuildChannelLite } from "../discord/guildData.js";
import { describePermissions, type RoleLite } from "../discord/preflight.js";
import { describeRateLimit } from "../discord/client.js";
import { isImageField } from "../discord/images.js";
import { entryChannelType, itemLabel, type BuildRecord, type ItemKind, type Overwrite, type RecordEntry } from "./records.js";
import { holdCandidates, stuckFrom, stuckWarning, syncedWith, withSyncedHeld } from "./categorySync.js";

// Undoing a build, from its record. Planning is pure and conservative:
//
// - A changed setting goes back only if it still holds the value the build
//   set. If someone changed it since, it stays and the report says so.
// - A permission overwrite goes back per role or member, under the same
//   rule, so other changes made since on that channel are untouched.
// - Deleted items are recreated from their copies. They get new ids, so the
//   undo maps old ids to new ones for everything that pointed at them:
//   channel overwrites for a deleted role, a recreated category's channels,
//   server settings such as the system messages channel.
// - What the build created is deleted, last.
//
// Order: recreate roles, then categories, then channels; restore changed
// settings, newest change first; then delete created channels, categories,
// and roles. Each entry keeps its own outcome in the record, so running the
// undo again (after a rate limit, say) finishes only what is left.
//
// Putting a category's overwrites back one at a time would make Discord
// change every channel synced with it too, so those channels are held
// meanwhile (see categorySync.ts). A channel that followed the category
// when the change was made has an entry of its own and goes back by it; one
// that matches the category only now keeps what it has, and the preview
// says so.

export interface UndoLive {
  channels: GuildChannelLite[];
  roles: RoleLite[];
  // Server settings that point at channels, by Discord field name.
  guildSettings: Record<string, string | null | undefined>;
  // The bot's highest role position; roles at or above it cannot be edited.
  botTop?: number;
  // Members per role, where known.
  roleMemberCounts?: Record<string, number>;
  // The server's own settings, for undoing a server settings change.
  guild?: Record<string, unknown>;
  // Roles of the members a change gave or took a role from; null for a
  // member who has left.
  memberRoles?: Record<string, string[] | null>;
  // Where items recreated by earlier undos live now: old id to new id. A
  // record made before the item was deleted and recreated still names the
  // old id, and must reach the item that stands in its place.
  aliases?: Record<string, string>;
}

// Follows old ids to the item that stands in their place now.
export function resolveAlias(aliases: Record<string, string> | undefined, id: string): string {
  let current = id;
  for (let hops = 0; hops < 20 && aliases?.[current]; hops++) current = aliases[current];
  return current;
}

// The record's entries with every id they name forwarded through aliases.
// Deleted entries keep their own id: they are recreated from their copy.
function forwarded(record: BuildRecord, aliases: Record<string, string> | undefined): RecordEntry[] {
  if (!aliases || Object.keys(aliases).length === 0) return record.entries;
  const fwd = (id: string) => resolveAlias(aliases, id);
  return record.entries.map((e) => {
    if (e.op === "created") return { ...e, id: fwd(e.id) };
    if (e.op === "member_role") return { ...e, role: fwd(e.role) };
    if (e.op === "updated") {
      const fields = Object.fromEntries(
        Object.entries(e.fields).map(([k, v]) =>
          k.endsWith("_id") || k === "parent_id"
            ? [k, { before: typeof v.before === "string" ? fwd(v.before) : v.before, after: typeof v.after === "string" ? fwd(v.after) : v.after }]
            : [k, v]
        )
      );
      const mapList = (list: Overwrite[]) => list.map((o) => (Number(o.type) === 0 ? { ...o, id: fwd(o.id) } : o));
      return {
        ...e,
        id: e.kind === "server" ? e.id : fwd(e.id),
        fields,
        ...(e.overwrites ? { overwrites: { before: mapList(e.overwrites.before), after: mapList(e.overwrites.after) } } : {}),
      };
    }
    return e;
  });
}

export type UndoAction =
  | { type: "recreate"; entry: number; kind: ItemKind; name: string; lines: string[] }
  | {
      type: "restore";
      entry: number;
      kind: ItemKind;
      id: string;
      name: string;
      lines: string[];
      fields: Record<string, unknown>;
      puts: Overwrite[];
      deletes: string[];
    }
  | { type: "delete"; entry: number; kind: ItemKind; id: string; name: string; lines: string[] }
  | { type: "member"; entry: number; name: string; member: string; role: string; add: boolean; lines: string[] }
  | { type: "skip"; entry: number; name: string; lines: string[] };

const SETTING_NAMES: Record<string, string> = {
  system_channel_id: "system messages channel",
  afk_channel_id: "AFK channel",
  safety_alerts_channel_id: "safety alerts channel",
  rules_channel_id: "rules channel",
  public_updates_channel_id: "community updates channel",
};

function norm(v: unknown): unknown {
  if (v === undefined || v === "") return null;
  // Discord returns lists such as a server's features in no fixed order.
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [...v].sort();
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function show(field: string, v: unknown): string {
  if (norm(v) === null) return field === "parent_id" ? "no category" : "none";
  if (field === "color" && typeof v === "number") return `#${v.toString(16).padStart(6, "0")}`;
  // A value such as a name or a topic was written by whoever set it.
  return quoted(typeof v === "string" ? v : JSON.stringify(v), 60);
}

function permissionChange(from: unknown, to: unknown): string {
  const a = BigInt(String(from ?? "0"));
  const b = BigInt(String(to ?? "0"));
  const added = describePermissions(b & ~a);
  const removed = describePermissions(a & ~b);
  return [
    added.length ? `gives back ${added.join(", ")}` : "",
    removed.length ? `takes away ${removed.join(", ")}` : "",
  ].filter(Boolean).join("; ") || "no change";
}

function sameOverwrite(a: Overwrite | undefined, b: Overwrite | undefined): boolean {
  if (!a || !b) return a === b;
  return a.allow === b.allow && a.deny === b.deny && Number(a.type) === Number(b.type);
}

function label(kind: ItemKind, name: string, channelType?: number): string {
  return itemLabel(kind, name, channelType);
}

const isFinished = (e: RecordEntry) => e.undo?.status === "done" || e.undo?.status === "skipped";

export function planUndo(record: BuildRecord, live: UndoLive): UndoAction[] {
  const channelById = new Map(live.channels.map((c) => [c.id, c]));
  const roleById = new Map(live.roles.map((r) => [r.id, r]));
  const recreateRoles: UndoAction[] = [];
  const recreateCategories: UndoAction[] = [];
  const recreateChannels: UndoAction[] = [];
  const restores: UndoAction[] = [];
  const deleteChannels: UndoAction[] = [];
  const deleteCategories: UndoAction[] = [];
  const deleteRoles: UndoAction[] = [];
  const entries = forwarded(record, live.aliases);
  const createdIds = new Set(
    entries.filter((e) => e.op === "created").map((e) => e.id)
  );
  // Roles this build deleted. Discord drops a deleted role's overwrites
  // everywhere, so one missing from a channel the build also changed went
  // with the role, not with a later edit, and comes back with it.
  const deletedRoleIds = new Set(
    entries.filter((e) => e.op === "deleted" && e.kind === "role").map((e) => e.id)
  );
  // Channels whose permissions this record puts back itself.
  const restoredHere = new Set(
    entries.flatMap((e) => (e.op === "updated" && e.kind === "channel" && e.overwrites ? [e.id] : []))
  );

  // A channel's type from the record, or from the server for older records.
  const tOf = (e: RecordEntry): number | undefined =>
    entryChannelType(e) ?? ("id" in e && e.kind !== "role" ? channelById.get(e.id)?.type : undefined);

  entries.forEach((e, i) => {
    if (isFinished(e)) return;
    // An item deleted and recreated since: this change's entry reaches the
    // one that stands in its place.
    const original = record.entries[i];
    const movedTo =
      (e.op === "created" || e.op === "updated") && e.kind !== "server" && "id" in original && original.id !== e.id
        ? e.id
        : undefined;
    const movedLine = movedTo
      ? [
          `It was deleted and recreated since${movedTo.startsWith("pending-") ? " (by an undo above)" : ` (now ${movedTo})`}, ` +
            "and this reaches the one that replaced it.",
        ]
      : [];

    if (e.op === "created") {
      const exists = e.kind === "role" ? roleById.has(e.id) : channelById.has(e.id);
      if (!exists) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${label(e.kind, e.name, tOf(e))} is already gone.`] });
        return;
      }
      const lines = [`Delete ${label(e.kind, e.name, tOf(e))}, which this change created.`, ...movedLine];
      if (e.kind === "channel" && (channelById.get(e.id) as { last_message_id?: string | null } | undefined)?.last_message_id) {
        lines.push("It has had messages since, and they are deleted with it.");
      }
      if (e.kind === "category") {
        const inside = live.channels.filter((c) => c.parent_id === e.id && !createdIds.has(c.id)).length;
        if (inside > 0) lines.push(`${inside} channel(s) this change did not create are inside and are left without a category.`);
      }
      if (e.kind === "role") {
        const n = live.roleMemberCounts?.[e.id];
        if (n) lines.push(`${n} member(s) have it now and lose it.`);
      }
      const target = e.kind === "channel" ? deleteChannels : e.kind === "category" ? deleteCategories : deleteRoles;
      target.push({ type: "delete", entry: i, kind: e.kind, id: e.id, name: e.name, lines });
      return;
    }

    if (e.op === "member_role") {
      const roles = live.memberRoles?.[e.member];
      const who = e.memberName || e.member;
      if (roles === undefined) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`Whether ${quoted(who)} still has ${quoted(e.name)} could not be read.`] });
        return;
      }
      if (roles === null) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${quoted(who)} has left the server.`] });
        return;
      }
      const roleExists = roleById.has(e.role) || entries.some((x) => x.op === "deleted" && x.kind === "role" && x.id === e.role);
      if (!roleExists) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`The role ${quoted(e.name)} no longer exists.`] });
        return;
      }
      const has = roles.includes(e.role);
      if (e.change === "added" && !has) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${quoted(who)} no longer has ${quoted(e.name)}.`] });
        return;
      }
      if (e.change === "removed" && has) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${quoted(who)} has ${quoted(e.name)} again already.`] });
        return;
      }
      restores.push({
        type: "member",
        entry: i,
        name: e.name,
        member: e.member,
        role: e.role,
        add: e.change === "removed",
        lines: [e.change === "added" ? `Take ${quoted(e.name)} back from ${quoted(who)}.` : `Give ${quoted(e.name)} back to ${quoted(who)}.`],
      });
      return;
    }

    if (e.op === "updated") {
      const now = (
        e.kind === "server" ? live.guild : e.kind === "role" ? roleById.get(e.id) : channelById.get(e.id)
      ) as Record<string, unknown> | undefined;
      if (!now) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${label(e.kind, e.name, tOf(e))} no longer exists, so its changes cannot be undone.`] });
        return;
      }
      if (e.kind === "role" && live.botTop !== undefined && Number(now.position ?? 0) >= live.botTop) {
        restores.push({ type: "skip", entry: i, name: e.name, lines: [`${label(e.kind, e.name, tOf(e))} is now at or above the bot's highest role, so the bot cannot change it back.`] });
        return;
      }
      const fields: Record<string, unknown> = {};
      const lines: string[] = [];
      for (const [field, { before, after }] of Object.entries(e.fields)) {
        if (same(now[field], after)) {
          if (!same(before, after)) {
            fields[field] = before;
            if (isImageField(e.kind, field) && typeof before === "string" && !before.startsWith("data:")) {
              // Saved before 2.0, or unreadable when the change was made.
              delete fields[field];
              lines.push(`${field}: the earlier image was not saved when it was changed, so it cannot be put back.`);
              continue;
            }
            lines.push(
              field === "permissions"
                ? `Permissions: ${permissionChange(now[field], before)}.`
                : isImageField(e.kind, field)
                  ? before === null
                    ? `${field}: removed again.`
                    : `${field}: the earlier image is put back.`
                  : `${field}: ${show(field, now[field])} back to ${show(field, before)}.`
            );
          }
        } else if (!same(now[field], before)) {
          lines.push(`${field} stays ${show(field, now[field])}: it was changed since.`);
        }
      }
      const puts: Overwrite[] = [];
      const deletes: string[] = [];
      if (e.overwrites) {
        const liveList = ((now.permission_overwrites as Overwrite[] | undefined) ?? []);
        const targets = new Set([...e.overwrites.before, ...e.overwrites.after].map((o) => o.id));
        let changedSince = 0;
        for (const t of targets) {
          const b = e.overwrites.before.find((o) => o.id === t);
          const a = e.overwrites.after.find((o) => o.id === t);
          const found = liveList.find((o) => o.id === t);
          // Gone with a role this build deleted: what the build left there
          // still counts as current, and it has to be put back even if the
          // build never changed it.
          const wentWithRole = !found && deletedRoleIds.has(t);
          const n = wentWithRole ? a : found;
          if (sameOverwrite(n, a)) {
            if (sameOverwrite(a, b) && !wentWithRole) continue;
            if (b) puts.push(b);
            else if (n && !wentWithRole) deletes.push(t);
          } else if (!sameOverwrite(n, b)) {
            changedSince += 1;
          }
        }
        if (puts.length || deletes.length) {
          lines.push(`Permissions: ${puts.length + deletes.length} role or member setting(s) put back as they were.`);
        }
        if (changedSince > 0) {
          lines.push(`${changedSince} permission setting(s) were changed since and stay as they are.`);
        }
        if (e.kind === "category" && (puts.length || deletes.length)) {
          const bystanders = syncedWith(e.id, live.channels).filter((c) => !restoredHere.has(c.id));
          if (bystanders.length > 0) {
            lines.push(
              "Channels that match its permissions now but were not part of this change keep their own: " +
                `${bystanders.map((c) => label("channel", c.name ?? c.id, c.type)).join(", ")}.`
            );
          }
        }
      }
      if (Object.keys(fields).length === 0 && puts.length === 0 && deletes.length === 0) {
        restores.push({
          type: "skip",
          entry: i,
          name: e.name,
          lines: lines.length ? lines : [`${label(e.kind, e.name, tOf(e))} is already as it was.`],
        });
        return;
      }
      restores.push({
        type: "restore",
        entry: i,
        kind: e.kind,
        id: e.id,
        name: e.name,
        lines: [`Restore ${label(e.kind, e.name, tOf(e))}.`, ...movedLine, ...lines],
        fields,
        puts,
        deletes,
      });
      return;
    }

    // Deleted: recreate, unless something by that name is back already.
    // An item this undo already recreated, in a run that then failed on the
    // follow-up work (giving the role back, its overwrites, moving channels
    // into a category), is not such a clash: the rest still has to happen.
    const resumeId = e.undo?.status === "failed" ? e.undo.newId : undefined;
    if (e.kind === "role") {
      if (resumeId && roleById.has(resumeId)) {
        recreateRoles.push({
          type: "recreate",
          entry: i,
          kind: "role",
          name: e.name,
          lines: [`Finish restoring the role ${quoted(e.name)}, recreated by an earlier run that stopped partway: its members and channel settings.`],
        });
        return;
      }
      const clash = live.roles.find((r) => (r.name ?? "").toLowerCase() === e.name.toLowerCase());
      if (clash) {
        recreateRoles.push({ type: "skip", entry: i, name: e.name, lines: [`A role named ${quoted(e.name)} exists again (${clash.id.startsWith("pending-") ? "recreated by an undo above" : clash.id}), so it is not recreated.`] });
        return;
      }
      const lines = [`Recreate the role ${quoted(e.name)} with its permissions and look.`];
      if (e.members && e.members.length > 0) lines.push(`Give it back to ${e.members.length} member(s) who had it.`);
      if (e.members === null) lines.push("Who had it was not recorded, so nobody gets it back automatically.");
      if (e.overwrites.length > 0) lines.push(`Restore its permission settings in ${e.overwrites.length} channel(s).`);
      lines.push("It gets a new id.", ...(e.notes ?? []));
      recreateRoles.push({ type: "recreate", entry: i, kind: "role", name: e.name, lines });
      return;
    }
    const snapshotType = Number(e.snapshot.type ?? 0);
    if (resumeId && channelById.has(resumeId)) {
      (e.kind === "category" ? recreateCategories : recreateChannels).push({
        type: "recreate",
        entry: i,
        kind: e.kind,
        name: e.name,
        lines: [`Finish restoring ${label(e.kind, e.name, tOf(e))}, recreated by an earlier run that stopped partway.`],
      });
      return;
    }
    const clash = live.channels.find(
      (c) => c.type === snapshotType && (c.name ?? "") === e.name && (c.parent_id ?? null) === ((e.snapshot.parent_id as string | null) ?? null)
    );
    if (clash) {
      (e.kind === "category" ? recreateCategories : recreateChannels).push({
        type: "skip",
        entry: i,
        name: e.name,
        lines: [`${label(e.kind, e.name, tOf(e))} exists again (${clash.id.startsWith("pending-") ? "recreated by an undo above" : clash.id}), so it is not recreated.`],
      });
      return;
    }
    const lines = [`Recreate ${label(e.kind, e.name, tOf(e))} with its settings and permissions.`];
    if (e.kind === "category" && e.children?.length) {
      lines.push(`Put back the ${e.children.length} channel(s) that were in it, where they are still without a category.`);
    }
    for (const s of e.settings ?? []) {
      lines.push(`Point the server's ${SETTING_NAMES[s] ?? s} back at it, if nothing else has been chosen since.`);
    }
    lines.push("It gets a new id.", ...(e.notes ?? []));
    (e.kind === "category" ? recreateCategories : recreateChannels).push({
      type: "recreate",
      entry: i,
      kind: e.kind,
      name: e.name,
      lines,
    });
  });

  return [
    ...recreateRoles,
    ...recreateCategories,
    ...recreateChannels,
    ...restores.reverse(),
    ...deleteChannels,
    ...deleteCategories,
    ...deleteRoles,
  ];
}

export interface UndoResult {
  entry: number;
  name: string;
  status: "done" | "skipped" | "failed";
  lines: string[];
  newId?: string;
}

// Fields copied when a channel is recreated. The rest of a channel object
// (ids, last message, timestamps) belongs to the old channel.
const CHANNEL_FIELDS = [
  "name",
  "type",
  "topic",
  "nsfw",
  "rate_limit_per_user",
  "bitrate",
  "user_limit",
  "rtc_region",
  "video_quality_mode",
  "default_auto_archive_duration",
  "default_reaction_emoji",
  "default_sort_order",
  "default_forum_layout",
  "default_thread_rate_limit_per_user",
  "position",
];

export async function executeUndo(
  rest: REST,
  guildId: string,
  record: BuildRecord,
  actions: UndoAction[],
  live: UndoLive,
  // Called after every action, to save progress.
  onProgress: (record: BuildRecord) => void,
  // Called when an item is recreated under a new id, so records made
  // before can still find it.
  onAlias?: (oldId: string, newId: string) => void
): Promise<UndoResult[]> {
  const reason = `discord-mcp undo ${record.buildId}`;
  const results: UndoResult[] = [];
  // Old id to new id: items recreated by any earlier undo, by an earlier run
  // of this one, and by this run as it goes.
  const aliasMap: Record<string, string> = { ...(live.aliases ?? {}) };
  for (const e of record.entries) {
    if (e.op === "deleted" && e.undo?.newId) aliasMap[e.id] = e.undo.newId;
  }
  const setAlias = (oldId: string, newId: string) => {
    aliasMap[oldId] = newId;
    live.aliases = { ...(live.aliases ?? {}), [oldId]: newId };
    onAlias?.(oldId, newId);
  };
  const mapId = (id: string) => resolveAlias(aliasMap, id);
  const existingRoles = new Set(live.roles.map((r) => r.id));
  const existingChannels = new Map(live.channels.map((c) => [c.id, c]));
  // The view of the server kept current with every write, so the next
  // change in a multi-change undo is planned against what is really there
  // without reading the channel list again (Discord allows 10 a minute).
  const putChannel = (c: GuildChannelLite) => {
    const merged = { ...(existingChannels.get(c.id) ?? {}), ...c } as GuildChannelLite;
    existingChannels.set(c.id, merged);
    live.channels = [...live.channels.filter((x) => x.id !== c.id), merged];
  };
  const dropChannel = (id: string) => {
    existingChannels.delete(id);
    live.channels = live.channels.filter((x) => x.id !== id);
  };
  const putRole = (r: RoleLite) => {
    existingRoles.add(r.id);
    const prior = live.roles.find((x) => x.id === r.id);
    live.roles = [...live.roles.filter((x) => x.id !== r.id), { ...(prior ?? {}), ...r } as RoleLite];
  };
  const dropRole = (id: string) => {
    existingRoles.delete(id);
    live.roles = live.roles.filter((x) => x.id !== id);
  };
  const setOverwrite = (channelId: string, target: string, o: Overwrite | null) => {
    const c = existingChannels.get(channelId);
    if (!c) return;
    const list = (c.permission_overwrites ?? []).filter((x) => x.id !== target);
    putChannel({ ...c, permission_overwrites: o ? [...list, o] : list });
  };
  const setMemberRole = (member: string, role: string, has: boolean) => {
    const roles = live.memberRoles?.[member];
    if (!live.memberRoles || !roles) return;
    live.memberRoles[member] = has ? [...new Set([...roles, role])] : roles.filter((r) => r !== role);
  };
  // Channels whose overwrites a restore puts back: a recreated role's
  // overwrites there come from the restore, which has the earlier state.
  const restoredOverwrites = new Set(
    record.entries.flatMap((e) =>
      e.op === "updated" && e.overwrites && !isFinished(e) ? [resolveAlias(aliasMap, e.id)] : []
    )
  );
  // Writes overwrites on a channel; on a category, with the channels synced
  // with it held, so they do not change along with it.
  const onChannel = async (channelId: string, write: () => Promise<void>): Promise<string[]> => {
    if (existingChannels.get(channelId)?.type !== 4) {
      await write();
      return [];
    }
    const { stuck } = await withSyncedHeld(
      rest,
      channelId,
      existingChannels.values(),
      holdCandidates(guildId, record.botUserId, live.roles),
      write
    );
    return stuckWarning(stuck);
  };
  // After a failed step: what to say about holds it could not let go.
  const stuckNote = (err: unknown): string => {
    const lines = stuckWarning(stuckFrom(err));
    return lines.length ? ` ${lines.join(" ")}` : "";
  };

  // The id a failed earlier run recreated this item under, when that item
  // is still there.
  const resumeTarget = (e: RecordEntry, exists: (id: string) => boolean): string | undefined => {
    const id = e.undo?.status === "failed" ? e.undo.newId : undefined;
    return id && exists(id) ? id : undefined;
  };
  // Remembers what a recreate made as soon as it exists.
  const markCreated = (entry: number, newId: string) => {
    record.entries[entry].undo = { status: "failed", note: "Recreated; the rest was not finished.", newId };
    onProgress(record);
  };

  const finish = (entry: number, status: UndoResult["status"], name: string, lines: string[], newId?: string) => {
    const e = record.entries[entry];
    e.undo = { status, ...(lines.length ? { note: lines.join(" ") } : {}), ...(newId ? { newId } : {}) };
    results.push({ entry, name, status, lines, ...(newId ? { newId } : {}) });
    onProgress(record);
  };

  for (const action of actions) {
    if (action.type === "skip") {
      finish(action.entry, "skipped", action.name, action.lines);
      continue;
    }
    const e = record.entries[action.entry];
    try {
      if (action.type === "recreate" && e.op === "deleted" && e.kind === "role") {
        const s = e.snapshot;
        const resumed = resumeTarget(e, (id) => existingRoles.has(id));
        const created = resumed
          ? (live.roles.find((r) => r.id === resumed) as RoleLite)
          : ((await rest.post(Routes.guildRoles(guildId), {
              body: {
                name: s.name ?? e.name,
                permissions: String(s.permissions ?? "0"),
                color: Number(s.color ?? 0),
                hoist: Boolean(s.hoist),
                mentionable: Boolean(s.mentionable),
                ...(s.unicode_emoji ? { unicode_emoji: s.unicode_emoji } : {}),
              },
              reason,
            })) as RoleLite);
        setAlias(e.id, created.id);
        putRole(created);
        // Saved before the follow-up work: if that fails, the next run
        // finds the role it made and carries on, instead of seeing a role
        // by that name and leaving the rest undone.
        markCreated(action.entry, created.id);
        const notes: string[] = [];
        if (!resumed) {
          try {
            await rest.patch(Routes.guildRoles(guildId), {
              body: [{ id: created.id, position: Number(s.position ?? 1) }],
              reason,
            });
          } catch {
            notes.push("It could not be moved back to its old place in the role list (the bot's own role must sit above it).");
          }
        }
        let given = 0;
        let gone = 0;
        for (const member of e.members ?? []) {
          try {
            await rest.put(Routes.guildMemberRole(guildId, member, created.id), { reason });
            setMemberRole(member, created.id, true);
            given += 1;
          } catch (err) {
            if ((err as { code?: number }).code === 10007) gone += 1;
            else throw err;
          }
        }
        if (given) notes.push(`Given back to ${given} member(s).`);
        if (gone) notes.push(`${gone} member(s) who had it have left the server.`);
        let restored = 0;
        for (const o of e.overwrites) {
          if (!existingChannels.has(o.channel_id) || restoredOverwrites.has(o.channel_id)) continue;
          notes.push(
            ...(await onChannel(o.channel_id, async () => {
              await rest.put(Routes.channelPermission(o.channel_id, created.id), {
                body: { type: 0, allow: o.allow, deny: o.deny },
                reason,
              });
            }))
          );
          setOverwrite(o.channel_id, created.id, { id: created.id, type: 0, allow: o.allow, deny: o.deny });
          restored += 1;
        }
        if (restored) notes.push(`Its permission settings in ${restored} channel(s) are back.`);
        finish(action.entry, "done", e.name, [`${resumed ? "Finished restoring" : "Recreated"} the role ${quoted(e.name)} (${created.id}).`, ...notes], created.id);
      } else if (action.type === "recreate" && e.op === "deleted" && e.kind !== "role") {
        const s = e.snapshot;
        const body: Record<string, unknown> = {};
        for (const k of CHANNEL_FIELDS) if (s[k] !== undefined && s[k] !== null) body[k] = s[k];
        if (Array.isArray(s.available_tags)) {
          body.available_tags = (s.available_tags as Array<Record<string, unknown>>).map(
            ({ name, moderated, emoji_id, emoji_name }) => ({ name, moderated, emoji_id, emoji_name })
          );
        }
        const notes: string[] = [];
        const parent = s.parent_id as string | null | undefined;
        if (parent) {
          const mapped = mapId(parent);
          if (existingChannels.has(mapped)) body.parent_id = mapped;
          else notes.push("Its category no longer exists, so it is recreated without one.");
        }
        const overwrites = ((s.permission_overwrites as Overwrite[] | undefined) ?? [])
          .map((o) => ({ ...o, id: Number(o.type) === 0 ? mapId(o.id) : o.id }))
          .filter((o) => Number(o.type) !== 0 || o.id === guildId || existingRoles.has(o.id));
        const dropped = ((s.permission_overwrites as Overwrite[] | undefined) ?? []).length - overwrites.length;
        if (dropped > 0) notes.push(`${dropped} permission setting(s) for roles that no longer exist are left out.`);
        body.permission_overwrites = overwrites;
        const resumed = resumeTarget(e, (id) => existingChannels.has(id));
        const created = resumed
          ? (existingChannels.get(resumed) as GuildChannelLite)
          : ((await rest.post(Routes.guildChannels(guildId), { body, reason })) as GuildChannelLite);
        setAlias(e.id, created.id);
        putChannel(created);
        markCreated(action.entry, created.id);
        if (e.kind === "category") {
          let moved = 0;
          for (const child of e.children ?? []) {
            const now = existingChannels.get(child);
            if (!now || now.parent_id) continue;
            await rest.patch(Routes.channel(child), { body: { parent_id: created.id }, reason });
            putChannel({ ...now, parent_id: created.id });
            moved += 1;
          }
          if (moved) notes.push(`${moved} channel(s) moved back into it.`);
        }
        for (const field of e.settings ?? []) {
          if (live.guildSettings[field]) {
            notes.push(`The server's ${SETTING_NAMES[field] ?? field} was set to something else since, so it stays.`);
            continue;
          }
          try {
            await rest.patch(Routes.guild(guildId), { body: { [field]: created.id }, reason });
            live.guildSettings[field] = created.id;
            if (live.guild) live.guild = { ...live.guild, [field]: created.id };
            notes.push(`The server's ${SETTING_NAMES[field] ?? field} points at it again.`);
          } catch {
            notes.push(`The server's ${SETTING_NAMES[field] ?? field} could not be pointed back at it (that needs Manage Server).`);
          }
        }
        finish(action.entry, "done", e.name, [`${resumed ? "Finished restoring" : "Recreated"} ${label(e.kind, e.name, entryChannelType(e))} (${created.id}).`, ...notes], created.id);
      } else if (action.type === "restore") {
        const fields = { ...action.fields };
        // Lines planned for something that turns out not to be possible
        // are taken out, and what happened instead is said.
        let lines = action.lines.slice(1);
        const instead: string[] = [];
        if (typeof fields.parent_id === "string") {
          const mapped = mapId(fields.parent_id);
          if (existingChannels.has(mapped)) fields.parent_id = mapped;
          else {
            delete fields.parent_id;
            lines = lines.filter((l) => !l.startsWith("parent_id:"));
            instead.push("Its earlier category no longer exists, so it stays where it is.");
          }
        }
        if (Object.keys(fields).length > 0) {
          if (action.kind === "server") {
            for (const k of ["afk_channel_id", "system_channel_id", "rules_channel_id", "public_updates_channel_id"]) {
              if (typeof fields[k] === "string") fields[k] = mapId(fields[k] as string);
            }
            await rest.patch(Routes.guild(guildId), { body: fields, reason });
            if (live.guild) live.guild = { ...live.guild, ...fields };
            for (const [k, v] of Object.entries(fields)) {
              if (k in live.guildSettings) live.guildSettings[k] = v as string | null;
            }
          } else if (action.kind === "role") {
            await rest.patch(Routes.guildRole(guildId, action.id), { body: fields, reason });
            putRole({ ...(live.roles.find((r) => r.id === action.id) as RoleLite), ...fields } as RoleLite);
          } else {
            await rest.patch(Routes.channel(action.id), { body: fields, reason });
            const c = existingChannels.get(action.id);
            if (c) putChannel({ ...c, ...fields } as GuildChannelLite);
          }
        }
        let rolesGone = 0;
        const writes = async () => {
          for (const o of action.puts) {
            const target = Number(o.type) === 0 ? mapId(o.id) : o.id;
            if (Number(o.type) === 0 && target !== guildId && !existingRoles.has(target)) {
              rolesGone += 1;
              continue;
            }
            await rest.put(Routes.channelPermission(action.id, target), {
              body: { type: Number(o.type), allow: o.allow, deny: o.deny },
              reason,
            });
            setOverwrite(action.id, target, { id: target, type: Number(o.type), allow: o.allow, deny: o.deny });
          }
          for (const t of action.deletes) {
            try {
              await rest.delete(Routes.channelPermission(action.id, t), { reason });
            } catch (err) {
              if ((err as { code?: number }).code !== 10009) throw err;
            }
            setOverwrite(action.id, t, null);
          }
        };
        const notes =
          action.puts.length || action.deletes.length ? await onChannel(action.id, writes) : [];
        if (rolesGone > 0) {
          instead.push(`${rolesGone} of those permission setting(s) belong to roles that no longer exist and were left out.`);
        }
        finish(action.entry, "done", action.name, [...lines, ...instead, ...notes]);
      } else if (action.type === "member") {
        const role = mapId(action.role);
        try {
          if (action.add) {
            await rest.put(Routes.guildMemberRole(guildId, action.member, role), { reason });
          } else {
            await rest.delete(Routes.guildMemberRole(guildId, action.member, role), { reason });
          }
          setMemberRole(action.member, role, action.add);
        } catch (err) {
          if ((err as { code?: number }).code !== 10007) throw err;
          finish(action.entry, "skipped", action.name, ["The member has left the server."]);
          continue;
        }
        finish(action.entry, "done", action.name, action.lines);
      } else if (action.type === "delete") {
        const deletedType = entryChannelType(e) ?? existingChannels.get(action.id)?.type;
        try {
          await rest.delete(
            action.kind === "role" ? Routes.guildRole(guildId, action.id) : Routes.channel(action.id),
            { reason }
          );
        } catch (err) {
          const code = (err as { code?: number }).code;
          if (code !== 10003 && code !== 10011) throw err;
        }
        if (action.kind === "role") dropRole(action.id);
        else dropChannel(action.id);
        finish(action.entry, "done", action.name, [`Deleted ${label(action.kind, action.name, deletedType)}.`]);
      }
    } catch (err) {
      const message =
        (describeRateLimit(err) ?? (err instanceof Error ? err.message : String(err))) + stuckNote(err);
      // Keeps the id of an item already recreated, so the next run resumes.
      const made = record.entries[action.entry].undo?.newId;
      finish(
        action.entry,
        "failed",
        action.name,
        made ? [message, "It was recreated, but not everything that belongs to it is back; undoing again finishes that."] : [message],
        made
      );
    }
  }

  // Finished when nothing is left to do: every entry done or skipped.
  if (record.entries.every(isFinished)) record.undoneAt = Date.now();
  record.undoRuns = (record.undoRuns ?? 0) + 1;
  onProgress(record);
  return results;
}

// Plans several changes for one preview, newest first, each against the
// server as undoing the newer ones would leave it. The same undo runs, on
// copies, against a stand-in for Discord that changes nothing and hands out
// placeholder ids, so the preview cannot drift from what running it does:
// an item an earlier step deletes is gone for the later ones, and one it
// recreates is there.
export async function planInOrder(
  guildId: string,
  records: BuildRecord[],
  live: UndoLive
): Promise<Array<{ record: BuildRecord; actions: UndoAction[] }>> {
  const view = structuredClone(live);
  let next = 0;
  const standIn = {
    async post(_route: string, options?: { body?: unknown }) {
      return { ...((options?.body as Record<string, unknown>) ?? {}), id: `pending-${++next}` };
    },
    async patch() {
      return {};
    },
    async put() {
      return {};
    },
    async delete() {
      return {};
    },
    async get() {
      return {};
    },
  } as unknown as REST;
  const out: Array<{ record: BuildRecord; actions: UndoAction[] }> = [];
  for (const record of records) {
    const copy = structuredClone(record);
    const actions = planUndo(copy, view);
    out.push({ record, actions });
    await executeUndo(standIn, guildId, copy, actions, view, () => {});
  }
  return out;
}
