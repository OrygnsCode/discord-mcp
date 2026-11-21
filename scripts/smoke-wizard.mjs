// Setup wizard smoke test. Runs the built wizard the way a person would,
// fully offline: smoke-wizard-stub.mjs stands in for fetch, plays Discord
// (unreachable, refusing, busy, blocked, erroring, or fine), and takes the
// setup report. Every folder the wizard looks in points into a temp dir, so
// no real config is read or written.
//
// Run with: node scripts/smoke-wizard.mjs (after npm run build)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");
const stub = pathToFileURL(join(root, "scripts", "smoke-wizard-stub.mjs")).href;
const { CI_VARIABLES } = await import(pathToFileURL(join(root, "dist", "usageStats.js")).href);
const { SETUP_CODES, SETUP_TROUBLE } = await import(pathToFileURL(join(root, "dist", "usageReport.js")).href);
const major = process.versions.node.split(".")[0];

let failures = 0;
function check(condition, label) {
  if (condition) console.log(`ok: ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "discord-mcp-wizard-"));

// A token-shaped value, built rather than written out.
const token = ["A".repeat(26), "b".repeat(6), "C_-".repeat(13)].join(".");

// One wizard run. The answers go in through a pipe, which then closes, so a
// prompt past the last answer quits the wizard. With answers null the pipe
// stays open and nothing is typed. A run still going after 60 seconds is
// killed.
async function runWizard(name, discord, answers, opts = {}) {
  const box = join(work, name);
  const log = join(box, "fetch.log");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(DISCORD_|OMNICORD_|SMOKE_)/i.test(key) || CI_VARIABLES.includes(key) || key === "DO_NOT_TRACK") delete env[key];
  }
  Object.assign(env, {
    HOME: box,
    USERPROFILE: box,
    APPDATA: join(box, "roaming"),
    LOCALAPPDATA: join(box, "local"),
    XDG_CONFIG_HOME: join(box, "config"),
    DISCORD_MCP_HOME: opts.home ?? join(box, "home"),
    DISCORD_MCP_TELEMETRY: "on",
    DISCORD_MCP_TELEMETRY_URL: "https://telemetry.invalid",
    SMOKE_FETCH_LOG: log,
    SMOKE_DISCORD: discord,
    ...(opts.env ?? {}),
  });
  mkdirSync(box, { recursive: true });
  opts.before?.(box);
  const child = spawn(process.execPath, ["--import", stub, entry, "init"], {
    cwd: box,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
    opts.onOutput?.(out.replace(/\x1b\[[0-9;]*m/g, ""), child);
  });
  child.stderr.on("data", (d) => (out += d.toString()));
  if (answers) child.stdin.end(answers.map((a) => `${a}\n`).join(""));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  if (!answers) child.stdin.destroy();
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const reports = calls.filter((c) => c.url.endsWith("/discord-mcp/v1/setup")).map((c) => JSON.parse(c.body));
  const report = reports.at(-1) ?? {};
  return {
    code,
    out: out.replace(/\x1b\[[0-9;]*m/g, ""),
    discord: calls.filter((c) => c.url.startsWith("https://discord.com/")),
    report,
    reports: reports.length,
    trouble: report.trouble ?? [],
    box,
  };
}

// What every run's report must hold, whatever happened.
function checkReport(name, r) {
  const body = JSON.stringify(r.report);
  check(r.reports === 1, `${name}: sends exactly one setup report (${r.reports})`);
  check(r.report.node === major, `${name}: with the major Node.js version (${r.report.node})`);
  check(r.trouble.every((t) => SETUP_TROUBLE.includes(t)) && new Set(r.trouble).size === r.trouble.length, `${name}: trouble only from the list, each once (${r.trouble.join(", ")})`);
  check(!("code" in r.report) || SETUP_CODES.includes(r.report.code), `${name}: a code only from the list (${r.report.code})`);
  check(!body.includes(token) && !body.includes(r.box) && !body.includes("smokebot") && !/\d{17,}/.test(body.replace(r.report.nonce, "")), `${name}: no token, path, bot name, or ID in the report`);
  check(!r.out.includes(token), `${name}: the token is never printed`);
}

// Answers for a run that goes all the way: how many bots, the token, the
// invite level, the bot is in the server, the default server, where to
// register.
const allTheWay = ["1", token, "", "", "", ""];

try {
  // Discord cannot be reached: one retry, then a plain explanation, exit 1.
  const offline = await runWizard("offline", "offline", ["1", token]);
  checkReport("offline", offline);
  check(offline.code === 1, `offline: exits with 1 (${offline.code})`);
  check(offline.out.includes("Setup could not reach Discord.") && offline.out.includes("[ENOTFOUND]") && offline.out.includes("github.com/OrygnsCode/discord-mcp/issues"), "offline: says it could not reach Discord, with the code and where to ask");
  check(!offline.out.includes("    at ") && !offline.out.includes("Node.js v"), "offline: no crash trace");
  check(offline.discord.length === 2, `offline: tries Discord twice, not once or forever (${offline.discord.length})`);
  check(offline.report.outcome === "failed" && offline.report.step === "token" && offline.report.error === "network" && offline.report.code === "ENOTFOUND", `offline: reports failed at the token, network, ENOTFOUND (${JSON.stringify(offline.report)})`);
  check(offline.trouble.join() === "input_visible", "offline: and that the token prompt could not hide input, since this one is a pipe");

  // A secure connection someone is getting in the way of.
  const cert = await runWizard("certificate", "certificate", ["1", token]);
  checkReport("certificate", cert);
  check(cert.code === 1 && cert.out.includes("Setup could not make a secure connection to Discord.") && cert.out.includes("antivirus"), "certificate: says what usually causes it");
  check(cert.report.error === "certificate" && cert.report.code === "SELF_SIGNED_CERT_IN_CHAIN", `certificate: reports certificate, with its code (${cert.report.code})`);

  // What was pasted is refused: a Client Secret gets a hint, a token with a
  // character no token has is never sent, and q quits cleanly.
  const secret = "aB3_-".repeat(6) + "xy";
  const unusable = `${token}${String.fromCharCode(0x2026)}`;
  const ctrlV = String.fromCharCode(22);
  const rejects = await runWizard("rejects", "rejects", ["1", secret, unusable, ctrlV, `${token}${String.fromCharCode(27)}[D`, "q"]);
  checkReport("rejects", rejects);
  check(rejects.out.includes("rejected.") && rejects.out.includes("That looks like the Client Secret, not the bot token."), "rejects: a Client Secret is named as one");
  check(rejects.out.includes("characters a bot token never has"), "rejects: a token with a stray character is caught");
  check(rejects.out.includes("Ctrl+V came through as a key instead of pasting the token") && rejects.out.includes(process.platform === "win32" ? "right-click" : process.platform === "darwin" ? "Cmd+V" : "Ctrl+Shift+V"), "rejects: Ctrl+V typed as a key is named, with how to paste on this system");
  check(rejects.out.includes("Keys like the arrows, Escape, or Ctrl came through"), "rejects: so is an arrow key typed into the token");
  check(rejects.discord.length === 1, `rejects: only the secret went to Discord (${rejects.discord.length} calls)`);
  check(rejects.code === 0 && rejects.out.includes("Setup cancelled."), `rejects: q still quits cleanly (${rejects.code})`);
  check(rejects.report.outcome === "cancelled" && rejects.report.step === "token" && !("error" in rejects.report) && !("code" in rejects.report), "rejects: reports cancelled at the token step, with no error or code");
  check(["token_secret", "token_unusable", "token_ctrl_v", "token_control", "input_visible"].every((t) => rejects.trouble.includes(t)) && rejects.trouble.length === 5, `rejects: and what went wrong on the way (${rejects.trouble.join(", ")})`);

  // Discord busy once, then fine: the same token is checked again on Enter,
  // and setup runs to the end. The token is pasted the way copying leaves it.
  const messy = `  "${String.fromCharCode(0x200b)}${token}"  `;
  const busy = await runWizard("busy", "429-once", ["1", messy, "", "", "", "", ""]);
  checkReport("busy", busy);
  check(busy.out.includes("HTTP 429") && busy.out.includes("Press Enter to try again"), "busy: says Discord is turning requests away, and offers to try again");
  check(busy.discord.length >= 3 && busy.discord.every((c) => c.auth === `Bot ${token}`), "busy: the same token is tried again, cleaned of what copying added");
  check(busy.code === 0 && busy.out.includes("Setup complete.") && busy.out.includes("This is smokebot"), `busy: setup completes (${busy.code})`);
  const saved = readFileSync(join(busy.box, "home", ".env"), "utf8");
  check(saved.includes(`DISCORD_TOKEN=${token}\n`) && saved.includes("DISCORD_MCP_GUILD=100000000000000003"), "busy: the clean token and the default server are saved");
  // Run from the sandbox, the app it finds is Claude Code for this folder.
  const registered = JSON.parse(readFileSync(join(busy.box, ".mcp.json"), "utf8"));
  check(registered.mcpServers?.["discord-mcp"]?.args?.[0] === entry, "busy: and registered, in the sandbox's own project file");
  check(busy.report.outcome === "completed" && !("step" in busy.report) && !("error" in busy.report) && !("code" in busy.report) && busy.report.apps.join() === "claude-code", `busy: reports completed, with no step, error, or code (${JSON.stringify(busy.report)})`);
  check(["token_cleaned", "discord_429", "input_visible"].every((t) => busy.trouble.includes(t)) && busy.trouble.length === 3, `busy: and what went wrong on the way (${busy.trouble.join(", ")})`);

  // Refused for the connection, and an error on Discord's side.
  const blockedConn = await runWizard("forbidden", "403-once", ["1", token, "", "", "", "", ""]);
  checkReport("forbidden", blockedConn);
  check(blockedConn.out.includes("HTTP 403") && blockedConn.out.includes("VPN") && blockedConn.report.outcome === "completed" && blockedConn.trouble.includes("discord_403"), "forbidden: names a VPN or proxy, and completes after trying again");
  const down = await runWizard("discord-down", "503-once", ["1", token, "", "", "", "", ""]);
  checkReport("discord-down", down);
  check(down.out.includes("HTTP 503") && down.report.outcome === "completed" && down.trouble.includes("discord_5xx"), "discord-down: completes after trying again, noted as Discord's error");

  // A connection that drops once is tried again without asking.
  const flaky = await runWizard("flaky", "reset-once", allTheWay);
  checkReport("flaky", flaky);
  check(flaky.code === 0 && flaky.report.outcome === "completed" && flaky.trouble.includes("network_retry") && !flaky.out.includes("could not reach"), `flaky: completes, noted as a second try (${flaky.trouble.join(", ")})`);

  // Intents off at first, then on after Enter. The token comes wrapped in
  // the markers some terminals put around a paste.
  const esc = String.fromCharCode(27);
  const intents = await runWizard("intents", "intents-off", ["1", `${esc}[200~${token}${esc}[201~`, "", "", "", "", ""]);
  checkReport("intents", intents);
  check(intents.out.includes("OFF") && intents.out.includes("Press Enter to re-check") && intents.report.outcome === "completed" && intents.trouble.includes("intents_off"), "intents: says they are off, completes once on, and notes it");
  check(intents.discord.every((c) => c.auth === `Bot ${token}`) && intents.trouble.includes("token_cleaned"), "intents: the paste markers are taken off the token before it is sent");

  // A bot in no server yet, and servers that cannot be listed.
  const lonely = await runWizard("no-servers", "no-servers", ["1", token, "", "", ""]);
  checkReport("no-servers", lonely);
  check(lonely.report.outcome === "completed" && lonely.trouble.includes("no_servers") && !readFileSync(join(lonely.box, "home", ".env"), "utf8").includes("DISCORD_MCP_GUILD"), "no-servers: completes with no default server, and notes it");
  const unlisted = await runWizard("servers-unlisted", "servers-500", ["1", token, "", "", ""]);
  checkReport("servers-unlisted", unlisted);
  check(unlisted.out.includes("Could not list the bot's servers just now (HTTP 500)") && unlisted.report.outcome === "completed" && unlisted.trouble.includes("servers_unlisted"), "servers-unlisted: says so, completes, and notes it");

  // An app config file that is not valid JSON is left alone.
  const brokenConfig = "{ this is not json";
  const broken = await runWizard("config-invalid", "fine", allTheWay, { before: (box) => writeFileSync(join(box, ".mcp.json"), brokenConfig) });
  checkReport("config-invalid", broken);
  check(broken.out.includes("is not valid JSON, so it was left untouched") && readFileSync(join(broken.box, ".mcp.json"), "utf8") === brokenConfig, "config-invalid: the file is left exactly as it was, and the snippet printed");
  check(broken.report.outcome === "completed" && broken.trouble.includes("config_invalid"), "config-invalid: completes, and notes it");

  // The settings folder cannot be written: the path named, exit 1, and the
  // details line, the one to paste into an issue, shows the home folder as ~.
  const blocked = await runWizard("blocked", "fine", ["1", token, "", "", ""], {
    home: join(work, "blocked", "not-a-folder"),
    before: (box) => writeFileSync(join(box, "not-a-folder"), "a file where the folder should be"),
  });
  checkReport("blocked", blocked);
  check(blocked.code === 1 && blocked.out.includes("Setup could not save") && blocked.out.includes("not-a-folder"), `blocked: says which path it could not save (${blocked.code})`);
  const detailsLine = blocked.out.split("\n").find((l) => l.includes("Details:")) ?? "";
  check(detailsLine.includes(`~${sep}not-a-folder`) && !detailsLine.includes(blocked.box), `blocked: the details line shows the home folder as ~ (${detailsLine.trim()})`);
  check(blocked.report.outcome === "failed" && blocked.report.step === "save" && blocked.report.error === "files" && blocked.report.code === "EEXIST", `blocked: reports failed at the save step, files, EEXIST (${JSON.stringify(blocked.report)})`);

  // Something the wizard cannot explain: a bug, with where it happened.
  const bug = await runWizard("bug", "bug", ["1", token]);
  checkReport("bug", bug);
  check(bug.code === 1 && bug.out.includes("likely a bug") && /\n\s+at /.test(bug.out), "bug: says it is likely a bug, and shows where");
  check(bug.report.error === "other" && bug.report.code === "TypeError" && bug.report.step === "token", `bug: reports other, TypeError, at the token step (${JSON.stringify(bug.report)})`);

  // The terminal fails while the wizard waits for an answer.
  const terminal = await runWizard("terminal", "fine", null, { env: { SMOKE_STDIN_ERROR: "1" } });
  checkReport("terminal", terminal);
  check(terminal.code === 1 && terminal.out.includes("The terminal stopped sending input"), `terminal: says the terminal stopped, and exits with 1 (${terminal.code})`);
  check(terminal.report.outcome === "failed" && terminal.report.step === "start" && terminal.report.error === "terminal" && terminal.report.code === "EIO", `terminal: reports failed at the start, terminal, EIO (${JSON.stringify(terminal.report)})`);

  // Ctrl+C. Windows has no signals to send a child, so only elsewhere (CI
  // runs these on Linux and macOS).
  if (process.platform !== "win32") {
    // At a question, once, and the same press arriving twice the way npx
    // passes it on: quits like q, and is reported as cancelled.
    for (const [name, presses] of [["ctrl-c", 1], ["ctrl-c-twice", 2]]) {
      let sent = false;
      const r = await runWizard(name, "fine", null, {
        onOutput: (text, child) => {
          if (sent || !text.includes("How many? [1]: ")) return;
          sent = true;
          for (let i = 0; i < presses; i += 1) child.kill("SIGINT");
        },
      });
      checkReport(name, r);
      check(r.code === 0 && r.out.includes("Setup cancelled.") && r.report.outcome === "cancelled" && r.report.step === "start", `${name}: at a question, quits like q and is reported cancelled (${r.code}, ${JSON.stringify(r.report)})`);
    }
    // In the middle of a step: reported as cancelled at that step, and
    // stopped at once rather than after Discord's 15 seconds.
    let sent = false;
    const started = Date.now();
    const midStep = await runWizard("ctrl-c-mid-step", "hang", ["1", token], {
      onOutput: (text, child) => {
        if (sent || !text.includes("Checking with Discord... ")) return;
        sent = true;
        setTimeout(() => child.kill("SIGINT"), 200);
      },
    });
    checkReport("ctrl-c-mid-step", midStep);
    check(midStep.code === 130 && Date.now() - started < 10000 && midStep.out.includes("Setup cancelled."), `ctrl-c-mid-step: stops at once with 130 (${midStep.code}, ${Date.now() - started} ms)`);
    check(midStep.report.outcome === "cancelled" && midStep.report.step === "token", `ctrl-c-mid-step: reported cancelled at the token step (${JSON.stringify(midStep.report)})`);
  } else {
    console.log("skip: Ctrl+C runs (no signals to send a child on Windows; CI runs them on Linux and macOS)");
  }
} finally {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp folder must not mask the results.
  }
}

if (failures > 0) {
  console.error(`\nwizard smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nwizard smoke: all passed");
