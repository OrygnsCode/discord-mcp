import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import { renameLegacyEnvKeys, setting } from "./settings.js";

// Where discord-mcp keeps user data: the .env the wizard writes, bots.json,
// saved blueprints, scheduled messages, and the copy of the app the wizard
// registers when it was run through npx.
//
// A source checkout keeps everything next to package.json, which is what
// development and the test suites expect. An installed copy is different:
// the npx cache, a global install, and a node_modules dependency all live
// in directories that package managers delete and replace (npm cache
// clean, version upgrades), so user data there would not survive. For
// installed copies everything goes to a stable folder in the user profile,
// ~/.orygn/discord-mcp, which outlives any reinstall.
//
// Before 2.0 that folder was ~/.omnicord. An upgrade that has not been
// moved over yet keeps reading the old folder in place: merely running 2.0
// never moves anything, because an older copy still registered in some AI
// app reads the same files. The setup wizard moves the folder, as one step
// together with updating every old client entry it finds.

export const PACKAGE_ROOT = dirname(
  createRequire(import.meta.url).resolve("../package.json")
);

// Inside any node_modules means installed by a package manager rather
// than checked out from source.
export const IS_INSTALLED = PACKAGE_ROOT.split(sep).includes("node_modules");

export function defaultHome(user: string = homedir()): string {
  return join(user, ".orygn", "discord-mcp");
}

export function legacyHome(user: string = homedir()): string {
  return join(user, ".omnicord");
}

// What makes a folder count as holding someone's setup. The app folder
// alone does not: it is a copy of the program, not settings.
const SETTINGS_ENTRIES = [".env", "bots.json", "blueprints", "schedules"];

export function holdsSettings(dir: string): boolean {
  return SETTINGS_ENTRIES.some((name) => existsSync(join(dir, name)));
}

// The settings folder of an installed copy: the new location, unless only
// the old one holds settings.
export function installedHome(user: string = homedir()): string {
  const current = defaultHome(user);
  const legacy = legacyHome(user);
  if (!holdsSettings(current) && holdsSettings(legacy)) return legacy;
  return current;
}

// True while an installed copy is still reading ~/.omnicord, for the setup
// check and the wizard.
export function usingLegacyHome(user: string = homedir()): boolean {
  return !setting("HOME") && IS_INSTALLED && installedHome(user) === legacyHome(user);
}

// The directory that holds the .env and bots.json the wizard writes and the
// server reads. DISCORD_MCP_HOME overrides it, for a custom location, a
// container, or an isolated test run; otherwise a source checkout keeps
// config at the package root and an installed copy uses its home folder.
// config.ts reads these and nothing else (see configFolders there), so the
// wizard and the server always agree on where config lives.
export function configDir(): string {
  const override = setting("HOME");
  if (override) return override;
  return IS_INSTALLED ? installedHome() : PACKAGE_ROOT;
}

// Blueprints and schedules. Inside a custom home or a source checkout they
// sit in a .discord-mcp subfolder, or the .omnicord one an older version
// created if that is the only one there.
function dataSubfolder(base: string): string {
  const current = join(base, ".discord-mcp");
  const legacy = join(base, ".omnicord");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function dataDir(): string {
  const override = setting("DATA_DIR");
  if (override) return override;
  const home = setting("HOME");
  if (home) return dataSubfolder(home);
  return IS_INSTALLED ? installedHome() : dataSubfolder(PACKAGE_ROOT);
}

// Where the wizard copies the program when it runs from npx's cache. Always
// the new location (or the custom home), never ~/.omnicord, so a client
// entry registered by 2.0 never depends on the old folder.
export function appHome(): string {
  return setting("HOME") ?? defaultHome();
}

// Where the wizard writes DISCORD_TOKEN and DISCORD_MCP_GUILD (single-bot)
// and the bots.json (multi-bot). The server loads both from the same
// directory (see config.ts), so the wizard and the server always agree.
export function envFilePath(): string {
  return join(configDir(), ".env");
}

export function botsFilePath(): string {
  return join(configDir(), "bots.json");
}

// Writes a file that holds a bot token (.env, bots.json) so that only its
// owner can read it. Node creates files readable by every account on the
// machine unless told otherwise, and a bot token is the whole bot. The mode
// given at creation covers a new file; chmod covers one that was already
// there with wider permissions. Windows keeps its own access lists and
// ignores both.
export function writePrivateFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without permission bits; the write itself went through.
  }
}

// Whether accounts other than the owner can read a file, by its permission
// bits. Undefined where that cannot be told: on Windows, or a file that is
// not there.
export function readableByOthers(path: string, platform: string = process.platform): boolean | undefined {
  if (platform === "win32") return undefined;
  try {
    return (statSync(path).mode & 0o044) !== 0;
  } catch {
    return undefined;
  }
}

export const MOVED_NOTE = "MOVED-TO-DISCORD-MCP.txt";

export interface HomeMove {
  moved: string[];
  renamedSettings: string[];
}

// Moves everything except the app folder from the old home to the new one,
// renames old setting names in the moved .env, and leaves a note behind.
// The app folder stays because a client entry written by an older version
// may still point into it. Refuses when the destination already holds
// settings, so it never merges two setups.
export function moveLegacyHome(from: string, to: string): HomeMove {
  if (holdsSettings(to)) {
    throw new Error(`${to} already holds settings; nothing was moved.`);
  }
  const names = readdirSync(from).filter((name) => name !== "app" && name !== MOVED_NOTE);
  // Checked before anything moves, so a clash never leaves a half-moved
  // setup split across two folders.
  const clash = names.find((name) => existsSync(join(to, name)));
  if (clash) {
    throw new Error(`${join(to, clash)} already exists; nothing was moved.`);
  }
  mkdirSync(to, { recursive: true });
  const moved: string[] = [];
  for (const name of names) {
    const source = join(from, name);
    const target = join(to, name);
    try {
      renameSync(source, target);
    } catch (err) {
      // A different drive cannot rename; copy, then remove the original.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      cpSync(source, target, { recursive: true });
      rmSync(source, { recursive: true, force: true });
    }
    moved.push(name);
  }
  let renamedSettings: string[] = [];
  const envPath = join(to, ".env");
  if (existsSync(envPath)) {
    const result = renameLegacyEnvKeys(readFileSync(envPath, "utf8"));
    if (result.renamed.length > 0) writePrivateFile(envPath, result.text);
    renamedSettings = result.renamed;
  }
  writeFileSync(
    join(from, MOVED_NOTE),
    `Omnicord is now discord-mcp. Its settings moved to:\n  ${to}\n\n` +
      "The app folder here stays in case an AI app still runs Omnicord from it.\n" +
      "Once nothing does, this folder can be deleted.\n"
  );
  return { moved, renamedSettings };
}
