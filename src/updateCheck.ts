import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_NAME } from "./identity.js";
import { setting } from "./settings.js";

// Telling people a newer version exists.
//
// A server like this is installed once and then runs for months. Nothing
// else would ever tell its user that a fix came out, so once a day an
// installed copy asks the npm registry for the latest version number. When
// that is newer than the one running, the AI is told once per session, in
// one line, and run_setup_check says so each time it is asked.
//
// What is sent is the request itself: the package name, to npm, the same
// request any `npm install` makes. Nothing about servers, bots, or use.
// DISCORD_MCP_UPDATE_CHECK=false turns it off. A source checkout and the
// container image never ask: one is run by its developer, the other is
// updated by pulling a tag, and neither is helped by the command below.
//
// The answer comes from the network, so it is trusted for nothing but a
// version number of the plain three-part kind. Anything else is dropped,
// and what is shown is rebuilt from the parsed numbers.

const DAY_MS = 24 * 3600_000;
const STATE_FILE = "update-check.json";
const REGISTRY = "https://registry.npmjs.org";
const MAX_BODY = 64 * 1024;

export type Version = [number, number, number];

// A released version, such as 2.1.0. Pre-releases and anything decorated
// are not offered as updates.
export function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== "string") return undefined;
  const m = text.trim().match(/^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewer(latest: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

export function updateCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = setting("UPDATE_CHECK", env)?.toLowerCase();
  return !(value === "false" || value === "0" || value === "off" || value === "no");
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<{
  ok: boolean;
  text(): Promise<string>;
}>;

// The latest published version, or undefined when it cannot be had: no
// network, a slow registry, an answer that is not a version.
export async function latestPublished(
  current: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  timeoutMs = 4000
): Promise<Version | undefined> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${REGISTRY}/${PACKAGE_NAME.replace("/", "%2F")}/latest`, {
      headers: { accept: "application/json", "user-agent": `discord-mcp/${current} (update check)` },
      signal: stop.signal,
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const body = await res.text();
    if (body.length > MAX_BODY) return undefined;
    return parseVersion((JSON.parse(body) as { version?: unknown } | null)?.version);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface State {
  checkedAt: number;
  latest?: string;
}

function readState(dir: string): State | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Partial<State> | null;
    if (!raw || typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return undefined;
    return { checkedAt: raw.checkedAt, ...(parseVersion(raw.latest) ? { latest: raw.latest } : {}) };
  } catch {
    return undefined;
  }
}

export interface UpdateCheckOptions {
  current: string;
  dir: string;
  installed: boolean;
  now?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: Fetch;
}

// The newer version to mention, or undefined. Asks the registry at most
// once a day per data folder, whatever the answer was, and otherwise goes by
// what it was told last time.
export async function newerVersion(opts: UpdateCheckOptions): Promise<string | undefined> {
  const current = parseVersion(opts.current);
  if (!current || !opts.installed || !updateCheckEnabled(opts.env)) return undefined;
  const now = opts.now ?? Date.now();
  let state = readState(opts.dir);
  // A clock set back would otherwise put the next check far in the future.
  const fresh = state !== undefined && now >= state.checkedAt && now - state.checkedAt < DAY_MS;
  if (!fresh) {
    const latest = await latestPublished(opts.current, opts.fetchImpl);
    state = { checkedAt: now, ...(latest ? { latest: latest.join(".") } : state?.latest ? { latest: state.latest } : {}) };
    try {
      if (!existsSync(opts.dir)) mkdirSync(opts.dir, { recursive: true });
      writeFileSync(join(opts.dir, STATE_FILE), JSON.stringify(state) + "\n");
    } catch {
      // A folder that cannot be written means asking again next start;
      // nothing worse.
    }
  }
  const latest = parseVersion(state?.latest);
  return latest && isNewer(latest, current) ? latest.join(".") : undefined;
}

export const UPDATE_COMMAND = `npx ${PACKAGE_NAME}@latest init`;
export const RELEASES_URL = "https://github.com/OrygnsCode/discord-mcp/releases";

// One line, written as information for the AI to pass on, not as an order
// to it: what is out, the one command, and where the changes are listed.
export function updateNotice(latest: string, current: string): string {
  return (
    `discord-mcp ${latest} is available; this is ${current}. To update, the person who set this up runs ` +
    `\`${UPDATE_COMMAND}\`, chooses "Re-register with your AI client", and restarts the AI app. ` +
    `What changed: ${RELEASES_URL}`
  );
}

// ---- the running process ----

let available: string | undefined;
let shown = false;

// Starts the check without waiting for it. Called once the first real
// request has arrived, so a discovery probe never reaches the network.
export function startUpdateCheck(opts: UpdateCheckOptions): Promise<void> {
  return newerVersion(opts).then(
    (latest) => {
      available = latest;
    },
    () => undefined
  );
}

// The newer version this process knows of, for run_setup_check.
export function availableUpdate(): string | undefined {
  return available;
}

// The notice still owed to this session, and the way to say it was given.
export function pendingUpdateNotice(current: string): string | undefined {
  return available !== undefined && !shown ? updateNotice(available, current) : undefined;
}

export function updateNoticeGiven(): void {
  shown = true;
}

export const __testing = {
  reset(): void {
    available = undefined;
    shown = false;
  },
  assume(latest: string | undefined): void {
    available = latest;
    shown = false;
  },
};
