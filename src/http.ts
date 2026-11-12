import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { VERSION, type ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { SERVER_INFO } from "./identity.js";
import { setting } from "./settings.js";

// Streamable HTTP transport with a security posture that matches what
// this server can do. A Discord bot token sits behind this endpoint, so
// the rules are strict and on by default:
//
// - Binding beyond loopback requires DISCORD_MCP_HTTP_TOKEN. The process
//   refuses to start on a public interface without one, instead of
//   quietly exposing the bot to the network.
// - When a token is set, every /mcp request needs Authorization: Bearer,
//   compared in constant time.
// - Requests carrying a browser Origin header are rejected unless the
//   origin is allowlisted via DISCORD_MCP_HTTP_ORIGINS. Non-browser MCP
//   clients send no Origin; a browser page driving this API cross-site
//   is exactly the DNS rebinding attack the MCP spec says to block.
// - In loopback mode the Host header must also be a loopback name, which
//   closes the rebinding hole where an attacker's domain resolves to
//   127.0.0.1.
//
// These checks run before the MCP handler sees anything; the SDK's handler
// does no Host, Origin, or token checks of its own.
//
// Serving is stateless: each request is answered by a fresh server instance
// (building one takes a few milliseconds). 2026-07-28 clients send their
// protocol version with every request; 2025-era clients are served the
// established stateless way, with no session id, so the GET and DELETE
// session operations answer 405. Nothing in the tools depends on a session:
// confirmations and staged plans are process-wide and addressed by ids the
// tools hand out.

const MAX_BODY_BYTES = 1024 * 1024;
// Open subscriptions/listen streams, the only long-lived thing a client can
// hold open here.
const MAX_SUBSCRIPTIONS = 64;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// The scheme name is case-insensitive (RFC 7235), and some clients send it
// in lower case.
function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match ? match[1].trim() : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading but leave the socket open, so the caller can still
        // answer 413 before closing it.
        req.pause();
        req.removeAllListeners("data");
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Node's request as a web-standard Request, which is what the SDK's handler
// takes. The body was already read (and size-checked) by the caller.
function toWebRequest(
  req: IncomingMessage,
  url: URL,
  body: string | undefined,
  signal: AbortSignal
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return new Request(url, {
    method: req.method,
    headers,
    body: body !== undefined && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    signal,
  });
}

// Copies the handler's web Response onto Node's response, streaming the
// body so SSE responses flow as they are produced.
function writeWebResponse(res: ServerResponse, response: Response): void {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream);
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy());
  body.pipe(res);
}

export function startHttpServer(
  config: ServerConfig,
  options: { port: number; host: string }
): void {
  const authToken = setting("HTTP_TOKEN");
  const allowedOrigins = new Set(
    (setting("HTTP_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
  const loopback = LOOPBACK_HOSTS.has(options.host);

  if (!loopback && !authToken) {
    console.error(
      `Refusing to bind to ${options.host} without authentication. A bot ` +
        "token sits behind this endpoint. Set DISCORD_MCP_HTTP_TOKEN to a " +
        "strong secret to serve beyond localhost, or bind to 127.0.0.1."
    );
    process.exit(1);
  }

  const mcp = createMcpHandler(() => buildServer(config), {
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (err) => console.error(`discord-mcp http: ${err.message}`),
  });

  // Every request is handled inside one catch. This listener is async, and
  // anything thrown from it would be an unhandled rejection, which ends the
  // process: before this, a single request with a malformed Host header,
  // sent by anyone who could reach the port and before any token check,
  // stopped the server.
  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`discord-mcp http: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal error.");
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      rpcError(res, 400, "Malformed request line or Host header.");
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { name: SERVER_INFO.name, version: VERSION });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found; the MCP endpoint is /mcp" });
      return;
    }

    // Origin gate: browser pages do not get to drive this API cross-site.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      rpcError(res, 403, "Origin not allowed.");
      return;
    }

    // Host gate in loopback mode, against DNS rebinding.
    if (loopback && !authToken) {
      const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK_HOSTS.has(hostName)) {
        rpcError(res, 403, "Host header must be a loopback address.");
        return;
      }
    }

    if (authToken) {
      const presented = bearerToken(req);
      if (!presented || !constantTimeEquals(presented, authToken)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or invalid bearer token." },
            id: null,
          })
        );
        return;
      }
    }

    let raw: string | undefined;
    let parsedBody: unknown;
    if (req.method === "POST") {
      try {
        raw = await readBody(req);
        parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch (err) {
        const tooBig = err instanceof Error && err.message === "body too large";
        if (tooBig) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Body too large." }, id: null }),
            () => req.destroy()
          );
        } else {
          rpcError(res, 400, "Invalid JSON.");
        }
        return;
      }
    }

    // Abort the handler's work if the client goes away mid-response.
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });

    try {
      const response = await mcp.fetch(toWebRequest(req, url, raw, aborter.signal), {
        parsedBody,
      });
      writeWebResponse(res, response);
    } catch (err) {
      console.error(`discord-mcp http: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) rpcError(res, 500, "Internal error.");
      else res.destroy();
    }
  }

  httpServer.listen(options.port, options.host, () => {
    console.error(
      `discord-mcp v${VERSION} on http://${options.host}:${options.port}/mcp ` +
        (authToken
          ? "(bearer auth required)"
          : "(loopback only, no auth token set)") +
        (config.token ? "" : " (no DISCORD_TOKEN set, diagnostics will say so)")
    );
  });

  const shutdown = async () => {
    const { stopGateway } = await import("./discord/gateway.js");
    await stopGateway();
    await mcp.close().catch(() => undefined);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
