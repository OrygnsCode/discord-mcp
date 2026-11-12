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
            rest[last] = answering ? answering.run : run;
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

// Builds a fully wired McpServer. A factory rather than a singleton because
// stateless HTTP answers each request with a fresh instance, while stdio
// pins one instance for the whole connection.
export function buildServer(config: ServerConfig): McpServer {
  const real = new McpServer(
    { ...SERVER_INFO, version: VERSION },
    { instructions: serverInstructions({ tools: config.toolsets.tools, safeMode: safeModeEnabled(), strictParams: strictParams() }) }
  );
  // With no DISCORD_MCP_TOOLS set the selection holds every tool, so this is a
  // pass-through and the registered surface is identical to before.
  const server = applyToolsets(real, config.toolsets.tools);
  registerDiagnostics(server, config);
  registerReadTools(server, config);
  registerWriteTools(server, config);
  registerBuilderTools(server, config);
  registerManageTools(server, config);
  registerModerationTools(server, config);
  registerReactionTools(server, config);
  registerCommunityTools(server, config);
  registerEventTools(server, config);
  registerRealtimeTools(server, config);
  registerThreadTools(server, config);
  registerForumTools(server, config);
  registerAutomodTools(server, config);
  registerSettingsTools(server, config);
  registerExpressionTools(server, config);
  registerBlueprintTools(server, config);
  registerChangeTools(server, config);
  registerMessagingTools(server, config);
  registerMemberTools(server, config);
  registerPermissionTools(server, config);
  registerStructureTools(server, config);
  registerStageTools(server, config);
  registerRosterTools(server, config);
  registerAppCommandTools(server, config);
  registerBotProfileTools(server, config);
  registerAuditTools(server, config);
  registerCatchUpTools(server, config);
  // Hand back the real server: the proxy exists only to gate registration.
  return real;
}
