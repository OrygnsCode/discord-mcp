import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type {
  APIGuildMember,
  RESTGetAPICurrentUserGuildsResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getRoles } from "../discord/guildData.js";
import { getRestForToken, NoTokenError } from "../discord/client.js";
import { chooseSharedBot } from "../discord/botRouting.js";
import { quoted } from "../discord/names.js";
import { resolveOne } from "../discord/resolve.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam, memberDisplayName } from "./common.js";

// Roster reads: the servers the bot is in, a paged member list, and the
// members holding a role. search_members covers name and filter search;
// these cover the plain enumerations.

// How many pages of 1000 members get_role_members reads while looking for
// holders to list.
const MAX_MEMBER_PAGES = 3;

export function registerRosterTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description:
        "Every server your bots are in, each labeled with which bot reaches " +
        "it, with approximate member counts. A server more than one of your " +
        "bots is in appears once per bot, with handles_server marking the " +
        "one that tools run as there. Use get_server_overview for one " +
        "server's full detail.",
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      if (config.bots.length === 0) {
        return fail(new NoTokenError().message);
      }
      // One bad bot (a reset token, a transient error) must not take down the
      // whole map: fetch each bot's servers independently and mark any that
      // could not be reached rather than failing the call.
      const perBot = await Promise.all(
        config.bots.map(async (bot) => {
          try {
            const rest = getRestForToken(bot.token);
            const guilds = (await rest.get(Routes.userGuilds(), {
              query: new URLSearchParams({ with_counts: "true" }),
            })) as RESTGetAPICurrentUserGuildsResult;
            return { bot, guilds, reachable: true };
          } catch {
            return {
              bot,
              guilds: [] as RESTGetAPICurrentUserGuildsResult,
              reachable: false,
            };
          }
        })
      );
      const servers = perBot.flatMap(({ bot, guilds }) =>
        guilds.map((g) => ({
          id: g.id,
          name: g.name,
          members_approximate:
            (g as { approximate_member_count?: number }).approximate_member_count ?? null,
          owner: g.owner ?? false,
          bot: bot.name,
        }))
      );
      // A server several bots are in: say which of them tools run as there,
      // by the same rule the tools themselves follow.
      const botsIn = new Map<string, string[]>();
      for (const s of servers) botsIn.set(s.id, [...(botsIn.get(s.id) ?? []), s.bot]);
      const prefer = { defaultBot: config.bots.find((b) => b.isDefault)?.name, byServer: config.serverBots };
      const sharedNotes: string[] = [];
      const listed = servers.map((s) => {
        const bots = botsIn.get(s.id) ?? [];
        if (bots.length < 2) return s;
        const chosen = chooseSharedBot(bots, s.id, prefer);
        if (s.bot === bots[0]) {
          sharedNotes.push(
            `${bots.length} of your bots are in ${quoted(s.name)} (${bots.join(", ")}). ` +
              (chosen
                ? `Tools run as ${chosen.botName} there: ` +
                  (chosen.why === "configured" ? "bots.json gives it that server." : "it is the default bot.")
                : `Nothing says which should handle it, so tools refuse there until bots.json does: ` +
                  `"servers": { "${s.id}": "${bots[0]}" }.`)
          );
        }
        return { ...s, handles_server: chosen?.botName === s.bot };
      });
      const uniqueServers = botsIn.size;
      const unreachable = perBot
        .filter((p) => !p.reachable)
        .map((p) => p.bot.name);
      let summary: string;
      if (config.bots.length === 1) {
        summary = perBot[0].reachable
          ? `The bot is in ${servers.length} server(s).`
          : "The bot could not be reached; check its token with run_setup_check.";
      } else {
        summary =
          `${config.bots.length} bots across ${uniqueServers} server(s).` +
          (unreachable.length
            ? ` ${unreachable.length} unreachable (${unreachable.join(", ")}); check them with run_setup_check.`
            : "");
      }
      return ok(summary, {
        bots: config.bots.map((b) => ({
          name: b.name,
          default: b.isDefault,
          reachable:
            perBot.find((p) => p.bot.name === b.name)?.reachable ?? false,
        })),
        servers: listed,
        ...(unreachable.length ? { unreachable } : {}),
      }, sharedNotes);
    })
  );

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description:
        "A paged roster of server members. Pass after with the last id to " +
        "continue. For finding specific people, search_members is better.",
      inputSchema: {
        guild: guildParam,
        limit: z.number().int().min(1).max(1000).optional()
          .describe("How many, up to 1000. Default 100."),
        after: z.string().optional().describe("User id cursor to page past."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, limit, after }) => {
      const { rest, guildId } = await enter(config, guild);
      const params = new URLSearchParams({ limit: String(limit ?? 100) });
      if (after) params.set("after", after);
      const members = (await rest.get(Routes.guildMembers(guildId), {
        query: params,
      })) as APIGuildMember[];
      return ok(`${members.length} member(s).`, {
        members: members.map((m) => ({
          id: m.user?.id,
          name: m.user?.username,
          display_name: memberDisplayName(m),
          bot: m.user?.bot ?? false,
          joined_at: m.joined_at,
        })),
        next_after: members.length > 0 ? members[members.length - 1].user?.id : null,
      });
    })
  );

  server.registerTool(
    "get_role_members",
    {
      title: "Get role members",
      description: "The members who currently hold a given role.",
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max results. Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ role, guild, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const roleId = resolution.match.id;
      const name = resolution.match.name;
      const max = limit ?? 50;
      // Everyone holds @everyone, and members do not list it among their roles.
      const everyone = roleId === guildId;

      // How many hold it, from Discord's own count. The number of holders
      // found while looking for enough to list is not that: it stops early,
      // and it used to be reported as the total.
      let total: number | undefined;
      if (!everyone) {
        try {
          const counts = (await rest.get(Routes.guildRoleMemberCounts(guildId))) as Record<string, number>;
          total = counts[roleId] ?? 0;
        } catch {
          total = undefined;
        }
      }

      const holders: APIGuildMember[] = [];
      let after: string | undefined;
      let seen = 0;
      let reachedEnd = false;
      const enough = () => holders.length >= max || (total !== undefined && holders.length >= total);
      for (let page = 0; page < MAX_MEMBER_PAGES && !enough() && !reachedEnd; page += 1) {
        const params = new URLSearchParams({ limit: "1000" });
        if (after) params.set("after", after);
        const batch = (await rest.get(Routes.guildMembers(guildId), {
          query: params,
        })) as APIGuildMember[];
        seen += batch.length;
        for (const m of batch) {
          if (everyone || m.roles.includes(roleId)) holders.push(m);
        }
        if (batch.length < 1000) reachedEnd = true;
        after = batch[batch.length - 1]?.user?.id;
      }

      const listed = holders.slice(0, max);
      const known = total ?? (reachedEnd && !everyone ? holders.length : undefined);
      // Looked through as many members as it will, without reaching the
      // end or enough holders: some are missing from the list.
      const cutShort = !reachedEnd && !enough();
      const summary = everyone
        ? `Every member holds @everyone. Listing ${listed.length}; list_members pages through all of them.`
        : known !== undefined
          ? `${known} member(s) hold ${quoted(name)}.` + (listed.length < known ? ` Listing ${listed.length}.` : "")
          : `At least ${holders.length} member(s) hold ${quoted(name)}; the count could not be read.` +
            (listed.length < holders.length ? ` Listing ${listed.length}.` : "");
      return ok(
        summary,
        {
          role: { id: roleId, name },
          ...(known !== undefined ? { total: known } : {}),
          members: listed.map((m) => ({
            id: m.user?.id,
            name: m.user?.username,
            display_name: memberDisplayName(m),
          })),
        },
        cutShort
          ? [`Only the first ${seen} members of the server were looked through, so holders who joined later are not listed.`]
          : []
      );
    })
  );
}
