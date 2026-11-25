// Prints the usage stats. The token is the receiver's STATS_TOKEN secret,
// given in the environment or as a file:
//   STATS_TOKEN=... node stats.mjs [days]
//   STATS_TOKEN_FILE=path node stats.mjs [days]
import { readFileSync } from "node:fs";

const days = Number(process.argv[2] ?? 30);
const base = (process.env.STATS_URL ?? "https://telemetry.orygn.tech").replace(/\/+$/, "");
const token = process.env.STATS_TOKEN ?? (process.env.STATS_TOKEN_FILE ? readFileSync(process.env.STATS_TOKEN_FILE, "utf8").trim() : "");
if (!token) {
  console.error("Set STATS_TOKEN or STATS_TOKEN_FILE.");
  process.exit(1);
}
const res = await fetch(`${base}/discord-mcp/v1/stats?days=${days}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`The receiver answered ${res.status}.`);
  process.exit(1);
}
const { from, perDay, totals } = await res.json();

console.log(`Since ${from}\n`);
console.log("day          reports  new  first-of-week  first-of-month  dev");
for (const [day, d] of Object.entries(perDay)) {
  console.log(`${day}  ${String(d.pings).padStart(7)}  ${String(d.first_ever).padStart(3)}  ${String(d.first_week).padStart(13)}  ${String(d.first_month).padStart(14)}  ${String(d.dev_pings).padStart(3)}`);
}
const sum = (key) => Object.values(perDay).reduce((n, d) => n + d[key], 0);
console.log(`\nInstalls active in the span (first-of-month, summed): ${sum("first_month")}`);
console.log(`New installs: ${sum("first_ever")}`);
console.log(`Container runs that only looked new (not counted above): ${totals.first_ever?.container ?? 0}\n`);

const show = (title, entries, limit = 15) => {
  const list = Object.entries(entries ?? {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (list.length === 0) return;
  console.log(title);
  for (const [k, n] of list) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log("");
};
for (const metric of ["version", "app", "os", "install", "ctx", "country", "bots", "servers", "largest", "age", "active_app"]) {
  show(metric, totals[metric]);
}
// Tools: installs-days that used each, whatever the band.
const tools = {};
for (const [key, n] of Object.entries(totals.tool ?? {})) {
  const name = key.split("|")[0];
  tools[name] = (tools[name] ?? 0) + n;
}
show("tools (install-days)", tools, 40);
show("gate", totals.gate);
show("errors", totals.error);
show("failed calls by tool (install-days)", totals.tool_failed, 40);
show("setup runs", totals.setup);
show("setup apps", totals.setup_app);
show("setup stopped at (outcome|step)", totals.setup_step);
show("setup errors (step|kind)", totals.setup_error);
show("setup error codes (kind|code)", totals.setup_code, 30);
show("setup trouble (outcome|what)", totals.setup_trouble, 40);
show("setup Node.js (outcome|major)", totals.setup_node);
