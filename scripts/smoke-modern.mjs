// Stdio smoke test for the 2026-07-28 protocol, through the official SDK
// client, plus the background-work rule from lifecycle.ts. No Discord token.
// smoke.mjs covers the 2025-era flow over raw JSON-RPC; this covers the
// modern one the way new clients actually run it.
//
// Run with: node scripts/smoke-modern.mjs

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");
const dataDir = join(tmpdir(), `discord-mcp-smoke-modern-${Date.now()}`);
const env = { ...process.env, DISCORD_TOKEN: "", DISCORD_MCP_GUILD: "", DISCORD_MCP_DATA_DIR: dataDir };

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

const CONNECTED = "discord-mcp: client connected";

// Sends raw lines to a fresh server and collects its stdout replies and
// stderr. Used to check what a probe-only connection does and does not do.
// Waits for the replies it expects rather than a fixed time: a cold start
// takes anywhere from one to several seconds on a busy machine. After the
// replies, a settle period lets any stderr that would follow arrive.
async function rawSession(lines, expectIds, { settleMs = 1000, timeoutMs = 30000 } = {}) {
  const child = spawn(process.execPath, [entry], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  for (const line of lines) child.stdin.write(JSON.stringify(line) + "\n");
  const parse = () =>
    stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { unparsable: l };
        }
      });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ids = new Set(parse().map((r) => r.id));
    if (expectIds.every((id) => ids.has(id))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, settleMs));
  child.kill();
  await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
  return { replies: parse(), stderr };
}

const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "smoke-modern", version: "0.0.1" },
};

try {
  // 1. A probe-only connection, what a new client's short-lived copy sees:
  //    it is answered, and starts no background work.
  const probe = await rawSession(
    [{ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope } }],
    [1]
  );
  const discover = probe.replies.find((r) => r.id === 1);
  check(
    Array.isArray(discover?.result?.supportedVersions) &&
      discover.result.supportedVersions.includes("2026-07-28"),
    "server/discover advertises 2026-07-28"
  );
  check(
    discover?.result?.instructions?.startsWith("Discord server management through a bot account."),
    "server/discover carries the server's instructions"
  );
  check(!probe.stderr.includes(CONNECTED), "a probe-only connection starts no background work");
  check(probe.replies.every((r) => !r.unparsable), "stdout carries only JSON-RPC");

  // 2. A real connection on either era does start it.
  const legacy = await rawSession([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    },
  ], [1]);
  check(legacy.stderr.includes(CONNECTED), "a 2025-era initialize starts background work");

  const modernFirst = await rawSession([
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope } },
  ], [1, 2]);
  check(
    modernFirst.stderr.split(CONNECTED).length === 2,
    "discover then a real request starts background work exactly once"
  );

  // 3. The full modern flow through the official client.
  const client = new Client(
    { name: "smoke-modern", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" } }
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: tmpdir(), stderr: "ignore" })
  );
  check(client.getNegotiatedProtocolVersion() === "2026-07-28", "client negotiates 2026-07-28 over stdio");

  const { tools } = await client.listTools();
  check(tools.length > 100, `full tool list over the modern protocol (${tools.length} tools)`);
  check(
    tools.find((t) => t.name === "get_bot_info")?.annotations?.readOnlyHint === true,
    "tool annotations survive"
  );

  const setup = await client.callTool({ name: "run_setup_check", arguments: {} });
  check(setup.isError === true, "setup check fails gracefully without a token");
  check((setup.content?.[0]?.text ?? "").includes("DISCORD_TOKEN"), "failure names DISCORD_TOKEN");

  // State across calls: a gated delete needs the token from the call before
  // it, so this proves one pinned server instance serves the connection.
  const parse = (res) => JSON.parse(res.content?.[0]?.text ?? "{}");
  const saved = await client.callTool({
    name: "save_blueprint",
    arguments: { name: "modern-blueprint", blueprint: { roles: [{ name: "Modern Role" }] } },
  });
  check(saved.isError !== true, "a blueprint saves over the modern protocol");
  const gate = parse(await client.callTool({ name: "delete_blueprint", arguments: { blueprint: "modern-blueprint" } }));
  const token = gate.data?.confirm_token ?? gate.confirm_token;
  check(typeof token === "string", "delete is gated with a confirm token");
  const deleted = parse(
    await client.callTool({ name: "delete_blueprint", arguments: { blueprint: "modern-blueprint", confirm_token: token } })
  );
  check((deleted.data?.deleted ?? deleted.deleted) === true, "the confirm token from the previous call is honored");
  check(gate.data?.confirmed_by === "token", "an app that cannot show a dialog confirms by token alone");

  await client.close();

  // 4. An app that can show a form: the call with the token comes back as
  // input_required, the client asks its user (here a scripted answer) and
  // calls again, and only a ticked box goes ahead.
  const answers = [];
  const asked = [];
  const dialogClient = new Client(
    { name: "smoke-modern-dialog", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" }, capabilities: { elicitation: { form: {} } } }
  );
  dialogClient.setRequestHandler("elicitation/create", async (request) => {
    asked.push(request.params);
    return answers.shift();
  });
  await dialogClient.connect(
    new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: tmpdir(), stderr: "ignore" })
  );
  check(dialogClient.getNegotiatedProtocolVersion() === "2026-07-28", "the dialog client negotiates 2026-07-28");
  const tryDelete = async (name, answer) => {
    await dialogClient.callTool({ name: "save_blueprint", arguments: { name, blueprint: { roles: [] } } });
    const preview = parse(await dialogClient.callTool({ name: "delete_blueprint", arguments: { blueprint: name } }));
    answers.push(answer);
    const before = asked.length;
    const result = parse(
      await dialogClient.callTool({
        name: "delete_blueprint",
        arguments: { blueprint: name, confirm_token: preview.data?.confirm_token },
      })
    );
    return { preview, result, dialogs: asked.length - before };
  };
  const yes = await tryDelete("dialog-yes", { action: "accept", content: { confirm: true } });
  check(yes.preview.data?.confirmed_by === "dialog", "the preview says the dialog confirms");
  check(yes.dialogs === 1 && asked.at(-1)?.message?.includes("dialog-yes"), "the token call shows one dialog naming the target");
  check(yes.result.data?.deleted === true, "a ticked box deletes");
  const no = await tryDelete("dialog-no", { action: "decline" });
  check(no.result.data?.deleted !== true && no.result.data?.confirmation === "declined", "a declined dialog deletes nothing");
  const kept = await dialogClient.callTool({ name: "get_blueprint", arguments: { blueprint: "dialog-no" } });
  check(kept.isError !== true, "the declined blueprint is still saved");
  await dialogClient.close();
} catch (err) {
  check(false, `modern stdio flow: ${err?.message ?? err}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke-modern: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-modern: all passed");
process.exit(0);
