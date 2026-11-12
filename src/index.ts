#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, VERSION } from "./config.js";
import { buildServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { PACKAGE_ROOT } from "./home.js";
import { npxCacheWarning } from "./install.js";
import { startBackgroundWork, watchForRealConnection } from "./lifecycle.js";
import { setting } from "./settings.js";

// Entry point. Two transports:
//
//   orygn-discord-mcp          stdio, the default; for desktop MCP clients
//   orygn-discord-mcp --http   Streamable HTTP on 127.0.0.1:3414
//   orygn-discord-mcp init     the setup wizard ("setup" works too)
//
// One hard rule in stdio mode and everything it pulls in: nothing writes
// to stdout except the MCP protocol itself. Logs go to stderr.

function parseArgs(argv: string[]): {
  http: boolean;
  port: number;
  host: string;
} {
  const args = argv.slice(2);
  const http = args.includes("--http");
  const portFlag = args.indexOf("--port");
  const hostFlag = args.indexOf("--host");

  const port =
    portFlag !== -1
      ? Number(args[portFlag + 1])
      : Number(setting("PORT") ?? 3414);
  const host =
    hostFlag !== -1
      ? args[hostFlag + 1]
      : setting("HTTP_HOST") ?? "127.0.0.1";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port "${port}". Use --port 1..65535.`);
    process.exit(1);
  }
  return { http, port, host };
}

// The init subcommand runs the interactive setup wizard and exits. "setup"
// is accepted too, since that is the word people guess first.
if (process.argv[2] === "init" || process.argv[2] === "setup") {
  const { runWizard } = await import("./wizard.js");
  await runWizard();
  process.exit(0);
}

const config = loadConfig();

// A misspelled group would otherwise look like tools going missing at
// random, so refuse to start and name the valid groups instead.
if (config.toolsets.unknown.length > 0) {
  const { unknownToolsetMessage } = await import("./toolsets.js");
  const { settingSource } = await import("./settings.js");
  console.error(unknownToolsetMessage(config.toolsets.unknown, settingSource("TOOLS")));
  process.exit(1);
}

const { http, port, host } = parseArgs(process.argv);

// A client config naming a file inside npm's npx cache works until npm
// clears that folder, and then fails on every start with nothing on screen
// to explain it. Say so while it still runs. See install.ts.
const npxWarning = npxCacheWarning(PACKAGE_ROOT, process.env);
if (npxWarning) console.error(npxWarning);

if (http) {
  void startBackgroundWork(config);
  startHttpServer(config, { port, host });
} else {
  // Serves both protocol eras: a 2025-era client opens with initialize, a
  // 2026-07-28 client with server/discover or an enveloped request. One
  // server instance from the factory is pinned per connection.
  serveStdio(() => buildServer(config));
  // Attached after serveStdio so the transport's own stdin listener is
  // already in place. See lifecycle.ts for why the start waits.
  watchForRealConnection(process.stdin, () => void startBackgroundWork(config));
  console.error(
    `discord-mcp v${VERSION} on stdio` +
      (config.toolsets.all
        ? ""
        : ` (toolsets: core, ${config.toolsets.groups.join(", ")})`) +
      (config.token ? "" : " (no DISCORD_TOKEN set, diagnostics will say so)")
  );
}
