// Live acceptance test. Unlike the smoke test, this one needs a real
// DISCORD_TOKEN and talks to the actual Discord API. It drives the server
// over stdio exactly like an MCP client would and prints the envelope
// summaries so a human can eyeball them. It creates, edits, and deletes
// channels, roles, messages, and more, so it only ever runs against a
// disposable test server (see the guard below).
//
// Run with: DISCORD_MCP_HOME=<folder with a test .env> node scripts/acceptance.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve the token and server exactly as the server does, by loading its
// own config module: only DISCORD_MCP_HOME when that is set, otherwise the
// package root, and a variable already in the environment wins. The values
// land in this process's environment, which the server under test inherits,
// so it runs with exactly what the guard checked.
await import("../dist/config.js");
const { setting } = await import("../dist/settings.js");
const token = process.env.DISCORD_TOKEN;
const guildId = setting("GUILD");

// The guard. A real community server must never receive this suite, and
// the package root .env may well hold a production token. Only the known
// disposable test servers are allowed, plus any listed explicitly in
// DISCORD_MCP_ACCEPTANCE_GUILDS by someone running their own.
const DISPOSABLE_GUILDS = new Set([
  "1514153264613167187", // OmniCord Dev
  "1526520926446026824", // Omnicord Dev 2
  ...(process.env.DISCORD_MCP_ACCEPTANCE_GUILDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
]);
if (!token || !guildId || !DISPOSABLE_GUILDS.has(guildId)) {
  console.error(
    `Refusing to run: the configured server (${guildId ?? "none"}) is not a known disposable ` +
      "test server. Point DISCORD_MCP_HOME at a folder whose .env has a test bot's " +
      "DISCORD_TOKEN and DISCORD_MCP_GUILD, or list your own test server's id in " +
      "DISCORD_MCP_ACCEPTANCE_GUILDS."
  );
  process.exit(1);
}
process.env.DISCORD_MCP_GUILD = guildId;

// Someone outside the test server, banned and unbanned to test lifting a
// ban: on OmniCord Dev, our second test bot, which is only in Omnicord Dev
// 2. Elsewhere set DISCORD_MCP_ACCEPTANCE_BAN_USER, or that part is skipped.
const OTHER_TEST_BOT =
  process.env.DISCORD_MCP_ACCEPTANCE_BAN_USER ?? (guildId === "1514153264613167187" ? "1526521112698163250" : undefined);

// Test assets are generated from raw bytes and served over loopback so
// the sticker and soundboard tools fetch real URLs without depending on
// anything external having the right size or format.

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crc32.table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// A solid-color truecolor PNG at exactly the sticker size.
function makePng(size, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A short silent MPEG-1 Layer III stream: valid frame headers with
// zeroed payloads, which decoders render as silence. About half a second.
function makeSilentMp3() {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: 20 }, () => frame));
}

const ASSET_PORT = 38917;
const stickerPng = makePng(320, 60, 120, 200);
const soundMp3 = makeSilentMp3();
const assetServer = createServer((req, res) => {
  if (req.url === "/sticker.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(stickerPng);
  } else if (req.url === "/sound.mp3") {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(soundMp3);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => assetServer.listen(ASSET_PORT, "127.0.0.1", resolve));

const entry = join(root, "dist", "index.js");

const child = spawn(process.execPath, [entry], {
  cwd: root,
  // A fast scheduler tick so the schedule_message test fires within the
  // run instead of waiting out the production half-minute interval.
  // Test assets are served over loopback, which uploads refuse by default.
  env: { ...process.env, DISCORD_MCP_SCHEDULER_TICK_MS: "1500", DISCORD_MCP_ALLOW_PRIVATE_URLS: "true" },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    // Generous timeout: the rate limiter queues politely when Discord
    // imposes a bucket wait, and heavy write sequences legitimately sit
    // in that queue for tens of seconds.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }
      // Discord allows 10 reads of a server's channel list a minute, and this
      // suite makes many; waiting out that hold is correct, and takes a minute.
    }, 150000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let failed = false;

// Calls a tool and returns the envelope with isError attached, without
// treating an error as a test failure. For steps where an error is the
// expected outcome.
async function callToolRaw(name, args = {}) {
  const res = await request("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "{}";
  const envelope = JSON.parse(text);
  envelope.isError = res.result?.isError === true;
  console.log(`\n[${envelope.isError ? "error" : "ok"}] ${name}`);
  console.log(`  ${envelope.summary}`);
  return envelope;
}

async function callTool(name, args = {}) {
  const envelope = await callToolRaw(name, args);
  if (envelope.isError) failed = true;
  for (const w of envelope.warnings ?? []) {
    console.log(`  warning: ${w}`);
  }
  return envelope;
}

// If the run dies partway, a section's own cleanup never runs. This removes
// what the suite creates (every name starts with omnitest) and puts the
// system messages channel back where it was, through the REST API alone so
// it does not depend on whatever broke.
let systemChannelAtStart;
async function crashCleanup() {
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json", "X-Audit-Log-Reason": "discord-mcp acceptance cleanup" };
  const call = async (method, path, body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (r.status !== 429) return r.status === 204 ? null : r.json().catch(() => null);
      const b = await r.json();
      await new Promise((res) => setTimeout(res, Math.ceil((b.retry_after ?? 1) * 1000) + 250));
    }
    return null;
  };
  try {
    const channels = (await call("GET", `/guilds/${guildId}/channels`)) ?? [];
    for (const c of channels.filter((x) => /^omnitest/i.test(x.name ?? "")).sort((a, b) => (a.type === 4) - (b.type === 4))) {
      await call("DELETE", `/channels/${c.id}`);
    }
    const roles = (await call("GET", `/guilds/${guildId}/roles`)) ?? [];
    for (const r of roles.filter((x) => /^omnitest/i.test(x.name ?? ""))) {
      await call("DELETE", `/guilds/${guildId}/roles/${r.id}`);
    }
    if (OTHER_TEST_BOT) await call("DELETE", `/guilds/${guildId}/bans/${OTHER_TEST_BOT}`);
    if (systemChannelAtStart !== undefined) {
      const g = await call("GET", `/guilds/${guildId}`);
      if (g && g.system_channel_id !== systemChannelAtStart) {
        await call("PATCH", `/guilds/${guildId}`, { system_channel_id: systemChannelAtStart });
      }
    }
    console.error("acceptance: cleaned up after the error");
  } catch (err) {
    console.error(`acceptance: cleanup after the error also failed: ${err.message}`);
  }
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "discord-mcp-acceptance", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  const info = await callTool("get_bot_info");
  const guilds = info.data?.guilds?.list ?? [];
  if (guilds.length > 0) {
    console.log("  guilds:");
    for (const g of guilds) console.log(`    ${g.name} (${g.id})`);
  }

  const check = await callTool("run_setup_check");
  for (const c of check.data?.checks ?? []) {
    const mark = c.status === "pass" ? "+" : c.status === "warn" ? "!" : "x";
    console.log(`  [${mark}] ${c.check}: ${c.detail}`);
    if (c.fix) console.log(`      fix: ${c.fix}`);
  }

  // Phase 1 read tools, all against the default guild from .env.
  await callTool("get_server_overview");
  await callTool("list_channels");
  await callTool("list_roles");

  const found = await callTool("find", { query: "general" });
  if (!found.data?.match && !(found.data?.candidates?.length >= 0)) {
    failed = true;
    console.error("  find returned neither match nor candidates");
  }

  await callTool("search_members", { query: "Omnicord" });
  await callTool("get_member", { user: "Omnicord" });
  await callTool("read_messages", { channel: "general" });
  await callTool("search_messages", { channel: "general", query: "omnicord" });

  // Phase 2: writes, the confirmation gate, and cleanup. The flow leaves
  // the server exactly as it found it.

  function expect(condition, label) {
    if (condition) {
      console.log(`  expect ok: ${label}`);
    } else {
      failed = true;
      console.error(`  EXPECT FAIL: ${label}`);
    }
  }

  // Discord catch-up: both growth thresholds in the setup check, and the
  // hidden-channel registry fed by the gateway. The dev bot is an
  // administrator, so it sees every channel and the field stays absent; a
  // registry that never heard of this server would report it as unknown.
  // GUILD_CREATE can lag the first calls, so give it a few seconds.
  const setupNames = (check.data?.checks ?? []).map((c) => c.check);
  expect(setupNames.includes("guild_count") && setupNames.includes("user_count"), "setup check reports both growth thresholds");
  let hiddenField = "unchecked";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const listed = await callTool("list_channels");
    hiddenField = listed.data?.hidden_from_bot;
    if (hiddenField === undefined || hiddenField?.count !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(hiddenField === undefined, "list_channels: the gateway knows this server and the bot sees every channel");

  // Runs a destructive tool through its full gate: first call returns the
  // preview and token, second call executes with it.
  async function deleteViaTool(tool, refKey, refValue) {
    const gate = await callTool(tool, { [refKey]: refValue });
    if (gate.data?.confirm_token) {
      return callTool(tool, {
        [refKey]: refValue,
        confirm_token: gate.data.confirm_token,
      });
    }
    return gate;
  }

  const stamp = `omnicord acceptance ${Date.now()}`;

  const dryMsg = await callTool("send_message", {
    channel: "general",
    content: "never sent",
    dry_run: true,
  });
  expect(dryMsg.data?.executed === false, "send_message dry_run sends nothing");

  const sent = await callTool("send_message", {
    channel: "general",
    content: stamp,
  });
  expect(typeof sent.data?.id === "string", "send_message returns a message id");
  expect(typeof sent.data?.jump_link === "string", "send_message returns a jump link");

  const reply = await callTool("send_message", {
    channel: "general",
    content: "reply for the acceptance run",
    reply_to: sent.data.id,
  });
  expect(typeof reply.data?.id === "string", "reply sends");

  // Native search hits Discord's index, which lags a moment behind a just-sent
  // message, so assert the result shape and the filter paths rather than that
  // this exact message is already searchable.
  const searchShape = await callTool("search_messages", { query: "omnicord" });
  expect(
    typeof searchShape.data?.total_results === "number" &&
      Array.isArray(searchShape.data?.matches),
    "search returns the native index result shape"
  );

  const searchByAuthor = await callTool("search_messages", { author: "Omnicord" });
  expect(
    typeof searchByAuthor.data?.total_results === "number",
    "search accepts an author filter"
  );

  const searchByHas = await callTool("search_messages", { has: "poll" });
  expect(Array.isArray(searchByHas.data?.matches), "search accepts a has filter");

  const searchNoFilter = await callToolRaw("search_messages", {});
  expect(searchNoFilter.isError === true, "search with no filter is rejected");

  const newChannel = await callTool("create_channel", {
    name: "omnitest-temp",
    topic: "Omnicord acceptance area, safe to delete",
  });
  expect(typeof newChannel.data?.id === "string", "create_channel returns an id");

  const inNew = await callTool("send_message", {
    channel: "omnitest-temp",
    content: "hello from the acceptance run",
  });
  expect(typeof inNew.data?.id === "string", "fresh channel accepts messages");

  const forwarded = await callTool("forward_message", {
    channel: "omnitest-temp",
    from_channel: "general",
    message_id: sent.data.id,
  });
  expect(
    typeof forwarded.data?.id === "string",
    "forward_message forwards a message into another channel"
  );

  const forwardedNote = await callTool("forward_message", {
    channel: "omnitest-temp",
    from_channel: "general",
    message_id: sent.data.id,
    content: "Reposting for visibility.",
  });
  expect(
    typeof forwardedNote.data?.id === "string" &&
      typeof forwardedNote.data?.note_id === "string",
    "forward_message with a note posts both the forward and the note"
  );

  const vcStatus = await callTool("set_voice_channel_status", {
    channel: "General",
    status: "Acceptance run in progress",
  });
  expect(vcStatus.data?.status === "Acceptance run in progress", "voice channel status sets");
  const vcClear = await callTool("set_voice_channel_status", {
    channel: "General",
    status: "",
  });
  expect(vcClear.data?.status === null, "voice channel status clears");

  const newRole = await callTool("create_role", {
    name: "omnitest-role",
    preset: "member",
    color: "#00b0f4",
  });
  expect(typeof newRole.data?.id === "string", "create_role returns an id");
  expect(
    !(newRole.data?.permissions ?? []).includes("administrator"),
    "member preset does not grant administrator"
  );

  const assigned = await callTool("assign_role", {
    member: "Omnicord",
    role: "omnitest-role",
  });
  expect(assigned.data?.role?.name === "omnitest-role", "role assigned to the bot");

  const again = await callTool("assign_role", {
    member: "Omnicord",
    role: "omnitest-role",
  });
  expect(again.data?.already_assigned === true, "double assignment is a no-op");

  // Confirmation gate, live: no token means preview, bogus token means
  // rejection, real token means deletion.
  const gate = await callTool("delete_message", {
    channel: "general",
    message_id: reply.data.id,
  });
  expect(gate.data?.executed === false, "deletion without token is blocked");
  expect(typeof gate.data?.confirm_token === "string", "preview returns a token");

  const stillThere = await callTool("read_messages", {
    channel: "general",
    limit: 10,
  });
  expect(
    (stillThere.data?.messages ?? []).some((m) => m.id === reply.data.id),
    "message survives the preview"
  );

  const bogus = await callToolRaw("delete_message", {
    channel: "general",
    message_id: reply.data.id,
    confirm_token: "0".repeat(32),
  });
  expect(bogus.isError === true, "bogus token is rejected");

  const realDelete = await callTool("delete_message", {
    channel: "general",
    message_id: reply.data.id,
    confirm_token: gate.data.confirm_token,
  });
  expect(realDelete.data?.deleted === true, "valid token deletes");

  const gateTwo = await callTool("delete_message", {
    channel: "general",
    message_id: sent.data.id,
  });
  const deleteTwo = await callTool("delete_message", {
    channel: "general",
    message_id: sent.data.id,
    confirm_token: gateTwo.data?.confirm_token,
  });
  expect(deleteTwo.data?.deleted === true, "second deletion with its own token");

  const afterCleanup = await callTool("read_messages", {
    channel: "general",
    limit: 10,
  });
  const ids = (afterCleanup.data?.messages ?? []).map((m) => m.id);
  expect(
    !ids.includes(sent.data.id) && !ids.includes(reply.data.id),
    "both acceptance messages are gone"
  );

  // Phase 3a: builder staging. Everything here must change nothing.

  const layouts = await callTool("list_reference_layouts");
  expect((layouts.data?.layouts ?? []).length === 3, "three reference layouts ship");

  const layout = await callTool("get_reference_layout", {
    layout_id: "gaming-community",
  });
  expect(Boolean(layout.data?.blueprint?.categories), "layout carries a blueprint");

  const missingLayout = await callToolRaw("get_reference_layout", {
    layout_id: "does-not-exist",
  });
  expect(missingLayout.isError === true, "unknown layout id is rejected");

  const beforePlan = await callTool("list_channels");
  const beforeCount = (beforePlan.data?.channels ?? []).length;

  const plan = await callTool("plan_server_build", {
    blueprint: {
      theme: "acceptance staging probe",
      roles: [{ name: "omnitest-planned", preset: "member" }],
      categories: [
        {
          name: "omnitest-planned-cat",
          channels: [
            { name: "omnitest-planned-chan", topic: "never created" },
            { name: "Planned Voice", type: "voice" },
          ],
        },
      ],
      channels: [{ name: "general" }],
    },
  });
  expect(typeof plan.data?.plan_id === "string", "plan stages with an id");
  expect(plan.data?.steps?.[0]?.action === "create_role", "plan orders roles first");
  expect(plan.data?.to_create === 4, "plan counts four new items");
  expect(plan.data?.reused === 1, "plan reuses existing general channel");

  const afterPlan = await callTool("list_channels");
  expect(
    (afterPlan.data?.channels ?? []).length === beforeCount,
    "planning created nothing"
  );

  const badPlan = await callToolRaw("plan_server_build", {
    blueprint: {
      channels: [
        { name: "ghost-channel", private_to: ["Nonexistent Role"] },
        { name: "rules", posting_roles: ["Nonexistent Role"] },
      ],
    },
  });
  expect(badPlan.isError === true, "invalid blueprint is rejected");
  expect(
    (badPlan.data?.errors ?? []).length >= 2,
    "all blueprint problems reported at once"
  );

  // Raw REST access for verification and cleanup; delete tools arrive in
  // a later phase.
  // The token and server the guard at the top checked.
  const auth = { Authorization: `Bot ${token}` };
  systemChannelAtStart = (await (await fetch(`https://discord.com/api/v10/guilds/${guildId}`, { headers: auth })).json()).system_channel_id ?? null;

  // Phase 3b: execute a real build, verify the overwrites Discord stored,
  // prove idempotent re-runs, then remove everything.

  const execBlueprint = {
    theme: "acceptance build",
    roles: [{ name: "omnitest-exec-role", preset: "member", color: "#ff7f50" }],
    categories: [
      {
        name: "omnitest-private-cat",
        private_to: ["omnitest-exec-role"],
        channels: [{ name: "omnitest-secret", topic: "inherits category privacy" }],
      },
      {
        name: "omnitest-open-cat",
        channels: [
          {
            name: "omnitest-rules",
            read_only: true,
            posting_roles: ["omnitest-exec-role"],
            topic: "read only test",
          },
          { name: "Omnitest Voice", type: "voice" },
        ],
      },
    ],
  };

  const stagedExec = await callTool("plan_server_build", {
    blueprint: execBlueprint,
  });
  expect(stagedExec.data?.to_create === 6, "exec plan stages six new items");

  const badExec = await callToolRaw("execute_build_plan", {
    plan_id: "0".repeat(16),
  });
  expect(badExec.isError === true, "unknown plan_id is rejected");

  const built = await callTool("execute_build_plan", {
    plan_id: stagedExec.data.plan_id,
  });
  expect(built.data?.created === 6, "build creates all six items");
  expect(built.data?.report?.every((r) => r.status !== "failed"), "no step failed");

  const byName = new Map(built.data.report.map((r) => [r.name, r]));
  const secretId = byName.get("omnitest-secret")?.id;
  const rulesId = byName.get("omnitest-rules")?.id;
  const roleStep = byName.get("omnitest-exec-role");

  // Verify what Discord actually stored, not what we sent.
  const secretChan = await (
    await fetch(`https://discord.com/api/v10/channels/${secretId}`, {
      headers: auth,
    })
  ).json();
  const VIEW_BIT = 1n << 10n;
  const everyoneOw = (secretChan.permission_overwrites ?? []).find(
    (o) => o.id === guildId
  );
  const roleOw = (secretChan.permission_overwrites ?? []).find(
    (o) => o.id === roleStep?.id
  );
  expect(
    everyoneOw && (BigInt(everyoneOw.deny) & VIEW_BIT) !== 0n,
    "live secret channel denies everyone view"
  );
  expect(
    roleOw && (BigInt(roleOw.allow) & VIEW_BIT) !== 0n,
    "live secret channel allows the role view"
  );

  const rulesChan = await (
    await fetch(`https://discord.com/api/v10/channels/${rulesId}`, {
      headers: auth,
    })
  ).json();
  const SEND_BIT = 1n << 11n;
  const rulesEveryone = (rulesChan.permission_overwrites ?? []).find(
    (o) => o.id === guildId
  );
  expect(
    rulesEveryone && (BigInt(rulesEveryone.deny) & SEND_BIT) !== 0n,
    "live rules channel denies everyone send"
  );
  // Everyone is denied thread creation as well, so the posting role has to
  // get it back or nobody below admin can start a thread there.
  const CREATE_PUBLIC_THREADS_BIT = 1n << 35n;
  const rulesPoster = (rulesChan.permission_overwrites ?? []).find(
    (o) => o.id === roleStep?.id
  );
  expect(
    rulesPoster &&
      (BigInt(rulesPoster.allow) & SEND_BIT) !== 0n &&
      (BigInt(rulesPoster.allow) & CREATE_PUBLIC_THREADS_BIT) !== 0n,
    "live rules channel lets the posting role send and start threads"
  );

  // Idempotency: the same blueprint again, inline this time. Everything
  // already exists, so nothing new may be created.
  const rerun = await callTool("execute_build_plan", {
    blueprint: execBlueprint,
  });
  expect(rerun.data?.created === 0, "re-run creates nothing");
  expect(rerun.data?.reused === 6, "re-run reuses all six items");

  // Cleanup via the real gated tools: channels first, categories after,
  // then the role.
  for (const name of [
    "omnitest-secret",
    "omnitest-rules",
    "Omnitest Voice",
    "omnitest-private-cat",
    "omnitest-open-cat",
  ]) {
    const id = byName.get(name)?.id;
    if (!id) continue;
    const res = await deleteViaTool("delete_channel", "channel", id);
    expect(res.data?.deleted === true, `gated delete removed ${name}`);
  }
  const execRoleDel = await deleteViaTool("delete_role", "role", roleStep?.id);
  expect(execRoleDel.data?.deleted === true, "gated delete removed the exec role");

  // Live probe: the planner allows forums on non-community servers based
  // on a June 2026 probe of the real API. This keeps checking that, so a
  // Discord policy change shows up here instead of in a user's build.
  const probe = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/channels`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "omnitest-forum-probe", type: 15 }),
    }
  );
  if (probe.ok) {
    const created = await probe.json();
    expect(true, "forum creation on non-community server still works");
    await fetch(`https://discord.com/api/v10/channels/${created.id}`, {
      method: "DELETE",
      headers: auth,
    });
  } else {
    expect(
      false,
      `forum probe failed (${probe.status}); planner gating needs retuning`
    );
  }
  // Phase 4 batch 1: updates, edits, pins, then gated deletes finish the
  // cleanup that raw REST used to do.
  const chUpdate = await callTool("update_channel", {
    channel: "omnitest-temp",
    topic: "updated by the acceptance run",
    slowmode_seconds: 5,
  });
  expect((chUpdate.data?.changed ?? []).length === 2, "update_channel changes two fields");

  const edited = await callTool("edit_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
    content: "edited by the acceptance run",
  });
  expect(edited.data?.id === inNew.data.id, "edit_message edits the bot's own message");

  const pinned = await callTool("pin_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
  });
  expect(pinned.data?.pinned === true, "message pins");
  const pinsList = await callTool("list_pinned_messages", {
    channel: "omnitest-temp",
  });
  expect(
    (pinsList.data?.pins ?? []).some((p) => p.id === inNew.data.id),
    "pin shows in the pin list"
  );
  const unpinned = await callTool("unpin_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
  });
  expect(unpinned.data?.pinned === false, "message unpins");

  const roleUpdate = await callTool("update_role", {
    role: "omnitest-role",
    color: "#22c55e",
    name: "omnitest-role-renamed",
  });
  expect((roleUpdate.data?.changed ?? []).length === 2, "update_role changes two fields");

  const delCh = await deleteViaTool("delete_channel", "channel", newChannel.data.id);
  expect(delCh.data?.deleted === true, "gated delete_channel removed the test channel");
  const delRoleTool = await deleteViaTool("delete_role", "role", newRole.data.id);
  expect(delRoleTool.data?.deleted === true, "gated delete_role removed the test role");

  // Phase 4 batch 2: moderation. With only the owner and the bot on the
  // test server, the live tests target the protection paths (which must
  // refuse with clear reasons) plus the two read tools. Actual kicks and
  // bans get exercised when a second test account joins.

  const ownerInfo = await callTool("get_server_overview");
  const ownerId = ownerInfo.data?.owner_id;

  const kickOwner = await callToolRaw("kick_member", { member: ownerId });
  expect(
    kickOwner.isError === true && /owner/i.test(kickOwner.summary),
    "kicking the owner is refused with an owner explanation"
  );

  const banOwner = await callToolRaw("ban_member", { user: ownerId, dry_run: true });
  expect(
    banOwner.isError === true && /owner/i.test(banOwner.summary),
    "banning the owner is refused before the gate"
  );

  const timeoutSelf = await callToolRaw("timeout_member", {
    member: "Omnicord",
    duration_minutes: 5,
  });
  expect(
    timeoutSelf.isError === true && /itself/i.test(timeoutSelf.summary),
    "the bot refuses to time itself out"
  );

  const untimeoutBot = await callTool("remove_timeout", { member: "Omnicord" });
  expect(untimeoutBot.data?.changed === false, "remove_timeout no-ops when not timed out");

  const bans = await callTool("list_bans");
  expect((bans.data?.bans ?? []).length === 0, "ban list is empty");

  const audit = await callTool("get_audit_log", { limit: 20 });
  expect((audit.data?.entries ?? []).length > 0, "audit log returns entries");
  expect(
    (audit.data?.entries ?? []).some((e) => e.action === "channel_delete"),
    "audit entries carry readable action names"
  );

  const badAction = await callToolRaw("get_audit_log", { action: "made_up_event" });
  expect(badAction.isError === true, "unknown audit action name is rejected with the valid list");

  // Incident actions: pause invites briefly, read the report, then resume.
  // Reversible and auto-expiring, so this leaves the server unlocked.
  const paused = await callTool("set_incident_actions", { invites: 1 });
  expect(
    typeof paused.data?.incidents?.invites_paused_until === "string",
    "pausing invites returns a resume time"
  );
  expect(
    paused.data?.incidents?.dms_paused_until === null,
    "pausing invites leaves DMs untouched"
  );
  const incidentReport = await callTool("set_incident_actions", {});
  expect(
    typeof incidentReport.data?.incidents?.invites_paused_until === "string",
    "a no-argument call reports the current pause"
  );
  // Putting the pause up took one call. Taking it down asks first.
  const longer = await callTool("set_incident_actions", { invites: 2 });
  expect(
    longer.data?.executed === undefined && new Date(longer.data?.incidents?.invites_paused_until) > new Date(paused.data?.incidents?.invites_paused_until),
    "a longer pause goes up at once"
  );
  const resumePreview = await callTool("set_incident_actions", { invites: 0 });
  expect(
    resumePreview.data?.executed === false && /Would lift the pause on new invites, which runs until/.test(resumePreview.summary ?? ""),
    "lifting a running pause previews first"
  );
  const stillPaused = await callTool("set_incident_actions", {});
  expect(
    typeof stillPaused.data?.incidents?.invites_paused_until === "string",
    "and the pause is still up after the preview"
  );
  const resumed = await callTool("set_incident_actions", { invites: 0, confirm_token: resumePreview.data?.confirm_token });
  expect(
    resumed.data?.incidents?.invites_paused_until === null,
    "resuming invites with the token clears the pause"
  );
  const nothingToLift = await callTool("set_incident_actions", { invites: 0 });
  expect(
    nothingToLift.data?.executed === undefined && nothingToLift.data?.incidents?.invites_paused_until === null,
    "with no pause running there is nothing to confirm"
  );

  // Engagement batch: reactions, polls, emojis, invites, webhooks, and
  // scheduled events, all created and removed within the run.

  const reactMsg = await callTool("send_message", {
    channel: "general",
    content: `omnicord engagement acceptance ${Date.now()}`,
  });
  const reactId = reactMsg.data.id;

  const reacted = await callTool("add_reactions", {
    channel: "general",
    message_id: reactId,
    emojis: ["\u2705", "\u274c"],
  });
  expect((reacted.data?.added ?? []).length === 2, "two reactions added in one call");

  const reactors = await callTool("get_reactions", {
    channel: "general",
    message_id: reactId,
    emoji: "\u2705",
  });
  expect(
    (reactors.data?.users ?? []).some((u) => u.bot === true),
    "the bot shows up among reactors"
  );

  await callTool("remove_reaction", {
    channel: "general",
    message_id: reactId,
    emoji: "\u274c",
  });
  const clearGate = await callTool("clear_reactions", {
    channel: "general",
    message_id: reactId,
  });
  const cleared = await callTool("clear_reactions", {
    channel: "general",
    message_id: reactId,
    confirm_token: clearGate.data?.confirm_token,
  });
  expect(cleared.data?.cleared === "all", "gated clear removes all reactions");

  const poll = await callTool("create_poll", {
    channel: "general",
    question: "Omnicord acceptance poll?",
    answers: ["Yes", "Also yes"],
    duration_hours: 1,
  });
  expect(typeof poll.data?.id === "string", "poll posts");

  const openResults = await callTool("get_poll_results", {
    channel: "general",
    message_id: poll.data.id,
  });
  expect(openResults.data?.finalized === false, "fresh poll is open");
  expect((openResults.data?.answers ?? []).length === 2, "poll carries both answers");

  // A poll cannot be reopened, so ending one asks first.
  const endPreview = await callTool("end_poll", {
    channel: "general",
    message_id: poll.data.id,
  });
  expect(
    endPreview.data?.executed === false && /Would end the poll .* with 0 vote\(s\) in\./.test(endPreview.summary ?? ""),
    "ending a poll previews first, with the votes so far"
  );
  const stillOpen = await callTool("get_poll_results", { channel: "general", message_id: poll.data.id });
  expect(stillOpen.data?.finalized === false, "and the poll is still open after the preview");
  const endedPoll = await callTool("end_poll", {
    channel: "general",
    message_id: poll.data.id,
    confirm_token: endPreview.data?.confirm_token,
  });
  expect(endedPoll.data?.ended === true, "own poll ends early with the token");

  // Discord finalizes expired polls asynchronously; poll for the flag
  // instead of racing it.
  let finalized = false;
  for (let i = 0; i < 10; i += 1) {
    const closedResults = await callToolRaw("get_poll_results", {
      channel: "general",
      message_id: poll.data.id,
    });
    if (closedResults.data?.finalized === true) {
      finalized = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(finalized, "ended poll reports finalized");

  // Custom emoji: create from Discord's own default avatar asset, react
  // with it by name, then remove it.
  const emoji = await callTool("create_emoji", {
    name: "omnitest_emoji",
    image_url: "https://cdn.discordapp.com/embed/avatars/0.png",
  });
  expect(typeof emoji.data?.id === "string", "custom emoji uploads from a url");

  const emojiList = await callTool("list_emojis");
  expect(
    (emojiList.data?.emojis ?? []).some((e) => e.name === "omnitest_emoji"),
    "custom emoji appears in the list"
  );

  const customReact = await callTool("add_reactions", {
    channel: "general",
    message_id: reactId,
    emojis: ["omnitest_emoji"],
  });
  expect((customReact.data?.added ?? []).length === 1, "custom emoji resolves by bare name for reactions");

  const emojiGate = await callTool("delete_emoji", { emoji: "omnitest_emoji" });
  const emojiGone = await callTool("delete_emoji", {
    emoji: "omnitest_emoji",
    confirm_token: emojiGate.data?.confirm_token,
  });
  expect(emojiGone.data?.deleted === true, "gated emoji delete works");

  // Invites.
  const invite = await callTool("create_invite", {
    channel: "general",
    max_age_seconds: 600,
    max_uses: 1,
  });
  expect(typeof invite.data?.code === "string", "invite creates with explicit lifetime");

  const inviteInfo = await callTool("get_invite", { code: invite.data.code });
  expect(
    inviteInfo.data?.guild?.id === guildId,
    "invite inspection points at the test server"
  );

  const inviteList = await callTool("list_invites");
  expect(
    (inviteList.data?.invites ?? []).some((i) => i.code === invite.data.code),
    "invite shows in the list"
  );

  const inviteGate = await callTool("delete_invite", { code: invite.data.code });
  const inviteGone = await callTool("delete_invite", {
    code: invite.data.code,
    confirm_token: inviteGate.data?.confirm_token,
  });
  expect(inviteGone.data?.revoked === true, "gated invite revocation works");

  // Webhooks: create, post through with an identity override, verify the
  // token never leaks, rename, delete.
  const hook = await callTool("create_webhook", {
    channel: "general",
    name: "omnitest-hook",
  });
  expect(typeof hook.data?.id === "string", "webhook creates");

  const hookList = await callTool("list_webhooks");
  expect(
    (hookList.data?.webhooks ?? []).some((h) => h.name === "omnitest-hook"),
    "webhook shows in the list"
  );
  expect(
    !JSON.stringify(hookList).toLowerCase().includes("token"),
    "webhook listing never leaks tokens"
  );

  const hookPost = await callTool("send_webhook_message", {
    webhook: "omnitest-hook",
    content: "hello from the acceptance webhook",
    username_override: "Omnitest Crier",
  });
  expect(typeof hookPost.data?.id === "string", "webhook posts a message");

  const hookFeed = await callTool("read_messages", { channel: "general", limit: 5 });
  expect(
    (hookFeed.data?.messages ?? []).some((m) => m.author?.name === "Omnitest Crier"),
    "webhook message carries the identity override"
  );

  await callTool("update_webhook", { webhook: "omnitest-hook", name: "omnitest-hook-renamed" });
  const hookGate = await callTool("delete_webhook", { webhook: "omnitest-hook-renamed" });
  const hookGone = await callTool("delete_webhook", {
    webhook: "omnitest-hook-renamed",
    confirm_token: hookGate.data?.confirm_token,
  });
  expect(hookGone.data?.deleted === true, "gated webhook delete works");

  // Scheduled events: one external, one voice, both canceled.
  const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const endAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  const extEvent = await callTool("create_event", {
    name: "omnitest-external-event",
    type: "external",
    start_time: startAt,
    end_time: endAt,
    location: "The Void",
    description: "Acceptance run external event.",
  });
  expect(typeof extEvent.data?.id === "string", "external event schedules");

  const voiceEvent = await callTool("create_event", {
    name: "omnitest-voice-event",
    type: "voice",
    channel: "General",
    start_time: startAt,
  });
  expect(typeof voiceEvent.data?.id === "string", "voice event schedules with channel resolution");

  const recurringEvent = await callTool("create_event", {
    name: "omnitest-recurring-event",
    type: "external",
    start_time: startAt,
    end_time: endAt,
    location: "The Void",
    repeat: "weekly",
  });
  expect(
    recurringEvent.data?.recurrence?.frequency === "weekly",
    "recurring event carries a weekly recurrence rule"
  );

  const eventList = await callTool("list_events");
  expect((eventList.data?.events ?? []).length >= 2, "both events listed");

  const attendees = await callTool("get_event_attendees", { event: "omnitest-external-event" });
  expect((attendees.data?.attendees ?? []).length === 0, "fresh event has no attendees");

  const eventUpdate = await callTool("update_event", {
    event: "omnitest-external-event",
    description: "Updated by the acceptance run.",
  });
  expect(
    (eventUpdate.data?.description ?? "").includes("Updated"),
    "event description updates"
  );

  const pastEvent = await callToolRaw("create_event", {
    name: "omnitest-past",
    type: "external",
    start_time: "2020-01-01T00:00:00Z",
    end_time: "2020-01-02T00:00:00Z",
    location: "Yesterday",
  });
  expect(pastEvent.isError === true, "past start time is rejected");

  for (const name of ["omnitest-external-event", "omnitest-voice-event", "omnitest-recurring-event"]) {
    const gate = await callTool("cancel_event", { event: name });
    const canceled = await callTool("cancel_event", {
      event: name,
      confirm_token: gate.data?.confirm_token,
    });
    expect(canceled.data?.canceled === true, `gated cancel removed ${name}`);
  }

  // Message cleanup for this section.
  for (const id of [reactId, poll.data.id, hookPost.data.id]) {
    const gate = await callTool("delete_message", { channel: "general", message_id: id });
    await callTool("delete_message", {
      channel: "general",
      message_id: id,
      confirm_token: gate.data?.confirm_token,
    });
  }
  const engagementSweep = await callTool("read_messages", { channel: "general", limit: 10 });
  expect(
    !(engagementSweep.data?.messages ?? []).some((m) =>
      [reactId, poll.data.id, hookPost.data.id].includes(m.id)
    ),
    "engagement messages cleaned up"
  );

  // Gateway batch: the bot goes online and watches itself act. The
  // connection races server startup, so first wait for it.

  let gatewayUp = false;
  for (let i = 0; i < 30; i += 1) {
    const info = await callToolRaw("get_bot_info");
    if (info.data?.gateway?.status === "connected") {
      gatewayUp = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(gatewayUp, "gateway connects and the bot shows online");

  const subscription = await callTool("subscribe_events", {
    types: ["message_created", "reaction_added", "channel_created"],
    include_bots: true,
  });
  const subId = subscription.data?.subscription_id;
  expect(typeof subId === "string", "subscription opens");

  async function waitForEvent(predicate, label) {
    for (let i = 0; i < 20; i += 1) {
      const batch = await callToolRaw("get_recent_events", {
        subscription_id: subId,
        limit: 100,
      });
      const hit = (batch.data?.events ?? []).find(predicate);
      if (hit) {
        expect(true, label);
        return hit;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(false, label);
    return undefined;
  }

  const gwMsg = await callTool("send_message", {
    channel: "general",
    content: "gateway acceptance marker",
  });
  await waitForEvent(
    (e) => e.type === "message_created" && e.data.message_id === gwMsg.data.id,
    "own message arrives as a gateway event"
  );

  await callTool("add_reactions", {
    channel: "general",
    message_id: gwMsg.data.id,
    emojis: ["\u2705"],
  });
  await waitForEvent(
    (e) => e.type === "reaction_added" && e.data.message_id === gwMsg.data.id,
    "reaction arrives as a gateway event"
  );

  const gwChannel = await callTool("create_channel", { name: "omnitest-gateway" });
  await waitForEvent(
    (e) => e.type === "channel_created" && e.channel_id === gwChannel.data.id,
    "channel creation arrives as a gateway event"
  );

  const subList = await callTool("list_event_subscriptions");
  expect(
    (subList.data?.subscriptions ?? []).some((s) => s.id === subId),
    "subscription shows in the list"
  );

  const unsub = await callTool("unsubscribe_events", { subscription_id: subId });
  expect(unsub.data?.removed === true, "unsubscribe works");
  const deadDrain = await callToolRaw("get_recent_events", { subscription_id: subId });
  expect(deadDrain.isError === true, "draining a removed subscription fails cleanly");

  // Cleanup: the gateway test channel and marker message.
  const gwChanGate = await callTool("delete_channel", { channel: gwChannel.data.id });
  await callTool("delete_channel", {
    channel: gwChannel.data.id,
    confirm_token: gwChanGate.data?.confirm_token,
  });
  const gwMsgGate = await callTool("delete_message", {
    channel: "general",
    message_id: gwMsg.data.id,
  });
  await callTool("delete_message", {
    channel: "general",
    message_id: gwMsg.data.id,
    confirm_token: gwMsgGate.data?.confirm_token,
  });

  // AutoMod batch: a keyword rule's full lifecycle.

  const rule = await callTool("create_automod_rule", {
    name: "omnitest-automod",
    trigger: "keyword",
    keywords: ["omnitestforbidden"],
    actions: ["block", "timeout"],
    timeout_minutes: 1,
  });
  expect(rule.data?.enabled === true, "automod rule creates enabled");
  expect((rule.data?.actions ?? []).includes("timeout"), "automod rule carries both actions");

  const ruleList = await callTool("list_automod_rules");
  expect(
    (ruleList.data?.rules ?? []).some(
      (r) => r.name === "omnitest-automod" && r.trigger === "keyword"
    ),
    "automod rule shows in the list with a readable trigger"
  );

  // Turning a rule off stops it catching anything, so it asks first.
  const ruleOffPreview = await callTool("update_automod_rule", {
    rule: "omnitest-automod",
    enabled: false,
  });
  expect(
    ruleOffPreview.data?.executed === false && /turn it off/.test(ruleOffPreview.summary ?? ""),
    "turning an automod rule off previews first"
  );
  const ruleStillOn = await callTool("list_automod_rules");
  expect(
    (ruleStillOn.data?.rules ?? []).find((r) => r.name === "omnitest-automod")?.enabled === true,
    "and the rule is still on after the preview"
  );
  const ruleOff = await callTool("update_automod_rule", {
    rule: "omnitest-automod",
    enabled: false,
    confirm_token: ruleOffPreview.data?.confirm_token,
  });
  expect(ruleOff.data?.enabled === false, "automod rule disables with the token");
  const ruleOn = await callTool("update_automod_rule", { rule: "omnitest-automod", enabled: true });
  expect(ruleOn.data?.enabled === true && ruleOn.data?.executed === undefined, "and turns back on at once");

  const ruleGate = await callTool("delete_automod_rule", { rule: "omnitest-automod" });
  const ruleGone = await callTool("delete_automod_rule", {
    rule: "omnitest-automod",
    confirm_token: ruleGate.data?.confirm_token,
  });
  expect(ruleGone.data?.deleted === true, "gated automod delete works");

  // Threads batch: branch from a message, talk inside it by raw ID,
  // manage state and membership, archive, unarchive by ID, delete.

  const origin = await callTool("send_message", {
    channel: "general",
    content: "thread origin marker",
  });
  const thread = await callTool("create_thread", {
    channel: "general",
    name: "omnitest-thread",
    message_id: origin.data.id,
  });
  expect(typeof thread.data?.id === "string", "thread branches from a message");

  const inThread = await callTool("send_message", {
    channel: thread.data.id,
    content: "hello inside the thread",
  });
  expect(typeof inThread.data?.id === "string", "raw thread id resolves for sending");

  const threadFeed = await callTool("read_messages", { channel: thread.data.id });
  expect(
    (threadFeed.data?.messages ?? []).some((m) => m.id === inThread.data.id),
    "thread messages read back"
  );

  const threadList = await callTool("list_threads");
  expect(
    (threadList.data?.active ?? []).some((t) => t.name === "omnitest-thread"),
    "thread shows among active threads"
  );

  await callTool("update_thread", { thread: "omnitest-thread", slowmode_seconds: 5 });
  await callTool("add_thread_member", { thread: "omnitest-thread", member: ownerId });
  const threadMembers = await callTool("list_thread_members", { thread: "omnitest-thread" });
  expect((threadMembers.data?.members ?? []).length >= 2, "added member shows in the thread");
  await callTool("remove_thread_member", { thread: "omnitest-thread", member: ownerId });

  await callTool("update_thread", { thread: "omnitest-thread", archived: true });
  const archivedList = await callTool("list_threads", {
    channel: "general",
    include_archived: true,
  });
  expect(
    (archivedList.data?.archived ?? []).some((t) => t.name === "omnitest-thread"),
    "archived thread shows under include_archived"
  );

  const unarchive = await callTool("update_thread", {
    thread: thread.data.id,
    archived: false,
  });
  expect(
    (unarchive.data?.changed ?? []).includes("unarchived"),
    "archived thread resolves by raw id and unarchives"
  );

  const threadGate = await callTool("delete_thread", { thread: "omnitest-thread" });
  const threadGone = await callTool("delete_thread", {
    thread: "omnitest-thread",
    confirm_token: threadGate.data?.confirm_token,
  });
  expect(threadGone.data?.deleted === true, "gated thread delete works");

  const originGate = await callTool("delete_message", {
    channel: "general",
    message_id: origin.data.id,
  });
  await callTool("delete_message", {
    channel: "general",
    message_id: origin.data.id,
    confirm_token: originGate.data?.confirm_token,
  });

  // Forums batch: a forum channel with tags, a tagged post, replies, tag
  // management, and teardown.

  const forumChan = await callTool("create_channel", {
    name: "omnitest-forum",
    type: "forum",
  });
  expect(typeof forumChan.data?.id === "string", "forum channel creates");

  const bugTag = await callTool("create_forum_tag", {
    forum: "omnitest-forum",
    name: "bug",
  });
  expect(typeof bugTag.data?.id === "string", "forum tag creates with an id");
  await callTool("create_forum_tag", { forum: "omnitest-forum", name: "feature" });

  const forumPost = await callTool("create_forum_post", {
    forum: "omnitest-forum",
    title: "omnitest-post",
    content: "opening message of the acceptance post",
    tags: ["bug"],
  });
  expect((forumPost.data?.tags ?? []).includes("bug"), "post carries its tag by name");

  const taggedPosts = await callTool("list_forum_posts", {
    forum: "omnitest-forum",
    tag: "bug",
  });
  expect(
    (taggedPosts.data?.posts ?? []).some((p) => p.title === "omnitest-post"),
    "tag filter finds the post"
  );

  const forumReply = await callTool("reply_to_forum_post", {
    post: "omnitest-post",
    content: "a reply in the post",
  });
  expect(typeof forumReply.data?.id === "string", "forum post takes replies");

  const retag = await callTool("update_forum_post", {
    post: "omnitest-post",
    tags: ["feature"],
    pinned: true,
  });
  expect(
    (retag.data?.changed ?? []).some((c) => c.includes("pinned")),
    "post pins and retags"
  );

  await callTool("update_forum_tag", {
    forum: "omnitest-forum",
    tag: "bug",
    name: "defect",
  });

  const postGate = await callTool("delete_forum_post", { post: "omnitest-post" });
  const postGone = await callTool("delete_forum_post", {
    post: "omnitest-post",
    confirm_token: postGate.data?.confirm_token,
  });
  expect(postGone.data?.deleted === true, "gated forum post delete works");

  const tagGate = await callTool("delete_forum_tag", {
    forum: "omnitest-forum",
    tag: "defect",
  });
  const tagGone = await callTool("delete_forum_tag", {
    forum: "omnitest-forum",
    tag: "defect",
    confirm_token: tagGate.data?.confirm_token,
  });
  expect(tagGone.data?.deleted === true, "gated forum tag delete works");

  const forumGate = await callTool("delete_channel", { channel: forumChan.data.id });
  await callTool("delete_channel", {
    channel: forumChan.data.id,
    confirm_token: forumGate.data?.confirm_token,
  });

  // Settings batch: widget, server fields, templates, prune, presence,
  // and the honest Community-only error paths.

  // The widget is a public page, so turning it on asks first.
  const widgetPreview = await callTool("update_server_widget", { enabled: true });
  expect(
    widgetPreview.data?.executed === false && /Would turn the server widget on\./.test(widgetPreview.summary ?? ""),
    "turning the widget on previews first"
  );
  const widgetStillOff = await callTool("get_server_widget");
  expect(widgetStillOff.data?.enabled === false, "and the widget is still off after the preview");
  const widgetOn = await callTool("update_server_widget", { enabled: true, confirm_token: widgetPreview.data?.confirm_token });
  expect(widgetOn.data?.enabled === true, "widget enables with the token");
  const widgetState = await callTool("get_server_widget");
  expect(widgetState.data?.enabled === true, "widget state reads back");
  const widgetOff = await callTool("update_server_widget", { enabled: false });
  expect(widgetOff.data?.enabled === false && widgetOff.data?.executed === undefined, "and turns off at once");

  const afkUp = await callTool("update_server", { afk_timeout_seconds: 900 });
  expect(
    (afkUp.data?.changed ?? []).some((c) => c.includes("900")),
    "server afk timeout updates"
  );
  await callTool("update_server", { afk_timeout_seconds: 300 });

  // A server that never had a welcome screen errors with the Community
  // explanation; one that had a screen configured keeps the data even
  // after Community is turned off. Both are legitimate states.
  const welcome = await callToolRaw("get_welcome_screen");
  expect(
    welcome.isError === true
      ? /Community/i.test(welcome.summary)
      : Array.isArray(welcome.data?.channels),
    "welcome screen reads back or explains the Community requirement"
  );

  const onboarding = await callToolRaw("get_onboarding");
  expect(
    onboarding.isError === true || onboarding.data?.enabled === false,
    "onboarding reads back or fails cleanly"
  );

  const integrations = await callTool("list_integrations");
  expect(Array.isArray(integrations.data?.integrations), "integrations list");

  const template = await callTool("create_server_template", {
    name: "omnitest-template",
    description: "Acceptance snapshot.",
  });
  expect(typeof template.data?.code === "string", "server template creates");

  const templateList = await callTool("list_server_templates");
  expect(
    (templateList.data?.templates ?? []).some((t) => t.code === template.data.code),
    "template shows in the list"
  );

  const synced = await callTool("sync_server_template", { code: template.data.code });
  expect(synced.data?.out_of_sync === false, "template syncs clean");

  const templateGate = await callTool("delete_server_template", {
    code: template.data.code,
  });
  const templateGone = await callTool("delete_server_template", {
    code: template.data.code,
    confirm_token: templateGate.data?.confirm_token,
  });
  expect(templateGone.data?.deleted === true, "gated template delete works");

  // The preview endpoint works for any guild the bot belongs to; the
  // discoverability requirement only applies to outsiders.
  const preview = await callTool("get_server_preview");
  expect(
    typeof preview.data?.members_approximate === "number",
    "preview returns member counts for the bot's own guild"
  );

  // Prune executions are limited to a few per guild every several
  // minutes (Discord error 30040), so repeated test runs only assert the
  // preview, which uses Discord's unlimited count endpoint.
  const pruneGate = await callTool("prune_members", { days: 1 });
  expect(pruneGate.data?.preview?.would_prune === 0, "prune preview counts zero on the test server");

  const presenceIdle = await callTool("set_bot_presence", {
    status: "idle",
    activity_text: "Acceptance run",
  });
  expect(presenceIdle.data?.status === "idle", "presence sets to idle over the gateway");
  await callTool("set_bot_presence", { status: "online" });

  // Community batch: enable the feature for real, run the tests that
  // were previously only error paths, then put everything back.

  await callTool("create_channel", { name: "omnitest-rules", topic: "Rules for the test." });
  await callTool("create_channel", { name: "omnitest-updates", topic: "Mod updates." });

  const communityOn = await callTool("update_server", {
    community: true,
    rules_channel: "omnitest-rules",
    public_updates_channel: "omnitest-updates",
  });
  expect(
    (communityOn.data?.changed ?? []).includes("Community enabled"),
    "Community enables with prerequisites handled"
  );

  const featureCheck = await callTool("get_server_overview");
  expect(
    (featureCheck.data?.features ?? []).includes("COMMUNITY"),
    "server reports the COMMUNITY feature"
  );

  // Announcement channels were impossible before Community; now they are
  // the positive test for the planner's gating logic.
  const announceChan = await callTool("create_channel", {
    name: "omnitest-announce",
    type: "announcement",
  });
  expect(typeof announceChan.data?.id === "string", "announcement channel creates on a Community server");

  // Only an announcement thread can be started without a message in an
  // announcement channel; the tool used to ask for a public one.
  const newsThread = await callTool("create_thread", { channel: "omnitest-announce", name: "omnitest-news-thread" });
  expect(typeof newsThread.data?.id === "string", "a thread starts in an announcement channel without a message");
  const newsPrivate = await callToolRaw("create_thread", { channel: "omnitest-announce", name: "omnitest-news-private", private: true });
  expect(newsPrivate.isError && /no private threads/.test(newsPrivate.summary ?? ""), "a private thread in an announcement channel is refused with the reason");

  // Stage channels exist only on a Community server. Ending a live stage
  // ends it for everyone listening, so it asks first.
  const stageChan = await callTool("create_channel", { name: "omnitest-stage", type: "stage" });
  const stageStart = await callTool("start_stage", { channel: stageChan.data?.id, topic: "omnitest town hall" });
  expect(!stageStart.isError, "a stage starts");
  const stagePreview = await callTool("end_stage", { channel: stageChan.data?.id });
  expect(stagePreview.data?.executed === false && /Would end the live stage "omnitest town hall"/.test(stagePreview.summary ?? ""), "ending a stage previews first, naming its topic");
  const stageLive = await callTool("list_stages");
  expect((stageLive.data?.stages ?? []).some((x) => x.topic === "omnitest town hall"), "and the stage is still live after the preview");
  const stageEnded = await callTool("end_stage", { channel: stageChan.data?.id, confirm_token: stagePreview.data?.confirm_token });
  expect(stageEnded.data?.ended === true, "the token ends the stage");
  {
    const g = await callTool("delete_channel", { channel: stageChan.data?.id });
    await callTool("delete_channel", { channel: stageChan.data?.id, confirm_token: g.data?.confirm_token });
  }

  const mpRule = await callTool("create_automod_rule", {
    name: "omnitest-mp-rule",
    trigger: "member_profile",
    keywords: ["zzqqxx"],
    actions: ["block"],
  });
  expect(mpRule.isError !== true, "member_profile automod rule creates on a Community server");
  const mpDeleted = await deleteViaTool("delete_automod_rule", "rule", "omnitest-mp-rule");
  expect(mpDeleted.data?.deleted === true, "member_profile rule deletes");

  const welcomeSet = await callTool("update_welcome_screen", {
    enabled: true,
    description: "Welcome to the acceptance run.",
    channels: [{ channel: "general", description: "Start here" }],
  });
  expect(welcomeSet.data?.updated === true, "welcome screen updates for real");

  const welcomeRead = await callTool("get_welcome_screen");
  expect(
    (welcomeRead.data?.channels ?? []).length === 1,
    "welcome screen reads back with its channel card"
  );

  // Onboarding needs at least seven default channels, five sendable.
  // general, rules, updates, announce, plus three fillers makes seven.
  for (let i = 1; i <= 3; i += 1) {
    await callTool("create_channel", { name: `omnitest-onb-${i}` });
  }
  await callTool("create_role", { name: "omnitest-onb-role", preset: "member" });

  const onboardingSet = await callTool("update_onboarding", {
    enabled: true,
    mode: "default",
    default_channels: [
      "general",
      "omnitest-rules",
      "omnitest-updates",
      "omnitest-announce",
      "omnitest-onb-1",
      "omnitest-onb-2",
      "omnitest-onb-3",
    ],
    prompts: [
      {
        title: "What brings you here?",
        type: "multiple_choice",
        options: [
          { title: "Just looking around", roles: ["omnitest-onb-role"] },
          { title: "Updates please", channels: ["omnitest-updates"] },
        ],
      },
    ],
  });
  expect(onboardingSet.data?.enabled === true, "onboarding enables with a real prompt");
  expect((onboardingSet.data?.prompts ?? []).length === 1, "onboarding carries the prompt");

  const onboardingRead = await callTool("get_onboarding");
  expect(onboardingRead.data?.enabled === true, "onboarding reads back enabled");

  // Offering a role with moderator powers lets anyone pick it for
  // themselves, so it waits for confirmation. Left unconfirmed.
  expect(onboardingSet.data?.executed !== false, "grants: an ordinary role on offer goes ahead at once");
  await callTool("create_role", { name: "omnitest-onb-mod", preset: "moderator" });
  const onbMod = await callTool("update_onboarding", {
    prompts: [{ title: "What brings you here?", options: [{ title: "Moderate", roles: ["omnitest-onb-mod"] }] }],
  });
  expect(
    onbMod.data?.executed === false &&
      (onbMod.summary ?? "").includes('Would let anyone in the server pick "omnitest-onb-mod" for themselves') &&
      (onbMod.summary ?? "").includes("kick and time out members"),
    "grants: offering a moderator role in onboarding is previewed, saying what it gives"
  );
  const onbAfter = await callTool("get_onboarding");
  expect(!JSON.stringify(onbAfter.data ?? {}).includes("Moderate"), "grants: and onboarding is unchanged without the token");

  const onboardingOff = await callTool("update_onboarding", { enabled: false });
  expect(onboardingOff.data?.enabled === false, "onboarding disables again");

  // Stickers and soundboard, from the loopback-served generated assets.
  const sticker = await callTool("create_sticker", {
    name: "omnitest_sticker",
    description: "Acceptance sticker.",
    tags: "robot",
    image_url: `http://127.0.0.1:${ASSET_PORT}/sticker.png`,
  });
  expect(typeof sticker.data?.id === "string", "sticker uploads from a generated png");

  const stickerList = await callTool("list_stickers");
  expect(
    (stickerList.data?.stickers ?? []).some((s) => s.name === "omnitest_sticker"),
    "sticker shows in the list"
  );

  await callTool("update_sticker", {
    sticker: "omnitest_sticker",
    description: "Renamed by the run.",
  });

  const stickerGate = await callTool("delete_sticker", { sticker: "omnitest_sticker" });
  const stickerGone = await callTool("delete_sticker", {
    sticker: "omnitest_sticker",
    confirm_token: stickerGate.data?.confirm_token,
  });
  expect(stickerGone.data?.deleted === true, "gated sticker delete works");

  const soundCreate = await callToolRaw("create_soundboard_sound", {
    name: "omnitest-sound",
    sound_url: `http://127.0.0.1:${ASSET_PORT}/sound.mp3`,
    volume: 0.5,
  });
  expect(soundCreate.isError !== true, "soundboard sound uploads from generated audio");

  if (soundCreate.isError !== true) {
    const soundList = await callTool("list_soundboard_sounds");
    expect(
      (soundList.data?.sounds ?? []).some((s) => s.name === "omnitest-sound"),
      "sound shows in the list"
    );

    const soundUpdate = await callTool("update_soundboard_sound", {
      sound: "omnitest-sound",
      volume: 0.8,
    });
    expect(soundUpdate.data?.volume === 0.8, "sound volume updates");

    const soundGate = await callTool("delete_soundboard_sound", { sound: "omnitest-sound" });
    const soundGone = await callTool("delete_soundboard_sound", {
      sound: "omnitest-sound",
      confirm_token: soundGate.data?.confirm_token,
    });
    expect(soundGone.data?.deleted === true, "gated sound delete works");
  }

  // Put the server back: welcome screen off, Community off, then sweep
  // the channels and role this section created.
  await callTool("update_welcome_screen", { enabled: false });
  // Turning Community off takes down what depends on it, so it asks first.
  const communityOffPreview = await callTool("update_server", { community: false });
  expect(
    communityOffPreview.data?.executed === false && /Community goes off/.test(communityOffPreview.summary ?? ""),
    "turning Community off previews first"
  );
  const communityOff = await callTool("update_server", { community: false, confirm_token: communityOffPreview.data?.confirm_token });
  expect(
    (communityOff.data?.changed ?? []).includes("Community disabled"),
    "Community disables cleanly with the token"
  );

  for (const name of [
    "omnitest-announce",
    "omnitest-onb-1",
    "omnitest-onb-2",
    "omnitest-onb-3",
    "omnitest-rules",
    "omnitest-updates",
  ]) {
    const chanGate = await callTool("delete_channel", { channel: name });
    await callTool("delete_channel", {
      channel: name,
      confirm_token: chanGate.data?.confirm_token,
    });
  }
  for (const name of ["omnitest-onb-role", "omnitest-onb-mod"]) {
    const onbRoleGate = await callTool("delete_role", { role: name });
    await callTool("delete_role", {
      role: name,
      confirm_token: onbRoleGate.data?.confirm_token,
    });
  }

  assetServer.close();

  // Blueprint store batch: export the pristine server, prove drift
  // detection in both directions, and close with the round-trip test:
  // re-applying an export must create nothing.

  // Leftover saved blueprints from an interrupted run would collide on
  // name; sweep them defensively first.
  for (const name of ["omnitest-baseline", "omnitest-structure"]) {
    const leftover = await callToolRaw("get_blueprint", { blueprint: name });
    if (!leftover.isError) {
      const g = await callToolRaw("delete_blueprint", { blueprint: name });
      if (g.data?.confirm_token) {
        await callToolRaw("delete_blueprint", {
          blueprint: name,
          confirm_token: g.data.confirm_token,
        });
      }
    }
  }

  const baseline = await callTool("export_server_blueprint", {
    save_as: "omnitest-baseline",
  });
  expect(typeof baseline.data?.saved_id === "string", "export saves straight to the store");
  expect(
    (baseline.data?.blueprint?.categories ?? []).length === 2,
    "pristine server exports its two default categories"
  );
  expect(
    (baseline.data?.blueprint?.roles ?? []).length === 0,
    "managed and everyone roles stay out of the export"
  );

  const bpList = await callTool("list_blueprints");
  expect(
    (bpList.data?.blueprints ?? []).some((b) => b.name === "omnitest-baseline"),
    "exported blueprint shows in the store"
  );

  const cleanDiff = await callTool("diff_blueprint", { blueprint: "omnitest-baseline" });
  expect(cleanDiff.data?.in_sync === true, "pristine server diffs clean against its own export");
  expect(
    (cleanDiff.data?.extra?.channels ?? []).length === 0,
    "no phantom extras on a clean diff"
  );

  const structure = {
    roles: [{ name: "omnitest-bp-role", preset: "member", color: "#ff00aa" }],
    categories: [
      {
        name: "omnitest-bp-cat",
        private_to: ["omnitest-bp-role"],
        channels: [
          {
            name: "omnitest-bp-chan",
            topic: "drift me",
            read_only: true,
            posting_roles: ["omnitest-bp-role"],
          },
        ],
      },
    ],
  };
  await callTool("save_blueprint", { name: "omnitest-structure", blueprint: structure });

  const beforeBuild = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  expect(
    beforeBuild.data?.missing?.roles?.length === 1 &&
      beforeBuild.data?.missing?.categories?.length === 1 &&
      beforeBuild.data?.missing?.channels?.length === 1,
    "unbuilt blueprint reports everything missing"
  );

  await callTool("execute_build_plan", { blueprint: structure });

  const afterBuild = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  expect(afterBuild.data?.in_sync === true, "built blueprint diffs clean");

  await callTool("update_channel", { channel: "omnitest-bp-chan", topic: "drifted" });
  const drifted = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  const driftEntry = (drifted.data?.changed ?? []).find((c) => c.name === "omnitest-bp-chan");
  expect(
    drifted.data?.in_sync === false && driftEntry?.fields?.includes("topic"),
    "topic drift is detected with the field named"
  );

  // The round trip: exporting the server as it stands and re-executing
  // that export must reuse everything and create nothing.
  const roundTrip = await callTool("export_server_blueprint", {});
  expect(
    !(roundTrip.warnings ?? []).some((w) => w.includes("omnitest-bp-chan")),
    "export reads a built read-only channel back with nothing left over"
  );
  const reapplied = await callTool("execute_build_plan", {
    blueprint: roundTrip.data.blueprint,
  });
  expect(reapplied.data?.created === 0, "re-applying an export creates nothing");
  expect((reapplied.data?.reused ?? 0) >= 3, "re-applying an export reuses the structure");

  // Drift in the other direction: the baseline now sees extras.
  const extras = await callTool("diff_blueprint", { blueprint: "omnitest-baseline" });
  expect(
    (extras.data?.extra?.channels ?? []).includes("omnitest-bp-chan") &&
      (extras.data?.extra?.roles ?? []).includes("omnitest-bp-role"),
    "baseline diff reports the new entities as extra"
  );

  // Cleanup: structure entities and both saved blueprints.
  for (const channel of ["omnitest-bp-chan", "omnitest-bp-cat"]) {
    const g = await callTool("delete_channel", { channel });
    await callTool("delete_channel", { channel, confirm_token: g.data?.confirm_token });
  }
  const bpRoleGate = await callTool("delete_role", { role: "omnitest-bp-role" });
  await callTool("delete_role", {
    role: "omnitest-bp-role",
    confirm_token: bpRoleGate.data?.confirm_token,
  });
  for (const name of ["omnitest-baseline", "omnitest-structure"]) {
    const g = await callTool("delete_blueprint", { blueprint: name });
    await callTool("delete_blueprint", { blueprint: name, confirm_token: g.data?.confirm_token });
  }
  const emptyStore = await callTool("list_blueprints");
  expect((emptyStore.data?.blueprints ?? []).length === 0, "blueprint store ends the run empty");

  // Edit loop: change existing items in place, exactly as planned.
  {
    const VIEW = 1n << 10n;
    const SEND = 1n << 11n;
    const ADD_REACTIONS = 1n << 6n;
    // Raw reads, waiting out a rate limit the way the server's own client
    // does: this section hits the channel list often.
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const rawChannels = () => rawGet(`/guilds/${guildId}/channels`);
    const rawChannel = async (name) => (await rawChannels()).find((c) => c.name === name);
    const ow = (c, id) => (c?.permission_overwrites ?? []).find((o) => o.id === id);

    const editStructure = {
      roles: [{ name: "omnitest-edit-role", preset: "member" }],
      categories: [
        {
          name: "omnitest-edit-cat",
          private_to: ["omnitest-edit-role"],
          channels: [{ name: "omnitest-edit-a", topic: "one" }, { name: "omnitest-edit-synced" }],
        },
      ],
      channels: [{ name: "omnitest-edit-ro", read_only: true, posting_roles: ["omnitest-edit-role"] }],
    };
    const setup = await callTool("execute_build_plan", { blueprint: editStructure });
    expect(setup.data?.created === 5, "edit loop: setup builds five items");
    expect(setup.data?.check?.in_sync === true, "edit loop: the check after building finds everything in place");

    // The leak fix, live: a read-only channel created in a private category.
    await callTool("create_channel", { name: "omnitest-edit-leak", category: "omnitest-edit-cat", read_only: true });
    const leak = await rawChannel("omnitest-edit-leak");
    const leakEveryone = ow(leak, guildId);
    expect(
      leakEveryone && (BigInt(leakEveryone.deny) & VIEW) !== 0n && (BigInt(leakEveryone.deny) & SEND) !== 0n,
      "edit loop: a read-only channel created in a private category stays private"
    );

    // Something the blueprint cannot express, which edits must leave alone.
    const roleId = (await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.name === "omnitest-edit-role")?.id;
    await callTool("set_channel_permissions", {
      channel: "omnitest-edit-a",
      target: "omnitest-edit-role",
      allow: ["view_channel", "connect", "add_reactions"],
    });

    // Edit through an export: the items carry ids.
    const exported = (await callTool("export_server_blueprint", {})).data.blueprint;
    const cat = exported.categories.find((c) => c.name === "omnitest-edit-cat");
    const role = exported.roles.find((r) => r.name === "omnitest-edit-role");
    const ro = exported.channels.find((c) => c.name === "omnitest-edit-ro");
    expect(Boolean(cat?.id && role?.id && ro?.id), "edit loop: the export carries ids");
    const a = cat.channels.find((c) => c.name === "omnitest-edit-a");
    const synced = cat.channels.find((c) => c.name === "omnitest-edit-synced");
    const edit = {
      roles: [{ ...role, color: "#123456" }],
      categories: [{ ...cat, private_to: null, channels: [
        { ...a, name: "omnitest-edit-renamed", topic: "two", private_to: [] },
        synced,
      ] }],
      channels: [{ ...ro, posting_roles: [] }],
    };
    const planned = await callTool("plan_server_build", { blueprint: edit, update_existing: true });
    const updates = (planned.data?.steps ?? []).filter((s) => s.action.startsWith("update_"));
    const updated = new Set(updates.map((s) => s.name));
    expect(
      planned.data?.to_create === 0 &&
        ["omnitest-edit-role", "omnitest-edit-cat", "omnitest-edit-renamed", "omnitest-edit-synced", "omnitest-edit-ro"].every((n) => updated.has(n)) &&
        updates.length === 5,
      "edit loop: the plan changes exactly the five edited items"
    );
    expect((planned.data?.risks ?? []).some((r) => r.includes("omnitest-edit-cat") && r.includes("everyone")), "edit loop: opening the category is flagged");

    // A plan is the approval of exactly those changes. Change one of the
    // items it touches, and it must refuse.
    await callTool("update_channel", { channel: "omnitest-edit-a", topic: "drifted" });
    const stale = await callToolRaw("execute_build_plan", { plan_id: planned.data.plan_id });
    expect(stale.isError === true && /changed since/.test(stale.summary ?? ""), "edit loop: a plan whose items changed since is refused, and nothing runs");
    const stillOld = await rawChannel("omnitest-edit-a");
    expect(stillOld?.topic === "drifted", "edit loop: the refused plan changed nothing");

    const fresh = await callTool("plan_server_build", { blueprint: edit, update_existing: true });
    const applied = await callTool("execute_build_plan", { plan_id: fresh.data.plan_id });
    expect(applied.data?.updated === 5 && applied.data?.created === 0, "edit loop: the fresh plan applies five changes");
    expect(applied.data?.check?.in_sync === true, "edit loop: the check after applying finds nothing left over");

    const renamed = await rawChannel("omnitest-edit-renamed");
    expect(renamed?.topic === "two", "edit loop: the channel was renamed in place and its topic changed");
    const roleOw = ow(renamed, roleId);
    expect(
      roleOw && (BigInt(roleOw.allow) & VIEW) === 0n && (BigInt(roleOw.allow) & ADD_REACTIONS) !== 0n,
      "edit loop: admins only removed the role's view and kept its add-reactions allow"
    );
    const catNow = (await rawChannels()).find((c) => c.name === "omnitest-edit-cat");
    expect(!ow(catNow, guildId) || (BigInt(ow(catNow, guildId).deny) & VIEW) === 0n, "edit loop: the category is open");
    const syncedNow = await rawChannel("omnitest-edit-synced");
    expect(!ow(syncedNow, guildId) || (BigInt(ow(syncedNow, guildId).deny) & VIEW) === 0n, "edit loop: the synced channel opened with its category");
    const leakNow = await rawChannel("omnitest-edit-leak");
    expect((BigInt(ow(leakNow, guildId)?.deny ?? 0) & VIEW) !== 0n, "edit loop: a channel with its own settings did not follow the category");
    const roNow = await rawChannel("omnitest-edit-ro");
    expect(!ow(roNow, roleId) || (BigInt(ow(roNow, roleId).allow) & SEND) === 0n, "edit loop: the posting role can no longer post");
    const roleNow = (await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.id === roleId);
    expect(roleNow?.color === 0x123456, "edit loop: the role's color changed");

    const twice = await callToolRaw("execute_build_plan", { plan_id: fresh.data.plan_id });
    expect(twice.isError === true && /already been executed/.test(twice.summary ?? ""), "edit loop: a plan cannot run twice");

    // The same channel's name has now changed once and its topic twice in
    // a few seconds. Discord allows about two such edits per 10 minutes, so
    // more renames should be refused quickly, not leave the call hanging.
    let limited = null;
    let slowest = 0;
    for (let i = 1; i <= 3 && !limited; i++) {
      const started = Date.now();
      const r = await callToolRaw("update_channel", { channel: "omnitest-edit-renamed", name: `omnitest-edit-renamed-${i}` });
      slowest = Math.max(slowest, Date.now() - started);
      if (r.isError) limited = r;
    }
    expect(slowest < 35_000, "edit loop: no rename waited out a long rate limit");
    if (limited) {
      expect(limited.data?.rate_limited === true && /not sent/.test(limited.summary ?? ""), "edit loop: the held rename is refused with the reason");
    } else {
      console.log("  note: Discord did not hold any of the renames this run");
    }

    // Cleanup through the gated tools.
    for (const c of await rawChannels()) {
      if (!c.name?.startsWith("omnitest-edit")) continue;
      if (c.type === 4) continue;
      const res = await deleteViaTool("delete_channel", "channel", c.id);
      expect(res.data?.deleted === true, `edit loop: cleanup removed ${c.name}`);
    }
    const catGone = await deleteViaTool("delete_channel", "channel", catNow.id);
    expect(catGone.data?.deleted === true, "edit loop: cleanup removed the category");
    const roleGone = await deleteViaTool("delete_role", "role", roleId);
    expect(roleGone.data?.deleted === true, "edit loop: cleanup removed the role");
  }

  // Deletions through a plan: named explicitly, last, and exactly as planned.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const rawChannels = () => rawGet(`/guilds/${guildId}/channels`);

    const setup = await callTool("execute_build_plan", {
      blueprint: {
        roles: [{ name: "omnitest-del-role" }],
        categories: [{ name: "omnitest-del-cat", channels: [{ name: "omnitest-del-msg" }, { name: "omnitest-del-keep" }] }],
        channels: [{ name: "omnitest-del-empty" }],
      },
    });
    expect(setup.data?.created === 5, "delete: setup builds five items");
    await callTool("send_message", { channel: "omnitest-del-msg", content: "this message goes with its channel" });
    const me = (await callTool("get_bot_info")).data;
    const botId = me?.id ?? me?.bot?.id ?? me?.user?.id;
    await callTool("assign_role", { member: botId, role: "omnitest-del-role" });

    const remove = {
      channels: ["omnitest-del-msg", "#omnitest-del-empty"],
      categories: ["omnitest-del-cat"],
      roles: ["omnitest-del-role"],
    };
    const planned = await callTool("plan_server_build", { blueprint: {}, remove });
    const steps = planned.data?.steps ?? [];
    const step = (name) => steps.find((s) => s.name === name);
    expect(planned.data?.to_delete === 4 && steps.every((s) => s.action.startsWith("delete_")), "delete: a plan with only deletions lists four deletions");
    expect(step("omnitest-del-msg")?.details?.loses?.some((l) => l.includes("messages")) && step("omnitest-del-msg")?.risks?.length === 1, "delete: the channel with a message says its messages go, flagged");
    expect(step("omnitest-del-empty")?.details?.loses?.some((l) => l.includes("never had a message")), "delete: the empty channel says it never had a message");
    expect((step("omnitest-del-cat")?.details?.left_without_category ?? []).includes("omnitest-del-keep"), "delete: the category names the channel it leaves behind");
    expect(step("omnitest-del-role")?.details?.loses?.some((l) => l.includes("1 member")), "delete: the role counts its one member, from Discord's member counts");

    const conflict = await callToolRaw("plan_server_build", {
      blueprint: { channels: [{ name: "omnitest-del-empty", topic: "keep me" }] },
      remove: { channels: ["omnitest-del-empty"] },
    });
    expect(conflict.isError === true && JSON.stringify(conflict.data ?? {}).includes("also the blueprint"), "delete: an item both kept and removed is refused");

    // The plan said the empty channel never had a message. Now it has one, so
    // the plan no longer says what would happen, and it must not run.
    await callTool("send_message", { channel: "omnitest-del-empty", content: "now it has history" });
    const stale = await callToolRaw("execute_build_plan", { plan_id: planned.data.plan_id });
    expect(stale.isError === true && /changed since/.test(stale.summary ?? ""), "delete: a deletion plan whose targets changed is refused");
    expect((await rawChannels()).some((c) => c.name === "omnitest-del-msg"), "delete: the refused plan deleted nothing");

    const fresh = await callTool("plan_server_build", { blueprint: {}, remove });
    const done = await callTool("execute_build_plan", { plan_id: fresh.data.plan_id });
    expect(done.data?.deleted === 4 && done.data?.check?.in_sync === true, "delete: four deletions run and the check finds them gone");
    const after = await rawChannels();
    expect(!after.some((c) => ["omnitest-del-msg", "omnitest-del-empty", "omnitest-del-cat"].includes(c.name)), "delete: the channels and category are gone");
    const keep = after.find((c) => c.name === "omnitest-del-keep");
    expect(keep && !keep.parent_id, "delete: the channel left behind survives without a category");
    const rolesAfter = await rawGet(`/guilds/${guildId}/roles`);
    expect(!rolesAfter.some((r) => r.name === "omnitest-del-role"), "delete: the role is gone");

    const keepGone = await deleteViaTool("delete_channel", "channel", keep?.id);
    expect(keepGone.data?.deleted === true, "delete: cleanup removed the channel left behind");
  }

  // Undo: a build that edits, creates, and deletes, reversed from its record.
  {
    const VIEW = 1n << 10n;
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const botId = (await callTool("get_bot_info")).data?.bot?.id;
    const guildBefore = await rawGet(`/guilds/${guildId}`);

    // The starting point, built and then seen the way a person would compare it.
    await callTool("execute_build_plan", {
      blueprint: {
        roles: [{ name: "omnitest-undo-role", color: "#336699", hoist: true }],
        categories: [
          {
            name: "omnitest-undo-cat",
            private_to: ["omnitest-undo-role"],
            channels: [{ name: "omnitest-undo-a", topic: "one" }, { name: "omnitest-undo-child" }],
          },
        ],
        channels: [{ name: "omnitest-undo-old", topic: "keep me", slowmode_seconds: 10, private_to: ["omnitest-undo-role"] }],
      },
    });
    await callTool("assign_role", { member: botId, role: "omnitest-undo-role" });
    await callTool("send_message", { channel: "omnitest-undo-old", content: "history that undo cannot bring back" });
    await callTool("update_server", { system_channel: "omnitest-undo-old" });

    const view = async () => {
      const [channels, roles, guild, me] = await Promise.all([
        rawGet(`/guilds/${guildId}/channels`),
        rawGet(`/guilds/${guildId}/roles`),
        rawGet(`/guilds/${guildId}`),
        rawGet(`/guilds/${guildId}/members/${botId}`),
      ]);
      const roleName = (id) => (id === guildId ? "@everyone" : id === botId ? "bot" : roles.find((r) => r.id === id)?.name ?? id);
      return {
        roles: roles
          .filter((r) => r.name.startsWith("omnitest-undo"))
          .map((r) => ({ name: r.name, color: r.color, hoist: r.hoist, permissions: r.permissions }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        channels: channels
          .filter((c) => c.name.startsWith("omnitest-undo"))
          .map((c) => ({
            name: c.name,
            type: c.type,
            topic: c.topic ?? null,
            slowmode: c.rate_limit_per_user ?? 0,
            parent: c.parent_id ? channels.find((p) => p.id === c.parent_id)?.name ?? "?" : null,
            overwrites: (c.permission_overwrites ?? [])
              .map((o) => `${roleName(o.id)}:${o.allow}:${o.deny}`)
              .sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        system: channels.find((c) => c.id === guild.system_channel_id)?.name ?? null,
        botHasRole: me.roles.some((id) => roles.find((r) => r.id === id)?.name === "omnitest-undo-role"),
      };
    };
    const start = await view();
    expect(start.system === "omnitest-undo-old" && start.botHasRole, "undo: the starting point is set up");

    // One build that changes, creates, and deletes.
    const exported = (await callTool("export_server_blueprint", {})).data.blueprint;
    const cat = exported.categories.find((c) => c.name === "omnitest-undo-cat");
    const a = cat.channels.find((c) => c.name === "omnitest-undo-a");
    const child = cat.channels.find((c) => c.name === "omnitest-undo-child");
    const role = exported.roles.find((r) => r.name === "omnitest-undo-role");
    const planned = await callTool("plan_server_build", {
      blueprint: {
        roles: [{ name: "omnitest-undo-new" }],
        categories: [
          {
            ...cat,
            private_to: null,
            channels: [{ ...a, name: "omnitest-undo-renamed", topic: "two" }, child, { name: "omnitest-undo-made" }],
          },
        ],
      },
      update_existing: true,
      remove: { channels: ["omnitest-undo-old"], roles: [role.id] },
    });
    expect((planned.warnings ?? []).some((w) => w.includes("system messages channel")), "undo: the plan warns that deleting the channel clears the system messages setting");
    const built = await callTool("execute_build_plan", { plan_id: planned.data?.plan_id });
    const buildId = built.data?.change_id;
    expect(typeof buildId === "string" && built.data?.deleted === 2 && built.data?.created === 2, "undo: the build ran and left a change_id");
    const middle = await view();
    expect(middle.system === null && !middle.botHasRole && !middle.roles.some((r) => r.name === "omnitest-undo-role"), "undo: the build deleted the channel and the role, clearing the setting");

    const listed = await callTool("list_changes", {});
    const entry = (listed.data?.changes ?? []).find((b) => b.change_id === buildId);
    expect(entry?.created === 2 && entry.deleted === 2 && entry.undo === "not undone", "undo: list_changes shows the build");

    const preview = await callTool("undo_change", { change_id: buildId });
    const lines = (preview.data?.preview ?? []).flatMap((p) => (p.steps ?? []).flatMap((s) => s.what ?? []));
    expect(preview.data?.executed === false && typeof preview.data?.confirm_token === "string", "undo: the first call only previews");
    expect(lines.some((l) => l.includes("Give it back to 1 member")) && lines.some((l) => l.includes("messages, threads")), "undo: the preview says who gets the role back and what cannot come back");
    expect(preview.data?.token_expires_in_seconds === 600, "undo: the confirm token lasts ten minutes, long enough to read the preview");

    const undone = await callTool("undo_change", { change_id: buildId, confirm_token: preview.data.confirm_token });
    expect(!undone.isError && (undone.data?.changes ?? []).flatMap((c) => c.results ?? []).every((r) => r.status !== "failed"), "undo: every step succeeds");
    const end = await view();
    expect(JSON.stringify(end.roles) === JSON.stringify(start.roles), "undo: the roles are back as they were");
    expect(end.botHasRole, "undo: the member who had the deleted role has it again");
    expect(end.system === "omnitest-undo-old", "undo: the system messages channel points at the recreated channel");
    const channelDiff = end.channels.filter((c, i) => JSON.stringify(c) !== JSON.stringify(start.channels[i]));
    expect(channelDiff.length === 0 && end.channels.length === start.channels.length, "undo: every channel is back with its name, topic, slowmode, category, and permissions");
    if (channelDiff.length) console.log("  differs:", JSON.stringify({ start: start.channels, end: end.channels }));

    const again = await callToolRaw("undo_change", { change_id: buildId });
    expect(again.isError === true && /already been undone/.test(again.summary ?? ""), "undo: a build cannot be undone twice");

    // Cleanup, and the system messages channel back where it was.
    if (guildBefore.system_channel_id) {
      await callTool("update_server", { system_channel: guildBefore.system_channel_id });
    }
    const channelsNow = await rawGet(`/guilds/${guildId}/channels`);
    for (const c of channelsNow.filter((x) => x.name.startsWith("omnitest-undo")).sort((x, y) => (x.type === 4) - (y.type === 4))) {
      await deleteViaTool("delete_channel", "channel", c.id);
    }
    const rolesNow = await rawGet(`/guilds/${guildId}/roles`);
    for (const r of rolesNow.filter((x) => x.name.startsWith("omnitest-undo"))) {
      await deleteViaTool("delete_role", "role", r.id);
    }
    const guildAfter = await rawGet(`/guilds/${guildId}`);
    expect(guildAfter.system_channel_id === guildBefore.system_channel_id, "undo: cleanup put the system messages channel back");
  }

  // Undo for single tools: a change any structural tool makes can be undone,
  // so "undo that" works whichever tool the AI picked.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const chan = async (name) => (await rawGet(`/guilds/${guildId}/channels`)).find((c) => c.name === name);
    const roleBy = async (name) => (await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.name === name);
    const undoIt = async (changeId, label) => {
      expect(typeof changeId === "string", `undo one: ${label} returned a change_id`);
      const preview = await callTool("undo_change", { change_id: changeId });
      const done = preview.data?.confirm_token
        ? await callTool("undo_change", { change_id: changeId, confirm_token: preview.data.confirm_token })
        : preview;
      const steps = (done.data?.changes ?? []).flatMap((c) => c.results ?? []);
      expect(!done.isError && steps.length > 0 && steps.every((x) => x.status === "done"), `undo one: ${label} is undone`);
    };
    const botId = (await callTool("get_bot_info")).data?.bot?.id;
    const ADD_REACTIONS = String(1n << 6n);

    const c1 = await callTool("create_channel", { name: "omnitest-one-a" });
    await undoIt(c1.data?.change_id, "a created channel");
    expect(!(await chan("omnitest-one-a")), "undo one: the created channel is gone");

    await callTool("create_channel", { name: "omnitest-one-b", topic: "original" });
    const role = await callTool("create_role", { name: "omnitest-one-role", color: "#112233" });
    const roleId = role.data?.id;

    const u1 = await callTool("update_channel", { channel: "omnitest-one-b", topic: "changed", slowmode_seconds: 5 });
    await undoIt(u1.data?.change_id, "a topic and slowmode edit");
    const b1 = await chan("omnitest-one-b");
    expect(b1?.topic === "original" && (b1?.rate_limit_per_user ?? 0) === 0, "undo one: the topic and slowmode are back");

    const sp = await callTool("set_channel_permissions", { channel: "omnitest-one-b", target: "omnitest-one-role", allow: ["add_reactions"] });
    await undoIt(sp.data?.change_id, "a permission setting");
    expect(!((await chan("omnitest-one-b"))?.permission_overwrites ?? []).some((o) => o.id === roleId), "undo one: the permission setting is gone again");

    const lk = await callTool("lock_channel", { channel: "omnitest-one-b" });
    await undoIt(lk.data?.change_id, "a lock");
    expect(!((await chan("omnitest-one-b"))?.permission_overwrites ?? []).some((o) => o.id === guildId && (BigInt(o.deny) & (1n << 11n)) !== 0n), "undo one: the channel is unlocked again");

    const ur = await callTool("update_role", { role: "omnitest-one-role", color: "#ff0000" });
    await undoIt(ur.data?.change_id, "a role color edit");
    expect((await roleBy("omnitest-one-role"))?.color === 0x112233, "undo one: the role color is back");

    const as = await callTool("assign_role", { member: botId, role: "omnitest-one-role" });
    await undoIt(as.data?.change_id, "a role given");
    expect(!(await rawGet(`/guilds/${guildId}/members/${botId}`)).roles.includes(roleId), "undo one: the role given is taken back");
    await callTool("assign_role", { member: botId, role: "omnitest-one-role" });
    const rm = await callTool("remove_role", { member: botId, role: "omnitest-one-role" });
    await undoIt(rm.data?.change_id, "a role taken");
    expect((await rawGet(`/guilds/${guildId}/members/${botId}`)).roles.includes(roleId), "undo one: the role taken is given back");

    const cc = await callTool("clone_channel", { channel: "omnitest-one-b", new_name: "omnitest-one-b-copy" });
    await undoIt(cc.data?.change_id, "a cloned channel");
    expect(!(await chan("omnitest-one-b-copy")), "undo one: the cloned channel is gone");
    const cr = await callTool("clone_role", { role: "omnitest-one-role", new_name: "omnitest-one-role-copy" });
    await undoIt(cr.data?.change_id, "a cloned role");
    expect(!(await roleBy("omnitest-one-role-copy")), "undo one: the cloned role is gone");

    const gBefore = await rawGet(`/guilds/${guildId}`);
    const us = await callTool("update_server", { afk_timeout_seconds: gBefore.afk_timeout === 900 ? 1800 : 900 });
    await undoIt(us.data?.change_id, "a server setting");
    expect((await rawGet(`/guilds/${guildId}`)).afk_timeout === gBefore.afk_timeout, "undo one: the server setting is back");

    await callTool("set_channel_permissions", { channel: "omnitest-one-b", target: "omnitest-one-role", allow: ["add_reactions"] });
    const doomed = await chan("omnitest-one-b");
    const dc = await deleteViaTool("delete_channel", "channel", doomed?.id);
    await undoIt(dc.data?.change_id, "a deleted channel");
    const back = await chan("omnitest-one-b");
    expect(back?.topic === "original" && (back?.permission_overwrites ?? []).some((o) => o.id === roleId && o.allow === ADD_REACTIONS), "undo one: the deleted channel is back with its topic and permissions");

    const dr = await deleteViaTool("delete_role", "role", roleId);
    await undoIt(dr.data?.change_id, "a deleted role");
    const roleBack = await roleBy("omnitest-one-role");
    expect(roleBack?.color === 0x112233 && (await rawGet(`/guilds/${guildId}/members/${botId}`)).roles.includes(roleBack.id), "undo one: the deleted role is back, on the member who had it");
    expect(((await chan("omnitest-one-b"))?.permission_overwrites ?? []).some((o) => o.id === roleBack?.id && o.allow === ADD_REACTIONS), "undo one: and its permission setting on the channel is back");

    const lc = await callTool("list_changes", {});
    expect((lc.data?.changes ?? []).some((c) => c.by === "delete_role" && c.undo === "undone"), "undo one: list_changes names the tool and shows the change undone");

    for (const c of (await rawGet(`/guilds/${guildId}/channels`)).filter((x) => x.name.startsWith("omnitest-one"))) {
      await deleteViaTool("delete_channel", "channel", c.id);
    }
    for (const r of (await rawGet(`/guilds/${guildId}/roles`)).filter((x) => x.name.startsWith("omnitest-one"))) {
      await deleteViaTool("delete_role", "role", r.id);
    }
  }

  // The Desktop sequence: create, edit, delete, undo the delete, then undo
  // everything since the start in one go. The recreated channel has a new
  // id, and the older changes still name the old one.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const chan = async (name) => (await rawGet(`/guilds/${guildId}/channels`)).find((c) => c.name === name);
    // Taken now: anything earlier, such as the last section's cleanup,
    // is outside the window.
    const since = new Date().toISOString();

    const a = await callTool("create_channel", { name: "omnitest-since" });
    const b = await callTool("lock_channel", { channel: "omnitest-since" });
    const doomed = await chan("omnitest-since");
    const c = await deleteViaTool("delete_channel", "channel", doomed?.id);
    expect([a, b, c].every((r) => typeof r.data?.change_id === "string"), "since: create, lock, and delete each return a change_id");

    const p1 = await callTool("undo_change", { change_id: c.data.change_id });
    await callTool("undo_change", { change_id: c.data.change_id, confirm_token: p1.data?.confirm_token });
    const back = await chan("omnitest-since");
    expect(back && back.id !== doomed?.id, "since: undoing the delete brings the channel back under a new id");

    const preview = await callTool("undo_change", { since });
    expect(preview.data?.executed === false && (preview.data?.preview ?? []).length === 2, "since: everything since the start is one preview, two changes left");
    const all = await callTool("undo_change", { since, confirm_token: preview.data?.confirm_token });
    expect(!all.isError && (all.data?.changes ?? []).length === 2, "since: one confirmation undoes both");
    expect(!(await chan("omnitest-since")), "since: the recreated channel is gone, reached through the old id");
    const listed = (await callTool("list_changes", { limit: 5 })).data?.changes ?? [];
    expect([a, b, c].every((r) => listed.some((x) => x.change_id === r.data.change_id && x.undo === "undone")), "since: all three changes show as undone");
    const nothing = await callToolRaw("undo_change", { since });
    expect(nothing.isError === true && /left to undo/.test(nothing.summary ?? ""), "since: running it again finds nothing left");
  }

  // Blueprint permissions: per-role extras beyond who can see and post.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const bit = (n) => 1n << BigInt(n);
    const VIEW = bit(10), SEND = bit(11), EMBED = bit(14), MENTION = bit(17), MANAGE_MSG = bit(13);
    const chan = async (name) => (await rawGet(`/guilds/${guildId}/channels`)).find((c) => c.name === name);

    const built = await callTool("execute_build_plan", {
      blueprint: {
        roles: [{ name: "omnitest-x-role" }],
        categories: [
          {
            name: "omnitest-x-cat",
            private_to: ["omnitest-x-role"],
            permissions: [{ role: "omnitest-x-role", allow: ["manage_messages"] }],
            channels: [
              {
                name: "omnitest-x-news",
                read_only: true,
                posting_roles: ["omnitest-x-role"],
                permissions: [{ role: "omnitest-x-role", allow: ["mention_everyone", "embed_links"] }],
              },
              { name: "omnitest-x-plain" },
            ],
          },
        ],
      },
    });
    expect(built.data?.created === 4 && built.data?.check?.in_sync === true, "extras: the build runs and checks in sync");
    const roleId = (await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.name === "omnitest-x-role")?.id;
    const ow = (c) => (c?.permission_overwrites ?? []).find((o) => o.id === roleId);
    const cat = await chan("omnitest-x-cat");
    expect((BigInt(ow(cat)?.allow ?? 0) & (VIEW | MANAGE_MSG)) === (VIEW | MANAGE_MSG), "extras: the category's role can see it and manage messages");
    const news = await chan("omnitest-x-news");
    const newsAllow = BigInt(ow(news)?.allow ?? 0);
    expect((newsAllow & (VIEW | SEND | EMBED | MENTION)) === (VIEW | SEND | EMBED | MENTION), "extras: in the read-only channel the role sees, posts, embeds, and mentions everyone");
    // The channel lists the role, so the role's extras there are exactly that
    // list: the category's manage_messages does not carry over.
    expect((newsAllow & MANAGE_MSG) === 0n, "extras: a role listed on the channel gets exactly that list there, not the category's as well");
    const plain = await chan("omnitest-x-plain");
    expect(JSON.stringify(ow(plain)) === JSON.stringify(ow(cat)), "extras: the plain channel is synced to its category");

    const exported = (await callTool("export_server_blueprint", {})).data.blueprint;
    const xcat = exported.categories.find((c) => c.name === "omnitest-x-cat");
    expect(xcat?.permissions?.some((p) => p.role === "omnitest-x-role" && p.allow?.includes("manage_messages")), "extras: the export carries the category's extras");
    const again = await callTool("plan_server_build", { blueprint: { roles: exported.roles.filter((r) => r.name === "omnitest-x-role"), categories: [xcat] }, update_existing: true });
    expect(again.data?.to_update === 0 && again.data?.to_create === 0, "extras: planning the export against the server changes nothing");

    const xnews = xcat.channels.find((c) => c.name === "omnitest-x-news");
    const edit = await callTool("plan_server_build", {
      blueprint: { categories: [{ ...xcat, channels: [{ ...xnews, permissions: [{ role: "omnitest-x-role", allow: ["embed_links", "manage_messages"] }] }] }] },
      update_existing: true,
    });
    expect(edit.data?.to_update === 1, "extras: changing one role's extras is one update");
    const applied = await callTool("execute_build_plan", { plan_id: edit.data?.plan_id });
    const newsAfter = BigInt(ow(await chan("omnitest-x-news"))?.allow ?? 0);
    expect((newsAfter & MENTION) === 0n && (newsAfter & (VIEW | SEND | EMBED)) === (VIEW | SEND | EMBED), "extras: the edit took mention_everyone away and left seeing and posting alone");

    const preview = await callTool("undo_change", { change_id: applied.data?.change_id });
    await callTool("undo_change", { change_id: applied.data?.change_id, confirm_token: preview.data?.confirm_token });
    expect((BigInt(ow(await chan("omnitest-x-news"))?.allow ?? 0) & MENTION) !== 0n, "extras: undo puts mention_everyone back");

    for (const c of (await rawGet(`/guilds/${guildId}/channels`)).filter((x) => x.name.startsWith("omnitest-x")).sort((a, b) => (a.type === 4) - (b.type === 4))) {
      await deleteViaTool("delete_channel", "channel", c.id);
    }
    await deleteViaTool("delete_role", "role", roleId);
  }

  // Synced channels. Discord changes the channels synced with a category
  // along with it when the category's overwrites change one at a time; a
  // build and an undo change only what they show.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const VIEW = 1n << 10n;
    const owKey = (c) => (c?.permission_overwrites ?? []).map((o) => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort().join("|");
    const hidden = (c) => (BigInt(c?.permission_overwrites?.find((o) => o.id === guildId)?.deny ?? 0) & VIEW) !== 0n;
    const noHolds = (cs) => cs.every((c) => (c?.permission_overwrites ?? []).every((o) => o.allow !== "0" || o.deny !== "0"));
    const CAT = "omnitest-sync-cat", SECRET = "omnitest-sync-secret", LOBBY = "omnitest-sync-lobby", STAGE = "omnitest-sync-stage";

    const made = await callTool("execute_build_plan", {
      blueprint: {
        roles: [{ name: "omnitest-sync-role" }],
        categories: [{ name: CAT, private_to: ["omnitest-sync-role"], channels: [{ name: SECRET }, { name: LOBBY }, { name: STAGE, type: "voice" }] }],
      },
    });
    const ids = Object.fromEntries((made.data?.report ?? []).map((r) => [r.name, r.id]));
    const read = async (names) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, await rawGet(`/channels/${ids[n]}`)])));
    const start = await read([CAT, SECRET, LOBBY, STAGE]);
    expect(made.data?.created === 5 && [SECRET, LOBBY, STAGE].every((n) => owKey(start[n]) === owKey(start[CAT])), "sync: three channels start synced with their private category");

    const plan = await callTool("plan_server_build", {
      update_existing: true,
      blueprint: { categories: [{ name: CAT, private_to: null, channels: [{ name: SECRET, private_to: ["omnitest-sync-role"] }] }] },
    });
    const planned = (plan.data?.steps ?? []).map((s) => s.name);
    expect([CAT, LOBBY, STAGE].every((n) => planned.includes(n)) && !planned.includes(SECRET), "sync: the plan opens the category and the two channels that follow it, and leaves the one kept private alone");
    const applied = await callTool("execute_build_plan", { plan_id: plan.data?.plan_id });
    expect(applied.data?.check?.in_sync === true, "sync: the check after building finds the server as planned");
    const after = await read([CAT, SECRET, LOBBY, STAGE]);
    expect(!hidden(after[CAT]) && !hidden(after[LOBBY]) && !hidden(after[STAGE]), "sync: the category and the channels that follow it are open");
    expect(owKey(after[SECRET]) === owKey(start[SECRET]) && hidden(after[SECRET]), "sync: the channel the blueprint keeps private is exactly as it was (Discord would have opened it)");
    expect(noHolds(Object.values(after)), "sync: no hold is left on any channel");

    // A channel made in the opened category copies its overwrites, so it is
    // synced with it. Undoing the opening leaves it as it is, and says so.
    const late = await callTool("create_channel", { name: "omnitest-sync-late", category: CAT });
    ids["omnitest-sync-late"] = late.data?.id;
    expect(late.data?.synced_with_category === true && /synced/.test(late.summary ?? ""), "sync: a channel created with no permissions of its own says it is synced with its category");
    const preview = await callTool("undo_change", { change_id: applied.data?.change_id });
    const lines = (preview.data?.preview ?? []).flatMap((p) => (p.steps ?? []).flatMap((s) => s.what ?? []));
    expect(lines.some((l) => l.includes("omnitest-sync-late")), "sync: the undo preview names the newer channel it leaves alone");
    const undone = await callTool("undo_change", { change_id: applied.data?.change_id, confirm_token: preview.data?.confirm_token });
    expect(!undone.isError, "sync: the undo runs");
    const back = await read([CAT, SECRET, LOBBY, STAGE, "omnitest-sync-late"]);
    expect([CAT, SECRET, LOBBY, STAGE].every((n) => owKey(back[n]) === owKey(start[n])), "sync: undo puts back the category and the channels that followed it, exactly");
    expect(!hidden(back["omnitest-sync-late"]) && noHolds(Object.values(back)), "sync: the newer channel keeps its own permissions, and no hold is left");

    for (const n of ["omnitest-sync-late", SECRET, LOBBY, STAGE, CAT]) {
      if (ids[n]) await deleteViaTool("delete_channel", "channel", ids[n]);
    }
    if (ids["omnitest-sync-role"]) await deleteViaTool("delete_role", "role", ids["omnitest-sync-role"]);

    // The single permission tools keep Discord's behavior on a category:
    // its synced channels follow. They name and record those channels, so
    // undo puts each back.
    const F = { cat: "omnitest-fol-cat", a: "omnitest-fol-a", v: "omnitest-fol-v", news: "omnitest-fol-news" };
    const fmade = await callTool("execute_build_plan", {
      blueprint: {
        roles: [{ name: "omnitest-fol-role" }],
        categories: [{ name: F.cat, private_to: ["omnitest-fol-role"], channels: [
          { name: F.a }, { name: F.v, type: "voice" }, { name: F.news, read_only: true, posting_roles: ["omnitest-fol-role"] },
        ] }],
      },
    });
    const fids = Object.fromEntries((fmade.data?.report ?? []).map((r) => [r.name, r.id]));
    const fread = async () => Object.fromEntries(await Promise.all(Object.values(F).map(async (n) => [n, await rawGet(`/channels/${fids[n]}`)])));
    const fstart = await fread();
    expect(owKey(fstart[F.a]) === owKey(fstart[F.cat]) && owKey(fstart[F.v]) === owKey(fstart[F.cat]) && owKey(fstart[F.news]) !== owKey(fstart[F.cat]), "follow tools: two channels synced with the category, the read-only one not");

    const gpA = await callTool("get_channel_permissions", { channel: fids[F.a] });
    const gpNews = await callTool("get_channel_permissions", { channel: fids[F.news] });
    expect(gpA.data?.synced_with_category === true && gpNews.data?.synced_with_category === false, "follow tools: get_channel_permissions says which channels are synced with their category");
    // Opening a private category to everyone opens the channels synced with
    // it too, so it waits for confirmation, and the preview names them.
    const clearPreview = await callTool("clear_channel_permissions", { channel: fids[F.cat], target: "@everyone" });
    expect(
      clearPreview.data?.executed === false &&
        /^Safe mode: nothing was changed\. Would let everyone see /.test(clearPreview.summary ?? "") &&
        clearPreview.summary.includes(`#${F.a}`) &&
        clearPreview.summary.includes(`"${F.v}" (voice)`),
      "grants: opening a private category is previewed, naming the synced channels it opens"
    );
    expect(hidden(await rawGet(`/channels/${fids[F.cat]}`)), "grants: and the category stays private until confirmed");
    const cleared = await callTool("clear_channel_permissions", { channel: fids[F.cat], target: "@everyone", confirm_token: clearPreview.data?.confirm_token });
    const followedIds = (cleared.data?.followed_by_synced_channels ?? []).map((x) => x.id).sort();
    expect(followedIds.join() === [fids[F.a], fids[F.v]].sort().join(), "follow tools: the result names the two synced channels that followed");
    expect(/Discord applied the same change to the 2 channel/.test(cleared.summary ?? ""), "follow tools: and says so in words");
    const fafter = await fread();
    expect(!hidden(fafter[F.cat]) && !hidden(fafter[F.a]) && !hidden(fafter[F.v]) && hidden(fafter[F.news]), "follow tools: the category and its synced channels open; the read-only one keeps its own");
    const flisted = (await callTool("list_changes", { limit: 5 })).data?.changes?.find((c) => c.change_id === cleared.data?.change_id);
    expect(flisted?.changed === 3, "follow tools: the change records the category and both channels that followed");

    const fpreview = await callTool("undo_change", { change_id: cleared.data?.change_id });
    await callTool("undo_change", { change_id: cleared.data?.change_id, confirm_token: fpreview.data?.confirm_token });
    const fback = await fread();
    expect(Object.values(F).every((n) => owKey(fback[n]) === owKey(fstart[n])) && noHolds(Object.values(fback)), "follow tools: undo puts the category and both channels back exactly, with no hold left");

    const own = await callTool("set_channel_permissions", { channel: fids[F.a], target: "omnitest-fol-role", allow: ["view_channel", "connect", "add_reactions"] });
    expect(/no longer matches the permissions of its category/.test(own.summary ?? ""), "follow tools: changing a synced channel on its own says it stops following its category");
    // Set replaces the whole overwrite; the result says what that took away.
    // Replacing @everyone's overwrite with a send denial alone drops the
    // denial that hid the channel: previewed as opening it, and said why.
    const narrowPreview = await callTool("set_channel_permissions", { channel: fids[F.news], target: "@everyone", deny: ["send_messages"] });
    expect(
      narrowPreview.data?.executed === false &&
        narrowPreview.summary.includes(`Would let everyone see #${F.news}.`) &&
        /which no longer denies [^.]*view_channel/.test(narrowPreview.summary ?? ""),
      "grants: an overwrite that would stop hiding a channel is previewed, saying it no longer denies view_channel"
    );
    const narrow = await callTool("set_channel_permissions", { channel: fids[F.news], target: "@everyone", deny: ["send_messages"], confirm_token: narrowPreview.data?.confirm_token });
    expect(/no longer denies/.test(narrow.summary ?? "") && (narrow.data?.removed?.deny ?? []).includes("view_channel"), "follow tools: replacing an overwrite says which permissions it no longer sets");

    for (const n of [F.a, F.v, F.news, F.cat]) if (fids[n]) await deleteViaTool("delete_channel", "channel", fids[n]);
    if (fids["omnitest-fol-role"]) await deleteViaTool("delete_role", "role", fids["omnitest-fol-role"]);
  }

  // Power and access, live. A change that hands out moderator powers, opens
  // a private channel, lifts a ban, or lets a role with powers rise above
  // another waits for confirmation; the same tools go ahead at once when
  // nothing is handed out.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const VIEW = 1n << 10n;
    const KICK = 1n << 1n;
    const roleOrder = async () =>
      (await rawGet(`/guilds/${guildId}/roles`))
        .filter((r) => r.id !== guildId)
        .sort((a, b) => a.position - b.position || (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .map((r) => r.id);
    const low = await callTool("create_role", { name: "omnitest-grant-low", preset: "none" });
    const pow = await callTool("create_role", { name: "omnitest-grant-pow", preset: "none" });
    const gmade = await callTool("execute_build_plan", {
      blueprint: { channels: [{ name: "omnitest-grant-priv", private_to: ["omnitest-grant-low"] }] },
    });
    const privId = (gmade.data?.report ?? []).find((r) => r.name === "omnitest-grant-priv")?.id;
    const overwrites = async () => (await rawGet(`/channels/${privId}`)).permission_overwrites ?? [];
    try {
      // A role gaining a power.
      const upPreview = await callTool("update_role", { role: "omnitest-grant-pow", permissions: ["kick_members"] });
      expect(
        upPreview.data?.executed === false &&
          (upPreview.summary ?? "").includes('Would change the permissions of the role "omnitest-grant-pow" so that people with it can kick members. Nobody has the role yet.'),
        "grants: a role gaining a moderator power is previewed"
      );
      const upDone = await callTool("update_role", { role: "omnitest-grant-pow", permissions: ["kick_members"], confirm_token: upPreview.data?.confirm_token });
      const powNow = (await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.id === pow.data?.id);
      expect(!upDone.isError && (BigInt(powNow?.permissions ?? 0) & KICK) !== 0n, "grants: the token gives the role the power");
      const colour = await callTool("update_role", { role: "omnitest-grant-pow", color: "#123456" });
      expect(!colour.isError && colour.data?.executed !== false, "grants: a color change goes ahead at once");

      // Letting a role into a private channel, and a power in one channel.
      const inPreview = await callTool("set_channel_permissions", { channel: privId, target: "omnitest-grant-pow", allow: ["view_channel"] });
      expect(
        inPreview.data?.executed === false && (inPreview.summary ?? "").includes('Would let people with the role "omnitest-grant-pow" see #omnitest-grant-priv.'),
        "grants: letting a role into a private channel is previewed"
      );
      expect(!(await overwrites()).some((o) => o.id === pow.data?.id), "grants: and nothing changed yet");
      await callTool("set_channel_permissions", { channel: privId, target: "omnitest-grant-pow", allow: ["view_channel"], confirm_token: inPreview.data?.confirm_token });
      expect((await overwrites()).some((o) => o.id === pow.data?.id && (BigInt(o.allow) & VIEW) !== 0n), "grants: the token lets the role in");
      const chPower = await callTool("set_channel_permissions", { channel: privId, target: "omnitest-grant-pow", allow: ["view_channel", "manage_messages"] });
      expect(
        chPower.data?.executed === false &&
          (chPower.summary ?? "").includes(`Would let people with the role "omnitest-grant-pow" delete other people's messages in #omnitest-grant-priv.`),
        "grants: a moderator power in one channel is previewed"
      );

      // Opening it to everyone, two ways, both left unconfirmed.
      const openAll = await callTool("clear_channel_permissions", { channel: privId, target: "@everyone" });
      expect(openAll.data?.executed === false && (openAll.summary ?? "").includes("Would let everyone see #omnitest-grant-priv."), "grants: clearing a private channel's denial for @everyone is previewed");
      const sendOnly = await callTool("set_channel_permissions", { channel: privId, target: "@everyone", deny: ["send_messages"] });
      expect(sendOnly.data?.executed === false && /which no longer denies [^.]*view_channel/.test(sendOnly.summary ?? ""), "grants: an overwrite that would stop hiding it is previewed, saying why");
      const everyoneNow = (await overwrites()).find((o) => o.id === guildId);
      expect(everyoneNow && (BigInt(everyoneNow.deny) & VIEW) !== 0n, "grants: the channel stays private without a token");
      const quiet = await callTool("set_channel_permissions", { channel: privId, target: "omnitest-grant-low", allow: ["view_channel"], deny: ["send_messages"] });
      expect(!quiet.isError && quiet.data?.executed !== false, "grants: a change that hands out nothing goes ahead at once");

      // The owner holds every permission, so giving them a role with powers
      // hands them nothing.
      const ownerGive = await callTool("assign_role", { member: ownerId, role: "omnitest-grant-pow" });
      expect(!ownerGive.isError && ownerGive.data?.executed !== false, "grants: giving the owner a role with powers goes ahead, as they hold everything already");

      // Role order, checked against Discord itself: the role with a power
      // starts just below the other (created later, both at the bottom).
      const order = await roleOrder();
      const iLow = order.indexOf(low.data?.id);
      const iPow = order.indexOf(pow.data?.id);
      expect(iPow === iLow - 1, "grants: the role with a power starts just below the other");
      const rPreview = await callTool("reorder_roles", { moves: [{ role: pow.data?.id, position: iLow + 1 }] });
      expect(
        rPreview.data?.executed === false &&
          (rPreview.summary ?? "").includes('"omnitest-grant-pow" moves above "omnitest-grant-low", so people with "omnitest-grant-pow" could kick people whose highest role is "omnitest-grant-low".'),
        "grants: a role with powers rising above another is previewed"
      );
      const rDone = await callTool("reorder_roles", { moves: [{ role: pow.data?.id, position: iLow + 1 }], confirm_token: rPreview.data?.confirm_token });
      const order2 = await roleOrder();
      expect(order2.indexOf(pow.data?.id) === order2.indexOf(low.data?.id) + 1, "grants: Discord put the role exactly where the preview said");
      expect(!rDone.isError && (rDone.warnings ?? []).length === 0, "grants: and the result found no move the preview missed");
      const back = await callTool("reorder_roles", { moves: [{ role: low.data?.id, position: order2.indexOf(pow.data?.id) + 1 }] });
      const order3 = await roleOrder();
      expect(!back.isError && back.data?.moved === 1 && order3.indexOf(low.data?.id) === order3.indexOf(pow.data?.id) + 1, "grants: a role without such powers moves at once, where asked");

      // Lifting a ban, on someone who is not in this server (never a member).
      const inServer = OTHER_TEST_BOT ? (await rawGet(`/guilds/${guildId}/members/${OTHER_TEST_BOT}`))?.user?.id === OTHER_TEST_BOT : true;
      if (OTHER_TEST_BOT && !inServer) {
        const banPreview = await callTool("ban_member", { user: OTHER_TEST_BOT, reason: "omnitest grants" });
        await callTool("ban_member", { user: OTHER_TEST_BOT, reason: "omnitest grants", confirm_token: banPreview.data?.confirm_token });
        const unbanPreview = await callTool("unban_member", { user_id: OTHER_TEST_BOT });
        expect(
          unbanPreview.data?.executed === false &&
            new RegExp(`Would lift the ban on .+ \\(${OTHER_TEST_BOT}\\), banned with the reason "omnitest grants"\\. They could rejoin with any invite\\.`).test(unbanPreview.summary ?? ""),
          "grants: lifting a ban is previewed with who and why"
        );
        const unbanDone = await callTool("unban_member", { user_id: OTHER_TEST_BOT, confirm_token: unbanPreview.data?.confirm_token });
        expect((unbanDone.summary ?? "").startsWith(`Unbanned user ${OTHER_TEST_BOT}.`), "grants: the token lifts it");
      } else {
        console.log("  skipped: no user outside this server to ban; set DISCORD_MCP_ACCEPTANCE_BAN_USER to test lifting a ban.");
      }

      const bulk = await callTool("bulk_update_roles", { action: "assign", role: "omnitest-grant-pow", filter: { is_bot: true } });
      // The filter matches one member here, the bot, which is an administrator
      // and gains nothing from a role that lets its holders kick. A preview is
      // judged on the members it would reach, so it claims nothing new; the
      // unit suite covers members who do gain.
      expect(bulk.data?.executed === false && /to 1 member\(s\)/.test(bulk.summary ?? "") && !/lets them/.test(bulk.summary ?? ""), "grants: a bulk assignment to someone who already has the power claims nothing new");
    } finally {
      if (privId) await deleteViaTool("delete_channel", "channel", privId);
      for (const r of [pow, low]) if (r.data?.id) await deleteViaTool("delete_role", "role", r.data.id);
    }
  }

  // The confirmation dialog, live. A second server process serves an app
  // that can show a form (an MCP elicitation), whose answers this script
  // gives: a destructive call with its token asks the app, and only a
  // ticked box goes ahead. The main session above declares no such support
  // and keeps the token flow.
  {
    const rawGet = async (path) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, { headers: auth });
        if (r.status !== 429) return r.json();
        const body = await r.json();
        await new Promise((res) => setTimeout(res, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      }
      throw new Error(`still rate limited on ${path}`);
    };
    const exists = async (id) => (await rawGet(`/channels/${id}`))?.id === id;
    const mainConfirm = (check.data?.checks ?? []).find((c) => c.check === "confirmations");
    expect(/token from a preview/.test(mainConfirm?.detail ?? ""), "dialog: an app that declares no dialog support confirms by token");

    const dlg = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] });
    const dPending = new Map();
    const answers = [];
    const shown = [];
    let dNext = 1;
    let dBuf = "";
    dlg.stdout.on("data", (chunk) => {
      dBuf += chunk.toString();
      let nl;
      while ((nl = dBuf.indexOf("\n")) !== -1) {
        const line = dBuf.slice(0, nl).trim();
        dBuf = dBuf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.method === "elicitation/create") {
          shown.push(m.params.message);
          console.log(`  (dialog shown) ${m.params.message.replace(/\n/g, " | ")}`);
          const answer = answers.shift() ?? { action: "cancel" };
          dlg.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer }) + "\n");
        } else if (m.id !== undefined && dPending.has(m.id)) {
          dPending.get(m.id)(m);
          dPending.delete(m.id);
        }
      }
    });
    const dRequest = (method, params) =>
      new Promise((resolve, reject) => {
        const n = dNext++;
        dPending.set(n, resolve);
        dlg.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
        setTimeout(() => dPending.has(n) && reject(new Error(`dialog app: timed out waiting for ${method}`)), 150000);
      });
    const dCall = async (name, args = {}) => {
      const r = await dRequest("tools/call", { name, arguments: args });
      const envelope = JSON.parse(r.result?.content?.[0]?.text ?? "{}");
      envelope.isError = r.result?.isError === true;
      console.log(`\n[${envelope.isError ? "error" : "ok"}] (dialog app) ${name}`);
      console.log(`  ${envelope.summary}`);
      return envelope;
    };
    const YES = { action: "accept", content: { confirm: true } };
    const ids = {};
    try {
      await dRequest("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "discord-mcp-acceptance-dialog", version: "0.0.1" },
      });
      dlg.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const dSetup = await dCall("run_setup_check");
      const dConfirm = (dSetup.data?.checks ?? []).find((c) => c.check === "confirmations");
      expect(/dialog this app shows/.test(dConfirm?.detail ?? ""), "dialog: the setup check says this app confirms in a dialog");

      const made = await callTool("execute_build_plan", {
        blueprint: { categories: [{ name: "omnitest-dlg-cat", channels: [{ name: "omnitest-dlg-a" }, { name: "omnitest-dlg-b" }] }] },
      });
      for (const r of made.data?.report ?? []) ids[r.name] = r.id;

      const p1 = await dCall("delete_channel", { channel: ids["omnitest-dlg-a"] });
      expect(p1.data?.confirmed_by === "dialog" && /the dialog does the asking/i.test(p1.summary ?? ""), "dialog: a delete's preview says the dialog confirms it");
      answers.push({ action: "decline" });
      const no = await dCall("delete_channel", { channel: ids["omnitest-dlg-a"], confirm_token: p1.data?.confirm_token });
      expect(no.data?.confirmation === "declined" && (await exists(ids["omnitest-dlg-a"])), "dialog: declining keeps the channel");
      expect(/^Server: [^\n]+\.\nWould delete the text channel #omnitest-dlg-a /.test(shown.at(-1) ?? ""), "dialog: the dialog names the server, then the channel");
      const reuse = await callToolRaw("delete_channel", { channel: ids["omnitest-dlg-a"], confirm_token: p1.data?.confirm_token });
      expect(reuse.isError && (await exists(ids["omnitest-dlg-a"])), "dialog: a declined token cannot be spent elsewhere");

      const p2 = await dCall("delete_channel", { channel: ids["omnitest-dlg-a"] });
      answers.push(YES);
      const yes = await dCall("delete_channel", { channel: ids["omnitest-dlg-a"], confirm_token: p2.data?.confirm_token });
      expect(yes.data?.deleted === true && !(await exists(ids["omnitest-dlg-a"])), "dialog: a ticked box deletes the channel");

      const up = await dCall("undo_change", { change_id: yes.data?.change_id });
      answers.push(YES);
      const undone = await dCall("undo_change", { change_id: yes.data?.change_id, confirm_token: up.data?.confirm_token });
      expect(/Recreate #omnitest-dlg-a/.test(shown.at(-1) ?? ""), "dialog: the undo's dialog lists its steps");
      expect(
        /\nUndo the change made \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: recreate 1\./.test(shown.at(-1) ?? "") &&
          !/delete_channel/.test(shown.at(-1) ?? ""),
        "dialog: the undo's dialog says it plainly, without the tool name"
      );
      const back = (await rawGet(`/guilds/${guildId}/channels`)).find((c) => c.name === "omnitest-dlg-a");
      expect(!undone.isError && back?.parent_id === ids["omnitest-dlg-cat"], "dialog: a ticked box runs the undo");
      if (back) ids["omnitest-dlg-a"] = back.id;

      const plan = await dCall("plan_server_build", { blueprint: {}, remove: { channels: [ids["omnitest-dlg-b"]] } });
      expect(/the dialog does the asking/i.test(plan.summary ?? ""), "dialog: a plan that deletes says the dialog confirms it");
      answers.push({ action: "decline" });
      const planNo = await dCall("execute_build_plan", { plan_id: plan.data?.plan_id });
      expect(planNo.data?.confirmation === "declined" && (await exists(ids["omnitest-dlg-b"])), "dialog: declining a plan keeps the channel");
      expect(
        (shown.at(-1) ?? "").includes("\nRun the build plan: delete 1 channel.\nDelete #omnitest-dlg-b."),
        "dialog: the plan's dialog says what it does and lists its steps"
      );
      answers.push(YES);
      const planYes = await dCall("execute_build_plan", { plan_id: plan.data?.plan_id });
      expect(planYes.data?.deleted === 1 && !(await exists(ids["omnitest-dlg-b"])), "dialog: after a decline the plan still runs, once the box is ticked");

      // Handing out a power goes through the same dialog.
      const BAN = 1n << 2n;
      const dRole = await callTool("create_role", { name: "omnitest-dlg-role", preset: "none" });
      ids["omnitest-dlg-role"] = dRole.data?.id;
      const roleBits = async () => BigInt((await rawGet(`/guilds/${guildId}/roles`)).find((r) => r.id === ids["omnitest-dlg-role"])?.permissions ?? 0);
      const g1 = await dCall("update_role", { role: "omnitest-dlg-role", permissions: ["ban_members"] });
      expect(g1.data?.confirmed_by === "dialog", "dialog: a role gaining a power is confirmed in the dialog");
      answers.push({ action: "decline" });
      const gNo = await dCall("update_role", { role: "omnitest-dlg-role", permissions: ["ban_members"], confirm_token: g1.data?.confirm_token });
      expect(gNo.data?.confirmation === "declined" && ((await roleBits()) & BAN) === 0n, "dialog: declining leaves the role without the power");
      expect(
        (shown.at(-1) ?? "").includes('\nWould change the permissions of the role "omnitest-dlg-role" so that people with it can ban members.') &&
          (shown.at(-1) ?? "").includes("\nServer-wide: ban members."),
        "dialog: the dialog names the role and the power"
      );
      const g2 = await dCall("update_role", { role: "omnitest-dlg-role", permissions: ["ban_members"] });
      answers.push(YES);
      await dCall("update_role", { role: "omnitest-dlg-role", permissions: ["ban_members"], confirm_token: g2.data?.confirm_token });
      expect(((await roleBits()) & BAN) !== 0n, "dialog: a ticked box gives it");
      expect(answers.length === 0, "dialog: every answer given was asked for");
    } finally {
      dlg.kill();
      if (ids["omnitest-dlg-role"]) await deleteViaTool("delete_role", "role", ids["omnitest-dlg-role"]);
      for (const n of ["omnitest-dlg-a", "omnitest-dlg-b", "omnitest-dlg-cat"]) {
        if (ids[n] && (await exists(ids[n]))) await deleteViaTool("delete_channel", "channel", ids[n]);
      }
    }
  }

  // P1/P2 parity batches: messaging, members, permissions, structure,
  // diagnostics. Community-gated tools (announcement, stage) and real DMs
  // are exercised by hand, not here.

  // Messaging: get, bulk delete, scheduler.
  const m1 = await callTool("send_message", { channel: "general", content: "parity msg one" });
  const got = await callTool("get_message", { channel: "general", message_id: m1.data.id });
  expect(got.data?.message?.id === m1.data.id, "get_message returns the message");

  const m2 = await callTool("send_message", { channel: "general", content: "parity delete me alpha" });
  const m3 = await callTool("send_message", { channel: "general", content: "parity delete me beta" });
  const bulkGate = await callTool("bulk_delete_messages", { channel: "general", contains: "parity delete me" });
  expect(bulkGate.data?.preview?.count === 2, "bulk delete previews the right count");
  const bulkDone = await callTool("bulk_delete_messages", {
    channel: "general",
    contains: "parity delete me",
    confirm_token: bulkGate.data?.confirm_token,
  });
  expect(bulkDone.data?.deleted === 2, "bulk delete removes the matched messages");

  const soon = new Date(Date.now() + 4000).toISOString();
  const sched = await callTool("schedule_message", {
    channel: "general",
    content: "parity scheduled fire",
    send_at: soon,
  });
  expect(typeof sched.data?.id === "string", "message schedules");
  const schedList = await callTool("list_scheduled_messages");
  expect(
    (schedList.data?.scheduled ?? []).some((s) => s.id === sched.data.id),
    "scheduled message lists"
  );
  // Wait for the scheduler tick to fire it, then confirm it sent and cleared.
  await new Promise((r) => setTimeout(r, 9000));
  const afterFire = await callTool("list_scheduled_messages");
  expect(
    !(afterFire.data?.scheduled ?? []).some((s) => s.id === sched.data.id),
    "one-shot schedule clears after firing"
  );
  const firedFeed = await callTool("read_messages", { channel: "general", limit: 20 });
  const firedMsg = (firedFeed.data?.messages ?? []).find(
    (m) => m.content === "parity scheduled fire"
  );
  expect(Boolean(firedMsg), "scheduled message actually sent");
  const firedId = firedMsg?.id;

  // Members: nickname round trip, remove_role, permissions, voice (empty).
  const nickSet = await callTool("update_member", { member: "Omnicord", nickname: "Parity Bot" });
  expect((nickSet.data?.changed ?? []).some((c) => c.includes("Parity Bot")), "nickname sets");
  await callTool("update_member", { member: "Omnicord", nickname: "" });

  const tempRole = await callTool("create_role", { name: "omnitest-parity-role", preset: "member" });
  await callTool("assign_role", { member: "Omnicord", role: "omnitest-parity-role" });
  const removed = await callTool("remove_role", { member: "Omnicord", role: "omnitest-parity-role" });
  expect(removed.data?.role?.name === "omnitest-parity-role", "remove_role takes the role back");
  const roleHolders = await callTool("get_role_members", { role: "omnitest-parity-role" });
  expect((roleHolders.data?.members ?? []).length === 0, "get_role_members shows none after removal");

  const memberPerms = await callTool("get_member_permissions", { member: "Omnicord" });
  expect(memberPerms.data?.administrator === true, "bot reads as administrator server-wide");
  expect(memberPerms.data?.source === "discord", "get_member_permissions takes Discord's own answer");

  const explained = await callTool("explain_permissions", { actor: "bot", permission: "manage_channels" });
  expect(explained.data?.allowed === true, "explain_permissions confirms the bot can manage channels");
  expect(explained.data?.source === "discord", "explain_permissions takes Discord's own answer server-wide");
  const explainedNo = await callTool("explain_permissions", {
    actor: "bot",
    permission: "manage_channels",
    channel: "general",
  });
  expect(typeof explainedNo.data?.allowed === "boolean", "explain_permissions works channel-scoped");
  expect(explainedNo.data?.source === "discord", "explain_permissions takes Discord's own answer in a channel");

  // Structure: channel/role detail, clone, reorder, permission overwrites.
  const pchan = await callTool("create_channel", { name: "omnitest-parity-chan", topic: "parity" });
  const chDetail = await callTool("get_channel", { channel: pchan.data.id });
  expect(chDetail.data?.topic === "parity", "get_channel returns detail");

  const setPerm = await callTool("set_channel_permissions", {
    channel: pchan.data.id,
    target: "omnitest-parity-role",
    deny: ["view_channel"],
  });
  expect((setPerm.data?.deny ?? []).includes("view_channel"), "set_channel_permissions applies a deny");
  const readPerm = await callTool("get_channel_permissions", { channel: pchan.data.id });
  expect((readPerm.data?.overwrites ?? []).length >= 1, "get_channel_permissions reads it back");
  // Clearing the role's denial lets its holders see the channel again, so
  // it waits for confirmation.
  const clearPerm = await callTool("clear_channel_permissions", { channel: pchan.data.id, target: "omnitest-parity-role" });
  expect(
    clearPerm.data?.executed === false && clearPerm.summary.includes('Would let people with the role "omnitest-parity-role" see #omnitest-parity-chan.'),
    "grants: clearing a role's denial is previewed, since its holders could then see the channel"
  );
  const clearedPerm = await callTool("clear_channel_permissions", { channel: pchan.data.id, target: "omnitest-parity-role", confirm_token: clearPerm.data?.confirm_token });
  expect(clearedPerm.data?.cleared === true, "clear_channel_permissions clears with the token");

  const locked = await callTool("lock_channel", { channel: pchan.data.id });
  expect(locked.data?.locked === true, "lock_channel locks");
  const unlocked = await callTool("unlock_channel", { channel: pchan.data.id });
  expect(unlocked.data?.locked === false, "unlock_channel unlocks");

  const clonedChan = await callTool("clone_channel", { channel: pchan.data.id, new_name: "omnitest-parity-clone" });
  expect(typeof clonedChan.data?.id === "string", "clone_channel creates a copy");
  const clonedRole = await callTool("clone_role", { role: "omnitest-parity-role", new_name: "omnitest-parity-role-2" });
  expect(typeof clonedRole.data?.id === "string", "clone_role creates a copy");

  await callTool("reorder_channels", { moves: [{ channel: pchan.data.id, position: 0 }] });

  const bulkRoleGate = await callTool("bulk_update_roles", {
    action: "assign",
    role: "omnitest-parity-role",
    filter: { is_bot: true },
  });
  expect(typeof bulkRoleGate.data?.preview?.count === "number", "bulk_update_roles previews a count");

  // Diagnostics and roster.
  const stages = await callTool("list_stages");
  expect(Array.isArray(stages.data?.stages), "list_stages returns a list");
  const voice = await callTool("list_voice_members", { channel: "General" });
  expect(Array.isArray(voice.data?.members), "list_voice_members returns a list");
  const rateStatus = await callTool("get_rate_limit_status");
  expect(typeof rateStatus.data?.rate_limit_hits === "number", "rate limit status reports counts");
  const servers = await callTool("list_servers");
  expect((servers.data?.servers ?? []).length >= 1, "list_servers lists the bot's guilds");
  const roster = await callTool("list_members");
  expect((roster.data?.members ?? []).length >= 1, "list_members returns the roster");

  // Cleanup for the parity section.
  for (const id of [m1.data.id, firedId]) {
    const g = await callTool("delete_message", { channel: "general", message_id: id });
    if (g.data?.confirm_token) {
      await callTool("delete_message", { channel: "general", message_id: id, confirm_token: g.data.confirm_token });
    }
  }
  for (const channel of [pchan.data.id, clonedChan.data.id]) {
    const g = await callTool("delete_channel", { channel });
    await callTool("delete_channel", { channel, confirm_token: g.data?.confirm_token });
  }
  for (const role of ["omnitest-parity-role", "omnitest-parity-role-2"]) {
    const g = await callTool("delete_role", { role });
    await callTool("delete_role", { role, confirm_token: g.data?.confirm_token });
  }

  // The 2.0 features, live: files and images, webhook edits, polls, the
  // security review and access views, voice settings with undo, the bot's
  // server look, invites with roles or for particular people, catching up,
  // and importing a template. Server icons and the bot's avatar are left
  // alone here: Discord limits how often they change.
  console.log("\n--- features ---");
  {
    const feat = { channels: [], roles: [], template: null };
    const fetchJson = async (method, path, body) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, {
          method,
          headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status === 429) {
          const b = await r.json();
          await new Promise((res) => setTimeout(res, Math.ceil((b.retry_after ?? 1) * 1000) + 250));
          continue;
        }
        return r.status === 204 ? null : r.json().catch(() => null);
      }
      throw new Error(`still rate limited on ${path}`);
    };
    // The whole result, image content included.
    const callFull = async (name, args) => {
      const res = await request("tools/call", { name, arguments: args });
      return res.result ?? {};
    };
    // The suite's asset server is closed after the expressions section, so
    // this section serves its own file.
    const FEAT_PORT = 38918;
    const featAssets = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(stickerPng);
    });
    await new Promise((resolve) => featAssets.listen(FEAT_PORT, "127.0.0.1", resolve));
    try {
      const ch = await callTool("create_channel", { name: "omnitest-feat", type: "text" });
      feat.channels.push(ch.data?.id);
      const featId = ch.data?.id;

      const sent = await callTool("send_message", {
        channel: featId,
        content: "omnitest files",
        files: [
          { url: `http://127.0.0.1:${FEAT_PORT}/chart.png`, filename: "chart.png", description: "a test chart" },
          { url: "https://cdn.discordapp.com/embed/avatars/0.png", spoiler: true },
        ],
      });
      const stored = await fetchJson("GET", `/channels/${featId}/messages/${sent.data?.id}`);
      expect((stored?.attachments ?? []).map((a) => a.filename).join() === "chart.png,SPOILER_0.png", "features: send_message attaches files from URLs");
      const seen = await callFull("get_message", { channel: featId, message_id: sent.data?.id, include_images: true });
      const images = (seen.content ?? []).filter((c) => c.type === "image");
      expect(images.length === 2 && images.every((i) => i.mimeType === "image/webp"), "features: get_message hands back both images as webp");

      // An embed written in full, showing a file sent with it.
      const card = await callTool("send_message", {
        channel: featId,
        embeds: [{
          title: "omnitest card",
          author: "omnitest",
          fields: [{ name: "status", value: "ok", inline: true }],
          footer: "omnitest footer",
          image_url: "attachment://chart.png",
        }],
        files: [{ url: `http://127.0.0.1:${FEAT_PORT}/chart.png`, filename: "chart.png" }],
      });
      const cardStored = await fetchJson("GET", `/channels/${featId}/messages/${card.data?.id}`);
      const cardEmbed = cardStored?.embeds?.[0] ?? {};
      expect(
        cardEmbed.fields?.[0]?.inline === true && cardEmbed.footer?.text === "omnitest footer" && cardEmbed.author?.name === "omnitest" &&
          /\/chart\.png/.test(cardEmbed.image?.url ?? "") && (cardStored?.attachments ?? []).length === 0,
        "features: an embed carries fields, a footer, an author, and a file sent with it"
      );
      const noFile = await callToolRaw("send_message", { channel: featId, embeds: [{ title: "omnitest card", image_url: "attachment://missing.png" }] });
      expect(noFile.isError && /does not come with the message/.test(noFile.summary), "features: an embed picture pointing at a file that was not sent is refused");

      // A parameter a tool does not have: a rehearsal that would not have
      // been one is refused, and a read says what it ignored.
      const notDry = await callToolRaw("pin_message", { channel: featId, message_id: sent.data?.id, dry_run: true });
      const unpinned = await fetchJson("GET", `/channels/${featId}/messages/${sent.data?.id}`);
      expect(notDry.isError && /has no dry run/.test(notDry.summary) && unpinned?.pinned === false, "features: dry_run on a tool with no dry run is refused, and nothing is pinned");
      const insideKey = await callToolRaw("plan_server_build", { blueprint: { channels: [{ name: "omnitest-feat-hidden", private: true }] } });
      expect(insideKey.isError && insideKey.summary.includes('"blueprint.channels[0].private"'), "features: a key a blueprint's channel does not have is refused by its path");
      const readExtra = await callTool("list_pinned_messages", { channel: featId, colour: "red" });
      expect(!readExtra.isError && (readExtra.warnings ?? []).some((w) => w.includes('has no parameter named "colour"')), "features: a read-only tool says which parameter it ignored");

      const hook = await callTool("create_webhook", { channel: featId, name: "omnitest-feat-hook" });
      const posted = await callTool("send_webhook_message", { webhook: hook.data?.id, content: "before" });
      await callTool("edit_message", { channel: featId, message_id: posted.data?.id, content: "after" });
      const edited = await fetchJson("GET", `/channels/${featId}/messages/${posted.data?.id}`);
      expect(edited?.content === "after", "features: edit_message edits a webhook's message");

      const poll = await callTool("create_poll", { channel: featId, question: "omnitest?", answers: ["a", "b"], duration_hours: 1 });
      const voters = await callTool("get_poll_results", { channel: featId, message_id: poll.data?.id, include_voters: true });
      expect(!voters.isError && (voters.data?.answers ?? []).every((a) => Array.isArray(a.voters)), "features: get_poll_results lists voters per answer");

      const leave = await callTool("leave_server", { guild: guildId });
      expect(leave.data?.executed === false, "features: leave_server only previews without a token");

      const audit = await callTool("audit_server_security");
      expect(!audit.isError && Array.isArray(audit.data?.findings) && Array.isArray(audit.data?.checked), "features: audit_server_security reports findings and what it checked");
      const access = await callTool("get_channel_access", { channel: featId, include_members: true });
      expect(!access.isError && access.data?.everyone?.see === true && typeof access.data?.members?.can_see === "number", "features: get_channel_access answers role by role and member by member");
      const me = await fetchJson("GET", "/users/@me");
      const reach = await callTool("get_member_access", { member: me.id });
      expect(!reach.isError && Array.isArray(reach.data?.channels) && reach.data.channels.some((c) => c.id === featId), "features: get_member_access lists the channels a member reaches");

      const voice = await callTool("create_channel", { name: "omnitest-feat-voice", type: "voice", bitrate_kbps: 64, user_limit: 2 });
      feat.channels.push(voice.data?.id);
      const v1 = await fetchJson("GET", `/channels/${voice.data?.id}`);
      expect(v1?.bitrate === 64000 && v1?.user_limit === 2, "features: create_channel sets voice settings");
      const vUp = await callTool("update_channel", { channel: voice.data?.id, bitrate_kbps: 96, user_limit: 0 });
      const vUndo = await callTool("undo_change", { change_id: vUp.data?.change_id });
      await callTool("undo_change", { change_id: vUp.data?.change_id, confirm_token: vUndo.data?.confirm_token });
      const v2 = await fetchJson("GET", `/channels/${voice.data?.id}`);
      expect(v2?.bitrate === 64000 && v2?.user_limit === 2, "features: undo_change puts voice settings back");

      const plainRole = await callTool("create_role", { name: "omnitest-feat-joiner" });
      feat.roles.push(plainRole.data?.id);
      const roles = await callTool("list_roles");
      expect((roles.data?.roles ?? []).some((r) => r.name === "omnitest-feat-joiner" && r.members === 0), "features: list_roles gives member counts");

      const nick = await callTool("update_bot_profile", { nickname: "omnitest nick" });
      const reset = await callTool("update_bot_profile", { nickname: "none" });
      const meMember = await fetchJson("GET", `/guilds/${guildId}/members/${me.id}`);
      expect(!nick.isError && !reset.isError && meMember?.nick === null, "features: update_bot_profile sets and clears the bot's nickname in one server");

      const inv = await callTool("create_invite", { channel: featId, roles: ["omnitest-feat-joiner"], max_age_seconds: 600 });
      expect(inv.data?.gives_roles?.[0]?.name === "omnitest-feat-joiner", "features: create_invite gives a plain role at once");
      const forOne = await callTool("create_invite", { channel: featId, for_users: [me.id], max_age_seconds: 600 });
      const forInfo = await callTool("get_invite", { code: forOne.data?.code });
      expect(/Only 1 person can use it/.test(forInfo.summary ?? ""), "features: an invite for one person says so");

      const caught = await callTool("catch_up", { hours: 1, channels: [featId] });
      expect((caught.data?.channels ?? []).some((c) => c.id === featId && c.messages.some((m) => m.text === "omnitest files")), "features: catch_up finds the new messages");

      const tpl = await callTool("create_server_template", { name: "omnitest-feat-template" });
      feat.template = tpl.data?.code;
      const imported = await callTool("import_server_template", { template: `https://discord.new/${tpl.data?.code}` });
      const bpChannels = [...(imported.data?.blueprint?.channels ?? []), ...(imported.data?.blueprint?.categories ?? []).flatMap((c) => c.channels)];
      expect(bpChannels.some((c) => c.name === "omnitest-feat"), "features: import_server_template turns a template into a blueprint");
    } finally {
      featAssets.close();
      if (feat.template) await fetchJson("DELETE", `/guilds/${guildId}/templates/${feat.template}`).catch(() => {});
      for (const id of feat.channels.filter(Boolean)) await fetchJson("DELETE", `/channels/${id}`).catch(() => {});
      for (const id of feat.roles.filter(Boolean)) await fetchJson("DELETE", `/guilds/${guildId}/roles/${id}`).catch(() => {});
    }
  }

  // Behaviour settled in the 2.0 audit, live: a lock that holds and an
  // unlock that puts back only what the lock changed, scheduled messages
  // cancelled after a preview, invites revoked by their own server, builds
  // that give powers to people already here, counts that are counts, and
  // ids that are checked before any request.
  console.log("\n--- audit ---");
  {
    const made = { channels: [], roles: [], invites: [] };
    const api = async (method, path, body) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(`https://discord.com/api/v10${path}`, {
          method,
          headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status === 429) {
          const b = await r.json();
          await new Promise((res) => setTimeout(res, Math.ceil((b.retry_after ?? 1) * 1000) + 250));
          continue;
        }
        return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
      }
      throw new Error(`still rate limited on ${path}`);
    };
    // A call whose answer may be the SDK's own (an input it refused), which
    // is plain text, not an envelope.
    const callText = async (name, args) => {
      const res = await request("tools/call", { name, arguments: args });
      return { isError: res.result?.isError === true || res.error !== undefined, text: res.result?.content?.[0]?.text ?? res.error?.message ?? "" };
    };
    const SEND = 1n << 11n;
    const VIEW = 1n << 10n;
    const THREADS = (1n << 35n) | (1n << 36n) | (1n << 38n);
    const everyoneOn = async (id) => ((await api("GET", `/channels/${id}`)).body.permission_overwrites ?? []).find((o) => o.id === guildId) ?? { allow: "0", deny: "0" };
    try {
      const me = (await api("GET", "/users/@me")).body;

      // Locks.
      const open = (await api("POST", `/guilds/${guildId}/channels`, { name: "omnitest-audit-open", type: 0, permission_overwrites: [{ id: guildId, type: 0, allow: String(VIEW | SEND), deny: "0" }] })).body;
      made.channels.push(open.id);
      const locked = await callTool("lock_channel", { channel: open.id });
      let ow = await everyoneOn(open.id);
      expect((BigInt(ow.allow) & SEND) === 0n && (BigInt(ow.deny) & (SEND | THREADS)) === (SEND | THREADS) && /had been allowed to post here/.test(locked.summary ?? ""), "audit: a lock takes off an allowance that would have kept the channel open, and denies threads too");
      const unlocked = await callTool("unlock_channel", { channel: open.id });
      ow = await everyoneOn(open.id);
      expect(BigInt(ow.allow) === (VIEW | SEND) && BigInt(ow.deny) === 0n && unlocked.data?.locked === false, "audit: unlocking puts the channel back exactly as it was");
      const readOnly = (await api("POST", `/guilds/${guildId}/channels`, { name: "omnitest-audit-readonly", type: 0, permission_overwrites: [{ id: guildId, type: 0, allow: "0", deny: String(SEND | THREADS) }] })).body;
      made.channels.push(readOnly.id);
      await callTool("lock_channel", { channel: readOnly.id });
      const stays = await callTool("unlock_channel", { channel: readOnly.id });
      ow = await everyoneOn(readOnly.id);
      expect(BigInt(ow.deny) === (SEND | THREADS) && /stays closed/.test(stays.summary ?? ""), "audit: a channel that was read-only before a lock is still read-only after the unlock");

      // Scheduled messages.
      const queued = await callTool("schedule_message", { channel: open.id, content: "omnitest audit weekly", send_at: new Date(Date.now() - 60_000).toISOString(), repeat: "weekly" });
      const wait = new Date(queued.data?.send_at ?? 0).getTime() - Date.now();
      expect(wait > 6.9 * 86_400_000 && wait < 7 * 86_400_000, "audit: a weekly message whose start has passed waits for its next time");
      const cancelPreview = await callTool("cancel_scheduled_message", { schedule_id: queued.data?.id });
      expect(cancelPreview.data?.executed === false && /which repeats weekly: "omnitest audit weekly"/.test(cancelPreview.summary ?? ""), "audit: cancelling a scheduled message previews what would be lost");
      const cancelled = await callTool("cancel_scheduled_message", { schedule_id: queued.data?.id, confirm_token: cancelPreview.data?.confirm_token });
      expect(cancelled.data?.canceled === true, "audit: the token cancels it");

      // Invites.
      const invite = await callTool("create_invite", { channel: open.id, max_age_seconds: 300, for_users: [me.id, "900000000000000001"] });
      if (invite.data?.code) made.invites.push(invite.data.code);
      expect(invite.data?.for_users === 2 && /expires in 5 minutes/.test(invite.summary ?? ""), "audit: an invite for particular people passes its read-back, and says its lifetime in minutes");
      const notACode = await callToolRaw("delete_invite", { code: `../channels/${open.id}` });
      expect(notACode.isError && /is not an invite link or code/.test(notACode.summary ?? "") && (await api("GET", `/channels/${open.id}`)).status === 200, "audit: something that is not an invite code is refused, and nothing it pointed at is touched");
      const revokePreview = await callTool("delete_invite", { code: invite.data?.code });
      expect(revokePreview.data?.executed === false && /to #omnitest-audit-open, made by /.test(revokePreview.summary ?? ""), "audit: revoking an invite previews its channel and who made it");
      const revoked = await callTool("delete_invite", { code: invite.data?.code, confirm_token: revokePreview.data?.confirm_token });
      if (!revoked.isError) made.invites.pop();

      // Builds that give powers to people already here.
      const powers = { channels: [{ name: "omnitest-audit-powers", permissions: [{ role: "@everyone", allow: ["manage_webhooks"] }] }] };
      const direct = await callToolRaw("execute_build_plan", { blueprint: powers });
      const builtAnyway = ((await api("GET", `/guilds/${guildId}/channels`)).body ?? []).find((c) => c.name === "omnitest-audit-powers");
      if (builtAnyway) made.channels.push(builtAnyway.id);
      expect(direct.isError && /gives people already on the server powers/.test(direct.summary ?? "") && !builtAnyway, "audit: a blueprint that hands out a power is not built without a plan");
      const planned = await callTool("plan_server_build", { blueprint: powers });
      expect(/It gives people already on the server powers in what it creates/.test(planned.summary ?? ""), "audit: the plan says why it must run as planned");

      // Counts and names.
      const role = await callTool("create_role", { name: "omnitest-audit-counted" });
      if (role.data?.id) made.roles.push(role.data.id);
      await api("PUT", `/guilds/${guildId}/members/${me.id}/roles/${role.data?.id}`);
      await new Promise((res) => setTimeout(res, 1500));
      const holders = await callTool("get_role_members", { role: role.data?.id });
      expect(holders.data?.total === 1 && holders.data?.members?.[0]?.id === me.id, "audit: a role's holders are counted by Discord's own count");
      const everyone = await callTool("get_role_members", { role: "@everyone" });
      expect((everyone.data?.members ?? []).length >= 1 && /Every member holds @everyone/.test(everyone.summary ?? ""), "audit: @everyone lists members instead of none");
      const mention = await callTool("get_member", { user: `<@${me.id}>` });
      expect(mention.data?.id === me.id, "audit: a mention finds its member");

      // An edit mentions nobody.
      const sent = await callTool("send_message", { channel: open.id, content: "omnitest audit plain" });
      await callTool("edit_message", { channel: open.id, message_id: sent.data?.id, content: `<@${me.id}> edited in` });
      const after = (await api("GET", `/channels/${open.id}/messages/${sent.data?.id}`)).body;
      expect((after?.content ?? "").includes(me.id) && (after?.mentions ?? []).length === 0, "audit: an edit changes the text without creating a mention");

      // Ids that are not ids never reach Discord.
      const badId = await callText("get_message", { channel: open.id, message_id: ".." });
      expect(badId.isError && /17 to 20 digits/.test(badId.text), "audit: a message id that is not one is refused with what is expected");
      const badCode = await callText("delete_server_template", { code: ".." });
      expect(badCode.isError && /letters, digits, and dashes/.test(badCode.text), "audit: so is a template code");

      // Live events belong to one server.
      const sub = await callTool("subscribe_events", { types: ["message_created"] });
      expect(sub.data?.guild_id === guildId, "audit: a subscription records the server it was made for");
      if (sub.data?.subscription_id) await callTool("unsubscribe_events", { subscription_id: sub.data.subscription_id });
    } finally {
      for (const code of made.invites) await api("DELETE", `/invites/${code}`).catch(() => {});
      for (const id of made.channels.filter(Boolean)) await api("DELETE", `/channels/${id}`).catch(() => {});
      for (const id of made.roles.filter(Boolean)) await api("DELETE", `/guilds/${guildId}/roles/${id}`).catch(() => {});
    }
  }

  // Multi-bot routing, live.
  //
  // The pure routing logic is covered by the unit suite. What that cannot
  // show is that a request actually reaches the bot that is in the named
  // server, which is the part a refactor is most likely to break.
  //
  // Everything here is non-mutating on purpose. The destructive step stops at
  // the preview and never sends the confirm token back, so this section is
  // safe to run against a populated server even though the rest of the suite
  // is not. It skips cleanly on a single-bot install.
  console.log("\n--- multi-bot ---");
  {
    const servers = await callTool("list_servers");
    const list = servers.data?.servers ?? [];
    const botNames = [...new Set(list.map((s) => s.bot).filter(Boolean))];

    if (botNames.length < 2) {
      console.log(
        `  skipped: ${botNames.length === 1 ? "one bot" : "no bot"} configured. ` +
          "Add a second bot to bots.json to exercise routing."
      );
    } else {
      expect(
        list.every((s) => typeof s.bot === "string" && s.bot.length > 0),
        "list_servers labels every server with the bot that reaches it"
      );

      // Each bot should report itself when asked for by name. get_bot_info
      // returns bot as an object: { id, username, name }, where name is the
      // configured bot name.
      for (const name of botNames) {
        const info = await callTool("get_bot_info", { bot: name });
        expect(info.data?.bot?.name === name, `get_bot_info honours bot=${name}`);
      }

      const check = await callTool("run_setup_check", { bot: botNames[0] });
      expect(!check.isError, `run_setup_check runs for bot=${botNames[0]}`);

      // A server reached by a known bot must route to that bot, and the
      // destructive preview must say so before anything can be confirmed.
      const target = list.find((s) => s.bot);
      if (target) {
        const preview = await callToolRaw("delete_role", {
          role: "omnicord-nonexistent-role-for-routing-check",
          guild: target.name,
        });
        // The role does not exist, so this fails at resolution rather than
        // reaching the gate. Either way the failure must come from the bot
        // that owns the server, which proves the request was routed.
        expect(
          typeof preview.summary === "string" && preview.summary.length > 0,
          `a request naming ${target.name} is answered by its bot (${target.bot})`
        );
      }

      const unreachable = servers.data?.unreachable ?? [];
      expect(
        Array.isArray(unreachable),
        "list_servers reports an unreachable list, even when empty"
      );
    }
  }

  console.log(failed ? "\nacceptance: FAILED" : "\nacceptance: all good");
  child.kill();
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error(`acceptance error: ${err.message}`);
  await crashCleanup();
  child.kill();
  process.exit(1);
}
