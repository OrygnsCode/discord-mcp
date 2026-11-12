import { plainText, quoted } from "../discord/names.js";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "../home.js";

// Change records: what each change did, kept so it can be undone. A build
// is one change; so is a single create_channel, update_role, permission
// edit, or role given to a member. One JSON file per change in the data
// folder, per server, newest 50 kept.
//
// A record holds what is needed to put things back and nothing more:
// what was created (to delete it), each changed setting before and after
// (to restore it only if it still holds the value the build set), and a
// full copy of anything deleted (to recreate it). Records hold names,
// topics, and permission settings from the server; never a token.

const KEEP_PER_SERVER = 50;
const ID_PATTERN = /^[a-f0-9]{16}$/;
const SNOWFLAKE = /^\d{17,20}$/;
// An undo that has held its lock this long is assumed dead.
const LOCK_STALE_MS = 10 * 60_000;

export type ItemKind = "role" | "category" | "channel" | "server";

// How a recorded item is named in a sentence: "#general", "the voice
// channel Lobby", "the category Staff", "the role Mod".
export function itemLabel(kind: ItemKind, name: string, channelType?: number): string {
  if (kind === "server") return "the server settings";
  if (kind === "role") return `the role ${quoted(name)}`;
  if (kind === "category" || channelType === 4) return `the category ${quoted(name)}`;
  if (channelType === 2) return `the voice channel ${quoted(name)}`;
  if (channelType === 13) return `the stage channel ${quoted(name)}`;
  return `#${plainText(name)}`;
}

export type Overwrite = { id: string; type: number; allow: string; deny: string };

// What undoing one entry came to, kept on the entry so a second undo run
// picks up where the first stopped.
export interface EntryUndo {
  status: "done" | "skipped" | "failed";
  note?: string;
  // The id of an item undo recreated.
  newId?: string;
}

export type RecordEntry =
  | { op: "created"; kind: ItemKind; id: string; name: string; channelType?: number; undo?: EntryUndo }
  | {
      op: "updated";
      kind: ItemKind;
      id: string;
      name: string;
      // A channel's Discord type, for naming it ("the voice channel Lobby").
      // Records made before it was kept say "#name" for every channel.
      channelType?: number;
      // Discord's own field names, before and after.
      fields: Record<string, { before: unknown; after: unknown }>;
      overwrites?: { before: Overwrite[]; after: Overwrite[] };
      undo?: EntryUndo;
    }
  | {
      // A role given to or taken from a member.
      op: "member_role";
      change: "added" | "removed";
      member: string;
      memberName: string;
      role: string;
      name: string;
      undo?: EntryUndo;
    }
  | {
      op: "deleted";
      kind: "category" | "channel";
      id: string;
      name: string;
      // The channel as Discord returned it just before deletion.
      snapshot: Record<string, unknown>;
      // For a category: the channels it held, left without one.
      children?: string[];
      // Server settings that pointed at it, by Discord field name.
      settings?: string[];
      // What undo cannot bring back, said up front.
      notes?: string[];
      undo?: EntryUndo;
    }
  | {
      op: "deleted";
      kind: "role";
      id: string;
      name: string;
      snapshot: Record<string, unknown>;
      // Who had it, up to a cap; null when that could not be read.
      members: string[] | null;
      memberCount: number | null;
      // Its overwrites on channels this build did not delete.
      overwrites: Array<{ channel_id: string; allow: string; deny: string }>;
      notes?: string[];
      undo?: EntryUndo;
    };

export interface BuildRecord {
  buildId: string;
  guildId: string;
  botUserId: string;
  createdAt: number;
  // The tool that made the change.
  tool?: string;
  planId?: string;
  entries: RecordEntry[];
  // Set once an undo has finished every entry it could.
  undoneAt?: number;
  undoRuns?: number;
}

function serverDir(guildId: string): string {
  if (!SNOWFLAKE.test(guildId)) throw new Error("Invalid server id.");
  return join(dataDir(), "changes", guildId);
}

function fileFor(guildId: string, buildId: string, suffix = ".json"): string {
  if (!ID_PATTERN.test(buildId)) throw new Error("Invalid build id.");
  return join(serverDir(guildId), `${buildId}${suffix}`);
}

export function isValidBuildId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function saveRecord(record: Omit<BuildRecord, "buildId"> & { buildId?: string }): BuildRecord {
  const full: BuildRecord = { ...record, buildId: record.buildId ?? randomBytes(8).toString("hex") };
  mkdirSync(serverDir(full.guildId), { recursive: true });
  writeFileSync(fileFor(full.guildId, full.buildId), JSON.stringify(full, null, 2) + "\n");
  prune(full.guildId);
  return full;
}

function prune(guildId: string): void {
  const all = listRecords(guildId);
  for (const old of all.slice(KEEP_PER_SERVER)) {
    try {
      unlinkSync(fileFor(guildId, old.buildId));
    } catch {
      // Already gone.
    }
  }
}

// Newest first.
export function listRecords(guildId: string): BuildRecord[] {
  const dir = serverDir(guildId);
  if (!existsSync(dir)) return [];
  const out: BuildRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as BuildRecord);
    } catch {
      // A damaged record is skipped rather than failing the listing.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getRecord(guildId: string, buildId: string): BuildRecord | undefined {
  if (!isValidBuildId(buildId)) return undefined;
  try {
    return JSON.parse(readFileSync(fileFor(guildId, buildId), "utf8")) as BuildRecord;
  } catch {
    return undefined;
  }
}

// Exactly one undo of a build runs at a time. The lock is a file created
// only if absent, which only one process can do; one older than ten
// minutes belonged to a run that died and is taken over.
export function lockForUndo(guildId: string, buildId: string): boolean {
  const lock = fileFor(guildId, buildId, ".undo-lock");
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
  } catch {
    // Someone else cleared it.
  }
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    return false;
  }
}

export function unlockUndo(guildId: string, buildId: string): void {
  try {
    unlinkSync(fileFor(guildId, buildId, ".undo-lock"));
  } catch {
    // Already released.
  }
}

// Where recreated items live now, old id to new id, per server. Undo
// writes one each time it recreates something, so an older record that
// names the deleted item reaches the one that replaced it.
function aliasFile(guildId: string): string {
  return join(serverDir(guildId), "aliases.json");
}

export function loadAliases(guildId: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(aliasFile(guildId), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveAlias(guildId: string, oldId: string, newId: string): void {
  if (!SNOWFLAKE.test(oldId) || !SNOWFLAKE.test(newId)) return;
  mkdirSync(serverDir(guildId), { recursive: true });
  const all = loadAliases(guildId);
  all[oldId] = newId;
  writeFileSync(aliasFile(guildId), JSON.stringify(all, null, 2) + "\n");
}

export function writeRecord(record: BuildRecord): void {
  writeFileSync(fileFor(record.guildId, record.buildId), JSON.stringify(record, null, 2) + "\n");
}

// A recorded channel's Discord type, where the record has it.
export function entryChannelType(e: RecordEntry): number | undefined {
  if (e.op === "created" || e.op === "updated") return e.channelType;
  if (e.op === "deleted" && e.kind !== "role" && e.snapshot.type !== undefined) return Number(e.snapshot.type);
  return undefined;
}
