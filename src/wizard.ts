import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { VERSION } from "./config.js";
import {
  envFilePath,
  botsFilePath,
  appHome,
  defaultHome,
  legacyHome,
  writePrivateFile,
  moveLegacyHome,
  usingLegacyHome,
  IS_INSTALLED,
} from "./home.js";
import { COMMAND, PACKAGE_NAME } from "./identity.js";
import { copyToStableHome, inNpxCache } from "./install.js";
import { bold, cyan, dim, green, red, rule, underline, yellow } from "./term.js";
import { readIntents, type IntentStatus } from "./discord/intents.js";
import {
  CLIENT_KEY,
  carriedSettings,
  clientConfigState,
  claudeCodeLegacyScopes,
  mergeClientConfig,
  envUpsert,
  envRemoveKey,
  inviteUrl,
  INVITE_CHOICES,
  clientConfigCandidates,
  parseBotsFile,
  suggestBotName,
  uniqueBotName,
  serializeBotsFile,
  addBotToBotsFile,
  type ConfigCandidate,
  type WizardBot,
} from "./wizardLib.js";

// The interactive setup wizard: orygn-discord-mcp init. Walks from a bare
// Discord application to a working client config, validating each step
// against the live API instead of hoping. The pure logic lives in
// wizardLib.ts; this file is the conversation.

const PORTAL = "https://discord.com/developers/applications";

const packageRoot = dirname(
  createRequire(import.meta.url).resolve("../package.json")
);

class Cancelled extends Error {}

// Stdin handling without readline. Readline cannot serve this wizard:
// piped input closes the interface while answers are still buffered, and
// raw-mode token masking would fight readline over the same stream. One
// character-level consumer handles both, so the wizard works typed at a
// terminal and scripted through a pipe.
const ETX = String.fromCharCode(3); // Ctrl+C as a raw-mode character
const DEL = String.fromCharCode(127); // backspace in raw mode

const input: {
  buffer: string;
  lines: string[];
  waiter: ((line: string | undefined) => void) | undefined;
  ended: boolean;
  started: boolean;
  lastWasCR: boolean;
} = {
  buffer: "",
  lines: [],
  waiter: undefined,
  ended: false,
  started: false,
  lastWasCR: false,
};

function deliverLine(line: string | undefined): void {
  if (input.waiter) {
    const w = input.waiter;
    input.waiter = undefined;
    w(line);
  } else if (line !== undefined) {
    input.lines.push(line);
  }
}

function feedInput(text: string): void {
  for (const ch of text) {
    if (ch === ETX) {
      // Ctrl+C in raw mode arrives as a character rather than a signal.
      input.ended = true;
      deliverLine(undefined);
      return;
    }
    if (ch === "\n" && input.lastWasCR) {
      // The tail of a \r\n pair; the \r already delivered the line.
      input.lastWasCR = false;
      continue;
    }
    input.lastWasCR = ch === "\r";
    if (ch === "\r" || ch === "\n") {
      const line = input.buffer;
      input.buffer = "";
      deliverLine(line);
      continue;
    }
    if (ch === DEL || ch === "\b") {
      input.buffer = input.buffer.slice(0, -1);
      continue;
    }
    input.buffer += ch;
  }
}

function startInput(): void {
  if (input.started) return;
  input.started = true;
  process.stdin.on("data", (chunk: Buffer) => feedInput(chunk.toString("utf8")));
  process.stdin.on("end", () => {
    input.ended = true;
    deliverLine(undefined);
  });
  process.stdin.resume();
}

async function nextLine(): Promise<string | undefined> {
  startInput();
  if (input.lines.length > 0) return input.lines.shift();
  if (input.ended) return undefined;
  return new Promise((resolve) => {
    input.waiter = resolve;
  });
}

async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const line = await nextLine();
  if (line === undefined) throw new Cancelled();
  const answer = line.trim();
  if (answer.toLowerCase() === "q") throw new Cancelled();
  return answer;
}

// A yes/no question. Enter takes the default.
async function confirm(prompt: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await ask(`${prompt} ${dim(defaultYes ? "[Y/n]" : "[y/N]")}: `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

// Token input with no echo: raw mode suppresses terminal echo while the
// same character consumer keeps collecting the line. Piped input reads a
// plain line, so the wizard stays scriptable.
async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(prompt);
  process.stdout.write(prompt);
  startInput();
  process.stdin.setRawMode(true);
  try {
    const line = await nextLine();
    process.stdout.write("\n");
    if (line === undefined) throw new Cancelled();
    return line.trim();
  } finally {
    process.stdin.setRawMode(false);
  }
}

async function discordGet(token: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

interface AppInfo {
  id: string;
  name: string;
  botUsername: string;
  intents: IntentStatus;
}

async function fetchAppInfo(token: string): Promise<AppInfo | undefined> {
  const me = await discordGet(token, "/users/@me");
  if (me.status !== 200) return undefined;
  const app = await discordGet(token, "/applications/@me");
  if (app.status !== 200) return undefined;
  const user = me.json as { id: string; username: string };
  const application = app.json as { id: string; name: string; flags?: number };
  return {
    id: application.id,
    name: application.name,
    botUsername: user.username,
    intents: readIntents(application.flags ?? 0),
  };
}

export async function runWizard(): Promise<void> {
  console.log("");
  console.log(`  ${bold(cyan("Discord MCP"))} ${dim("by Orygn")}`);
  console.log(`  ${dim(rule())}`);
  console.log(`  ${dim(`Setup v${VERSION}. Type q at any prompt to quit; nothing is`)}`);
  console.log(`  ${dim("changed until it says so.")}\n`);

  try {
    if (await offerUpgrade()) return;
    const cfg = readExistingConfig();
    const hasExisting = cfg.envToken !== undefined || cfg.bots.length > 0;

    if (hasExisting) {
      const total = cfg.bots.length > 0 ? cfg.bots.length : 1;
      const names =
        cfg.bots.length > 0
          ? cfg.bots.map((b) => b.name || "(unnamed)").join(", ")
          : "one bot from .env";
      console.log(
        `  You already have ${total === 1 ? "a bot" : `${total} bots`} set up: ${bold(names)}.\n`
      );
      console.log("  What would you like to do?");
      console.log(`    ${bold("1")}. Add another bot ${dim("(for a different server)")}`);
      console.log(`    ${bold("2")}. Re-register with your AI client ${dim('(repairs "Server disconnected")')}`);
      console.log(`    ${bold("3")}. Reconfigure from scratch`);
      console.log(`    ${bold("4")}. Quit`);
      const choice = await ask(`  Choose 1-4 ${dim("[1]")}: `);
      if (choice === "4") throw new Cancelled();
      // Re-registering keeps the bots and only rewrites the client entry,
      // which is the whole repair for a client pointing at a copy that no
      // longer exists. Without it, that repair meant redoing the setup.
      if (choice === "2") {
        if (await registerClient()) printRestartSteps();
        return;
      }
      if (choice !== "3") {
        await runAddBot(cfg);
        return;
      }
      // choice 3 falls through to a fresh setup that supersedes the old config.
    }

    await runFreshSetup(cfg);
  } catch (err) {
    if (err instanceof Cancelled) {
      console.log(
        yellow("\nSetup cancelled. Nothing was changed beyond any step already confirmed.")
      );
      return;
    }
    throw err;
  } finally {
    process.stdin.pause();
  }
}

// The AI clients whose config files the wizard knows how to find.
function detectClients(): ConfigCandidate[] {
  return clientConfigCandidates({
    platform: process.platform,
    homedir: homedir(),
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    cwd: process.cwd(),
  });
}

// Before 2.0 this server was called Omnicord: registered under "omnicord"
// and keeping its settings in ~/.omnicord. Finding that setup, the wizard
// offers one step that points every old entry it can edit at this version
// and then moves the settings folder. The folder only moves when no old
// entry is left that still runs the previous version, since that version
// reads it. Returns true when the upgrade ran and the wizard is done, false
// to carry on with the normal flow.
async function offerUpgrade(): Promise<boolean> {
  const legacyFiles = detectClients().filter((c) => {
    if (!c.exists) return false;
    try {
      return clientConfigState(readFileSync(c.path, "utf8")).hasLegacy;
    } catch {
      return false;
    }
  });
  const claudeJson = join(homedir(), ".claude.json");
  const codeScopes = existsSync(claudeJson)
    ? claudeCodeLegacyScopes(readFileSync(claudeJson, "utf8"))
    : [];
  const settingsToMove = usingLegacyHome();
  if (legacyFiles.length === 0 && codeScopes.length === 0 && !settingsToMove) return false;

  console.log(`  ${bold("Omnicord is now discord-mcp.")}`);
  if (legacyFiles.length > 0) {
    console.log("  The previous version is registered in:");
    for (const c of legacyFiles) console.log(`    ${c.label} ${dim(c.path)}`);
  }
  if (settingsToMove) console.log(`  Its settings are in ${legacyHome()}.`);

  if (legacyFiles.length === 0 && !settingsToMove) {
    // Only Claude Code's own config has it, which the wizard does not edit.
    printClaudeCodeSteps(codeScopes);
    return false;
  }

  const what = [
    legacyFiles.length > 0
      ? `switch ${legacyFiles.length === 1 ? "it" : "them"} to this version`
      : undefined,
    settingsToMove && codeScopes.length === 0
      ? `move the settings to ${defaultHome()}`
      : undefined,
  ].filter(Boolean);
  if (what.length === 0) {
    printClaudeCodeSteps(codeScopes);
    return false;
  }
  const go = await confirm(`\n  ${what.join(" and ").replace(/^./, (c) => c.toUpperCase())}?`, true);
  if (!go) {
    console.log(dim("  Nothing changed. The previous version keeps working as it is.\n"));
    return false;
  }

  let allSwitched = true;
  if (legacyFiles.length > 0) {
    const entryPath = durableEntryPath();
    if (!entryPath) return true;
    const entry = { command: "node", args: [entryPath] };
    for (const target of legacyFiles) {
      if (!(await writeClientEntry(target, entry))) allSwitched = false;
    }
  }

  if (settingsToMove) {
    if (!allSwitched || codeScopes.length > 0) {
      console.log(
        `\n  Your settings stay in ${legacyHome()} for now, since something there still runs the previous version.`
      );
      console.log(dim(`  Run ${COMMAND} init again once it is switched over to move them.`));
    } else {
      try {
        const move = moveLegacyHome(legacyHome(), defaultHome());
        console.log(`\n  ${green("Moved your settings")} to ${defaultHome()}`);
        if (move.renamedSettings.length > 0) {
          console.log(dim(`  Renamed ${move.renamedSettings.join(", ")} to the DISCORD_MCP_ names.`));
        }
      } catch (err) {
        console.log(yellow(`\n  Could not move the settings: ${(err as Error).message}`));
        console.log(dim(`  They keep working where they are, in ${legacyHome()}.`));
      }
    }
  }

  printClaudeCodeSteps(codeScopes);
  printRestartSteps();
  return true;
}

// Claude Code keeps its MCP servers in ~/.claude.json alongside live state,
// so the wizard prints the commands rather than editing that file. No token
// goes on the command line: the server reads it from its own .env.
function printClaudeCodeSteps(scopes: string[]): void {
  if (scopes.length === 0) return;
  console.log(`\n  ${bold("Claude Code")} still has the previous version registered. To switch it:`);
  for (const scope of scopes) {
    const flag = scope === "user" ? " -s user" : "";
    if (scope !== "user") console.log(dim(`  In ${scope}:`));
    console.log(`    ${cyan(`claude mcp remove omnicord${flag}`)}`);
    console.log(`    ${cyan(`claude mcp add ${CLIENT_KEY}${flag} -- npx -y ${PACKAGE_NAME}`)}`);
  }
}

// Where the .env and bots.json live, and what is already configured. Reads
// files only, no Discord calls, so detecting an existing setup never needs a
// token and the smoke test stays offline.
interface ExistingConfig {
  envPath: string;
  botsPath: string;
  envToken: string | undefined;
  bots: WizardBot[];
}

function readExistingConfig(): ExistingConfig {
  const envPath = envFilePath();
  const botsPath = botsFilePath();
  let envToken: string | undefined;
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^\s*DISCORD_TOKEN\s*=\s*(.+?)\s*$/m);
    const value = m ? m[1].trim() : "";
    envToken = value.length > 0 ? value : undefined;
  }
  const bots = existsSync(botsPath)
    ? parseBotsFile(readFileSync(botsPath, "utf8"))
    : [];
  return { envPath, botsPath, envToken, bots };
}

// One bot's setup: token (validated live), intents (rechecked until on), an
// optional short name, and the invite. Shared by every path.
interface CollectedBot {
  token: string;
  app: AppInfo;
  name: string;
}

async function setupBot(opts: {
  heading: string;
  askName: boolean;
  takenNames: string[];
}): Promise<CollectedBot> {
  console.log(bold(cyan(opts.heading)));
  console.log(`  If you do not have this bot yet: open ${underline(PORTAL)}`);
  console.log("  New Application, name it, open the Bot page, Reset Token, copy it.");
  console.log("  Turn on all three Privileged Gateway Intents, and under Installation");
  console.log("  choose Guild Install only (uncheck User Install).\n");

  let token = "";
  let app: AppInfo | undefined;
  while (!app) {
    token = await askHidden(`  Paste the bot token ${dim("(input is hidden)")}: `);
    if (!token) continue;
    process.stdout.write("  Checking with Discord... ");
    app = await fetchAppInfo(token);
    console.log(
      app
        ? `${green("ok.")} This is ${bold(app.botUsername)} (app: ${app.name}).`
        : red("rejected.")
    );
    if (!app) {
      console.log(
        yellow("  Discord did not accept that token. Reset it in the portal and try again.")
      );
    }
  }

  console.log(`\n  ${bold("Privileged gateway intents")}`);
  for (;;) {
    const fresh = await fetchAppInfo(token);
    if (!fresh) {
      console.log(yellow("  Token stopped working; was it reset? Start the wizard again."));
      throw new Cancelled();
    }
    app = fresh;
    const i = app.intents;
    console.log(
      `  Server Members: ${i.members ? green("on") : red(bold("OFF"))}   ` +
        `Message Content: ${i.messageContent ? green("on") : red(bold("OFF"))}   ` +
        `Presence: ${i.presence ? green("on") : yellow("off (optional)")}`
    );
    if (i.members && i.messageContent) break;
    console.log(
      yellow("  Missing intents break member search and message reading.") + " Open the"
    );
    console.log(
      `  Bot page at ${underline(PORTAL)}, toggle them on, save, then press Enter here.`
    );
    await ask(`  Press Enter to re-check ${dim("(or q to quit)")}: `);
  }

  let name = "";
  if (opts.askName) {
    const suggested = suggestBotName(app.botUsername, opts.takenNames);
    const answer = await ask(
      `\n  Short name to tell this bot apart ${dim(`[${suggested}]`)}: `
    );
    name = answer ? uniqueBotName(answer, opts.takenNames) : suggested;
    console.log(`  Named ${bold(name)}.`);
  }

  console.log(`\n  ${bold("Invite the bot to its server")}`);
  console.log("  How much should the bot be allowed to do?");
  INVITE_CHOICES.forEach((c, idx) =>
    console.log(`    ${bold(String(idx + 1))}. ${c.label}`)
  );
  let choice = INVITE_CHOICES[0];
  const pick = await ask(`  Choose 1-${INVITE_CHOICES.length} ${dim("[1]")}: `);
  const pickIndex = Number(pick);
  if (Number.isInteger(pickIndex) && pickIndex >= 1 && pickIndex <= INVITE_CHOICES.length) {
    choice = INVITE_CHOICES[pickIndex - 1];
  }
  console.log(
    `\n  Open this URL, pick the server, authorize:\n  ${underline(cyan(inviteUrl(app.id, choice.permissions)))}\n`
  );
  await ask(`  Press Enter once the bot is in the server ${dim("(or q to quit)")}: `);

  return { token, app, name };
}

// Single-bot only: choose a default server so tools can omit the guild.
async function pickDefaultServer(token: string): Promise<string> {
  const guilds = await discordGet(token, "/users/@me/guilds");
  const guildList = Array.isArray(guilds.json)
    ? (guilds.json as Array<{ id: string; name: string }>)
    : [];
  if (guildList.length === 0) {
    console.log("  The bot is not in any server yet; continuing without a default server.");
    return "";
  }
  console.log("  The bot can see these servers:");
  guildList.forEach((g, idx) => console.log(`    ${idx + 1}. ${g.name} (${g.id})`));
  const sel = await ask(
    `  Use which as the default server? 1-${guildList.length}, or 0 for none ${dim("[1]")}: `
  );
  const selIndex = sel === "" ? 1 : Number(sel);
  if (Number.isInteger(selIndex) && selIndex >= 1 && selIndex <= guildList.length) {
    return guildList[selIndex - 1].id;
  }
  return "";
}

// The entry file to register. Run through npx, the wizard is running out of
// npm's npx cache, which npm can clear at any time, so the package is copied
// somewhere permanent first (see install.ts). Returns undefined when that
// copy fails, after saying why: registering the cached path instead would
// only postpone the failure to some later day.
function durableEntryPath(): string | undefined {
  if (!inNpxCache(packageRoot)) return join(packageRoot, "dist", "index.js");
  const home = appHome();
  console.log(dim("\n  npx runs this from a cache folder that npm does not keep, so"));
  console.log(dim(`  it is being copied to ${join(home, "app", VERSION)} first.`));
  try {
    const copy = copyToStableHome(packageRoot, home, VERSION);
    console.log(dim(copy.copied ? "  Copied." : "  That version is already there; reusing it."));
    return copy.entry;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(red(`  Could not copy it out of the npx cache: ${reason}`));
    console.log("  Nothing was registered, because the cached copy would stop working");
    console.log("  as soon as npm clears it. Install it permanently instead:");
    console.log(`  ${cyan(`npm install -g ${PACKAGE_NAME}`)}, then ${cyan(`${COMMAND} init`)} and choose to re-register.`);
    return undefined;
  }
}

function printSnippet(entry: { command: string; args: string[] }): void {
  console.log(JSON.stringify({ mcpServers: { [CLIENT_KEY]: entry } }, null, 2));
}

// Writes the discord-mcp entry into one client config file, backing the file
// up first and never touching invalid JSON. Any entry from before the rename
// in that file is removed in the same write, so the server never runs twice.
// When the file already has a different server under the discord-mcp key,
// it asks before replacing it. Returns false when nothing was written.
async function writeClientEntry(
  target: ConfigCandidate,
  entry: { command: string; args: string[] }
): Promise<boolean> {
  const before = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
  let state: ReturnType<typeof clientConfigState>;
  try {
    state = clientConfigState(before);
  } catch {
    console.log(yellow(`  ${target.path} is not valid JSON, so it was left untouched.`));
    console.log("  Add this to that file's mcpServers by hand:\n");
    printSnippet(entry);
    return false;
  }

  if (state.foreignEntry !== undefined) {
    console.log(`\n  A different Discord MCP is already set up in ${target.label} as "${CLIENT_KEY}":`);
    console.log(dim(`    ${JSON.stringify(state.foreignEntry).slice(0, 160)}`));
    console.log("  Two side by side give your AI duplicate tools to trip over, so we'd");
    console.log("  keep one. We're a little biased about which.");
    const replace = await confirm("  Replace it? Your current config is backed up first.", true);
    if (!replace) {
      console.log(dim(`  Left ${target.path} as it is. To add this server under another name,`));
      console.log(dim("  paste this into its mcpServers and rename the key:\n"));
      printSnippet(entry);
      return false;
    }
  }

  // The pre-2.0 home is about to move, so an entry that names it outright
  // would be left pointing at an empty folder.
  const movedHomes = [legacyHome()];
  const merged = mergeClientConfig(before, entry, { movedHomes });
  const carried = carriedSettings(before, movedHomes, entry);
  if (before !== undefined) {
    const backup = `${target.path}.bak-${CLIENT_KEY}-${Date.now()}`;
    copyFileSync(target.path, backup);
    console.log(dim(`  Backed up the existing file to ${backup}`));
  }
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, merged);
  console.log(`  ${green(`Wrote ${CLIENT_KEY} into`)} ${target.path}`);
  if (state.hasLegacy) console.log(dim("  Removed the previous version's entry from that file."));
  if (carried.length > 0) console.log(dim(`  Kept what the entry already set: ${carried.join(", ")}.`));
  return true;
}

// Register the server in one client config, regardless of how many bots were
// set up. Returns false when nothing could be registered; the reason is
// already on screen by then.
async function registerClient(): Promise<boolean> {
  const entryPath = durableEntryPath();
  if (!entryPath) return false;

  const present = detectClients().filter(
    (c) => c.exists || c.appPresent || c.client === "claude-code"
  );

  console.log("\n  Where should the server be registered?");
  console.log(dim(`  This only writes a "${CLIENT_KEY}" entry; everything else in the file`));
  console.log(dim("  is left as-is, and the original is backed up first."));
  present.forEach((c, idx) =>
    console.log(
      `    ${bold(String(idx + 1))}. ${c.label}${c.exists ? "" : dim(" (config file will be created)")}\n       ${dim(c.path)}`
    )
  );
  console.log(
    `    ${bold(String(present.length + 1))}. Just print the config snippet (paste it yourself)`
  );

  const entry = { command: "node", args: [entryPath] };

  const detected = present.findIndex((c) => c.exists || c.appPresent);
  const defaultChoice = detected >= 0 ? detected + 1 : present.length + 1;
  if (detected >= 0) {
    console.log(
      dim("  If unsure, press Enter: the wizard found this client on your machine.")
    );
  }
  const where = await ask(
    `  Choose 1-${present.length + 1} ${dim(`[${defaultChoice}]`)}: `
  );
  const whereIndex = where === "" ? defaultChoice : Number(where);

  if (Number.isInteger(whereIndex) && whereIndex >= 1 && whereIndex <= present.length) {
    // When the file cannot be written, a snippet to paste is already on
    // screen, which still finishes the setup.
    await writeClientEntry(present[whereIndex - 1], entry);
  } else {
    console.log("\n  Add this to your client's MCP config:\n");
    printSnippet(entry);
  }
  return true;
}

function printRestartSteps(): void {
  console.log(`\n${bold("Two steps left:")}`);
  console.log(`  1. ${bold("Fully restart your AI client")}: quit it from the system tray,`);
  console.log("     not just the window. New tools only load on a full restart.");
  console.log(`  2. In a fresh chat, ask: ${cyan('"run a setup check on my Discord bot"')}`);
  console.log("");
}

// A single bot supersedes any prior bots.json, so remove it: the one .env
// token must not merge with stale multi-bot entries.
function writeEnvSingle(
  cfg: ExistingConfig,
  token: string,
  defaultGuild: string
): void {
  mkdirSync(dirname(cfg.envPath), { recursive: true });
  const before = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, "utf8") : "";
  let text = envUpsert(before, "DISCORD_TOKEN", token);
  if (defaultGuild) {
    text = envUpsert(text, "DISCORD_MCP_GUILD", defaultGuild);
    // The pre-2.0 name would only linger as a stale duplicate.
    text = envRemoveKey(text, "OMNICORD_GUILD");
  }
  writePrivateFile(cfg.envPath, text);
  console.log(`  ${green("Token saved")} to ${cfg.envPath}`);
  console.log(
    `  ${dim(
      IS_INSTALLED
        ? "(stays on this machine; survives npm cache cleans and upgrades)"
        : "(gitignored, stays on this machine)"
    )}`
  );
  if (existsSync(cfg.botsPath)) {
    rmSync(cfg.botsPath);
    console.log(dim("  Removed the previous bots.json (reconfigured to a single bot)."));
  }
}

// Multiple bots go to bots.json. A leftover single-bot token in .env is cleared
// so it does not load as an extra bot.
function writeBotsMulti(cfg: ExistingConfig, bots: WizardBot[]): void {
  mkdirSync(dirname(cfg.botsPath), { recursive: true });
  writePrivateFile(cfg.botsPath, serializeBotsFile(bots));
  console.log(`  ${green("Bots saved")} to ${cfg.botsPath}`);
  console.log(
    `  ${dim(
      IS_INSTALLED
        ? "(stays on this machine; survives npm cache cleans and upgrades)"
        : "(gitignored, stays on this machine)"
    )}`
  );
  if (existsSync(cfg.envPath)) {
    const before = readFileSync(cfg.envPath, "utf8");
    if (/^\s*DISCORD_TOKEN\s*=\s*\S/m.test(before)) {
      const after = envRemoveKey(before, "DISCORD_TOKEN");
      if (after.trim().length === 0) rmSync(cfg.envPath);
      else writePrivateFile(cfg.envPath, after);
      console.log(dim("  Cleared the previous single-bot token from .env."));
    }
  }
}

function printBotList(bots: WizardBot[]): void {
  for (const b of bots) {
    console.log(`    ${bold(b.name)}${b.default ? dim(" (default)") : ""}`);
  }
  console.log(dim("  Each server is routed to the bot that is in it."));
}

// First-time setup, or a from-scratch reconfigure. Asks how many bots and
// branches: one bot to .env (unchanged), several to bots.json.
async function runFreshSetup(cfg: ExistingConfig): Promise<void> {
  console.log(bold(cyan("How many bots do you want to set up?")));
  console.log(dim("  Most people starting out use 1. If you run several servers each with"));
  console.log(dim("  their own bot, set them all up now; you can always add more later."));
  const answer = await ask(`  How many? ${dim("[1]")}: `);
  const parsed = answer === "" ? 1 : Number(answer);
  const count = Number.isInteger(parsed) && parsed >= 1 && parsed <= 25 ? parsed : 1;

  if (count === 1) {
    console.log("");
    const bot = await setupBot({ heading: "Set up your bot", askName: false, takenNames: [] });
    console.log("");
    const defaultGuild = await pickDefaultServer(bot.token);
    console.log(`\n${bold(cyan("Save configuration"))}`);
    writeEnvSingle(cfg, bot.token, defaultGuild);
    const registered = await registerClient();
    console.log(`\n${bold(green(registered ? "Setup complete." : "Bot saved."))}`);
    console.log(`  Bot: ${bold(bot.app.botUsername)} (app: ${bot.app.name})`);
    console.log(
      defaultGuild
        ? `  Default server: ${defaultGuild}`
        : "  Default server: none (pass guild per tool call or re-run init)"
    );
    if (registered) printRestartSteps();
    return;
  }

  const bots: WizardBot[] = [];
  for (let i = 0; i < count; i += 1) {
    console.log("");
    const bot = await setupBot({
      heading: `Bot ${i + 1} of ${count}`,
      askName: true,
      takenNames: bots.map((b) => b.name),
    });
    bots.push({ name: bot.name, token: bot.token, default: i === 0 });
  }
  console.log(`\n${bold(cyan("Save configuration"))}`);
  writeBotsMulti(cfg, bots);
  const registered = await registerClient();
  console.log(`\n${bold(green(registered ? "Setup complete." : "Bots saved."))}`);
  console.log(`  ${bots.length} bots configured:`);
  printBotList(parseBotsFile(serializeBotsFile(bots)));
  if (registered) printRestartSteps();
}

// Add one bot to an existing setup. The client is already registered, so this
// only collects the bot and writes bots.json, folding a bare .env bot in first
// (named) so every bot lives in one place.
async function runAddBot(cfg: ExistingConfig): Promise<void> {
  const taken = cfg.bots.map((b) => b.name).filter(Boolean);
  console.log("");
  const bot = await setupBot({ heading: "Add a bot", askName: true, takenNames: taken });

  console.log(`\n${bold(cyan("Save configuration"))}`);
  mkdirSync(dirname(cfg.botsPath), { recursive: true });
  let content = existsSync(cfg.botsPath) ? readFileSync(cfg.botsPath, "utf8") : undefined;

  if (cfg.bots.length === 0 && cfg.envToken) {
    let existingName = "main";
    const info = await fetchAppInfo(cfg.envToken);
    if (info) existingName = suggestBotName(info.botUsername, [bot.name]);
    content = addBotToBotsFile(content, { name: existingName, token: cfg.envToken });
    console.log(dim(`  Kept your existing bot as ${bold(existingName)} (default).`));
  }

  content = addBotToBotsFile(content, { name: bot.name, token: bot.token });
  writePrivateFile(cfg.botsPath, content);
  console.log(`  ${green("Bots saved")} to ${cfg.botsPath}`);

  console.log(`\n${bold(green("Bot added."))}`);
  const finalBots = parseBotsFile(content);
  console.log(`  ${finalBots.length} bots configured:`);
  printBotList(finalBots);
  console.log(
    `\n  ${bold("Fully restart your AI client")} for the new bot to take effect.`
  );
  console.log("");
}
