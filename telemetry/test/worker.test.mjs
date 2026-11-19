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
