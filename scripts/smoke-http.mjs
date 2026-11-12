// Streamable HTTP transport smoke test. No Discord token needed; this
// exercises both protocol eras over HTTP and every security gate.
//
// 2025-era traffic is sent as raw JSON-RPC, the way those clients send it.
// 2026-07-28 traffic goes through the official SDK client, so the test
// follows the real negotiation (server/discover, per-request envelope,
// standard headers) rather than a hand-built imitation of it.
//
// Run with: node scripts/smoke-http.mjs

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");

// A port nothing else holds right now. A fixed port fails, misleadingly,
// on any machine where some other program already listens on it.
const PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

function startServer(extraEnv = {}) {
  const env = { ...process.env, DISCORD_TOKEN: "", DISCORD_MCP_GUILD: "", ...extraEnv };
  return spawn(process.execPath, [entry, "--http", "--port", String(PORT)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function rpc(method, params, id) {
  return { jsonrpc: "2.0", id, method, params };
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  // 2025-era stateless serving answers as an SSE stream, which those
  // clients must accept (they send Accept: application/json,
  // text/event-stream). The JSON-RPC reply is the last data frame.
  const raw = await res.text();
  let json;
  try {
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const frames = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      json = frames.length > 0 ? JSON.parse(frames[frames.length - 1]) : undefined;
    } else {
      json = raw.length > 0 ? JSON.parse(raw) : undefined;
    }
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, contentType: res.headers.get("content-type") };
}

// Part 1: open loopback mode, both eras, and the gates.
{
  const child = startServer();
  check(await waitForHealth(), "http server comes up");

  const health = await (await fetch(`${BASE}/healthz`)).json();
  check(health.name === "discord-mcp" && typeof health.version === "string", "healthz reports identity");

  const evil = await post(
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evil", version: "0" } }, 3),
    { Origin: "https://evil.example" }
  );
  check(evil.status === 403, "browser origin is rejected");

  // fetch silently drops a custom Host header (undici treats it as
  // forbidden), so the rebinding probe needs a raw http request to
  // actually send a hostile Host.
  const rebindStatus = await new Promise((resolve, reject) => {
    const body = JSON.stringify(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } }, 4)
    );
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          Host: "attacker.example",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
  check(rebindStatus === 403, "non-loopback Host header is rejected in open mode");

  // A request the server cannot even parse must be answered, not crash it.
  // One with a malformed Host header used to end the process, for anyone
  // who could reach the port and before any token check.
  const rawStatus = (headers, body = "{}") =>
    new Promise((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", (err) => resolve(`error ${err.code}`));
      req.end(body);
    });
  check((await rawStatus({ Host: "not a host" })) === 400, "a malformed Host header is answered with 400");
  check((await rawStatus({ Host: "x:99999999" })) === 400, "a Host header with an impossible port is answered with 400");
  check((await fetch(`${BASE}/healthz`)).ok, "and the server is still running afterwards");
  check((await rawStatus({ Host: `127.0.0.1:${PORT}` }, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }))) === 413, "an oversized body is answered with 413");
  check((await fetch(`${BASE}/healthz`)).ok, "and the server is still running after that too");

  // 2025 era, the sequence those clients send: initialize, the initialized
  // notification, then requests. Serving is stateless, so no session id
  // comes back and later requests carry none.
  const legacyHeaders = { "MCP-Protocol-Version": "2025-06-18" };
  const init = await post(
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-http", version: "0.0.1" } }, 5)
  );
  check(init.status === 200, "2025 era: initialize succeeds");
  check(init.json?.result?.serverInfo?.name === "discord-mcp", "2025 era: server identifies as discord-mcp over http");
  check(init.json?.result?.instructions?.startsWith("Discord server management through a bot account."), "2025 era: its instructions come over http too");
  check(init.json?.result?.protocolVersion === "2025-06-18", "2025 era: the client's version is accepted");
  check(!init.headers.get("mcp-session-id"), "2025 era: no session id is issued (stateless)");

  const initialized = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...legacyHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  check(initialized.status === 202, "2025 era: initialized notification is accepted");

  const tools = await post(rpc("tools/list", {}, 6), legacyHeaders);
  const names = (tools.json?.result?.tools ?? []).map((t) => t.name);
  check(names.includes("get_bot_info"), "2025 era: tools list includes get_bot_info");
  check(names.includes("execute_build_plan"), "2025 era: tools list includes execute_build_plan");

  const call = await post(rpc("tools/call", { name: "run_setup_check", arguments: {} }, 7), legacyHeaders);
  const text = call.json?.result?.content?.[0]?.text ?? "";
  check(call.json?.result?.isError === true, "2025 era: setup check fails gracefully without a token");
  check(text.includes("DISCORD_TOKEN"), "2025 era: failure names DISCORD_TOKEN over http");

  // A stateless 2025-era request carries no record of what the app declared
  // at initialize, so the server cannot ask for a dialog and keeps to the
  // token flow, which works across requests.
  const legacyEnvelope = (r) => JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
  await post(rpc("tools/call", { name: "save_blueprint", arguments: { name: "http-legacy", blueprint: { roles: [] } } }, 8), legacyHeaders);
  const legacyGate = legacyEnvelope(
    await post(rpc("tools/call", { name: "delete_blueprint", arguments: { blueprint: "http-legacy" } }, 9), legacyHeaders)
  );
  check(legacyGate.data?.confirmed_by === "token", "2025 era: a stateless request confirms by token");
  const legacyDone = legacyEnvelope(
    await post(
      rpc("tools/call", { name: "delete_blueprint", arguments: { blueprint: "http-legacy", confirm_token: legacyGate.data?.confirm_token } }, 10),
      legacyHeaders
    )
  );
  check(legacyDone.data?.deleted === true, "2025 era: the token from an earlier request deletes");

  const getStream = await fetch(`${BASE}/mcp`, { headers: { Accept: "text/event-stream" } });
  check(getStream.status === 405, "2025 era: GET stream is 405 (no sessions to stream to)");
  const del = await fetch(`${BASE}/mcp`, { method: "DELETE" });
  check(del.status === 405, "2025 era: session DELETE is 405 (no sessions to end)");

  // 2026-07-28 era through the official client: probe, then enveloped calls.
  const client = new Client(
    { name: "smoke-http-2026", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" } }
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    check(client.getNegotiatedProtocolVersion() === "2026-07-28", "2026 era: negotiates 2026-07-28 over http");
    const modernTools = await client.listTools();
    const modernNames = modernTools.tools.map((t) => t.name);
    check(modernNames.length === names.length, "2026 era: same tool list as the 2025 era");
    const getBot = modernTools.tools.find((t) => t.name === "get_bot_info");
    check(getBot?.annotations?.readOnlyHint === true, "2026 era: tool annotations survive");
    const modernCall = await client.callTool({ name: "run_setup_check", arguments: {} });
    check(modernCall.isError === true, "2026 era: setup check fails gracefully without a token");
    check(
      (modernCall.content?.[0]?.text ?? "").includes("DISCORD_TOKEN"),
      "2026 era: failure names DISCORD_TOKEN"
    );
  } catch (err) {
    check(false, `2026 era over http: ${err?.message ?? err}`);
  } finally {
    await client.close().catch(() => {});
  }

  // A 2026-07-28 app that can show a form gets the dialog over stateless
  // HTTP too: each request declares what the app supports, and the dialog's
  // answer comes back on a fresh request.
  const dialogClient = new Client(
    { name: "smoke-http-dialog", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" }, capabilities: { elicitation: { form: {} } } }
  );
  const shown = [];
  dialogClient.setRequestHandler("elicitation/create", async (request) => {
    shown.push(request.params.message);
    return { action: "accept", content: { confirm: true } };
  });
  try {
    await dialogClient.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const parse = (r) => JSON.parse(r.content?.[0]?.text ?? "{}");
    await dialogClient.callTool({ name: "save_blueprint", arguments: { name: "http-dialog", blueprint: { roles: [] } } });
    const gate = parse(await dialogClient.callTool({ name: "delete_blueprint", arguments: { blueprint: "http-dialog" } }));
    check(gate.data?.confirmed_by === "dialog", "2026 era: an app that can show a form confirms in a dialog over http");
    const done = parse(
      await dialogClient.callTool({
        name: "delete_blueprint",
        arguments: { blueprint: "http-dialog", confirm_token: gate.data?.confirm_token },
      })
    );
    check(shown.length === 1 && shown[0].includes("http-dialog"), "2026 era: the dialog is shown once and names the target");
    check(done.data?.deleted === true, "2026 era: a ticked box deletes over http");
  } catch (err) {
    check(false, `2026 era dialog over http: ${err?.message ?? err}`);
  } finally {
    await dialogClient.close().catch(() => {});
  }

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// Part 2: bearer auth mode.
{
  const child = startServer({ DISCORD_MCP_HTTP_TOKEN: "smoke-secret-token" });
  check(await waitForHealth(), "auth-mode server comes up");

  const initBody = rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-http", version: "0.0.1" } },
    1
  );

  const noAuth = await post(initBody);
  check(noAuth.status === 401, "missing bearer is 401");

  const wrongAuth = await post(initBody, { Authorization: "Bearer wrong" });
  check(wrongAuth.status === 401, "wrong bearer is 401");

  const goodAuth = await post(initBody, { Authorization: "Bearer smoke-secret-token" });
  check(goodAuth.status === 200, "correct bearer initializes");

  const lowerAuth = await post(initBody, { Authorization: "bearer smoke-secret-token" });
  check(lowerAuth.status === 200, "the scheme name is accepted in any case");

  const health = await fetch(`${BASE}/healthz`);
  check(health.ok, "healthz stays public in auth mode");

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// Part 3: refusing to expose the bot without auth.
{
  const child = spawn(
    process.execPath,
    [entry, "--http", "--port", String(PORT), "--host", "0.0.0.0"],
    { cwd: root, env: { ...process.env, DISCORD_TOKEN: "", DISCORD_MCP_HTTP_TOKEN: "" }, stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 30000);
  });
  check(code === 1, "public bind without a token refuses to start");
  check(stderr.includes("DISCORD_MCP_HTTP_TOKEN"), "refusal message names the fix");
}

if (failures > 0) {
  console.error(`\nsmoke-http: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-http: all passed");
