import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { runInRequest } from "./requestContext.js";
import { answeringUnknown, strictParams } from "./unknownArguments.js";
import { serverInstructions } from "./instructions.js";
import { safeModeEnabled } from "./safety.js";
import { VERSION, type ServerConfig } from "./config.js";
import { SERVER_INFO } from "./identity.js";
import { registerDiagnostics } from "./tools/diagnostics.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerBuilderTools } from "./tools/builder.js";
import { registerManageTools } from "./tools/manage.js";
import { registerModerationTools } from "./tools/moderation.js";
import { registerReactionTools } from "./tools/reactions.js";
import { registerCommunityTools } from "./tools/community.js";
import { registerEventTools } from "./tools/events.js";
import { registerRealtimeTools } from "./tools/realtime.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerForumTools } from "./tools/forums.js";
import { registerAutomodTools } from "./tools/automod.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerExpressionTools } from "./tools/expressions.js";
import { registerBlueprintTools } from "./tools/blueprints.js";
import { registerChangeTools } from "./tools/changes.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerMemberTools } from "./tools/members.js";
import { registerPermissionTools } from "./tools/permissions.js";
import { registerStructureTools } from "./tools/structure.js";
import { registerStageTools } from "./tools/stages.js";
import { registerRosterTools } from "./tools/roster.js";
import { registerAppCommandTools } from "./tools/appCommands.js";
import { registerBotProfileTools } from "./tools/botProfile.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerCatchUpTools } from "./tools/catchUp.js";
import { noteClient, noteToolCall } from "./usageStats.js";

// Applies the toolset selection, the request scope the safety gate reads,
// and the answer to a parameter a tool does not have, without touching the
// tool modules.
//
// Every module reaches for exactly one method on the server, registerTool,
// and none of them uses its return value. So the whole filter is a proxy that
// drops registrations for tools outside the selection and forwards everything
// else, with each kept tool's callback wrapped in a request scope. Tools that are filtered out are never registered at all,
// which keeps them out of tools/list and out of the client's context.
//
// The stub stands in for the RegisteredTool a caller would normally get back.
// Nothing reads it today; returning a disabled handle rather than undefined
// means a future caller that does read it finds something coherent.
function applyToolsets(server: McpServer, allowed: ReadonlySet<string>): McpServer {
  const stub = {
    enabled: false,
    enable() {},
    disable() {},
    remove() {},
    update() {},
  } as unknown as ReturnType<McpServer["registerTool"]>;

  // Every tool callback runs inside a request scope, so the safety gate can
  // see what the connected app supports (a confirmation dialog or not)
  // without each tool passing its context along. The SDK passes the context
  // as the callback's last argument.
  const clientCapabilities = () => server.server.getClientCapabilities();
  const inRequest =
    (callback: (...a: unknown[]) => unknown) =>
    (...a: unknown[]) =>
      runInRequest({ ctx: a[a.length - 1] as ServerContext, clientCapabilities }, () => callback(...a));

  // Each call is counted for the usage stats under the tool's name, with
  // the class of error when it failed (see usageStats.ts). Nothing from
  // the arguments or the result is kept.
  const clientName = (ctx: unknown): string | undefined => {
    const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope;
    const fromEnvelope = (envelope?.["io.modelcontextprotocol/clientInfo"] as { name?: unknown } | undefined)?.name;
    return typeof fromEnvelope === "string" ? fromEnvelope : server.server.getClientVersion()?.name;
  };
  const counted =
    (name: string, callback: (...a: unknown[]) => unknown) =>
    async (...a: unknown[]) => {
      noteClient(clientName(a[a.length - 1]));
      let result: unknown;
      try {
        result = await callback(...a);
      } catch (err) {
        noteToolCall(name, { summary: String(err), data: {} });
        throw err;
      }
      noteToolCall(name, countedFailure(a[0], result));
      return result;
    };

  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          if (!allowed.has(name)) return stub;
          const last = rest.length - 1;
          if (typeof rest[last] === "function") {
            const run = inRequest(rest[last] as (...a: unknown[]) => unknown);
            // The definition comes first and the callback last. With both
            // there, a parameter the tool does not have gets an answer
            // (see unknownArguments.ts); the tool itself is untouched.
            const answering = last > 0 ? answeringUnknown(name, rest[0] as Parameters<typeof answeringUnknown>[1], run) : undefined;
            if (answering) rest[0] = answering.def;
            rest[last] = counted(name, answering ? answering.run : run);
          }
          return (
            target.registerTool as unknown as (
              n: string,
              ...r: unknown[]
            ) => ReturnType<McpServer["registerTool"]>
          )(name, ...rest);
        };
      }
      // Read and bind against the real server, never the proxy, so getters
      // and methods that touch private fields still resolve.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// A failed tool result's summary and data, for sorting the failure into a
// class. Undefined for anything that did not fail.
function failureOf(result: unknown): { summary: string; data: unknown } | undefined {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (r?.isError !== true) return undefined;
  const text = r.content?.[0]?.type === "text" ? (r.content[0].text ?? "") : "";
  try {
    const envelope = JSON.parse(text) as { summary?: unknown; data?: unknown };
    return { summary: typeof envelope.summary === "string" ? envelope.summary : "", data: envelope.data };
  } catch {
    return { summary: text, data: undefined };
  }
}

// The failure a call is counted with, if any. A dry run that is refused is
// the AI checking what is possible (can this server have gradient roles?),
// not something going wrong, so it counts as a call and not as a failure.
export function countedFailure(args: unknown, result: unknown): { summary: string; data: unknown } | undefined {
  if ((args as { dry_run?: unknown } | undefined)?.dry_run === true) return undefined;
  return failureOf(result);
}

// Every tool module, in registration order.
const REGISTRARS: ReadonlyArray<(server: McpServer, config: ServerConfig) => void> = [
  registerDiagnostics,
  registerReadTools,
  registerWriteTools,
  registerBuilderTools,
  registerManageTools,
  registerModerationTools,
  registerReactionTools,
  registerCommunityTools,
  registerEventTools,
  registerRealtimeTools,
  registerThreadTools,
  registerForumTools,
  registerAutomodTools,
  registerSettingsTools,
  registerExpressionTools,
  registerBlueprintTools,
  registerChangeTools,
  registerMessagingTools,
  registerMemberTools,
  registerPermissionTools,
  registerStructureTools,
  registerStageTools,
  registerRosterTools,
  registerAppCommandTools,
  registerBotProfileTools,
  registerAuditTools,
  registerCatchUpTools,
];

// The tools that declare readOnlyHint: true, learned by letting every module
// register into a recorder that keeps only the names and annotations.
// Registering does nothing else (stateless HTTP builds a fresh server per
// request on the same basis), and the annotations never depend on the
// config, so this runs once per process. A tool without the annotation
// counts as one that changes something.
let readOnlyNames: ReadonlySet<string> | undefined;
export function readOnlyToolNames(config: ServerConfig): ReadonlySet<string> {
  if (readOnlyNames) return readOnlyNames;
  const names = new Set<string>();
  const recorder = {
    registerTool(name: string, def?: { annotations?: { readOnlyHint?: boolean } }) {
      if (def?.annotations?.readOnlyHint === true) names.add(name);
      return undefined;
    },
  } as unknown as McpServer;
  for (const register of REGISTRARS) register(recorder, config);
  readOnlyNames = names;
  return names;
}

// What this install offers: the selected tool groups, narrowed to the tools
// that change nothing in read-only mode.
export function effectiveTools(config: ServerConfig): ReadonlySet<string> {
  if (!config.readOnly) return config.toolsets.tools;
  const readOnly = readOnlyToolNames(config);
  return new Set([...config.toolsets.tools].filter((name) => readOnly.has(name)));
}

// Builds a fully wired McpServer. A factory rather than a singleton because
// stateless HTTP answers each request with a fresh instance, while stdio
// pins one instance for the whole connection.
export function buildServer(config: ServerConfig): McpServer {
  const tools = effectiveTools(config);
  const real = new McpServer(
    { ...SERVER_INFO, version: VERSION },
    {
      instructions: serverInstructions({
        tools,
        safeMode: safeModeEnabled(),
        strictParams: strictParams(),
        readOnly: config.readOnly === true,
      }),
    }
  );
  // With no DISCORD_MCP_TOOLS set and read-only mode off the selection holds
  // every tool, so this is a pass-through and the registered surface is
  // identical to before.
  const server = applyToolsets(real, tools);
  for (const register of REGISTRARS) register(server, config);
  // Hand back the real server: the proxy exists only to gate registration.
  return real;
}
