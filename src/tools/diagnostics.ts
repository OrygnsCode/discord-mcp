import { DiscordAPIError, type REST } from "@discordjs/rest";
import { quoted } from "../discord/names.js";
import { Routes, UserFlags } from "discord-api-types/v10";
import type {
  APIUser,
  RESTGetAPICurrentUserGuildsResult,
  RESTGetAPIUserResult,
  RESTGetCurrentApplicationResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import { join } from "node:path";
import type { BotConfig, ServerConfig } from "../config.js";
import { ENVIRONMENT_SOURCE, VERSION, configFolders } from "../config.js";
import { ok, fail } from "../envelope.js";
import { enterBot, botParam, ToolProblem } from "./common.js";
import { describeRateLimit } from "../discord/client.js";

import { readIntents } from "../discord/intents.js";
import { getGatewayState } from "../discord/gateway.js";
import { PACKAGE_ROOT, defaultHome, legacyHome, readableByOthers, usingLegacyHome } from "../home.js";
import { npxCacheWarning } from "../install.js";
import { rateLimitStats } from "../discord/rateLimit.js";
import { growthChecks } from "../discord/thresholds.js";
import { SERVER_INFO } from "../identity.js";
import { LEGACY_PREFIX, PREFIX, legacySettingsInUse, settingSource } from "../settings.js";
import { RELEASES_URL, UPDATE_COMMAND, availableUpdate } from "../updateCheck.js";
import { confirmMode, safeModeEnabled, unknownConfirmMode } from "../safety.js";
import { appCanShowDialog } from "../requestContext.js";

// The gateway state reported for a bot other than the default one.
const NO_CONNECTION = { status: "off", reason: "only the default bot holds the live connection" } as const;

interface SetupCheck {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const PORTAL_BOT_PAGE =
  "https://discord.com/developers/applications, select your app, Bot page";

export function registerDiagnostics(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "get_rate_limit_status",
    {
      title: "Get rate limit status",
      description:
        "How rate limiting has been going: how many times Discord asked " +
        "this server to slow down (the request layer waits automatically), " +
        "and the invalid-request counter that matters because Discord " +
        "temporarily bans an IP after 10,000 invalid responses in ten " +
        "minutes. Useful when calls feel slow.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const stats = rateLimitStats();
      return ok(
        `${stats.rate_limit_hits} rate-limit wait(s) so far` +
          (stats.invalid_request_warnings > 0
            ? `, ${stats.invalid_request_count} invalid request(s) tracked`
            : "") +
          ".",
        stats
      );
    }
  );

  server.registerTool(
    "get_bot_info",
    {
      title: "Get bot info",
      description:
        "Identity and status of a connected Discord bot: bot user, " +
        "application, guild count, enabled gateway intents, and the " +
        "server version. With more than one bot configured, pass bot to " +
        "pick which (list_servers shows the configured bots). Use " +
        "run_setup_check for a full health check with fix instructions.",
      inputSchema: { bot: botParam },
      annotations: { readOnlyHint: true },
    },
    async ({ bot: botArg }) => {
      let entered: { rest: REST; bot: BotConfig };
      try {
        entered = enterBot(config, botArg);
      } catch (err) {
        if (err instanceof ToolProblem) return err.result;
        throw err;
      }
      const { rest, bot: selectedBot } = entered;

      try {
        const [user, app, guilds] = await Promise.all([
          rest.get(Routes.user("@me")) as Promise<RESTGetAPIUserResult>,
          rest.get(
            Routes.currentApplication()
          ) as Promise<RESTGetCurrentApplicationResult>,
          rest.get(
            Routes.userGuilds()
          ) as Promise<RESTGetAPICurrentUserGuildsResult>,
        ]);

        const intents = readIntents(app.flags ?? 0);
        // The guild list endpoint returns at most 200 entries per page.
        // Pagination is not worth wiring up until a bot of ours can
        // realistically exceed that.
        const guildCount = guilds.length;
        const guildCountDisplay =
          guildCount >= 200 ? "200 or more" : String(guildCount);

        const intentSummary = [
          intents.members ? "members on" : "members OFF",
          intents.messageContent ? "message content on" : "message content OFF",
          intents.presence ? "presence on" : "presence off",
        ].join(", ");

        return ok(
          `Logged in as ${user.username} (app: ${app.name}). ` +
            `In ${guildCountDisplay} server${guildCount === 1 ? "" : "s"}. Intents: ${intentSummary}. ` +
            `discord-mcp v${VERSION}.`,
          {
            bot: {
              id: user.id,
              username: user.username,
              name: selectedBot.name,
              ...(selectedBot.source ? { token_from: selectedBot.source } : {}),
            },
            application: { id: app.id, name: app.name },
            guilds: {
              count: guildCount,
              capped: guildCount >= 200,
              // First few guilds by id and name. Enough for a human or a
              // model to grab the right id for DISCORD_MCP_GUILD without a
              // separate lookup.
              list: guilds
                .slice(0, 10)
                .map((g) => ({ id: g.id, name: g.name })),
            },
            // Only the default bot holds the live connection. Its state
            // was reported for every bot, so a second bot read as online
            // and watchable when it is neither.
            gateway: selectedBot.isDefault ? getGatewayState() : NO_CONNECTION,
            intents,
            server: { name: SERVER_INFO.name, version: VERSION },
          }
        );
      } catch (err) {
        return describeRestError(err);
      }
    }
  );

  server.registerTool(
    "run_setup_check",
    {
      title: "Run setup check",
      description:
        "End-to-end health check of the discord-mcp setup: token presence and " +
        "validity, privileged gateway intent toggles, Discord's growth thresholds " +
        "(App Verification by servers, intent review by users), default guild membership, whether " +
        "this install runs from npm's temporary npx cache, how destructive " +
        "actions get confirmed in this app, and leftovers from before the 2.0 rename. " +
        "Every failed check comes with instructions for fixing it. With more " +
        "than one bot configured, pass bot to check a specific one. Run this " +
        "first when anything misbehaves.",
      inputSchema: { bot: botParam },
      annotations: { readOnlyHint: true },
    },
    async ({ bot: botArg }) => {
      const checks: SetupCheck[] = [];

      // Check 0: where this copy runs from. First, because it has nothing to
      // do with the token and check 1 returns early when the token is
      // missing. Only reported when there is something wrong, so a healthy
      // install's pass count does not change.
      if (npxCacheWarning(PACKAGE_ROOT, process.env)) {
        checks.push({
          check: "install_location",
          status: "warn",
          detail:
            `Running from npm's npx cache (${PACKAGE_ROOT}), which npm does ` +
            "not keep. When it is cleared, the AI client fails to start " +
            'it and shows "Server disconnected".',
          fix:
            "Run `npx @orygn/discord-mcp@latest init`, choose \"Re-register " +
            'with your AI client", then fully restart the client.',
        });
      }

      // A newer release, when the daily check has found one.
      const newer = availableUpdate();
      if (newer) {
        checks.push({
          check: "version",
          status: "warn",
          detail: `discord-mcp ${newer} is available; this is ${VERSION}.`,
          fix:
            `Run \`${UPDATE_COMMAND}\`, choose "Re-register with your AI client", then fully restart the client. ` +
            `What changed: ${RELEASES_URL}`,
        });
      }

      // Leftovers from before the 2.0 rename. Both keep working through 2.x,
      // so they are warnings, reported only when present.
      const legacyNames = legacySettingsInUse();
      if (legacyNames.length > 0) {
        const one = legacyNames.length === 1;
        checks.push({
          check: "setting_names",
          status: "warn",
          detail:
            `Using the pre-2.0 setting name${one ? "" : "s"} ${legacyNames.join(", ")}. ` +
            (one
              ? "It still works through 2.x and stops working in 3.0."
              : "They still work through 2.x and stop working in 3.0."),
          fix:
            "Rename " +
            legacyNames.map((n) => `${n} to ${n.replace(LEGACY_PREFIX, PREFIX)}`).join(", ") +
            `, wherever ${one ? "it is" : "they are"} set: the AI client's config (env section) or the .env file.`,
        });
      }
      if (usingLegacyHome()) {
        checks.push({
          check: "settings_folder",
          status: "warn",
          detail: `Settings are still in ${legacyHome()}, the folder used before 2.0. They work from there.`,
          fix:
            "Run `npx @orygn/discord-mcp@latest init` and accept the offer to " +
            `switch over, which moves them to ${defaultHome()}.`,
        });
      }

      // How destructive actions get confirmed in this app. It depends on
      // the app, not the token, so it comes before check 1.
      checks.push(confirmationCheck());

      // Check 1: a bot is configured.
      if (config.bots.length === 0) {
        checks.push({
          check: "token_present",
          status: "fail",
          detail: "No DISCORD_TOKEN is set.",
          fix:
            "Run `npx @orygn/discord-mcp init`, or set DISCORD_TOKEN in the MCP " +
            `server config (env section) or in ${configFolders().map((f) => join(f, ".env")).join(" or ")}. ` +
            "Get the token from " +
            PORTAL_BOT_PAGE +
            ", Reset Token.",
        });
        return finishChecks(checks);
      }
      let entered: { rest: REST; bot: BotConfig };
      try {
        entered = enterBot(config, botArg);
      } catch (err) {
        if (err instanceof ToolProblem) return err.result;
        throw err;
      }
      const { rest, bot } = entered;
      // A token file every account on the machine can read gives the bot to
      // any of them. Files the wizard writes are private; one made by hand
      // or by an earlier version may not be.
      const exposed =
        bot.source !== undefined && bot.source !== ENVIRONMENT_SOURCE && readableByOthers(bot.source) === true;
      checks.push({
        check: "token_present",
        status: exposed ? "warn" : "pass",
        // Where the token came from is said so a bot nobody meant to use
        // (a token left in some file) is seen for what it is.
        detail:
          (config.bots.length > 1
            ? `Checking bot ${quoted(bot.name)} of ${config.bots.length} configured.`
            : "DISCORD_TOKEN is set.") +
          (bot.source ? ` It comes from ${bot.source}.` : "") +
          (exposed ? " Other accounts on this machine can read that file, and the token in it is the whole bot." : ""),
        ...(exposed ? { fix: `Make it readable by you alone: chmod 600 "${bot.source}"` } : {}),
      });

      // Check 2: token valid. A 401 from /users/@me means Discord rejected
      // the token itself.
      let app: RESTGetCurrentApplicationResult;
      let guilds: RESTGetAPICurrentUserGuildsResult;
      let me: APIUser;
      try {
        me = (await rest.get(Routes.user("@me"))) as APIUser;
        checks.push({
          check: "token_valid",
          status: "pass",
          detail: "Discord accepted the token.",
        });
        [app, guilds] = await Promise.all([
          rest.get(
            Routes.currentApplication()
          ) as Promise<RESTGetCurrentApplicationResult>,
          // with_counts adds each server's approximate member count, for
          // the user threshold below.
          rest.get(Routes.userGuilds(), {
            query: new URLSearchParams({ with_counts: "true" }),
          }) as Promise<RESTGetAPICurrentUserGuildsResult>,
        ]);
      } catch (err) {
        if (err instanceof DiscordAPIError && err.status === 401) {
          checks.push({
            check: "token_valid",
            status: "fail",
            detail: "Discord rejected the token (401 Unauthorized).",
            fix:
              "The token is wrong, expired, or was reset. Generate a fresh " +
              "one at " +
              PORTAL_BOT_PAGE +
              ", Reset Token, and update DISCORD_TOKEN.",
          });
          return finishChecks(checks);
        }
        // Anything else is an answer too: this is the tool people run when
        // something is wrong, and a dropped connection used to come back as
        // a bare error with every finding so far thrown away.
        checks.push({
          check: "discord_reachable",
          status: "fail",
          detail: `Discord could not be asked about the token: ${unreachableReason(err)}.`,
          fix:
            "Check this machine's network connection and https://discordstatus.com, " +
            "then run the check again.",
        });
        return finishChecks(checks);
      }

      // Check 3: privileged intents. Members and Message Content gate core
      // functionality (member search, reading messages). Presence is only
      // needed for presence-based features and stays optional.
      const intents = readIntents(app.flags ?? 0);
      const intentFix =
        "Open " +
        PORTAL_BOT_PAGE +
        ", scroll to Privileged Gateway Intents, and turn the toggle on. " +
        "Below 10,000 users this needs no review.";
      checks.push({
        check: "intent_members",
        status: intents.members ? "pass" : "fail",
        detail: intents.members
          ? "Server Members intent is enabled."
          : "Server Members intent is disabled. Member listing and search will not work.",
        ...(intents.members ? {} : { fix: intentFix }),
      });
      checks.push({
        check: "intent_message_content",
        status: intents.messageContent ? "pass" : "fail",
        detail: intents.messageContent
          ? "Message Content intent is enabled."
          : "Message Content intent is disabled. Reading and searching messages will not work.",
        ...(intents.messageContent ? {} : { fix: intentFix }),
      });
      checks.push({
        check: "intent_presence",
        status: intents.presence ? "pass" : "warn",
        detail: intents.presence
          ? "Presence intent is enabled."
          : "Presence intent is disabled. Fine unless presence features are needed.",
      });

      // Check 4: Discord's growth thresholds, verification by servers and
      // privileged intents by users (see thresholds.ts). The guild list
      // comes back in pages of 200, so a full page means "at least".
      checks.push(
        ...growthChecks({
          serverCount: guilds.length,
          capped: guilds.length >= 200,
          verified: ((me.public_flags ?? me.flags ?? 0) & UserFlags.VerifiedBot) !== 0,
          memberTotal: guilds.reduce((sum, g) => sum + (g.approximate_member_count ?? 0), 0),
          anyPrivilegedIntent: intents.members || intents.messageContent || intents.presence,
        })
      );

      // Check 5: the gateway connection, which powers presence and event
      // subscriptions. Not fatal: every REST tool works without it.
      const gateway = bot.isDefault ? getGatewayState() : undefined;
      if (!gateway) {
        checks.push({
          check: "gateway",
          status: "pass",
          detail:
            `${quoted(bot.name)} holds no live connection to Discord: only the default bot does. It shows as offline ` +
            "and its servers cannot be watched with subscribe_events. Every other tool works for it.",
        });
      } else if (gateway.status === "connected") {
        checks.push({
          check: "gateway",
          status: "pass",
          detail: `Gateway connected since ${gateway.since}; the bot shows as online.`,
        });
      } else if (gateway.status === "connecting") {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: "Gateway is still connecting; presence and events start shortly.",
        });
      } else if (gateway.status === "off") {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: `Gateway is off (${gateway.reason}); the bot shows offline and event subscriptions are unavailable. REST tools are unaffected.`,
        });
      } else {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: `Gateway error: ${gateway.message}. REST tools are unaffected.`,
          fix: "Restart your AI app; if it persists, check the token and network.",
        });
      }

      // Check 6: default guild membership, only when one is configured.
      if (config.defaultGuild) {
        const present = guilds.some((g) => g.id === config.defaultGuild);
        checks.push({
          check: "default_guild",
          status: present ? "pass" : "fail",
          detail: present
            ? `Bot is a member of the default guild (${config.defaultGuild}).`
            : `Bot is not in the configured default guild (${config.defaultGuild}).`,
          ...(present
            ? {}
            : {
                fix:
                  `Invite the bot to that server, or fix ${settingSource("GUILD")}. ` +
                  "Build the invite URL in the Developer Portal under " +
                  "OAuth2, URL Generator, with the bot scope.",
              }),
        });
      }

      return finishChecks(checks);
    }
  );
}

function confirmationCheck(): SetupCheck {
  const name = settingSource("CONFIRM");
  const unknown = unknownConfirmMode();
  if (unknown !== undefined) {
    return {
      check: "confirmations",
      status: "warn",
      detail: `${name} is "${unknown}", which is not auto, token, or dialog, so auto applies.`,
      fix: `Set ${name} to auto, token, or dialog, or remove it.`,
    };
  }
  if (!safeModeEnabled()) {
    return {
      check: "confirmations",
      status: "pass",
      detail: `Safe mode is off (${settingSource("SAFE_MODE")}=false), so destructive actions run without confirmation.`,
    };
  }
  const mode = confirmMode();
  const canShow = appCanShowDialog();
  if (mode === "dialog" && !canShow) {
    return {
      check: "confirmations",
      status: "warn",
      detail:
        `${name}=dialog requires a confirmation dialog, and this app has not said it can show one, ` +
        "so destructive actions are refused here.",
      fix: `Use an app that supports MCP elicitation, or set ${name}=auto to confirm with a preview token instead.`,
    };
  }
  if (mode !== "token" && canShow) {
    return {
      check: "confirmations",
      status: "pass",
      detail:
        "Destructive actions are confirmed in a dialog this app shows the user, which the AI cannot " +
        `answer for them. If the app closes it unanswered (some do when nobody is there to answer), set ${name}=token.`,
    };
  }
  return {
    check: "confirmations",
    status: "pass",
    detail:
      "Destructive actions are confirmed with a token from a preview, which the AI relays to the user" +
      (mode === "token" ? ` (${name}=token).` : "; this app has not said it can show a confirmation dialog."),
  };
}

function finishChecks(checks: SetupCheck[]) {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const passes = checks.length - fails.length - warns.length;

  let summary = `Setup check: ${passes}/${checks.length} passed`;
  if (warns.length > 0) summary += `, ${warns.length} warning(s)`;
  if (fails.length > 0) {
    summary += `, ${fails.length} FAILED. First failure: ${fails[0].detail}`;
  } else {
    summary += ".";
  }

  const warnings = warns.map((w) => w.detail);
  return fails.length > 0
    ? fail(summary, { checks })
    : ok(summary, { checks }, warnings);
}

// Translates Discord REST errors into something actionable instead of a
// bare status code.
function describeRestError(err: unknown) {
  if (err instanceof DiscordAPIError) {
    if (err.status === 401) {
      return fail(
        "Discord rejected the bot token (401). Reset it in the Developer " +
          "Portal and update DISCORD_TOKEN.",
        { discord_error: { code: err.code, status: err.status } }
      );
    }
    return fail(`Discord API error ${err.status}: ${err.message}`, {
      discord_error: { code: err.code, status: err.status },
    });
  }
  return fail(
    `Could not reach Discord: ${unreachableReason(err)}. Check this machine's network ` +
      "connection and https://discordstatus.com, then try again.",
    { network_error: true }
  );
}

// Why a request did not get an answer from Discord, in a few words.
function unreachableReason(err: unknown): string {
  const limited = describeRateLimit(err);
  if (limited) return limited.replace(/\.$/, "");
  if (err instanceof DiscordAPIError) return `Discord answered ${err.status} (${err.message})`;
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const text = err instanceof Error ? err.message : String(err);
  return cause?.code ? `${text} (${cause.code})` : text;
}
