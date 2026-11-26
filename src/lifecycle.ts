import { VERSION, type ServerConfig } from "./config.js";
import { IS_INSTALLED, dataDir } from "./home.js";
import { checksForUpdates, startUpdateCheck } from "./updateCheck.js";

// When the background work starts: the Discord gateway connection and the
// message scheduler.
//
// Clients on the 2026-07-28 protocol start a server process just to ask it
// server/discover, then kill it and start the real one. That short-lived
// copy must not open a Discord connection or fire scheduled messages, so on
// stdio the background work waits for the first request that is not the
// discovery probe. A 2025-era client opens with initialize, which counts, so
// for today's clients nothing changes. HTTP has no probe copies (a probe is
// just another request to the same process), so it starts at launch.

export const PROBE_METHOD = "server/discover";

// True when a raw stdio line is a request or notification other than the
// discovery probe. Responses (no method) and unparsable lines do not count.
export function opensRealConnection(line: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  const method = (message as { method?: unknown } | null)?.method;
  return typeof method === "string" && method !== PROBE_METHOD;
}

// Reads the stream alongside the MCP transport, which keeps its own listener,
// and calls onReal once, at the first line that opens a real connection.
// Must be attached after the transport's own listener so no data is consumed
// before the transport sees it. A first message too large to hold is real
// traffic by definition, so it starts the work rather than buffering.
const MAX_BUFFER = 1024 * 1024;

export function watchForRealConnection(
  stream: NodeJS.ReadableStream,
  onReal: () => void
): void {
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line && opensRealConnection(line)) {
        stream.off("data", onData);
        buffer = "";
        onReal();
        return;
      }
    }
    if (buffer.length > MAX_BUFFER) {
      stream.off("data", onData);
      buffer = "";
      onReal();
    }
  };
  stream.on("data", onData);
}

let started = false;

// Idempotent: the first call starts both, later calls do nothing.
export async function startBackgroundWork(config: ServerConfig): Promise<void> {
  if (started) return;
  started = true;
  console.error(
    config.token
      ? "discord-mcp: client connected; starting the Discord gateway and scheduler"
      : "discord-mcp: client connected; no DISCORD_TOKEN, so no gateway or scheduler"
  );
  // The gateway connects in the background: presence goes online and event
  // subscriptions start flowing. A gateway failure degrades to REST-only and
  // shows up in diagnostics.
  const { startGateway } = await import("./discord/gateway.js");
  void startGateway(config);
  // The scheduler catches up anything that came due while the process was
  // down, then fires the rest on time. Read-only mode posts nothing, so it
  // does not run there: queued messages wait for an install that may send.
  if (config.readOnly) {
    console.error("discord-mcp: read-only mode, so queued messages are not sent; they stay queued.");
  } else {
    const { startScheduler } = await import("./scheduler.js");
    startScheduler(config);
  }
  // Usage stats: counting starts, and the daily report goes out on the
  // first call of a day that reaches Discord (see usageReport.ts).
  const { startUsageReport } = await import("./usageReport.js");
  startUsageReport(config);
  // Whether a newer version is out, asked of npm at most once a day and
  // never waited for (see updateCheck.ts).
  void startUpdateCheck({ current: VERSION, dir: dataDir(), installed: checksForUpdates(process.env, IS_INSTALLED) });
}

// Calls still running. A shutdown lets them finish first, so a change that
// is under way in Discord is not cut off halfway. Its answer cannot reach the
// app any more: the stdio transport stops answering once its input ends, as
// the MCP stdio binding says it should.
let running = 0;
let whenIdle: Array<() => void> = [];

export async function whileRunning<T>(work: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await work();
  } finally {
    running--;
    if (running === 0) {
      const waiting = whenIdle;
      whenIdle = [];
      for (const resolve of waiting) resolve();
    }
  }
}

export function callsRunning(): number {
  return running;
}

function idleOrAfter(ms: number): Promise<void> {
  if (running === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    whenIdle.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// On stdio the app owns the process: when it closes its end of the pipe,
// or asks the process to stop, the server ends too. Without this an open
// Discord connection kept it running with no app attached, so the bot stayed
// online and scheduled messages kept going out from a copy nobody could
// reach, for example after the app crashed or a remote session dropped.
//
// Calls already running get up to graceMs to finish their work, the Discord
// connection is closed so the bot goes offline at once, and the process exits; a hard
// deadline makes sure it does even if closing hangs. Usage stats are written
// on exit (see usageStats.ts). An error on the log stream is ignored: an app
// that closes it should cost the logs, not the server.
export const LEAVE_GRACE_MS = 5000;
const CLOSE_LIMIT_MS = 3000;

export interface LeaveOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log: NodeJS.WritableStream;
  signals?: Pick<NodeJS.Process, "once">;
  stop: () => Promise<void>;
  exit: (code: number) => void;
  graceMs?: number;
  closeLimitMs?: number;
}

export function exitWhenClientLeaves(options: LeaveOptions): () => Promise<void> {
  const grace = options.graceMs ?? LEAVE_GRACE_MS;
  const closeLimit = options.closeLimitMs ?? CLOSE_LIMIT_MS;
  let leaving: Promise<void> | undefined;
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };
  options.log.on("error", () => undefined);
  const leave = (why: string): Promise<void> => {
    if (leaving) return leaving;
    leaving = (async () => {
      try {
        options.log.write(`discord-mcp: ${why}, so the server is stopping.\n`);
      } catch {
        // The log is gone too; stop quietly.
      }
      const deadline = setTimeout(() => exit(0), grace + closeLimit);
      deadline.unref?.();
      await idleOrAfter(grace);
      await Promise.race([
        options.stop().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, closeLimit).unref?.()),
      ]);
      clearTimeout(deadline);
      exit(0);
    })();
    return leaving;
  };
  options.input.once("end", () => void leave("the app closed the connection"));
  options.input.once("close", () => void leave("the app closed the connection"));
  options.output.on("error", () => void leave("the app stopped reading"));
  options.signals?.once("SIGTERM", () => void leave("the app asked it to stop"));
  options.signals?.once("SIGINT", () => void leave("it was interrupted"));
  return () => leave("it was asked to stop");
}
