import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import type { REST } from "@discordjs/rest";
import {
  Routes,
  PresenceUpdateStatus,
  GatewayOpcodes,
  ActivityType,
} from "discord-api-types/v10";
import type { RESTGetCurrentApplicationResult } from "discord-api-types/v10";
import type { ServerConfig } from "../config.js";
import { getRest } from "./client.js";
import { readIntents, type IntentStatus } from "./intents.js";
import { gatewayIntentBits, normalizeDispatch, eventBus } from "./gatewayEvents.js";
import { handleVoiceDispatch } from "./voiceState.js";
import { handleHiddenChannelDispatch } from "./hiddenChannels.js";
import { handleCacheDispatch } from "./guildData.js";
import { setting, settingSource } from "../settings.js";

// The live gateway connection: one per process, shared by every transport
// session. It does two jobs: the bot shows as online while this server runs,
// and dispatch events feed the subscription bus. A gateway failure never
// takes the server down; every REST tool keeps working and the status
// here explains what happened.

export type GatewayState =
  | { status: "off"; reason: string }
  | { status: "connecting" }
  | { status: "connected"; since: string; intents: IntentStatus }
  | { status: "error"; message: string };

let state: GatewayState = { status: "off", reason: "not started" };
let manager: WebSocketManager | undefined;
let portalIntents: IntentStatus | undefined;
// The REST client of the bot this connection runs as (the default bot).
// Gateway-only knowledge, such as which channels are hidden from the bot,
// describes this bot alone.
let gatewayRest: REST | undefined;
// That bot's user id, from Ready: its own member updates are the ones that
// can change which channels it sees.
let selfId: string | undefined;

export function isGatewayBot(rest: REST): boolean {
  return gatewayRest !== undefined && rest === gatewayRest;
}

// Whether cached structure for this bot is kept current by gateway events:
// it is the bot holding the gateway connection, and that connection is up.
export function gatewayKeepsCacheFresh(rest: REST): boolean {
  return isGatewayBot(rest) && state.status === "connected";
}

export function getGatewayState(): GatewayState {
  return state;
}

export function getPortalIntents(): IntentStatus | undefined {
  return portalIntents;
}

// Close codes after which Discord does not let a connection come back, so
// nothing reconnects. They used to leave the state at "connecting" for the
// life of the process, and the setup check kept saying events would start
// shortly.
const FINAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token. It was reset or is wrong; update DISCORD_TOKEN and restart.",
  4010: "Discord rejected the shard this connection asked for.",
  4011: "The bot is in too many servers for a single connection and needs sharding, which this server does not do.",
  4012: "Discord rejected the gateway version in use.",
  4013: "Discord rejected the intents this connection asked for.",
  4014:
    "A privileged intent was asked for that is not enabled for the bot. Turn it on in the Developer Portal, Bot page, and restart.",
};

// The state a closed connection leaves behind: an error that stays for a
// final close code, otherwise "connecting" while the shard reconnects.
export function stateAfterClose(code: number, current: GatewayState): GatewayState {
  const final = FINAL_CLOSE[code];
  if (final) return { status: "error", message: final };
  // A later ordinary close does not paper over a final one.
  if (current.status === "connected") return { status: "connecting" };
  return current;
}

// The state a resumed connection leaves behind. A dropped connection that
// Discord lets resume sends no second Ready, only Resumed, and nothing
// listened for it: from the first drop on, the state read "connecting" for
// the life of the process. The bot was online and events kept arriving, but
// its status could not be changed and cached structure was no longer
// treated as current.
export function stateAfterResume(
  current: GatewayState,
  intents: IntentStatus,
  now: Date = new Date()
): GatewayState {
  if (current.status !== "connecting") return current;
  return { status: "connected", since: now.toISOString(), intents };
}

// Exposed for unit tests only: stands in for a live connection.
export const __testing = {
  assume(rest: REST | undefined, next: GatewayState): void {
    gatewayRest = rest;
    state = next;
  },
};

export async function startGateway(config: ServerConfig): Promise<void> {
  if (setting("GATEWAY")?.toLowerCase() === "off") {
    state = { status: "off", reason: `disabled by ${settingSource("GATEWAY")}=off` };
    return;
  }
  if (!config.token) {
    state = { status: "off", reason: "no DISCORD_TOKEN configured" };
    return;
  }

  try {
    state = { status: "connecting" };
    const rest = getRest(config);
    gatewayRest = rest;
    const app = (await rest.get(
      Routes.currentApplication()
    )) as RESTGetCurrentApplicationResult;
    portalIntents = readIntents(app.flags ?? 0);

    manager = new WebSocketManager({
      token: config.token,
      intents: gatewayIntentBits(portalIntents),
      rest,
      initialPresence: {
        status: PresenceUpdateStatus.Online,
        since: null,
        afk: false,
        activities: [],
      },
    });

    manager.on(WebSocketShardEvents.Dispatch, (payload) => {
      handleVoiceDispatch(payload.t, payload.d);
      handleHiddenChannelDispatch(payload.t, payload.d);
      handleCacheDispatch(payload.t, payload.d, selfId);
      const draft = normalizeDispatch(payload.t, payload.d);
      if (draft) eventBus.record(draft);
    });
    manager.on(WebSocketShardEvents.Ready, (data) => {
      selfId = data.user.id;
      state = {
        status: "connected",
        since: new Date().toISOString(),
        intents: portalIntents as IntentStatus,
      };
      console.error("discord-mcp gateway connected, bot presence is online");
    });
    manager.on(WebSocketShardEvents.Resumed, () => {
      const next = stateAfterResume(state, portalIntents as IntentStatus);
      if (next !== state) console.error("discord-mcp gateway reconnected");
      state = next;
    });
    manager.on(WebSocketShardEvents.Closed, (code) => {
      const next = stateAfterClose(code, state);
      const gaveUp = next.status === "error" && state.status !== "error";
      state = next;
      console.error(
        gaveUp
          ? `discord-mcp gateway closed for good (code ${code}): ${(next as { message: string }).message}`
          : `discord-mcp gateway closed with code ${code}, reconnecting`
      );
    });
    manager.on(WebSocketShardEvents.Error, (error) => {
      console.error(`discord-mcp gateway error: ${error.message}`);
    });

    await manager.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { status: "error", message };
    console.error(`discord-mcp gateway failed to start: ${message}`);
  }
}

// Presence updates ride the live gateway connection. Returns an error
// string when there is no connection to ride.
export async function setPresence(options: {
  status: "online" | "idle" | "dnd" | "invisible";
  activityText?: string;
}): Promise<string | null> {
  if (!manager || state.status !== "connected") {
    return (
      "The gateway is not connected, so presence cannot change. " +
      "Check run_setup_check for the gateway state."
    );
  }
  await manager.send(0, {
    op: GatewayOpcodes.PresenceUpdate,
    d: {
      since: null,
      afk: false,
      status: options.status as PresenceUpdateStatus,
      activities: options.activityText
        ? [
            {
              name: options.activityText,
              type: ActivityType.Custom,
              state: options.activityText,
            },
          ]
        : [],
    },
  });
  return null;
}

export async function stopGateway(): Promise<void> {
  if (manager) {
    try {
      await manager.destroy();
    } catch {
      // Already down; nothing to release.
    }
    manager = undefined;
  }
  state = { status: "off", reason: "stopped" };
}
