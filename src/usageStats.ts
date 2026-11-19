import { accessSync, constants, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { IS_INSTALLED, dataDir } from "./home.js";
import { setting, settingSource } from "./settings.js";
import { packagedAs } from "./packaging.js";

// Usage stats: what this install counts, while it runs, for the daily
// report (usageReport.ts sends it). Kept free of anything Discord so the
// REST client and the safety gate can feed it without import cycles.
//
// Nothing here is a name, an id, or text from Discord. A tool call is
// counted under the tool's own name, an error under a fixed class, a
// confirmation under preview, confirmed, or declined. Counts are kept per
// UTC day in one small file per process, which the report adds up once the
// day is over.

type Env = Record<string, string | undefined>;

export interface UsageSwitch {
  on: boolean;
  // Why it is off, for the setup check: which setting or circumstance.
  why?: string;
}

const ON_WORDS = ["on", "true", "1", "yes"];

// Set by CI systems. A test run is never real use.
export const CI_VARIABLES = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TF_BUILD", "JENKINS_URL", "TEAMCITY_VERSION", "BITBUCKET_BUILD_NUMBER", "CODEBUILD_BUILD_ID"];

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

// Whether usage stats are sent, and if not, why. DISCORD_MCP_TELEMETRY set
// to anything but on (off, false, disabled, ...) turns them off, so a word
// meant as off never leaves them on. DO_NOT_TRACK and CI always win. A
// source checkout is development, so it sends nothing unless told to.
export function usageSwitch(env: Env = process.env, installed: boolean = IS_INSTALLED || packagedAs(env) !== undefined): UsageSwitch {
  if (truthy(env.DO_NOT_TRACK)) return { on: false, why: "DO_NOT_TRACK is set" };
  const ci = CI_VARIABLES.find((name) => truthy(env[name]));
  if (ci) return { on: false, why: "running in CI" };
  const value = setting("TELEMETRY", env);
  if (value !== undefined) {
    if (ON_WORDS.includes(value.toLowerCase())) return { on: true };
    // The Claude Desktop bundle sets it from a checkbox in its settings.
    return { on: false, why: packagedAs(env) === "mcpb" ? "turned off in the extension's settings" : `${settingSource("TELEMETRY", env)}=${value}` };
  }
  if (!installed) return { on: false, why: "running from a source checkout" };
  return { on: true };
}

// The settings line for run_setup_check: plain, one line, either way. In
// the Claude Desktop bundle the switch is a checkbox, not a variable.
export function usageLine(sw: UsageSwitch = usageSwitch(), env: Env = process.env): string {
  if (!sw.on) return `Usage stats: off (${sw.why}).`;
  return packagedAs(env) === "mcpb"
    ? "Usage stats: on. To turn them off, untick Usage stats in this extension's settings."
    : `Usage stats: on. To turn them off, set ${settingSource("TELEMETRY", env)}=off.`;
}

// --- what is counted ---

export const ERROR_CLASSES = ["permission", "intents", "rate_limited", "not_found", "validation", "no_token", "network", "other"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const GATE_EVENTS = ["preview", "confirmed", "declined"] as const;
export type GateEvent = (typeof GATE_EVENTS)[number];

export interface DayTally {
  tools: Record<string, number>;
  gate: Partial<Record<GateEvent, number>>;
  errors: Partial<Record<ErrorClass, number>>;
  apps: string[];
}

// A failed result, sorted into a class by what it says. Only the class is
// kept, never the text.
export function errorClass(summary: string, data: unknown): ErrorClass {
  if ((data as { rate_limited?: unknown } | null)?.rate_limited === true || /rate.?limit/i.test(summary)) return "rate_limited";
  if (/No Discord bot token/i.test(summary)) return "no_token";
  if (/intent/i.test(summary)) return "intents";
  if (/permission|Missing Access|not allowed to|cannot (?:manage|edit|assign|kick|ban)/i.test(summary)) return "permission";
  if (/Could not reach Discord|network|ECONN|ETIMEDOUT|fetch failed/i.test(summary)) return "network";
  if (/has no parameter named|does not read|Input validation|Invalid arguments|has no dry run|expected .* received/i.test(summary)) return "validation";
  if (/No (?:single |configured )?\w*.{0,40}match|not found|Unknown \w+|does not exist|no longer exists|is not one of the servers/i.test(summary)) return "not_found";
  return "other";
}

// The AI app, from the name it gives when it connects, as one of a fixed
// list. Order matters: Claude Code before Claude, and so on. Claude
// Desktop 5 connects to an extension as "local-agent-mode-<the server's
// name>", so that prefix comes first: what follows it is
// our own name, which could hold any word.
const APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^local-agent-mode-|^custom3p-/i, "claude-desktop"],
  [/claude[-_ ]?code/i, "claude-code"],
  [/claude/i, "claude-desktop"],
  [/cursor/i, "cursor"],
  [/visual studio code|vscode|vs code/i, "vscode"],
  [/windsurf|codeium/i, "windsurf"],
  [/^roo|roo[-_ ]?code/i, "roo-code"],
  [/cline/i, "cline"],
  [/codex/i, "codex"],
  [/^zed/i, "zed"],
  [/goose/i, "goose"],
  [/continue/i, "continue"],
  [/lm[-_ ]?studio/i, "lm-studio"],
  [/gemini/i, "gemini-cli"],
  [/kiro/i, "kiro"],
  [/chatgpt|openai/i, "chatgpt"],
  [/jetbrains|intellij|pycharm|webstorm/i, "jetbrains"],
  [/opencode/i, "opencode"],
  [/warp/i, "warp"],
  [/librechat/i, "librechat"],
];

export function appName(clientName: string | undefined): string {
  if (!clientName || !clientName.trim()) return "unknown";
  for (const [pattern, name] of APPS) if (pattern.test(clientName)) return name;
  return "other";
}

// --- the running tally ---

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

interface Running {
  day: string;
  tally: DayTally;
  dirty: boolean;
  file: string;
}

let running: Running | undefined;
let counting = false;
let reachedDay: string | undefined;
let currentApp = "unknown";
let onActive: (() => void) | undefined;
const fileTag = `${process.pid}-${randomBytes(3).toString("hex")}`;

// Where the counts and the report's state live: the data folder, so they
// survive upgrades. Where that cannot be written (a container run without a
// volume, where the image's own folder belongs to root), the system's temp
// folder instead; those installs are labelled as containers anyway.
let resolvedDir: string | undefined;

export function usageDir(): string {
  if (resolvedDir) return resolvedDir;
  const primary = join(dataDir(), "usage-stats");
  try {
    mkdirSync(primary, { recursive: true });
    accessSync(primary, constants.W_OK);
    resolvedDir = primary;
  } catch {
    resolvedDir = join(tmpdir(), "discord-mcp-usage-stats");
  }
  return resolvedDir;
}

function emptyTally(): DayTally {
  return { tools: {}, gate: {}, errors: {}, apps: [] };
}

function today(): Running {
  const day = utcDay();
  if (!running || running.day !== day) {
    // The day turned: what is left of the old one is written before moving on.
    if (running?.dirty) flush();
    running = { day, tally: emptyTally(), dirty: false, file: join(usageDir(), `day-${day}-${fileTag}.json`) };
  }
  return running;
}

// Writes this process's count for the day, whole, under a temporary name
// renamed into place, so the report never reads half a file.
export function flush(): void {
  if (!running || !running.dirty) return;
  try {
    mkdirSync(usageDir(), { recursive: true });
    const temp = `${running.file}.tmp`;
    writeFileSync(temp, JSON.stringify(running.tally));
    renameSync(temp, running.file);
    running.dirty = false;
  } catch {
    // A folder that cannot be written just means nothing is counted.
  }
}

// Written at once, every time: an app closing the server kills it outright
// (on Windows nothing runs at exit), and a file of a few hundred bytes
// costs nothing next to the call that changed it.
function changed(r: Running): void {
  r.dirty = true;
  flush();
}

// Turns counting on for this process. Only an install that has a bot token
// counts: a directory scanner starting the server with no token is not use.
export function startCounting(opts: { hasBot: boolean; onActiveDay: () => void }): void {
  if (!usageSwitch().on || !opts.hasBot) return;
  counting = true;
  onActive = opts.onActiveDay;
  pruneOldFiles();
  process.once("exit", flush);
}

export function countingEnabled(): boolean {
  return counting;
}

export function noteClient(clientName: string | undefined): void {
  const name = appName(clientName);
  if (name !== "unknown") currentApp = name;
}

export function currentAppName(): string {
  return currentApp;
}

// A request to Discord that succeeded: this install is really in use today.
export function noteDiscordReached(): void {
  reachedDay = utcDay();
}

export function noteGate(event: GateEvent): void {
  if (!counting) return;
  const r = today();
  r.tally.gate[event] = (r.tally.gate[event] ?? 0) + 1;
  changed(r);
}

// One tool call and how it ended. A call that succeeded on a day Discord
// was reached makes the day active, which is when the report goes out.
export function noteToolCall(tool: string, failed: { summary: string; data: unknown } | undefined): void {
  if (!counting) return;
  const r = today();
  r.tally.tools[tool] = (r.tally.tools[tool] ?? 0) + 1;
  if (!r.tally.apps.includes(currentApp)) r.tally.apps.push(currentApp);
  if (failed) {
    const cls = errorClass(failed.summary, failed.data);
    r.tally.errors[cls] = (r.tally.errors[cls] ?? 0) + 1;
  }
  changed(r);
  if (!failed && reachedDay === r.day && onActive) {
    const go = onActive;
    setImmediate(go);
  }
}

// Day files from more than a week ago are never sent; they go.
const KEEP_DAYS = 8;

function pruneOldFiles(): void {
  try {
    const dir = usageDir();
    if (!existsSync(dir)) return;
    const cutoff = utcDay(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const name of readdirSync(dir)) {
      const m = name.match(/^day-(\d{4}-\d{2}-\d{2})-/);
      if (m && m[1] < cutoff) rmSync(join(dir, name), { force: true });
      // A temporary file left by a process that died mid-write.
      if (name.endsWith(".tmp") && Date.now() - statSync(join(dir, name)).mtimeMs > 3_600_000) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Nothing to prune is fine.
  }
}

// For tests: the state of this process's counting, and a way to reset it.
export const __testing = {
  reset(): void {
    resolvedDir = undefined;
    running = undefined;
    counting = false;
    reachedDay = undefined;
    currentApp = "unknown";
    onActive = undefined;
  },
  running: () => running,
  fileTag,
};
