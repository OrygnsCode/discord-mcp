import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../home.js";

// What lock_channel changed on a channel, so unlock_channel can put back
// exactly that and nothing more. A lock touches @everyone's overwrite two
// ways: it adds denials, and it takes off allowances (an allow beats a deny
// inside one overwrite, so leaving one would leave the channel open). Both
// are remembered as the bits that actually changed. A channel that was
// already closed is remembered too, with nothing changed, so unlocking
// everything after a raid leaves a read-only channel read-only.
//
// This is kept apart from the change records, which hold only the newest
// 50 per server: locking sixty channels must still unlock all sixty.

export interface ChannelLock {
  // Bits the lock added to @everyone's deny.
  denied: string;
  // Bits the lock took off @everyone's allow.
  unallowed: string;
  at: number;
}

const SNOWFLAKE = /^\d{17,20}$/;

function fileFor(guildId: string): string {
  if (!SNOWFLAKE.test(guildId)) throw new Error("Invalid server id.");
  return join(dataDir(), "locks", `${guildId}.json`);
}

function readAll(guildId: string): Record<string, ChannelLock> {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(guildId), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ChannelLock>)
      : {};
  } catch {
    // No file yet, or a damaged one: no locks on record.
    return {};
  }
}

function writeAll(guildId: string, locks: Record<string, ChannelLock>): void {
  const file = fileFor(guildId);
  mkdirSync(join(dataDir(), "locks"), { recursive: true });
  // Written whole and renamed into place, so a second copy of the server
  // reading at that moment never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(locks, null, 2) + "\n");
  renameSync(tmp, file);
}

function bits(value: unknown): bigint {
  try {
    return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

export function getLock(
  guildId: string,
  channelId: string
): { denied: bigint; unallowed: bigint } | undefined {
  const lock = readAll(guildId)[channelId];
  if (!lock || typeof lock !== "object") return undefined;
  return { denied: bits(lock.denied), unallowed: bits(lock.unallowed) };
}

// Records a lock. Locking a channel a second time adds to what the first
// lock changed instead of replacing it, so the first lock's allowance is
// not forgotten.
export function saveLock(
  guildId: string,
  channelId: string,
  change: { denied: bigint; unallowed: bigint }
): void {
  if (!SNOWFLAKE.test(channelId)) throw new Error("Invalid channel id.");
  const all = readAll(guildId);
  const earlier = all[channelId];
  all[channelId] = {
    denied: (bits(earlier?.denied) | change.denied).toString(),
    unallowed: (bits(earlier?.unallowed) | change.unallowed).toString(),
    at: Date.now(),
  };
  writeAll(guildId, all);
}

export function clearLock(guildId: string, channelId: string): void {
  const all = readAll(guildId);
  if (!(channelId in all)) return;
  delete all[channelId];
  writeAll(guildId, all);
}
