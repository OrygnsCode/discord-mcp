import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { PERMISSION_PRESETS } from "./discord/preflight.js";

// The pure half of the setup wizard. Everything here is a function of its
// inputs so the logic that touches user config files is unit tested
// without a terminal or a filesystem.

// The key this server is registered under in a client's mcpServers, and
// the key versions before 2.0 used.
export const CLIENT_KEY = "discord-mcp";
export const LEGACY_CLIENT_KEY = "omnicord";

// True when a client config entry runs this server: the npm package, its
// command or home folder, the Docker image, or the Omnicord package it was
// called before 2.0. Anything else under the discord-mcp key is someone
// else's server and is never replaced without asking.
export function isOurEntry(entry: unknown): boolean {
  const text = JSON.stringify(entry ?? null);
  return /omnicord|orygn[\\/]+discord-mcp|orygn-discord-mcp/i.test(text);
}

function parseConfigObject(existingText: string | undefined): Record<string, unknown> {
  if (!existingText || existingText.trim().length === 0) return {};
  const parsed = JSON.parse(existingText) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Config file is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function serversOf(parsed: Record<string, unknown>): Record<string, unknown> {
  return typeof parsed.mcpServers === "object" &&
    parsed.mcpServers !== null &&
    !Array.isArray(parsed.mcpServers)
    ? (parsed.mcpServers as Record<string, unknown>)
    : {};
}

// What a client config already holds, so the wizard can decide before it
// writes: an entry from before the rename, and someone else's server under
// the discord-mcp key. Throws on invalid JSON, like mergeClientConfig.
export function clientConfigState(existingText: string | undefined): {
  hasLegacy: boolean;
  foreignEntry: unknown | undefined;
} {
  const servers = serversOf(parseConfigObject(existingText));
  const current = servers[CLIENT_KEY];
  return {
    hasLegacy: Object.prototype.hasOwnProperty.call(servers, LEGACY_CLIENT_KEY),
    foreignEntry: current !== undefined && !isOurEntry(current) ? current : undefined,
  };
}

// Writes the discord-mcp entry into a client config file's JSON text and
// removes the entry versions before 2.0 used, so the same server never runs
// twice. All other content survives untouched. Whether an existing foreign
// discord-mcp entry may be replaced is the caller's decision (see
// clientConfigState); this function replaces it. Returns the new text,
// 2-space indented with a trailing newline, which matches how these files
// are machine-written.
export function mergeClientConfig(
  existingText: string | undefined,
  entry: { command: string; args: string[] },
  options: { movedHomes?: string[] } = {}
): string {
  const parsed = parseConfigObject(existingText);
  const servers = serversOf(parsed);
  const kept = keptSettings(servers, options.movedHomes ?? [], entry);
  delete servers[LEGACY_CLIENT_KEY];
  servers[CLIENT_KEY] = { command: entry.command, args: entry.args, ...kept };
  parsed.mcpServers = servers;
  return JSON.stringify(parsed, null, 2) + "\n";
}

// What the user added to this server's entry by hand and a rewrite must
// not lose: an env block (a toolset selection, a token, a custom home) and
// the app's own flags on the entry (disabled, autoApprove, and the like).
// Only command and args are the wizard's to write. Before, re-registering
// or upgrading from Omnicord wrote a bare entry, and a server set up
// through env came back with no token or with every tool loaded.
//
// Taken from the discord-mcp entry when it is this server's, otherwise
// from the pre-2.0 entry. Someone else's server under the discord-mcp key
// hands nothing over: its env may hold the token of a different bot.
//
// movedHomes lists folders the upgrade moves away (the pre-2.0 home). A
// home setting that points at one is dropped, since it only restated the
// default and would now name a folder with no settings in it.
function keptSettings(
  servers: Record<string, unknown>,
  movedHomes: string[],
  entry?: { command: string; args: string[] }
): Record<string, unknown> {
  const current = servers[CLIENT_KEY];
  // Ours by what it runs, or because it runs the very file being
  // registered: a source checkout has no package name in its path.
  const sameProgram =
    entry !== undefined &&
    typeof current === "object" &&
    current !== null &&
    JSON.stringify([(current as { command?: unknown }).command, (current as { args?: unknown }).args]) ===
      JSON.stringify([entry.command, entry.args]);
  const earlier =
    current !== undefined && (isOurEntry(current) || sameProgram) ? current : servers[LEGACY_CLIENT_KEY];
  if (typeof earlier !== "object" || earlier === null || Array.isArray(earlier)) return {};
  const { command: _command, args: _args, ...kept } = earlier as Record<string, unknown>;
  const env = kept.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    const same = (a: string, b: string) => samePath(a, b);
    const cleaned = Object.fromEntries(
      Object.entries(env as Record<string, unknown>).filter(
        ([key, value]) =>
          !(
            /^(OMNICORD|DISCORD_MCP)_HOME$/.test(key) &&
            typeof value === "string" &&
            movedHomes.some((home) => same(home, value))
          )
      )
    );
    if (Object.keys(cleaned).length > 0) kept.env = cleaned;
    else delete kept.env;
  }
  return kept;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// The names of what a rewrite carries over from the earlier entry, for the
// wizard to say. Names only: an env value can be a token.
export function carriedSettings(
  existingText: string | undefined,
  movedHomes: string[] = [],
  entry?: { command: string; args: string[] }
): string[] {
  let servers: Record<string, unknown>;
  try {
    servers = serversOf(parseConfigObject(existingText));
  } catch {
    return [];
  }
  const kept = keptSettings(servers, movedHomes, entry);
  const env = kept.env && typeof kept.env === "object" ? Object.keys(kept.env as Record<string, unknown>) : [];
  return [...Object.keys(kept).filter((k) => k !== "env"), ...env];
}

// Where Claude Code's own config (~/.claude.json) still registers the
// pre-2.0 entry: "user" for the user scope, or the project folder for a
// local scope. The wizard only reads this file and prints the commands to
// run, since Claude Code keeps live state in it.
export function claudeCodeLegacyScopes(text: string | undefined): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfigObject(text);
  } catch {
    return [];
  }
  const scopes: string[] = [];
  if (Object.prototype.hasOwnProperty.call(serversOf(parsed), LEGACY_CLIENT_KEY)) {
    scopes.push("user");
  }
  const projects = parsed.projects;
  if (typeof projects === "object" && projects !== null && !Array.isArray(projects)) {
    for (const [folder, project] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof project !== "object" || project === null) continue;
      const servers = serversOf(project as Record<string, unknown>);
      if (Object.prototype.hasOwnProperty.call(servers, LEGACY_CLIENT_KEY)) scopes.push(folder);
    }
  }
  return scopes;
}

// Sets KEY=value in dotenv-style text, replacing an existing line or
// appending one. Comments and unrelated lines survive byte for byte.
export function envUpsert(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

// Remove a KEY=... line from dotenv text, preserving every other line and
// comment. Used when a single bot is moved out of .env into bots.json so the
// old token does not linger and load as an extra bot.
export function envRemoveKey(content: string, key: string): string {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const kept = content.split(/\r?\n/).filter((line) => !pattern.test(line));
  return kept.join("\n").replace(/\n*$/, "\n");
}

export function inviteUrl(applicationId: string, permissions: bigint): string {
  return (
    "https://discord.com/oauth2/authorize" +
    `?client_id=${applicationId}&scope=bot&permissions=${permissions}`
  );
}

// Invite permission choices. The recommended bundle is the admin preset:
// everything the tools need without the Administrator bit, so the
// bot cannot bypass channel permission overwrites. Administrator is a
// legitimate choice for owners who would rather not think about
// permissions; the safety gate confirms destructive actions regardless
// of which level is granted.
export const INVITE_CHOICES: Array<{
  key: string;
  label: string;
  permissions: bigint;
}> = [
  {
    key: "recommended",
    label:
      "Recommended: manage channels, roles, messages, members, webhooks, " +
      "and events, without the Administrator bit",
    permissions: PERMISSION_PRESETS.admin,
  },
  {
    key: "moderation",
    label: "Moderation only: messages, timeouts, kicks, voice control",
    permissions: PERMISSION_PRESETS.moderator,
  },
  {
    key: "administrator",
    label:
      "Full Administrator: every permission, nothing to think about; " +
      "the safety gate still confirms destructive actions",
    permissions: PermissionFlagsBits.Administrator,
  },
];

// True when Claude Desktop has moved its data out of this folder. It leaves
// a ".user-data-left.<id>" marker behind and keeps no config there.
export function dataMovedOut(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.startsWith(".user-data-left"));
  } catch {
    return false;
  }
}

export interface ConfigCandidate {
  client: string;
  label: string;
  path: string;
  // The config file already exists: the client has MCP servers set up.
  exists: boolean;
  // The client looks installed (its config directory is present) even if
  // it has no MCP config file yet. Offered so a first-time MCP user is
  // not dropped to the manual snippet; the wizard creates the file.
  appPresent: boolean;
}

// Known client config locations. For each, the wizard records whether the
// config file exists and whether the client looks installed (its config
// directory is present), so it can offer a client even before that client
// has any MCP config file. Claude Code's project option is always offered.
// Claude Desktop's Windows folders carry a per-install id (Claude-Data\
// claude_<id>, Packages\Claude_<id>), found by scanning rather than
// hardcoding it. This function only reads the disk; it
// never creates or writes anything.
export function clientConfigCandidates(env: {
  platform: NodeJS.Platform;
  homedir: string;
  appData?: string;
  localAppData?: string;
  cwd: string;
}): ConfigCandidate[] {
  const out: ConfigCandidate[] = [];

  // Run from the home folder, a project-scoped path can be the very same
  // file as a global one (Cursor's ~/.cursor/mcp.json, for one). Listing it
  // twice would ask about and write the same file twice, so the first label
  // keeps it. Windows paths compare without case.
  const key = (p: string) => {
    const resolved = resolve(p);
    return env.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const push = (client: string, label: string, path: string) => {
    if (out.some((c) => key(c.path) === key(path))) return;
    out.push({
      client,
      label,
      path,
      exists: existsSync(path),
      // Installed if the config directory exists, even without the file.
      appPresent: existsSync(dirname(path)),
    });
  };

  if (env.platform === "win32") {
    // Current Claude Desktop builds keep their data, config included, in
    // %LOCALAPPDATA%\Claude-Data\claude_<id>\. Listed first because the
    // wizard preselects the first candidate that is present.
    if (env.localAppData) {
      const dataRoot = join(env.localAppData, "Claude-Data");
      try {
        for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^claude/i.test(entry.name)) continue;
          push(
            "claude-desktop",
            "Claude Desktop",
            join(dataRoot, entry.name, "claude_desktop_config.json")
          );
        }
      } catch {
        // No Claude-Data directory: an older build, covered below.
      }
    }
    // Older locations. When Desktop moves its data out it leaves the old
    // folder behind with only a marker file in it, so the folder alone
    // proves nothing; offering it would write a config Desktop never reads.
    if (env.appData) {
      const dir = join(env.appData, "Claude");
      if (!dataMovedOut(dir)) {
        push("claude-desktop", "Claude Desktop", join(dir, "claude_desktop_config.json"));
      }
    }
    if (env.localAppData) {
      const packages = join(env.localAppData, "Packages");
      try {
        for (const name of readdirSync(packages)) {
          if (!name.startsWith("Claude_")) continue;
          const dir = join(packages, name, "LocalCache", "Roaming", "Claude");
          if (dataMovedOut(dir)) continue;
          push(
            "claude-desktop",
            "Claude Desktop (Microsoft Store build)",
            join(dir, "claude_desktop_config.json")
          );
        }
      } catch {
        // No Packages directory means no Store build; nothing to add.
      }
    }
  } else if (env.platform === "darwin") {
    push(
      "claude-desktop",
      "Claude Desktop",
      join(
        env.homedir,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      )
    );
  } else {
    push(
      "claude-desktop",
      "Claude Desktop",
      join(env.homedir, ".config", "Claude", "claude_desktop_config.json")
    );
  }

  push("cursor", "Cursor (global)", join(env.homedir, ".cursor", "mcp.json"));
  push("cursor", "Cursor (this project)", join(env.cwd, ".cursor", "mcp.json"));
  push(
    "windsurf",
    "Windsurf",
    join(env.homedir, ".codeium", "windsurf", "mcp_config.json")
  );
  push("claude-code", "Claude Code (this project)", join(env.cwd, ".mcp.json"));

  return out;
}

// --- Multi-bot config (bots.json) ---
//
// The wizard writes additional bots to a bots.json next to the .env. These
// helpers are the pure half of that: parsing, naming, and serializing, so the
// file-writing logic is unit tested without a terminal.

export interface WizardBot {
  name: string;
  token: string;
  default?: boolean;
}

// Parse bots.json text into entries. Tolerant of empty, missing, or malformed
// input (returns an empty list) so a broken file never crashes the wizard.
export function parseBotsFile(content: string | undefined): WizardBot[] {
  if (!content || !content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const raw = (parsed as { bots?: unknown })?.bots;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => b as { name?: unknown; token?: unknown; default?: unknown })
    .filter((b) => typeof b?.token === "string" && b.token.trim().length > 0)
    .map((b) => ({
      name: typeof b.name === "string" ? b.name.trim() : "",
      token: (b.token as string).trim(),
      default: b.default === true,
    }));
}

// Return desired if free, otherwise desired-2, desired-3, ... comparing
// case-insensitively so names stay unambiguous when selected later.
export function uniqueBotName(desired: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;
  let n = 2;
  while (lower.has(`${desired}-${n}`.toLowerCase())) n += 1;
  return `${desired}-${n}`;
}

// A short, file-safe, unique bot name suggested from a Discord username.
export function suggestBotName(username: string, taken: string[]): string {
  const base =
    username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "bot";
  return uniqueBotName(base, taken);
}

// Enforce exactly one default: the first bot flagged default wins; if none is
// flagged, the first bot becomes default.
function ensureOneDefault(bots: WizardBot[]): WizardBot[] {
  if (bots.length === 0) return bots;
  let seen = false;
  const out = bots.map((b) => {
    if (b.default && !seen) {
      seen = true;
      return { ...b, default: true };
    }
    return { ...b, default: false };
  });
  if (!seen) out[0] = { ...out[0], default: true };
  return out;
}

// The "servers" object of a bots.json, which says which bot handles a server
// more than one of them is in. It is written by hand and the wizard never
// edits it, so a rewrite of the file has to carry it through.
export function botsFileServers(content: string | undefined): Record<string, unknown> | undefined {
  if (!content || !content.trim()) return undefined;
  try {
    const servers = (JSON.parse(content) as { servers?: unknown } | null)?.servers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// Serialize a bot list to bots.json text: 2-space indent, trailing newline,
// exactly one default. "servers" is what botsFileServers read from the file
// being replaced.
export function serializeBotsFile(bots: WizardBot[], servers?: Record<string, unknown>): string {
  return (
    JSON.stringify(
      {
        bots: ensureOneDefault(bots).map((b) => ({
          name: b.name,
          token: b.token,
          ...(b.default ? { default: true } : {}),
        })),
        ...(servers ? { servers } : {}),
      },
      null,
      2
    ) + "\n"
  );
}

// Add a bot to bots.json text. Dedups by token (a token already present is not
// duplicated; a missing name is filled in). The chosen name is uniquified if it
// collides. The first bot in an otherwise-empty file becomes the default.
export function addBotToBotsFile(
  content: string | undefined,
  bot: { name: string; token: string }
): string {
  const bots = parseBotsFile(content);
  const servers = botsFileServers(content);
  const token = bot.token.trim();
  const existing = bots.find((b) => b.token === token);
  if (existing) {
    if (!existing.name && bot.name) existing.name = bot.name;
    return serializeBotsFile(bots, servers);
  }
  const name = uniqueBotName(
    bot.name || "bot",
    bots.map((b) => b.name).filter(Boolean)
  );
  bots.push({ name, token, default: bots.length === 0 });
  return serializeBotsFile(bots, servers);
}
