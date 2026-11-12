import { VERSION, type ServerConfig } from "./config.js";
import { IS_INSTALLED, dataDir } from "./home.js";
import { startUpdateCheck } from "./updateCheck.js";

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
  // down, then fires the rest on time.
  const { startScheduler } = await import("./scheduler.js");
  startScheduler(config);
  // Whether a newer version is out, asked of npm at most once a day and
  // never waited for (see updateCheck.ts).
  void startUpdateCheck({ current: VERSION, dir: dataDir(), installed: IS_INSTALLED });
}
