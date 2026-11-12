import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Routes } from "discord-api-types/v10";
import type { ServerConfig } from "./config.js";
import { getRest, getRestForToken } from "./discord/client.js";
import { dataDir } from "./home.js";
import { setting } from "./settings.js";

// The message scheduler. Schedules persist as JSON files so they survive a
// restart, and the engine fires them with a periodic tick while the
// process is alive. A message that came due while the server was off is sent
// on the next start (catch-up), then either removed or advanced to its
// next repeat. This is honest about its one limit: nothing fires while the
// process is down, so always-on delivery wants the hosted or container
// deployment, not a laptop that sleeps.

// Default tick is half a minute, fine for human-scheduled messages.
// Overridable so tests can run the loop fast.
function tickMs(): number {
  const raw = Number(setting("SCHEDULER_TICK_MS"));
  return Number.isFinite(raw) && raw >= 250 ? raw : 30_000;
}

export type Repeat = "none" | "daily" | "weekly";

export interface ScheduledMessage {
  id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  send_at: string;
  repeat: Repeat;
  created_at: string;
  last_fired_at: string | null;
  // The configured bot that scheduled it, by name, and so the one that
  // sends it. Absent on messages scheduled before 2.0: the default bot.
  bot?: string;
  // Why the last attempt could not be delivered (the channel is gone, or
  // the bot may not post there). A one-shot with this set is not tried
  // again; it stays listed so the failure is seen instead of the message
  // quietly vanishing.
  failed?: string;
}

function storeDir(): string {
  return join(dataDir(), "schedules");
}

// Ids are randomBytes(8) hex: exactly 16 lowercase hex characters. Every
// path is built from a validated id so a tool argument can never escape
// the store directory through path traversal (e.g. "../../etc/x").
const ID_PATTERN = /^[a-f0-9]{16}$/;

export function isValidScheduleId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function fileFor(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error("Invalid schedule id.");
  }
  return join(storeDir(), `${id}.json`);
}

export function listSchedules(): ScheduledMessage[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const out: ScheduledMessage[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as ScheduledMessage);
    } catch {
      // Skip a corrupt entry rather than failing the whole list.
    }
  }
  return out.sort((a, b) => a.send_at.localeCompare(b.send_at));
}

export function saveSchedule(input: {
  guildId: string;
  channelId: string;
  channelName: string;
  content: string;
  sendAt: Date;
  repeat: Repeat;
  bot?: string;
}): ScheduledMessage {
  const schedule: ScheduledMessage = {
    id: randomBytes(8).toString("hex"),
    guild_id: input.guildId,
    channel_id: input.channelId,
    channel_name: input.channelName,
    content: input.content,
    send_at: input.sendAt.toISOString(),
    repeat: input.repeat,
    created_at: new Date().toISOString(),
    last_fired_at: null,
    ...(input.bot ? { bot: input.bot } : {}),
  };
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(fileFor(schedule.id), JSON.stringify(schedule, null, 2) + "\n");
  return schedule;
}

// One schedule by id, or undefined. A message being sent this very moment
// is claimed (renamed), so it is looked for under its claim too.
export function getSchedule(id: string): ScheduledMessage | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  const candidates = [fileFor(id), ...claimsOf(id)];
  for (const file of candidates) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ScheduledMessage;
    } catch {
      // Gone or mid-rename; try the next.
    }
  }
  return undefined;
}

function claimsOf(id: string): string[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${id}.claim-`))
    .map((f) => join(dir, f));
}

function cancelMark(id: string): string {
  return join(storeDir(), `${id}.cancelled`);
}

// Cancels a schedule. One that is being sent at this moment cannot be
// stopped, but a mark is left so a repeat does not come back afterwards
// (completeClaim checks it); before, cancelling then answered "no such
// message" and the repeat carried on.
export function cancelSchedule(id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  const file = fileFor(id);
  let found = false;
  try {
    unlinkSync(file);
    found = true;
  } catch {
    // Not there under its own name.
  }
  if (claimsOf(id).length > 0) {
    writeFileSync(cancelMark(id), "");
    found = true;
  }
  return found;
}

// --- Claims ---
//
// Every running copy of the server that shares this store runs its own
// scheduler: two AI apps set up on one install, for example. A due message
// is claimed before it is sent so only one copy sends it. A claim is an
// atomic rename of <id>.json to <id>.claim-<pid>-<ms>. When two copies race,
// exactly one rename succeeds and the other gets ENOENT. listSchedules reads
// only *.json, so a claimed message is invisible to the other copies until
// it is released.

const CLAIM_PATTERN = /^([a-f0-9]{16})\.claim-(\d+)-(\d+)$/;

// A send takes seconds. A claim older than this belongs to a copy that is
// stuck or gone, even if its process id has since been reused.
const STALE_CLAIM_MS = 10 * 60_000;

function claimFile(id: string, pid: number, at: number): string {
  return join(storeDir(), `${id}.claim-${pid}-${at}`);
}

// Claims a due schedule and returns it as it is on disk now, or undefined
// when another copy got there first or it is no longer due. Reading again
// after the rename matters: the list this copy worked from can be stale, and
// a repeat that another copy already sent has moved on to its next time.
export function claimDue(
  id: string,
  now: number = Date.now()
): { schedule: ScheduledMessage; claim: string } | undefined {
  const claim = claimFile(id, process.pid, now);
  try {
    renameSync(fileFor(id), claim);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let schedule: ScheduledMessage;
  try {
    schedule = JSON.parse(readFileSync(claim, "utf8")) as ScheduledMessage;
  } catch {
    renameSync(claim, fileFor(id));
    return undefined;
  }
  if (new Date(schedule.send_at).getTime() > now) {
    renameSync(claim, fileFor(id));
    return undefined;
  }
  return { schedule, claim };
}

// After a successful send: a one-shot is done, a repeat moves to its next
// time. The next occurrence is written before the claim is removed, so a
// crash in between leaves both files and recovery knows the send finished.
export function completeClaim(schedule: ScheduledMessage, claim: string): void {
  const cancelled = existsSync(cancelMark(schedule.id));
  if (cancelled) unlinkSync(cancelMark(schedule.id));
  if (schedule.repeat !== "none" && !cancelled) {
    const next = new Date(schedule.send_at);
    const stepMs = schedule.repeat === "daily" ? 86_400_000 : 604_800_000;
    // Skip forward past now so a long downtime does not unleash a backlog.
    do {
      next.setTime(next.getTime() + stepMs);
    } while (next.getTime() <= Date.now());
    const advanced = {
      ...schedule,
      send_at: next.toISOString(),
      last_fired_at: new Date().toISOString(),
    };
    writeFileSync(fileFor(schedule.id), JSON.stringify(advanced, null, 2) + "\n");
  }
  unlinkSync(claim);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Claims left behind by a copy that died mid-send (killed, crashed, or the
// app was quit). If the next occurrence was already written, the send
// finished and the claim is just removed. Otherwise the message is released
// to go out again: whether the interrupted send reached Discord cannot be
// known, and a scheduled message arriving twice beats one that never does.
export function recoverStaleClaims(
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = processAlive
): number {
  const dir = storeDir();
  if (!existsSync(dir)) return 0;
  let recovered = 0;
  for (const file of readdirSync(dir)) {
    const match = CLAIM_PATTERN.exec(file);
    if (!match) continue;
    const [, id, pidText, atText] = match;
    const pid = Number(pidText);
    const old = now - Number(atText) > STALE_CLAIM_MS;
    if (!old && (pid === process.pid || isAlive(pid))) continue;
    try {
      if (existsSync(fileFor(id))) unlinkSync(join(dir, file));
      else renameSync(join(dir, file), fileFor(id));
      recovered += 1;
    } catch {
      // Another copy recovered it first.
    }
  }
  return recovered;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

// Schedules already complained about in this process, so a message whose
// bot is gone is logged once, not every tick.
const complained = new Set<string>();

// The client that sends a schedule: the bot that scheduled it. A message
// scheduled by a bot other than the default used to go out through the
// default bot, which may not be in that server at all.
function restFor(config: ServerConfig, schedule: ScheduledMessage): ReturnType<typeof getRest> | undefined {
  if (!schedule.bot) return config.token ? getRest(config) : undefined;
  const bot = config.bots.find((b) => b.name === schedule.bot);
  return bot ? getRestForToken(bot.token) : undefined;
}

async function tick(config: ServerConfig): Promise<void> {
  if (running || config.bots.length === 0) return;
  running = true;
  try {
    recoverStaleClaims();
    for (const listed of listSchedules()) {
      if (new Date(listed.send_at).getTime() > Date.now()) continue;
      if (listed.failed && listed.repeat === "none") continue;
      const rest = restFor(config, listed);
      if (!rest) {
        if (!complained.has(listed.id)) {
          complained.add(listed.id);
          console.error(
            `discord-mcp scheduler: ${listed.id} was scheduled by the bot "${listed.bot}", which is no longer ` +
              "configured. It stays queued; cancel it, or add that bot back."
          );
        }
        continue;
      }
      try {
        await fireOne(rest, listed.id);
      } catch (err) {
        logFailure(listed.id, err);
      }
    }
  } catch (err) {
    // The tick runs unawaited; anything thrown here would be an unhandled
    // rejection, which ends the process.
    console.error(
      `discord-mcp scheduler: tick failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    running = false;
  }
}

async function fireOne(rest: ReturnType<typeof getRest>, id: string): Promise<void> {
  const claimed = claimDue(id);
  if (!claimed) return;
  const { schedule, claim } = claimed;
  try {
    await rest.post(Routes.channelMessages(schedule.channel_id), {
      body: {
        content: schedule.content,
        allowed_mentions: { parse: [] },
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    const reason = err instanceof Error ? err.message : String(err);
    if (existsSync(cancelMark(schedule.id))) {
      // Cancelled while this send was under way: it is simply gone.
      unlinkSync(cancelMark(schedule.id));
      unlinkSync(claim);
    } else if (status === 403 || status === 404) {
      // The channel vanished or the bot may no longer post there. Trying
      // again every tick would never work. A one-shot stays listed, marked
      // failed; a repeat waits for its next time.
      if (schedule.repeat === "none") {
        writeFileSync(fileFor(schedule.id), JSON.stringify({ ...schedule, failed: reason }, null, 2) + "\n");
        unlinkSync(claim);
      } else {
        completeClaim({ ...schedule, failed: reason }, claim);
      }
    } else {
      // Anything else (a network blip, a rate limit) is tried again.
      renameSync(claim, fileFor(schedule.id));
    }
    throw err;
  }
  const { failed: _cleared, ...delivered } = schedule;
  completeClaim(delivered, claim);
}

function logFailure(id: string, err: unknown): void {
  console.error(
    `discord-mcp scheduler: failed to send ${id}: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}

// Exposed for unit tests only.
export const __testing = { tick };

export function startScheduler(config: ServerConfig): void {
  if (timer || config.bots.length === 0) return;
  // Catch up immediately on start, then tick.
  void tick(config);
  timer = setInterval(() => void tick(config), tickMs());
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
