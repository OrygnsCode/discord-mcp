// Multi-bot routing. Given the servers each configured bot can reach, work
// out which bot should act for a requested server. Pure and data-only, so it
// unit-tests without any network or client. The live guild fetching and the
// translation to REST clients happen in the tool entry helper.

import { resolveOne } from "./resolve.js";

export interface BotGuilds {
  name: string;
  guilds: Array<{ id: string; name: string }>;
}

// How to settle a server that more than one configured bot is in. Almost no
// tool has a parameter to name a bot, so the server is settled here: by the
// user's own choice for that server when there is one, otherwise by the
// default bot when it is among them.
export interface RoutingPreference {
  defaultBot?: string;
  // Server id to bot name, from the "servers" object in bots.json.
  byServer?: Record<string, string>;
}

export type BotGuildResolution =
  // One bot acts in the resolved server. When several configured bots are
  // in it, "shared" says who they are and why this one was taken.
  | {
      kind: "match";
      botName: string;
      guildId: string;
      guildName: string;
      shared?: { bots: string[]; why: "configured" | "default" };
    }
  // The server resolved, more than one of the user's bots is in it, and
  // nothing settles which should act: no choice for that server, and the
  // default bot is not one of them.
  | { kind: "ambiguous-bot"; guildId: string; guildName: string; bots: string[] }
  // The name matched more than one server; the user has to be specific.
  | {
      kind: "ambiguous-guild";
      candidates: Array<{ id: string; name: string; bots: string[] }>;
    }
  // No configured bot is in any server matching the request.
  | { kind: "no-guild" };

// Which of the bots in one server handles it. The user's own choice for the
// server comes first, when it names a bot that is actually in it (a stale
// choice is passed over); then the default bot, when it is one of them.
// Undefined when neither settles it.
export function chooseSharedBot(
  bots: string[],
  guildId: string,
  prefer: RoutingPreference
): { botName: string; why: "configured" | "default" } | undefined {
  const configured = prefer.byServer?.[guildId];
  if (configured && bots.includes(configured)) return { botName: configured, why: "configured" };
  if (prefer.defaultBot && bots.includes(prefer.defaultBot)) return { botName: prefer.defaultBot, why: "default" };
  return undefined;
}

// Resolve a requested server across every candidate bot. When two bots share
// a server the preference settles it, or it is ambiguous by bot; when a name
// matches two servers it is ambiguous by server; anything unambiguous
// returns the acting bot.
export function resolveBotGuild(
  botGuilds: BotGuilds[],
  wanted: string,
  prefer: RoutingPreference = {}
): BotGuildResolution {
  // guild id -> its name and the bots that can reach it.
  const byId = new Map<string, { name: string; bots: string[] }>();
  for (const bg of botGuilds) {
    for (const g of bg.guilds) {
      const entry = byId.get(g.id);
      if (entry) {
        if (!entry.bots.includes(bg.name)) entry.bots.push(bg.name);
      } else {
        byId.set(g.id, { name: g.name, bots: [bg.name] });
      }
    }
  }

  const unique = [...byId.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    type: "server",
  }));
  const res = resolveOne(wanted, unique);

  if ("match" in res) {
    const info = byId.get(res.match.id);
    const bots = info?.bots ?? [];
    const guildName = info?.name ?? res.match.name;
    if (bots.length === 1) {
      return { kind: "match", botName: bots[0], guildId: res.match.id, guildName };
    }
    const chosen = chooseSharedBot(bots, res.match.id, prefer);
    if (chosen) {
      return { kind: "match", botName: chosen.botName, guildId: res.match.id, guildName, shared: { bots, why: chosen.why } };
    }
    return { kind: "ambiguous-bot", guildId: res.match.id, guildName, bots };
  }

  if (res.candidates.length === 0) return { kind: "no-guild" };
  return {
    kind: "ambiguous-guild",
    candidates: res.candidates.map((c) => ({
      id: c.id,
      name: c.name,
      bots: byId.get(c.id)?.bots ?? [],
    })),
  };
}

export type BotNameResolution =
  | { kind: "match"; botName: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

// Resolve an explicit bot selector (a name the caller passed) to one of the
// configured bot names.
export function resolveBotName(
  botNames: string[],
  wanted: string
): BotNameResolution {
  const res = resolveOne(
    wanted,
    botNames.map((n) => ({ id: n, name: n, type: "bot" }))
  );
  if ("match" in res) return { kind: "match", botName: res.match.id };
  if (res.candidates.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: res.candidates.map((c) => c.name) };
}
