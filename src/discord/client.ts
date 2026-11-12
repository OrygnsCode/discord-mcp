import { REST, RateLimitError, type RateLimitData } from "@discordjs/rest";
import type { ServerConfig } from "../config.js";
import { assertRouteMatchesLinks } from "./messageLinks.js";
import { attachRateLimitObserver } from "./rateLimit.js";

// Thin wrapper around the Discord REST client. @discordjs/rest already
// queues requests per route bucket and honors the rate limit headers, so
// for now we lean on that. The catalog's circuit breaker for invalid
// requests gets layered on top in a later phase.
//
// One REST client is built per bot token and reused. @discordjs/rest keeps
// its rate-limit buckets inside each instance, so a separate client per
// token means bots never share a rate-limit lane or step on each other.

const restByToken = new Map<string, REST>();

// When a rate limit fails a request instead of waiting it out. Ordinary
// limits are waited out, as they always were: a busy stretch can hold a
// route for a minute, and the call simply finishes later. Discord's hidden
// limits are different. The client sees them as a sublimit, a refusal while
// the route's normal quota is not used up, and the best known one, about
// two name or topic changes per channel per 10 minutes, runs for minutes;
// waiting that out inside a tool call leaves the AI app hanging until it
// gives up on the call. Those fail fast with the reason. Anything past five
// minutes fails too, since no client waits that long.
export const MAX_SUBLIMIT_WAIT_MS = 30_000;
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

export function rejectsRateLimit(data: Pick<RateLimitData, "timeToReset" | "retryAfter" | "sublimitTimeout">): boolean {
  if ((data.sublimitTimeout ?? 0) > MAX_SUBLIMIT_WAIT_MS) return true;
  return Math.max(data.timeToReset ?? 0, data.retryAfter ?? 0) > MAX_RATE_LIMIT_WAIT_MS;
}

// A rate-limit refusal in words, or null for any other error.
export function describeRateLimit(err: unknown): string | null {
  if (!(err instanceof RateLimitError)) return null;
  const waitMs = Math.max(err.timeToReset ?? 0, err.retryAfter ?? 0, err.sublimitTimeout ?? 0);
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  const at = new Date(Date.now() + waitMs).toISOString().slice(11, 16);
  const channelEdit = /^\/channels\/:id$/.test(err.route) && err.method.toUpperCase() === "PATCH";
  return (
    `Discord is holding further ${err.method.toUpperCase()} requests to ${err.route} for about ` +
    `${minutes} minute${minutes === 1 ? "" : "s"} (until ${at} UTC)` +
    (channelEdit
      ? ", most likely its limit of about two name or topic changes per channel every 10 minutes"
      : "") +
    ". This request was not sent. Try again after that."
  );
}

// A route that would not go where it says. Every id is percent-encoded
// into its own path segment, so a slash cannot break out of one, but a
// segment that is exactly "." or ".." is dropped or eats its neighbour when
// the URL is parsed: an "invite code" of ".." under /guilds/{id}/templates/
// would address the server itself. Nothing in a real route is a dot
// segment, so any such request is refused before it is sent. Characters
// that would start a query or fragment are refused too, for routes built
// by hand.
export class UnsafeRouteError extends Error {
  constructor() {
    super("One of the ids in this request is not a valid Discord id, so the request was not sent.");
    this.name = "UnsafeRouteError";
  }
}

export function assertSafeRoute(route: string): void {
  for (const segment of route.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Not valid percent-encoding; judged as written.
    }
    if (decoded === "." || decoded === ".." || /[?#\\\s]/.test(segment)) throw new UnsafeRouteError();
  }
}

export class NoTokenError extends Error {
  constructor() {
    super(
      "No Discord bot token configured. Set DISCORD_TOKEN in the MCP server " +
        "config or in a .env file next to the server. Tokens come from " +
        "https://discord.com/developers/applications under your app's Bot page."
    );
    this.name = "NoTokenError";
  }
}

// The REST client for a specific bot token, built lazily and cached.
export function getRestForToken(token: string): REST {
  let rest = restByToken.get(token);
  if (!rest) {
    // The library reports invalid requests (401, 403, 429) only when given
    // an interval, and its default is never. get_rate_limit_status showed a
    // counter that could not move; every one is reported now.
    rest = new REST({ version: "10", rejectOnRateLimit: rejectsRateLimit, invalidRequestWarningInterval: 1 }).setToken(token);
    // Every verb goes through request(), so this one check covers them all.
    const send = rest.request.bind(rest);
    rest.request = (options) => {
      assertSafeRoute(options.fullRoute);
      assertRouteMatchesLinks(options.fullRoute);
      return send(options);
    };
    attachRateLimitObserver(rest);
    restByToken.set(token, rest);
  }
  return rest;
}

// The REST client for the default bot. Single-bot call sites use this and
// are unaffected by multi-bot configuration.
export function getRest(config: ServerConfig): REST {
  if (!config.token) {
    throw new NoTokenError();
  }
  return getRestForToken(config.token);
}
