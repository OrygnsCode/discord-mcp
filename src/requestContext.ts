import { AsyncLocalStorage } from "node:async_hooks";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server";

// The MCP request a tool handler is serving, and the server instance serving
// it. buildServer() wraps every registered tool callback in this, so the
// safety gate can ask what the connected app supports without every tool
// passing its context along.

interface RequestScope {
  ctx?: ServerContext;
  // The low-level server's view of the app, from the 2025-era initialize
  // handshake. Undefined on instances that never saw one.
  clientCapabilities?: () => ClientCapabilities | undefined;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequest<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentRequest(): ServerContext | undefined {
  return storage.getStore()?.ctx;
}

// What the app declared it supports. A 2026-07-28 request carries the
// declaration itself; a 2025-era connection declared it once at initialize.
// A stateless HTTP instance serving a 2025-era app has neither, which reads
// as declaring nothing.
export function clientCapabilities(): ClientCapabilities | undefined {
  const scope = storage.getStore();
  const envelope = scope?.ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  const perRequest = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return perRequest ?? scope?.clientCapabilities?.();
}

// Whether the app said it can show the user a form (an MCP elicitation). An
// empty elicitation declaration means form support, per the spec's rule for
// apps written before URL mode existed.
export function appCanShowDialog(): boolean {
  const elicitation = clientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!elicitation) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}
