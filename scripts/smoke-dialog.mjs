// The confirmation dialog end to end over stdio, as a 2025-era app that can
// show a form (Claude Code and Claude Desktop today) runs it: the built
// server, the SDK's server-side handling of the dialog, and delete_blueprint,
// which touches only the local store, so no Discord token is needed.
// smoke-modern.mjs covers the same flow on the 2026-07-28 protocol.
//
// Run with: node scripts/smoke-dialog.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extra = {};
const home = mkdtempSync(join(tmpdir(), "discord-mcp-smoke-dialog-"));
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

async function session({ declare = true, answer }) {
  const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
    cwd: home,
    env: { ...process.env, DISCORD_TOKEN: "", DISCORD_MCP_GUILD: "", DISCORD_MCP_HOME: home, DISCORD_MCP_DATA_DIR: home, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map();
  const asked = [];
  let id = 1;
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === "elicitation/create") {
        asked.push(m.params);
        const reply = answer(m.params, asked.length);
        if (reply === "never") continue;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: reply }) + "\n");
      } else if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      }
    }
  });
  const req = (method, params, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const n = id++;
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      setTimeout(() => waiting.has(n) && reject(new Error(`timeout ${method}`)), timeoutMs);
    });
  await req("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: declare ? { elicitation: { form: {} } } : {},
    clientInfo: { name: "smoke-dialog", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (name, args) => {
    const r = await req("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result);
    let env;
    try { env = JSON.parse(text); } catch { env = { summary: text }; }
    return { ...env, isError: r.result?.isError === true, raw: r };
  };
  return { call, asked, close: () => child.kill() };
}

const bp = { roles: [], categories: [] };
const accept = () => ({ action: "accept", content: { confirm: true } });

{
  const s = await session({ answer: accept });
  await s.call("save_blueprint", { name: "dialog-one", blueprint: bp });
  const preview = await s.call("delete_blueprint", { blueprint: "dialog-one" });
  check(preview.data?.confirmed_by === "dialog", "preview says the dialog confirms");
  check(/dialog/.test(preview.summary) && !/get their answer/.test(preview.summary), "preview tells the model the dialog does the asking");
  check(s.asked.length === 0, "no dialog on the first call");
  const done = await s.call("delete_blueprint", { blueprint: "dialog-one", confirm_token: preview.data.confirm_token });
  check(s.asked.length === 1, "one dialog on the call with the token");
  check(/dialog-one/.test(s.asked[0]?.message ?? ""), "the dialog names the blueprint");
  check(s.asked[0]?.requestedSchema?.required?.includes("confirm"), "the dialog requires the box");
  check(/^Deleted/.test(done.summary), `accepted and ticked: deleted (${done.summary})`);
  const again = await s.call("delete_blueprint", { blueprint: "dialog-one", confirm_token: preview.data.confirm_token });
  check(again.isError, "the token is spent");
  const setup = await s.call("run_setup_check", {});
  const conf = (setup.data?.checks ?? []).find((c) => c.check === "confirmations");
  check(conf?.status === "pass" && /dialog this app shows/.test(conf.detail), "setup check reports the dialog");
  s.close();
}

for (const [label, reply, expect] of [
  ["declined", { action: "decline" }, /said no/],
  ["cancelled", { action: "cancel" }, /closed without an answer/],
  ["accepted unticked", { action: "accept", content: { confirm: false } }, /did not tick/],
  ["accepted without content", { action: "accept" }, /did not tick/],
]) {
  const s = await session({ answer: () => reply });
  await s.call("save_blueprint", { name: "dialog-two", blueprint: bp });
  const preview = await s.call("delete_blueprint", { blueprint: "dialog-two" });
  const res = await s.call("delete_blueprint", { blueprint: "dialog-two", confirm_token: preview.data.confirm_token });
  check(expect.test(res.summary), `${label}: ${res.summary}`);
  const still = await s.call("get_blueprint", { blueprint: "dialog-two" });
  check(!still.isError, `${label}: the blueprint is still there`);
  const reuse = await s.call("delete_blueprint", { blueprint: "dialog-two", confirm_token: preview.data.confirm_token });
  check(reuse.isError && s.asked.length === 1, `${label}: the token cannot be used again`);
  await s.call("delete_blueprint", { blueprint: "dialog-two", confirm_token: "x" });
  s.close();
}

{
  // An app that does not declare elicitation keeps the token flow.
  const s = await session({ declare: false, answer: accept });
  await s.call("save_blueprint", { name: "dialog-three", blueprint: bp });
  const preview = await s.call("delete_blueprint", { blueprint: "dialog-three" });
  check(preview.data?.confirmed_by === "token" && /get their answer/.test(preview.summary), "no elicitation: token flow and ask-first wording");
  const done = await s.call("delete_blueprint", { blueprint: "dialog-three", confirm_token: preview.data.confirm_token });
  check(/^Deleted/.test(done.summary) && s.asked.length === 0, "no elicitation: the token deletes, no dialog");
  s.close();
}

try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // A leftover temp folder must not mask the result.
}
if (failures > 0) {
  console.error(`\nsmoke-dialog: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-dialog: all passed");
process.exit(0);
