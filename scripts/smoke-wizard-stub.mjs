// Loaded with --import by smoke-wizard.mjs, before the wizard starts. Stands
// in for fetch: plays Discord the way SMOKE_DISCORD says, answers the usage
// report, and writes every request to SMOKE_FETCH_LOG. With
// SMOKE_STDIN_ERROR set, the terminal fails once the wizard is reading it.
import { appendFileSync } from "node:fs";

const { SMOKE_FETCH_LOG: log, SMOKE_DISCORD = "", SMOKE_STDIN_ERROR } = process.env;
const mode = new Set(SMOKE_DISCORD.split(",").filter(Boolean));
let calls = 0;
let appCalls = 0;

const noConnection = (code, message) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const auth = new Headers(init.headers).get("authorization");
  appendFileSync(log, `${JSON.stringify({ url, auth, body: init.body ?? null })}\n`);
  if (!url.startsWith("https://discord.com/")) return new Response(null, { status: 204 });
  calls += 1;
  // No answer, until the request gives up. The timer holds the process open
  // the way a real connection's socket does.
  if (mode.has("hang")) {
    return new Promise((_, reject) => {
      const open = setInterval(() => {}, 1000);
      init.signal?.addEventListener("abort", () => {
        clearInterval(open);
        reject(init.signal.reason);
      });
    });
  }
  if (mode.has("offline")) throw noConnection("ENOTFOUND", "getaddrinfo ENOTFOUND discord.com");
  if (mode.has("certificate")) throw noConnection("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain");
  if (mode.has("reset-once") && calls === 1) throw noConnection("ECONNRESET", "read ECONNRESET");
  for (const status of [429, 403, 503]) {
    if (mode.has(`${status}-once`) && calls === 1) return new Response("error code: 1015", { status });
  }
  if (mode.has("rejects")) return Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 });

  const path = new URL(url).pathname.replace("/api/v10", "");
  if (path === "/users/@me") {
    // Discord answering ok with nothing in it: the wizard has no way to read
    // it, which is a bug of the kind it cannot explain.
    if (mode.has("bug")) return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    return Response.json({ id: "100000000000000001", username: "smokebot" });
  }
  if (path === "/applications/@me") {
    appCalls += 1;
    // Off for the token check and the first intents check, then on.
    const off = mode.has("intents-off") && appCalls <= 2;
    return Response.json({ id: "100000000000000002", name: "Smoke App", flags: off ? 0 : (1 << 12) | (1 << 14) | (1 << 18) });
  }
  if (path === "/users/@me/guilds") {
    if (mode.has("no-servers")) return Response.json([]);
    if (mode.has("servers-500")) return Response.json({ message: "500: Internal Server Error" }, { status: 500 });
    return Response.json([{ id: "100000000000000003", name: "Smoke Server" }]);
  }
  return Response.json({ message: "404: Not Found" }, { status: 404 });
};

if (SMOKE_STDIN_ERROR) {
  const timer = setInterval(() => {
    if (process.stdin.listenerCount("error") === 0) return;
    clearInterval(timer);
    process.stdin.emit("error", Object.assign(new Error("read EIO"), { code: "EIO", syscall: "read" }));
  }, 50);
  timer.unref();
}
