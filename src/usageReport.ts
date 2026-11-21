import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Routes } from "discord-api-types/v10";
import type { RESTGetAPICurrentUserGuildsResult } from "discord-api-types/v10";
import { VERSION, type ServerConfig } from "./config.js";
import { IS_INSTALLED, PACKAGE_ROOT } from "./home.js";
import { inNpxCache } from "./install.js";
import { packagedAs } from "./packaging.js";
import { getRestForToken } from "./discord/client.js";
import {
  ERROR_CLASSES,
  GATE_EVENTS,
  currentAppName,
  flush,
  startCounting,
  usageDir,
  usageSwitch,
  utcDay,
  type DayTally,
} from "./usageStats.js";

// The daily usage report. At most once per UTC day per install (the
// settings folder is the install), on the first day's call that reached
// Discord, it sends what the install looks like and the counts of the days
// before, then stays quiet until the next day. See docs/privacy.md for the
// fields; every value is a number band or one of a fixed list.
//
// Several copies of the server can share one install (an app per window,
// two AI apps), so one lock file decides which of them sends, and the state
// file says a day was sent only once the receiver answered. A day's report
// carries a random number, reused if it has to be sent again; the receiver
// counts each number once and forgets it after two days, so a retry never
// counts twice and nothing links one day's report to another's.

export const REPORT_BASE = "https://telemetry.orygn.tech";
// The receiver's paths on that host.
export const REPORT_PATH = "/discord-mcp/v1";
export const SCHEMA = 1;
const SEND_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 60_000;
// A day's counts wait this long after a process last wrote them, so one
// still finishing its write at midnight is not sent half done.
const SETTLE_MS = 60_000;
const MAX_DAYS = 7;
// The receiver takes reports up to 64 KB. A week of heavy use, every tool
// every day, comes near that, so the oldest days are left out until the
// report fits.
export const MAX_REPORT_BYTES = 60_000;

type Env = Record<string, string | undefined>;

interface State {
  first_seen?: string;
  active: string[];
  sent_day?: string;
  nonce?: { day: string; value: string };
  failures?: number;
  next_try_at?: string;
}

export interface ReportDay {
  d: string;
  tools: Record<string, string>;
  gate: Record<string, string>;
  errors: Record<string, string>;
  apps: string[];
}

export interface Report {
  s: number;
  day: string;
  nonce: string;
  v: string;
  os: string;
  app: string;
  install: string;
  ctx: string;
  bots: string;
  servers?: string;
  largest?: string;
  age: string;
  first: { week: boolean; month: boolean; ever: boolean };
  days: ReportDay[];
}

// --- bands ---

export function countBand(n: number): string {
  return n >= 100 ? "100+" : n >= 10 ? "10-99" : "1-9";
}

export function botsBand(n: number): string {
  return n >= 4 ? "4+" : n >= 2 ? "2-3" : "1";
}

export function serversBand(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n <= 5 ? "2-5" : n <= 20 ? "6-20" : "21+";
}

export function sizeBand(members: number): string {
  return members >= 5000 ? "5k+" : members >= 500 ? "500-5k" : members >= 50 ? "50-500" : "<50";
}

export function ageBand(days: number): string {
  return days <= 0 ? "0" : days <= 7 ? "1-7" : days <= 30 ? "8-30" : days <= 90 ? "31-90" : "90+";
}

// --- where and how it runs ---

export function osName(platform: string = process.platform): string {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "other";
}

// How this copy was installed. The Docker image and the Claude Desktop
// bundle say so themselves (DISCORD_MCP_PACKAGING); the rest is read from
// where the package sits.
export function installKind(env: Env = process.env, root: string = PACKAGE_ROOT, installed: boolean = IS_INSTALLED): string {
  const packaged = packagedAs(env);
  if (packaged) return packaged;
  if (!installed) return "source";
  if (inNpxCache(root)) return "npx";
  // The wizard's own copy: <home>/app/<version>/node_modules/...
  if (/[\\/]app[\\/]\d+\.\d+\.\d+[^\\/]*[\\/]node_modules[\\/]/.test(root)) return "wizard";
  // npm's global folder is node_modules under lib (Unix) or npm (Windows).
  if (/[\\/](?:lib|npm)[\\/]node_modules[\\/]/.test(root)) return "global";
  return "other";
}

export function runContext(env: Env = process.env, fileExists: (p: string) => boolean = existsSync): string {
  if (packagedAs(env) === "docker") return "container";
  if (env.KUBERNETES_SERVICE_HOST || fileExists("/.dockerenv") || fileExists("/run/.containerenv")) return "container";
  return "default";
}

// --- the days ---

function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return utcDay(new Date(d.getTime() - back * 86_400_000));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Whether today is this install's first active day of its week, month, and
// ever, from the days before it. Worked out from the days before today
// only, so a report sent again later the same day says the same.
export function firstFlags(active: string[], day: string, firstSeen: string | undefined): Report["first"] {
  const earlier = active.filter((d) => d < day);
  return {
    week: !earlier.some((d) => isoWeekStart(d) === isoWeekStart(day)),
    month: !earlier.some((d) => d.slice(0, 7) === day.slice(0, 7)),
    ever: earlier.length === 0 && (firstSeen === undefined || firstSeen === day),
  };
}

// The finished days' counts, added up across every process's file. A day
// with a file written in the last minute waits for the next report.
export function collectDays(dir: string, today: string, now: number = Date.now()): { days: ReportDay[]; files: string[] } {
  const byDay = new Map<string, { tally: DayTally; files: string[]; fresh: boolean }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { days: [], files: [] };
  }
  for (const name of names) {
    const m = name.match(/^day-(\d{4}-\d{2}-\d{2})-[\w-]+\.json$/);
    if (!m || m[1] >= today) continue;
    const path = join(dir, name);
    let tally: DayTally;
    let mtime: number;
    try {
      tally = JSON.parse(readFileSync(path, "utf8")) as DayTally;
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const entry = byDay.get(m[1]) ?? { tally: { tools: {}, gate: {}, errors: {}, apps: [] }, files: [], fresh: false };
    for (const [tool, n] of Object.entries(tally.tools ?? {})) entry.tally.tools[tool] = (entry.tally.tools[tool] ?? 0) + (Number(n) || 0);
    for (const [k, n] of Object.entries(tally.gate ?? {})) {
      const key = k as keyof DayTally["gate"];
      entry.tally.gate[key] = (entry.tally.gate[key] ?? 0) + (Number(n) || 0);
    }
    for (const [k, n] of Object.entries(tally.errors ?? {})) {
      const key = k as keyof DayTally["errors"];
      entry.tally.errors[key] = (entry.tally.errors[key] ?? 0) + (Number(n) || 0);
    }
    for (const app of tally.apps ?? []) if (!entry.tally.apps.includes(app)) entry.tally.apps.push(app);
    entry.files.push(path);
    if (now - mtime < SETTLE_MS) entry.fresh = true;
    byDay.set(m[1], entry);
  }
  const ready = [...byDay.entries()].filter(([, e]) => !e.fresh).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, MAX_DAYS);
  return {
    days: ready.map(([d, e]) => ({
      d,
      tools: banded(e.tally.tools),
      gate: banded(Object.fromEntries(GATE_EVENTS.filter((k) => e.tally.gate[k]).map((k) => [k, e.tally.gate[k]!]))),
      errors: banded(Object.fromEntries(ERROR_CLASSES.filter((k) => e.tally.errors[k]).map((k) => [k, e.tally.errors[k]!]))),
      apps: e.tally.apps.slice(0, 10),
    })),
    files: ready.flatMap(([, e]) => e.files),
  };
}

function banded(counts: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(counts)) if (n > 0 && /^[a-z][a-z0-9_-]{0,47}$/.test(k)) out[k] = countBand(n);
  return out;
}

// --- state and the lock ---

function readState(dir: string): State {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State;
    return { ...s, active: Array.isArray(s.active) ? s.active.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [] };
  } catch {
    return { active: [] };
  }
}

function writeState(dir: string, state: State): void {
  const temp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, join(dir, "state.json"));
}

// Made with exclusive create, so of several processes trying at once one
// gets it. A lock older than a minute belongs to a process that died.
function takeLock(dir: string, now: number): boolean {
  const path = join(dir, "send.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      try {
        if (now - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(dir: string): void {
  rmSync(join(dir, "send.lock"), { force: true });
}

// After a failed send: 15 minutes, doubling, at most 6 hours.
export function backoffMs(failures: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, failures - 1), 6 * 3_600_000);
}

// --- sending ---

// The receiver's HTTP status, or 0 when it could not be reached.
type Post = (url: string, body: string) => Promise<number>;

const realPost: Post = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `discord-mcp/${VERSION}` },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: "error",
    });
    return res.status;
  } catch {
    return 0;
  }
};

// What a status means for the report: taken; refused for what it is, which
// sending it again would not change; or not taken this time.
export function sendOutcome(status: number): "sent" | "rejected" | "failed" {
  if (status >= 200 && status < 300) return "sent";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "failed";
}

// The report as sent, without the oldest days while it is too large.
export function fitReport(report: Report): string {
  let body = JSON.stringify(report);
  while (body.length > MAX_REPORT_BYTES && report.days.length > 0) {
    report.days = report.days.slice(0, -1);
    body = JSON.stringify(report);
  }
  return body;
}

// How many servers the bots are in, and the size of the largest, as bands.
// One request per bot, on the day a report goes out. Left out on failure.
type GuildCounts = (config: ServerConfig) => Promise<{ servers: number; largest: number } | undefined>;

// The servers a report counts, from each bot's list: every server once, and
// only those this install may act in (DISCORD_MCP_ALLOWED_SERVERS).
export function countServers(
  lists: ReadonlyArray<ReadonlyArray<{ id: string; approximate_member_count?: number }>>,
  allowed?: ReadonlySet<string>
): { servers: number; largest: number } {
  const ids = new Set<string>();
  let largest = 0;
  for (const guilds of lists) {
    for (const g of guilds) {
      if (allowed && !allowed.has(g.id)) continue;
      ids.add(g.id);
      largest = Math.max(largest, g.approximate_member_count ?? 0);
    }
  }
  return { servers: ids.size, largest };
}

const realGuildCounts: GuildCounts = async (config) => {
  try {
    const lists: RESTGetAPICurrentUserGuildsResult[] = [];
    for (const bot of config.bots) {
      lists.push(
        (await getRestForToken(bot.token).get(Routes.userGuilds(), {
          query: new URLSearchParams({ with_counts: "true" }),
        })) as RESTGetAPICurrentUserGuildsResult
      );
    }
    return countServers(lists, config.allowedServers);
  } catch {
    return undefined;
  }
};

interface Deps {
  post: Post;
  guildCounts: GuildCounts;
  env: Env;
}

let deps: Deps = { post: realPost, guildCounts: realGuildCounts, env: process.env };

// Where reports go. DISCORD_MCP_TELEMETRY_URL points them at another
// receiver, such as one run locally to test against.
function endpoint(path: string): string {
  const override = deps.env.DISCORD_MCP_TELEMETRY_URL?.trim().replace(/\/+$/, "");
  return (override && /^https?:\/\/[^\s]+$/.test(override) ? override : REPORT_BASE) + path;
}

let config: ServerConfig | undefined;
let sending = false;
let sentDay: string | undefined;
let retryAfter = 0;

// Turns the report on for this process, when usage stats are on and a bot
// is configured. Counting starts with it.
export function startUsageReport(cfg: ServerConfig): void {
  config = cfg;
  startCounting({ hasBot: cfg.bots.length > 0, onActiveDay: () => void sendIfDue() });
}

// Sends today's report if it has not gone out yet. Never throws, never
// writes to stdout, never holds up a tool: it runs after the result is out.
export async function sendIfDue(now: Date = new Date()): Promise<"sent" | "skipped" | "failed" | "rejected"> {
  if (!config || sending || !usageSwitch(deps.env).on) return "skipped";
  const day = utcDay(now);
  if (sentDay === day || now.getTime() < retryAfter) return "skipped";
  sending = true;
  const dir = usageDir();
  try {
    mkdirSync(dir, { recursive: true });
    const before = readState(dir);
    if (before.sent_day === day) {
      sentDay = day;
      return "skipped";
    }
    if (before.next_try_at && Date.parse(before.next_try_at) > now.getTime()) {
      retryAfter = Date.parse(before.next_try_at);
      return "skipped";
    }
    if (!takeLock(dir, now.getTime())) return "skipped";
    try {
      // Read again under the lock: another process may have just sent.
      const state = readState(dir);
      if (state.sent_day === day) {
        sentDay = day;
        return "skipped";
      }
      if (state.nonce?.day !== day) state.nonce = { day, value: randomBytes(16).toString("hex") };
      if (!state.first_seen) state.first_seen = day;
      const first = firstFlags(state.active, day, state.first_seen);
      if (!state.active.includes(day)) state.active = [...state.active.filter((d) => d < day), day].slice(-40);
      // Saved before sending, so a retry reuses the same number and flags.
      writeState(dir, state);

      flush();
      const { days, files } = collectDays(dir, day, now.getTime());
      const counts = await deps.guildCounts(config);
      const report: Report = {
        s: SCHEMA,
        day,
        nonce: state.nonce.value,
        v: VERSION,
        os: osName(),
        app: currentAppName(),
        install: installKind(deps.env),
        ctx: runContext(deps.env),
        bots: botsBand(config.bots.length),
        ...(counts ? { servers: serversBand(counts.servers), largest: sizeBand(counts.largest) } : {}),
        age: ageBand(daysBetween(state.first_seen, day)),
        first,
        days,
      };
      const outcome = sendOutcome(await deps.post(endpoint(`${REPORT_PATH}/ping`), fitReport(report)));
      if (outcome === "failed") {
        state.failures = (state.failures ?? 0) + 1;
        retryAfter = now.getTime() + backoffMs(state.failures);
        state.next_try_at = new Date(retryAfter).toISOString();
      } else {
        // Taken, or refused for good: either way this day is done, and the
        // counts it carried go, so a report the receiver will never take
        // cannot be retried for ever.
        state.sent_day = day;
        delete state.failures;
        delete state.next_try_at;
        for (const f of files) rmSync(f, { force: true });
        sentDay = day;
      }
      writeState(dir, state);
      return outcome;
    } finally {
      releaseLock(dir);
    }
  } catch {
    return "failed";
  } finally {
    sending = false;
  }
}

// --- the setup wizard ---

export const SETUP_FLOWS = ["fresh", "add_bot", "reregister", "upgrade"] as const;
export const SETUP_OUTCOMES = ["completed", "unfinished", "cancelled", "failed"] as const;
export const SETUP_STEPS = ["start", "token", "intents", "name", "invite", "server", "save", "register"] as const;
export const SETUP_ERRORS = ["network", "certificate", "files", "terminal", "old_node", "other"] as const;

// The error codes a failed run can report. Anything not here is sent as
// "other", so a code can only ever be one of these words.
export const SETUP_CODES = [
  // No connection, or no answer.
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH",
  "EHOSTUNREACH", "ENETDOWN", "ECONNABORTED", "EPIPE", "EPROTO", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "timeout",
  // A secure connection refused. ERR_SSL stands for every ERR_SSL_ code.
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL",
  // Files, and the terminal.
  "EACCES", "EPERM", "EBUSY", "ENOSPC", "EROFS", "ENOENT", "EEXIST", "ENOTDIR", "EISDIR",
  "EMFILE", "ENFILE", "EIO", "ELOOP", "ENAMETOOLONG", "EXDEV", "EINVAL", "UNKNOWN",
  "ENOTTY", "EBADF", "EAGAIN",
  // An error with no code, by its type.
  "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "none", "other",
] as const;

// What went wrong along the way, whatever the outcome.
export const SETUP_TROUBLE = [
  "input_visible", // the token prompt could not hide what was typed
  "token_cleaned", // spaces, quotes, or invisible characters taken out of a token
  "token_ctrl_v", // Ctrl+V arrived as a key instead of pasting
  "token_control", // other keys (arrows, Escape, Ctrl) arrived with the token
  "token_unusable", // a token with other characters no token has
  "token_secret", // rejected, and shaped like the Client Secret
  "token_id", // rejected, and shaped like an ID
  "token_public_key", // rejected, and shaped like the Public Key
  "token_rejected", // rejected, any other shape
  "discord_429", // Discord turned the connection away for a while
  "discord_403", // Discord refused the connection
  "discord_5xx", // Discord had an error of its own
  "discord_other", // any other answer that was neither ok nor a rejection
  "network_retry", // a request worked only on its second try
  "intents_off", // a required intent was off when checked
  "no_servers", // the bot was in no server yet
  "servers_unlisted", // the bot's servers could not be listed
  "npx_copy_failed", // the copy out of npx's cache failed
  "config_invalid", // an app's config file was not valid JSON
] as const;

export interface SetupEvent {
  flow: (typeof SETUP_FLOWS)[number];
  outcome: (typeof SETUP_OUTCOMES)[number];
  // Where it registered the server: the wizard's own client ids, or snippet.
  apps: string[];
  // The step it was on. Sent only for a run that did not complete.
  step?: (typeof SETUP_STEPS)[number];
  // The kind of error that stopped a failed run, and its code. Never the
  // error's text, which can hold file paths, a user name, or the token.
  error?: (typeof SETUP_ERRORS)[number];
  code?: (typeof SETUP_CODES)[number];
  trouble?: Array<(typeof SETUP_TROUBLE)[number]>;
}

// One report when the wizard ends: which path it took, how it ended, which
// app it set up, what went wrong along the way, and for a run that did not
// complete, where it stopped and why. Waits at most the send timeout.
export async function sendSetupEvent(event: SetupEvent): Promise<boolean> {
  if (!usageSwitch(deps.env).on) return false;
  const failed = event.outcome === "failed" && event.error !== undefined;
  const trouble = [...new Set(event.trouble ?? [])].slice(0, SETUP_TROUBLE.length);
  const body = {
    s: SCHEMA,
    kind: "setup",
    day: utcDay(),
    nonce: randomBytes(16).toString("hex"),
    v: VERSION,
    os: osName(),
    node: process.versions.node.split(".")[0],
    install: installKind(deps.env),
    flow: event.flow,
    outcome: event.outcome,
    apps: [...new Set(event.apps)].slice(0, 5),
    ...(trouble.length > 0 ? { trouble } : {}),
    ...(event.outcome !== "completed" && event.step ? { step: event.step } : {}),
    ...(failed ? { error: event.error, code: event.code ?? "none" } : {}),
  };
  return sendOutcome(await deps.post(endpoint(`${REPORT_PATH}/setup`), JSON.stringify(body))) === "sent";
}

// For tests: swap what sends and what counts servers, and reset the
// in-process memory of what was sent.
export const __testing = {
  use(next: Partial<Deps>, cfg?: ServerConfig): void {
    deps = { ...deps, ...next };
    if (cfg) config = cfg;
    sentDay = undefined;
    retryAfter = 0;
    sending = false;
  },
  reset(): void {
    deps = { post: realPost, guildCounts: realGuildCounts, env: process.env };
    config = undefined;
    sentDay = undefined;
    retryAfter = 0;
    sending = false;
  },
};
