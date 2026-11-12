import { config as loadDotenv } from "dotenv";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectToolsets, type ToolsetSelection } from "./toolsets.js";
import { installedHome, IS_INSTALLED, PACKAGE_ROOT } from "./home.js";
import { setting } from "./settings.js";

// Where the token and settings are read from. One place per kind of copy,
// the same place the wizard writes to (see configDir in home.ts):
//
//   DISCORD_MCP_HOME set   only that folder
//   a source checkout      only the package root, next to package.json
//   an installed copy      its home folder (~/.orygn/discord-mcp, or
//                          ~/.omnicord for an upgrade not moved over yet),
//                          then a .env placed inside the package by hand
//
// Nothing else is read. Until 2.0 the folder the server was started in came
// first, and every other location was tried after a custom home. Both were
// ways to run as a bot nobody chose: an AI app opened in some other
// project picked up that project's .env, DISCORD_TOKEN being the name every
// Discord bot uses, and a custom home with no token in it fell through to
// the real one. A real environment variable still overrides every file,
// since dotenv never replaces a variable that is already set, even an empty
// one.
// quiet:true matters too: dotenv v17 prints a banner to stdout by default,
// and anything on stdout that is not a JSON-RPC message breaks the stdio
// transport.
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("../package.json");

// Folders that may hold .env and bots.json, in the order they are read.
export function configFolders(
  home: string | undefined = setting("HOME"),
  installed: boolean = IS_INSTALLED
): string[] {
  if (home) return [home];
  return installed ? [installedHome(), PACKAGE_ROOT] : [PACKAGE_ROOT];
}

// Where DISCORD_TOKEN came from, for the setup check: "the environment"
// when the app's config or the shell set it, otherwise the file.
export const ENVIRONMENT_SOURCE = "the environment";
let tokenSource: string | undefined =
  process.env.DISCORD_TOKEN !== undefined ? ENVIRONMENT_SOURCE : undefined;
for (const folder of configFolders()) {
  const file = join(folder, ".env");
  const had = process.env.DISCORD_TOKEN !== undefined;
  loadDotenv({ path: file, quiet: true });
  if (!had && process.env.DISCORD_TOKEN !== undefined) tokenSource = file;
}

const pkg = require(packageJsonPath) as {
  version: string;
};

export const VERSION: string = pkg.version;

// A single Discord bot this server can act as. Multiple bots let one install
// drive several servers (or a test bot and a real bot) without swapping the
// token. One bot is always marked the default: it is what single-bot call
// sites use and what ambiguous requests fall back to.
export interface BotConfig {
  name: string;
  token: string;
  isDefault: boolean;
  // Where the token was read from: a file path, or "the environment".
  source?: string;
}

export interface ServerConfig {
  // Every configured bot. Empty when no token is set anywhere.
  bots: BotConfig[];
  // The default bot's token, or undefined when nothing is configured. Kept
  // as a top-level field so the existing single-bot call sites (getRest,
  // the gateway, the scheduler, the boot banners) keep working unchanged
  // while the multi-bot routing is built on top of `bots`.
  token: string | undefined;
  // Optional default guild ID. Tools accept an explicit guild and fall
  // back to this.
  defaultGuild: string | undefined;
  // Which bot handles a server that more than one configured bot is in:
  // server id to bot name, from "servers" in bots.json. Without an entry
  // the default bot handles it when it is one of them.
  serverBots?: Record<string, string>;
  // Which tool groups this process exposes. Resolved from DISCORD_MCP_TOOLS;
  // unset means every group. Carries any unknown group names so the entry
  // point can refuse to start instead of quietly exposing fewer tools.
  toolsets: ToolsetSelection;
}

// Shape of a bots.json file. Hand-editable, and also written by the wizard.
// Everything is `unknown` because it is user-supplied and must be validated.
interface RawBotEntry {
  name?: unknown;
  token?: unknown;
  default?: unknown;
}
interface RawBotsFile {
  bots?: unknown;
  servers?: unknown;
}

// Pure: given a parsed bots.json (or undefined) and the DISCORD_TOKEN from
// the environment, produce the normalized bot list. Exactly one bot ends up
// default, names are unique so a bot can be selected unambiguously, and
// duplicate tokens collapse to one entry. No I/O, so it is unit-testable in
// isolation.
export function buildBots(
  file: RawBotsFile | undefined,
  envToken: string | undefined
): BotConfig[] {
  const collected: Array<{ name: string; token: string; wantsDefault: boolean }> =
    [];
  const seenTokens = new Set<string>();

  const entries = Array.isArray(file?.bots)
    ? (file.bots as RawBotEntry[])
    : [];
  let index = 0;
  for (const entry of entries) {
    index += 1;
    const token = typeof entry?.token === "string" ? entry.token.trim() : "";
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    const name =
      typeof entry?.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : `bot${index}`;
    collected.push({ name, token, wantsDefault: entry?.default === true });
  }

  // A DISCORD_TOKEN from the environment is a bot too. It does not duplicate
  // a bots.json entry that already carries the same token.
  const env = envToken?.trim();
  if (env && !seenTokens.has(env)) {
    seenTokens.add(env);
    collected.push({ name: "default", token: env, wantsDefault: false });
  }

  if (collected.length === 0) return [];

  // Default selection: an explicit default:true wins (first one, if several
  // claim it); otherwise the environment token; otherwise the first bot.
  let defaultIdx = collected.findIndex((b) => b.wantsDefault);
  if (defaultIdx === -1) {
    defaultIdx = env ? collected.findIndex((b) => b.token === env) : 0;
  }
  if (defaultIdx === -1) defaultIdx = 0;

  // Make names unique so later phases can select a bot by name with no
  // ambiguity, without discarding the user's chosen label.
  const usedNames = new Set<string>();
  return collected.map((b, i) => {
    let name = b.name;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${b.name}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    return { name, token: b.token, isDefault: i === defaultIdx };
  });
}

// The "servers" object of bots.json, checked: each key a server id, each
// value the name of a configured bot (any letter case). An entry that is
// neither is dropped with a line on stderr, never fatal, like the rest of
// that file.
export function buildServerBots(
  file: RawBotsFile | undefined,
  bots: BotConfig[],
  warn: (line: string) => void = (line) => console.error(line)
): Record<string, string> {
  const raw = file?.servers;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn('[discord-mcp] Ignoring "servers" in bots.json: it should be an object of server id to bot name.');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [serverId, value] of Object.entries(raw as Record<string, unknown>)) {
    const bot = typeof value === "string" ? bots.find((b) => b.name.toLowerCase() === value.trim().toLowerCase()) : undefined;
    if (!/^\d{17,20}$/.test(serverId) || !bot) {
      warn(
        `[discord-mcp] Ignoring "servers" entry ${JSON.stringify(serverId)} in bots.json: ` +
          (bot ? "the key is not a server id." : `${JSON.stringify(value)} is not the name of a configured bot.`)
      );
      continue;
    }
    out[serverId] = bot.name;
  }
  return out;
}

function botsFileHasToken(file: RawBotsFile, token: string): boolean {
  return Array.isArray(file.bots) && (file.bots as RawBotEntry[]).some((e) => typeof e?.token === "string" && e.token.trim() === token);
}

// A bots.json is looked for in the same folders as .env. The first one
// found wins.
function readBotsFile(): { file: RawBotsFile; path: string } | undefined {
  for (const folder of configFolders()) {
    const path = join(folder, "bots.json");
    if (!existsSync(path)) continue;
    try {
      return { file: JSON.parse(readFileSync(path, "utf8")) as RawBotsFile, path };
    } catch (err) {
      // A malformed bots.json must not crash the server, and must not write
      // to stdout (that breaks the stdio transport). Warn on stderr and fall
      // back to whatever else is configured; diagnostics can flag it later.
      console.error(
        `[discord-mcp] Ignoring ${path}: not valid JSON (${(err as Error).message}).`
      );
      return undefined;
    }
  }
  return undefined;
}

export function loadConfig(): ServerConfig {
  const found = readBotsFile();
  const envToken = process.env.DISCORD_TOKEN?.trim();
  const bots = buildBots(found?.file, process.env.DISCORD_TOKEN).map((b) => ({
    ...b,
    // A token in both places is listed once, under its bots.json name.
    source: found && botsFileHasToken(found.file, b.token) ? found.path : b.token === envToken ? tokenSource : undefined,
  }));
  const defaultBot = bots.find((b) => b.isDefault);
  const defaultGuild = setting("GUILD");
  const toolsets = selectToolsets(setting("TOOLS"));
  return { bots, token: defaultBot?.token, defaultGuild, serverBots: buildServerBots(found?.file, bots), toolsets };
}
