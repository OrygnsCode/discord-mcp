import type { REST } from "@discordjs/rest";

// Rate-limit observer. The @discordjs/rest client owns the actual queueing
// and bucket math; this listens to the events it emits so a diagnostics
// tool can report what has been happening. It counts rather than controls,
// which is the honest scope: the library already prevents us from tripping
// Discord's limits, and this makes that activity visible.

interface RateLimitStats {
  rate_limit_hits: number;
  last_rate_limit: {
    route: string;
    global: boolean;
    timeout_ms: number;
    at: string;
  } | null;
  invalid_request_warnings: number;
  invalid_request_count: number;
  attached: boolean;
}

const stats: RateLimitStats = {
  rate_limit_hits: 0,
  last_rate_limit: null,
  invalid_request_warnings: 0,
  invalid_request_count: 0,
  attached: false,
};

// Every bot's client is observed, each once. A single flag used to stop
// after the first, so with several bots only the first one's rate limits
// were ever counted.
const observed = new WeakSet<REST>();

export function attachRateLimitObserver(rest: REST): void {
  if (observed.has(rest)) return;
  observed.add(rest);
  stats.attached = true;

  rest.on("rateLimited", (info) => {
    stats.rate_limit_hits += 1;
    stats.last_rate_limit = {
      route: info.route,
      global: info.global,
      timeout_ms: Number(info.timeToReset ?? info.retryAfter ?? 0),
      at: new Date().toISOString(),
    };
  });

  rest.on("invalidRequestWarning", (info) => {
    stats.invalid_request_warnings += 1;
    stats.invalid_request_count = info.count;
  });
}

export function rateLimitStats(): RateLimitStats {
  return { ...stats };
}
