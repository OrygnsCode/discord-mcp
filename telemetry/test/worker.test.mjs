// Tests for the usage stats receiver, run against the real Worker on a
// local D1 (Miniflare): validation, de-duplication, the counting, the rate
// limit, the private stats, the daily pruning, and a report from the real
// client code. Run with: npm test (in telemetry/), after the main build.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
function check(condition, label) {
  if (condition) console.log(`ok: ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

const migration = readFileSync(join(here, "migrations", "0001_init.sql"), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

async function start(bindings = { STATS_TOKEN: "test-stats-token" }, limit = 1000) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: join(here, "src", "worker.js"),
    compatibilityDate: "2025-11-01",
    d1Databases: { DB: "local-test" },
    bindings,
    ratelimits: { PING_LIMIT: { namespace_id: "2101", simple: { limit, period: 60 } } },
  }));
  const db = await mf.getD1Database("DB");
  for (const statement of migration) await db.prepare(statement).run();
  return { mf, db };
}

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const hex = (n) => n.toString(16).padStart(32, "0");
let next = 1;
const report = (extra = {}) => ({
  s: 1,
  day: today,
  nonce: hex(next++),
  v: "2.1.0",
  os: "windows",
  app: "claude-desktop",
  install: "wizard",
  ctx: "default",
  bots: "1",
  servers: "2-5",
  largest: "50-500",
  age: "8-30",
  first: { week: true, month: false, ever: false },
  days: [{ d: daysAgo(1), tools: { send_message: "10-99", read_messages: "1-9" }, gate: { preview: "1-9" }, errors: { permission: "1-9" }, apps: ["claude-desktop"] }],
  ...extra,
});

const { mf, db } = await start();
const send = (path, body, headers = {}) =>
  mf.dispatchFetch(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    cf: { country: "DE" },
  });
const count = async (day, metric, key = "") =>
  (await db.prepare("SELECT n FROM daily WHERE day = ?1 AND metric = ?2 AND key = ?3").bind(day, metric, key).first())?.n ?? 0;
const logRows = async () => (await db.prepare("SELECT COUNT(*) AS c FROM log").first()).c;

try {
  // Every kind of error and confirmation event the client can count is one
  // the receiver keeps.
  const { ERROR_CLASSES, GATE_EVENTS } = await import("../../dist/usageStats.js");
  const d9 = daysAgo(9);
  await send("/discord-mcp/v1/ping", report({ days: [{ d: d9, tools: { list_roles: "1-9" }, gate: Object.fromEntries(GATE_EVENTS.map((g) => [g, "1-9"])), errors: Object.fromEntries(ERROR_CLASSES.map((c) => [c, "1-9"])), apps: ["claude-code"] }] }));
  const lostClasses = [];
  for (const c of ERROR_CLASSES) if ((await count(d9, "error", `${c}|1-9`)) !== 1) lostClasses.push(c);
  check(lostClasses.length === 0 && ERROR_CLASSES.length === 14, `the receiver keeps every kind of error the client counts (${ERROR_CLASSES.length}; not kept: ${lostClasses.join(", ") || "none"})`);
  const lostGate = [];
  for (const g of GATE_EVENTS) if ((await count(d9, "gate", `${g}|1-9`)) !== 1) lostGate.push(g);
  check(lostGate.length === 0 && GATE_EVENTS.includes("expired"), `and every confirmation event (${GATE_EVENTS.join(", ")}; not kept: ${lostGate.join(", ") || "none"})`);
  const d10 = daysAgo(10);
  await send("/discord-mcp/v1/ping", report({ days: [{ d: d10, tools: { create_emoji: "10-99", update_role: "1-9" }, failed: { create_emoji: "10-99", "Not A Tool!": "1-9", update_role: "999" }, gate: {}, errors: { file: "10-99" }, apps: ["claude-code"] }] }));
  check((await count(d10, "tool_failed", "create_emoji|10-99")) === 1 && (await count(d10, "tool_failed", "update_role|999")) === 0 && (await db.prepare("SELECT COUNT(*) AS c FROM daily WHERE metric = 'tool_failed' AND key LIKE 'Not%'").first()).c === 0, "failed calls are kept per tool, by the same rules as tool counts");
  // A container run without saved state is first of everything every time:
  // it is counted apart, not as a new install.
  await send("/discord-mcp/v1/ping", report({ ctx: "container", first: { week: true, month: true, ever: true } }));
  await send("/discord-mcp/v1/ping", report({ ctx: "default", first: { week: true, month: true, ever: true } }));
  check((await count(today, "first_ever", "")) === 1 && (await count(today, "first_ever", "container")) === 1 && (await count(today, "first_month", "container")) === 1, "a container run that looks new is counted apart from new installs");
  const statsRes = await mf.dispatchFetch("http://localhost/discord-mcp/v1/stats?days=2", { headers: { authorization: "Bearer test-stats-token" } });
  const statsBody = await statsRes.json();
  check(statsBody.perDay[today]?.first_ever === 1 && statsBody.totals.first_ever?.container === 1, `and the stats keep it out of the daily new-install count (${JSON.stringify(statsBody.perDay[today])})`);
  await db.prepare("DELETE FROM daily").run();
  await db.prepare("DELETE FROM log").run();
  await db.prepare("DELETE FROM nonces").run();

  // A good report.
  const first = report();
  let res = await send("/discord-mcp/v1/ping", first);
  check(res.status === 204, `a report is taken (${res.status})`);
  check((await count(today, "pings")) === 1 && (await count(today, "version", "2.1.0")) === 1 && (await count(today, "app", "claude-desktop")) === 1 && (await count(today, "country", "DE")) === 1, "it counts as one report today, by version, app and country");
  check((await count(today, "first_week")) === 1 && (await count(today, "first_month")) === 0 && (await count(today, "first_ever")) === 0, "the first-of flags count only when set");
  const y = daysAgo(1);
  check((await count(y, "reports")) === 1 && (await count(y, "tool", "send_message|10-99")) === 1 && (await count(y, "tool", "read_messages|1-9")) === 1 && (await count(y, "gate", "preview|1-9")) === 1 && (await count(y, "error", "permission|1-9")) === 1 && (await count(y, "active_app", "claude-desktop")) === 1, "yesterday's counts go under yesterday");
  const logged = await db.prepare("SELECT body FROM log").first();
  check((await logRows()) === 1 && !logged.body.includes("203.0.113.7") && !logged.body.includes(first.nonce) && JSON.parse(logged.body).country === "DE", "the log keeps the report without its address or number");

  // The same report again counts once.
  res = await send("/discord-mcp/v1/ping", first);
  check(res.status === 204 && (await count(today, "pings")) === 1 && (await count(y, "tool", "send_message|10-99")) === 1 && (await logRows()) === 1, "the same report sent again is counted once");
  await send("/discord-mcp/v1/ping", report());
  check((await count(today, "pings")) === 2 && (await count(y, "tool", "send_message|10-99")) === 2, "another install's report adds to the counts");

  // Values outside the lists.
  await send("/discord-mcp/v1/ping", report({ os: "plan9", app: "<script>", install: "evil", v: "1.2", bots: "999", servers: undefined, largest: "huge", age: "old", ctx: "space", first: "yes" }));
  check((await count(today, "os", "other")) === 1 && (await count(today, "app", "other")) === 1 && (await count(today, "install", "other")) === 1 && (await count(today, "version", "other")) === 1 && (await count(today, "bots", "other")) === 1 && (await count(today, "servers", "unknown")) === 1 && (await count(today, "largest", "unknown")) === 1 && (await count(today, "ctx", "other")) === 1, "values outside the lists are counted as other or unknown");
  check((await db.prepare("SELECT COUNT(*) AS c FROM daily WHERE key LIKE '%script%' OR key LIKE '%evil%' OR key LIKE '%plan9%'").first()).c === 0, "and never stored as sent");
  await send("/discord-mcp/v1/ping", report({ days: [
    { d: daysAgo(2), tools: { "DROP TABLE x": "1-9", ok_tool: "999", fine_tool: "1-9", ["a".repeat(60)]: "1-9" }, gate: { approve_all: "1-9" }, errors: { "<x>": "1-9" }, apps: ["evil", "cursor"] },
    { d: daysAgo(2), tools: { twice: "1-9" } },
    { d: daysAgo(-5), tools: { future: "1-9" } },
    { d: daysAgo(100), tools: { ancient: "1-9" } },
    { d: "yesterday", tools: { words: "1-9" } },
  ] }));
  const d2 = daysAgo(2);
  check((await count(d2, "tool", "fine_tool|1-9")) === 1 && (await db.prepare("SELECT COUNT(*) AS c FROM daily WHERE key LIKE 'DROP%' OR key LIKE 'ok_tool%' OR key LIKE 'aaaa%' OR key LIKE 'approve%' OR key LIKE '<x>%' OR key LIKE 'twice%' OR key LIKE 'future%' OR key LIKE 'ancient%' OR key LIKE 'words%'").first()).c === 0, "tool names, bands and days outside the rules are dropped");
  check((await count(d2, "active_app", "other")) === 1 && (await count(d2, "active_app", "cursor")) === 1, "and unknown apps count as other");
  const many = Array.from({ length: 12 }, (_, i) => ({ d: daysAgo(i + 3), tools: { many_days: "1-9" } }));
  await send("/discord-mcp/v1/ping", report({ days: many }));
  check((await db.prepare("SELECT COUNT(*) AS c FROM daily WHERE metric = 'tool' AND key = 'many_days|1-9'").first()).c === 7, "at most seven days per report");

  // Reports that are not reports.
  check((await send("/discord-mcp/v1/ping", "{not json")).status === 400, "not JSON: 400");
  check((await send("/discord-mcp/v1/ping", { ...report(), nonce: "short" })).status === 400, "no proper number: 400");
  check((await send("/discord-mcp/v1/ping", { ...report(), s: 2 })).status === 400, "an unknown schema: 400");
  check((await send("/discord-mcp/v1/ping", { ...report(), pad: "x".repeat(70_000) })).status === 413, "too large: 413");
  // A week of every tool every day, as the client sends it at most.
  const heavy = report({ days: Array.from({ length: 7 }, (_, i) => ({ d: daysAgo(i + 1), tools: Object.fromEntries(Array.from({ length: 160 }, (_, t) => [`tool_name_number_${t}`, "10-99"])), gate: { preview: "1-9" }, errors: { other: "1-9" }, apps: ["cursor"] })) });
  const heavyBody = JSON.stringify(heavy);
  res = await send("/discord-mcp/v1/ping", heavyBody);
  check(heavyBody.length < 60_000 && res.status === 204 && (await count(daysAgo(7), "tool", "tool_name_number_159|10-99")) === 1, `a heavy week fits and is counted (${heavyBody.length} bytes)`);

  // Development and setup.
  const before = await count(today, "pings");
  await send("/discord-mcp/v1/ping", report({ install: "source" }));
  check((await count(today, "pings")) === before && (await count(today, "dev_pings")) === 1, "a report from a source checkout is counted apart, and nowhere else");
  await send("/discord-mcp/v1/setup", { s: 1, kind: "setup", day: today, nonce: hex(next++), v: "2.1.0", os: "macos", install: "npx", flow: "fresh", outcome: "completed", apps: ["claude-desktop", "evil"] });
  check((await count(today, "setup", "fresh|completed")) === 1 && (await count(today, "setup_app", "claude-desktop")) === 1 && (await count(today, "setup_app", "other")) === 1 && (await count(today, "setup_install", "npx")) === 1, "a setup run is counted by path, outcome and app");
  // Where a run stopped, and why it failed: the step only for a run that did
  // not complete, the kind of error only for one that failed.
  const setupRun = (extra) => send("/discord-mcp/v1/setup", { s: 1, kind: "setup", day: today, nonce: hex(next++), v: "2.1.1", os: "windows", install: "npx", flow: "fresh", apps: [], ...extra });
  await setupRun({ outcome: "failed", step: "token", error: "network" });
  check((await count(today, "setup_step", "failed|token")) === 1 && (await count(today, "setup_error", "token|network")) === 1, "a failed run is counted by the step it stopped at and its kind of error");
  await setupRun({ outcome: "cancelled", step: "invite", error: "network" });
  check((await count(today, "setup_step", "cancelled|invite")) === 1 && (await count(today, "setup_error", "invite|network")) === 0, "a cancelled run counts its step, never an error");
  await setupRun({ flow: "reregister", outcome: "completed", step: "register", error: "files" });
  check((await count(today, "setup", "reregister|completed")) === 1 && (await count(today, "setup_step", "completed|register")) === 0 && (await count(today, "setup_error", "register|files")) === 0, "a completed run counts neither");
  await setupRun({ outcome: "failed", step: "drop table", error: "EACCES C:\\Users\\someone" });
  check((await count(today, "setup_step", "failed|other")) === 1 && (await count(today, "setup_error", "other|other")) === 1, "an unknown step or kind of error is counted as other");
  const lastSetup = await db.prepare("SELECT body FROM log WHERE kind = 'setup' ORDER BY rowid DESC LIMIT 1").first();
  check(!lastSetup.body.includes("Users") && !lastSetup.body.includes("drop"), `and the log keeps only the cleaned values (${lastSetup.body})`);
  await setupRun({ outcome: "failed" });
  check((await count(today, "setup", "fresh|failed")) === 3 && (await count(today, "setup_step", "failed|other")) === 1, "a failed run from before 2.1.1, with neither, still counts as a run");
  const metricRows = async (metric) => (await db.prepare("SELECT COUNT(*) AS c FROM daily WHERE metric = ?1").bind(metric).first()).c;
  check((await metricRows("setup_node")) === 0 && (await metricRows("setup_trouble")) === 0 && (await metricRows("setup_code")) === 0, "and fields a report does not have add no counts");

  // The error code: only for a failed run, from a fixed list.
  await setupRun({ outcome: "failed", step: "token", error: "network", code: "ENOTFOUND" });
  check((await count(today, "setup_code", "network|ENOTFOUND")) === 1, "a failed run's error code is counted with its kind");
  await setupRun({ outcome: "failed", step: "save", error: "files", code: "EACCES: permission denied, open 'C:\\Users\\someone\\x.json'" });
  await setupRun({ outcome: "failed", step: "save", error: "files", code: 13 });
  check((await count(today, "setup_code", "files|other")) === 2, "a code not on the list, text or a number, is counted as other");
  await setupRun({ outcome: "cancelled", step: "token", error: "network", code: "ENOTFOUND" });
  await setupRun({ outcome: "failed", step: "token", code: "ENOTFOUND" });
  check((await count(today, "setup_code", "network|ENOTFOUND")) === 1 && (await count(today, "setup_code", "-|ENOTFOUND")) === 0 && (await metricRows("setup_code")) === 2, "no code is counted for a run that did not fail, or one with no kind of error");

  // What went wrong along the way: any outcome, each at most once.
  await setupRun({ outcome: "completed", flow: "reregister", trouble: ["token_secret", "token_secret", "intents_off", "rm -rf /", 7, null] });
  check((await count(today, "setup_trouble", "completed|token_secret")) === 1 && (await count(today, "setup_trouble", "completed|intents_off")) === 1 && (await count(today, "setup_trouble", "completed|other")) === 1, "trouble is counted for a completed run too, once each, with anything unknown as other");
  await setupRun({ outcome: "cancelled", step: "token", trouble: "token_secret" });
  await setupRun({ outcome: "cancelled", step: "token", trouble: { token_secret: true } });
  check((await count(today, "setup_trouble", "cancelled|token_secret")) === 0, "trouble that is not a list is ignored");
  const flood = await setupRun({ outcome: "cancelled", step: "token", trouble: Array.from({ length: 5000 }, (_, i) => `t${i}`) });
  check(flood.status === 204 && (await count(today, "setup_trouble", "cancelled|other")) === 1, "a flood of trouble is cut short and counted once, as other");

  // The major Node.js version.
  await setupRun({ outcome: "completed", flow: "upgrade", node: "22" });
  check((await count(today, "setup_node", "completed|22")) === 1, "the Node.js major version is counted with the outcome");
  for (const node of ["999", "7", "22.11.0", "0", "", "abc", 22]) await setupRun({ outcome: "completed", flow: "upgrade", node });
  check((await count(today, "setup_node", "completed|other")) === 7, "anything else is counted as other");

  // Every row a setup report adds stays small, whatever it carries.
  const countsBefore = await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM daily").first();
  await setupRun({ outcome: "failed", step: "token", error: "network", code: "ENOTFOUND", node: "24", apps: Array.from({ length: 50 }, () => "cursor"), trouble: [...Array.from({ length: 17 }, (_, i) => `x${i}`), "token_id"] });
  const countsAfter = await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM daily").first();
  check(countsAfter.n - countsBefore.n <= 12, `one report adds at most a dozen counts (${countsAfter.n - countsBefore.n})`);

  // The private stats.
  const get = (path, headers = {}) => mf.dispatchFetch(`http://localhost${path}`, { headers });
  check((await get("/discord-mcp/v1/stats")).status === 404 && (await get("/discord-mcp/v1/stats", { authorization: "Bearer wrong-token-xxxxx" })).status === 404, "stats without the token: not found");
  res = await get("/discord-mcp/v1/stats?days=7", { authorization: "Bearer test-stats-token" });
  const body = await res.json();
  check(res.status === 200 && body.perDay[today].pings >= 4 && body.totals.tool["send_message|10-99"] >= 2 && body.totals.setup["fresh|completed"] === 1, "stats with the token: the counts");
  check((await get("/discord-mcp/v1/ping")).status === 404 && (await get("/nothing")).status === 404 && (await send("/v1/ping", report())).status === 404 && (await send("/other/v1/ping", report())).status === 404, "anything else: not found");
  const closed = await start({});
  check((await closed.mf.dispatchFetch("http://localhost/discord-mcp/v1/stats", { headers: { authorization: "Bearer " } })).status === 404, "with no token set, stats stay closed");
  await closed.mf.dispose();

  // The rate limit, from one address.
  const limited = await start(undefined, 3);
  const burst = [];
  for (let i = 0; i < 5; i += 1) {
    burst.push((await limited.mf.dispatchFetch("http://localhost/discord-mcp/v1/ping", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.9" }, body: JSON.stringify(report()) })).status);
  }
  const counted = (await limited.db.prepare("SELECT n FROM daily WHERE day = ?1 AND metric = 'pings'").bind(today).first())?.n ?? 0;
  check(burst.every((s) => s === 204) && counted === 3, `past the limit, reports are answered but not counted (${counted} of 5)`);
  await limited.mf.dispose();

  // Daily pruning.
  await db.prepare("INSERT INTO nonces (nonce, seen, fresh) VALUES ('old', ?1, 0)").bind(daysAgo(4)).run();
  await db.prepare("INSERT INTO log (ts, kind, body) VALUES (?1, 'ping', '{}')").bind(new Date(Date.now() - 8 * 86_400_000).toISOString()).run();
  const worker = await mf.getWorker();
  await worker.scheduled({ scheduledTime: new Date(), cron: "23 3 * * *" });
  check((await db.prepare("SELECT COUNT(*) AS c FROM nonces WHERE nonce = 'old'").first()).c === 0 && (await db.prepare("SELECT COUNT(*) AS c FROM nonces").first()).c > 0, "numbers older than three days are forgotten, recent ones kept");
  check((await db.prepare("SELECT COUNT(*) AS c FROM log WHERE ts < ?1").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).first()).c === 0 && (await logRows()) > 0, "the log keeps seven days");

  // A report from the real client code, over HTTP.
  const served = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: join(here, "src", "worker.js"),
    compatibilityDate: "2025-11-01",
    d1Databases: { DB: "local-client" },
    bindings: { STATS_TOKEN: "t" },
    port: 0,
  }));
  const url = (await served.ready).toString().replace(/\/$/, "");
  const sdb = await served.getD1Database("DB");
  for (const statement of migration) await sdb.prepare(statement).run();
  const data = mkdtempSync(join(tmpdir(), "dmcp-telemetry-client-"));
  process.env.DISCORD_MCP_DATA_DIR = data;
  process.env.DISCORD_TOKEN = "";
  const client = await import("../../dist/usageReport.js");
  client.__testing.use(
    { env: { DISCORD_MCP_TELEMETRY: "on", DISCORD_MCP_TELEMETRY_URL: url, DISCORD_MCP_PACKAGING: "mcpb" }, guildCounts: async () => ({ servers: 1, largest: 30 }) },
    { bots: [{ name: "b", token: "t", isDefault: true }], toolsets: {} },
  );
  const outcome = await client.sendIfDue();
  const n = (await sdb.prepare("SELECT n FROM daily WHERE day = ?1 AND metric = 'install' AND key = 'mcpb'").bind(today).first())?.n ?? 0;
  check(outcome === "sent" && n === 1 && ((await sdb.prepare("SELECT n FROM daily WHERE day = ?1 AND metric = 'largest' AND key = '<50'").bind(today).first())?.n ?? 0) === 1, `the client's own report is taken and counted (${outcome})`);
  const setupSent = await client.sendSetupEvent({ flow: "add_bot", outcome: "cancelled", apps: [] });
  check(setupSent === true && ((await sdb.prepare("SELECT n FROM daily WHERE metric = 'setup' AND key = 'add_bot|cancelled'").first())?.n ?? 0) === 1, "and so is its setup event");
  await client.sendSetupEvent({ flow: "fresh", outcome: "failed", apps: [], step: "token", error: "certificate" });
  check(((await sdb.prepare("SELECT n FROM daily WHERE metric = 'setup_error' AND key = 'token|certificate'").first())?.n ?? 0) === 1, "and a failed one, with its step and kind of error");
  // Every step and kind of error the client can send is one the receiver
  // keeps, rather than counting it as other.
  for (const step of client.SETUP_STEPS) await client.sendSetupEvent({ flow: "fresh", outcome: "failed", apps: [], step, error: "other" });
  for (const error of client.SETUP_ERRORS) await client.sendSetupEvent({ flow: "fresh", outcome: "failed", apps: [], step: "save", error });
  const kept = async (metric, key) => ((await sdb.prepare("SELECT n FROM daily WHERE metric = ?1 AND key = ?2").bind(metric, key).first())?.n ?? 0) > 0;
  const lostSteps = [];
  for (const step of client.SETUP_STEPS) if (!(await kept("setup_step", `failed|${step}`))) lostSteps.push(step);
  const lostErrors = [];
  for (const error of client.SETUP_ERRORS) if (!(await kept("setup_error", `save|${error}`))) lostErrors.push(error);
  check(lostSteps.length === 0 && lostErrors.length === 0 && !(await kept("setup_step", "failed|other")), `the receiver knows every step and kind of error the client sends (not kept: ${[...lostSteps, ...lostErrors].join(", ") || "none"})`);
  for (const code of client.SETUP_CODES) await client.sendSetupEvent({ flow: "fresh", outcome: "failed", apps: [], step: "token", error: "network", code });
  const lostCodes = [];
  for (const code of client.SETUP_CODES) if (!(await kept("setup_code", `network|${code}`))) lostCodes.push(code);
  check(lostCodes.length === 0 && client.SETUP_CODES.length > 40, `and every error code (${client.SETUP_CODES.length}; not kept: ${lostCodes.join(", ") || "none"})`);
  await client.sendSetupEvent({ flow: "upgrade", outcome: "completed", apps: [], trouble: [...client.SETUP_TROUBLE] });
  const lostTrouble = [];
  for (const t of client.SETUP_TROUBLE) if (!(await kept("setup_trouble", `completed|${t}`))) lostTrouble.push(t);
  check(lostTrouble.length === 0 && !(await kept("setup_trouble", "completed|other")), `and every kind of trouble, all at once (not kept: ${lostTrouble.join(", ") || "none"})`);
  const major = process.versions.node.split(".")[0];
  check(await kept("setup_node", `completed|${major}`), `and the Node.js it runs on (${major})`);
  await served.dispose();
  rmSync(data, { recursive: true, force: true });
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`\ntelemetry: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntelemetry: all passed");
