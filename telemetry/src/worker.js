// Receives discord-mcp's anonymous usage reports and keeps daily counts.
// The client side is src/usageReport.ts; docs/privacy.md lists the fields.
//
//   POST /discord-mcp/v1/ping    the daily report of an install
//   POST /discord-mcp/v1/setup   one setup wizard run
//   GET  /discord-mcp/v1/stats   the counts, for whoever holds STATS_TOKEN
//
// It answers nothing outside those paths.
//
// Both POST paths must stay up for good: every published version sends to
// them, including versions that can no longer be updated. Every value is
// checked against a fixed list or pattern; anything else is counted as
// "other" or dropped, so a report can never add a row of its own making.

const SCHEMA = 1;
const BASE = '/discord-mcp/v1';
const MAX_BODY = 64 * 1024;
const MAX_DAYS = 7;
const MAX_TOOLS = 250;
const LOG_DAYS = 7;
const NONCE_DAYS = 3;
const DAY_MS = 86_400_000;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TOOL_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const COUNTRY_RE = /^[A-Z][A-Z0-9]$/;

const OS = new Set(['windows', 'macos', 'linux', 'other']);
const APPS = new Set([
  'claude-desktop', 'claude-code', 'cursor', 'vscode', 'windsurf', 'roo-code', 'cline', 'codex', 'zed',
  'goose', 'continue', 'lm-studio', 'gemini-cli', 'kiro', 'chatgpt', 'jetbrains', 'opencode', 'warp',
  'librechat', 'other', 'unknown',
]);
const INSTALLS = new Set(['wizard', 'npx', 'global', 'docker', 'mcpb', 'source', 'other']);
const CONTEXTS = new Set(['default', 'container']);
const BOTS = new Set(['1', '2-3', '4+']);
const SERVERS = new Set(['0', '1', '2-5', '6-20', '21+']);
const LARGEST = new Set(['<50', '50-500', '500-5k', '5k+']);
const AGES = new Set(['0', '1-7', '8-30', '31-90', '90+']);
const COUNTS = new Set(['1-9', '10-99', '100+']);
const GATE = new Set(['preview', 'confirmed', 'declined']);
const ERRORS = new Set(['permission', 'intents', 'rate_limited', 'not_found', 'validation', 'no_token', 'network', 'other']);
const FLOWS = new Set(['fresh', 'add_bot', 'reregister', 'upgrade']);
const OUTCOMES = new Set(['completed', 'unfinished', 'cancelled', 'failed']);
const SETUP_APPS = new Set(['claude-desktop', 'claude-code', 'cursor', 'windsurf', 'snippet', 'other']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && (url.pathname === `${BASE}/ping` || url.pathname === `${BASE}/setup`)) {
      return receive(request, env, url.pathname === `${BASE}/ping` ? 'ping' : 'setup');
    }
    // Everything else is private. A failed check answers 404, like an
    // address that does not exist, and an unset STATS_TOKEN refuses all.
    if (request.method === 'GET' && url.pathname === `${BASE}/stats` && (await authorized(request, env))) {
      return Response.json(await stats(env.DB, intParam(url, 'days', 30, 1, 400)));
    }
    return new Response('not found', { status: 404 });
  },

  // Once a day: forget report numbers after three days and the log after seven.
  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM nonces WHERE seen < ?1').bind(isoDay(now - NONCE_DAYS * DAY_MS)),
      env.DB.prepare('DELETE FROM log WHERE ts < ?1').bind(new Date(now - LOG_DAYS * DAY_MS).toISOString()),
    ]);
  },
};

// ── receiving ─────────────────────────────────────────────────────────────

async function receive(request, env, kind) {
  // An address sending far more than any client would is not recorded past
  // the limit. The address is only the limiter's key and is never stored.
  const address = request.headers.get('cf-connecting-ip');
  if (address && env.PING_LIMIT) {
    const { success } = await env.PING_LIMIT.limit({ key: address });
    if (!success) return new Response(null, { status: 204 });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) return new Response('too large', { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response('too large', { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!body || typeof body !== 'object' || body.s !== SCHEMA || typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) {
    return new Response('bad report', { status: 400 });
  }

  const now = Date.now();
  const today = isoDay(now);
  const country = typeof request.cf?.country === 'string' && COUNTRY_RE.test(request.cf.country) ? request.cf.country : 'XX';
  const clean = kind === 'ping' ? cleanPing(body, now) : cleanSetup(body);
  const rows = kind === 'ping' ? pingRows(clean, today, country) : setupRows(clean, today);

  // One transaction: the report's number, the counts, the log. A number
  // seen before (a report sent again after an answer that never arrived)
  // turns fresh to 0, and the two inserts after it then add nothing. If
  // anything fails, none of it stays, and the client's retry counts.
  const fresh = 'SELECT fresh FROM nonces WHERE nonce = ?2';
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO nonces (nonce, seen, fresh) VALUES (?1, ?2, 1) ON CONFLICT (nonce) DO UPDATE SET fresh = 0',
      ).bind(body.nonce, today),
      // Every count in one statement.
      env.DB.prepare(
        `INSERT INTO daily (day, metric, key, n)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 1
         FROM json_each(?1) WHERE (${fresh}) = 1
         ON CONFLICT (day, metric, key) DO UPDATE SET n = n + 1`,
      ).bind(JSON.stringify(rows), body.nonce),
      env.DB.prepare(`INSERT INTO log (ts, kind, body) SELECT ?1, ?3, ?4 WHERE (${fresh}) = 1`).bind(
        new Date(now).toISOString(),
        body.nonce,
        kind,
        JSON.stringify({ ...clean, country }),
      ),
    ]);
  } catch (err) {
    console.error('report not recorded', String(err));
    return new Response('error', { status: 500 });
  }
  return new Response(null, { status: 204 });
}

function pick(value, allowed, fallback = 'other') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function version(value) {
  return typeof value === 'string' && VERSION_RE.test(value) ? value : 'other';
}

function bandMap(value, keys) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let n = 0;
  for (const [k, band] of Object.entries(value)) {
    if (n >= MAX_TOOLS) break;
    if (!(keys instanceof Set ? keys.has(k) : keys.test(k)) || !COUNTS.has(band)) continue;
    out[k] = band;
    n += 1;
  }
  return out;
}

// The report reduced to what is allowed. A finished day is only taken from
// the last six weeks and never from the future.
export function cleanPing(body, now) {
  const first = body.first && typeof body.first === 'object' ? body.first : {};
  const earliest = isoDay(now - 42 * DAY_MS);
  const latest = isoDay(now + DAY_MS);
  const days = [];
  const seen = new Set();
  for (const d of Array.isArray(body.days) ? body.days : []) {
    if (days.length >= MAX_DAYS) break;
    if (!d || typeof d.d !== 'string' || !DAY_RE.test(d.d) || d.d < earliest || d.d > latest || seen.has(d.d)) continue;
    seen.add(d.d);
    days.push({
      d: d.d,
      tools: bandMap(d.tools, TOOL_RE),
      gate: bandMap(d.gate, GATE),
      errors: bandMap(d.errors, ERRORS),
      apps: [...new Set((Array.isArray(d.apps) ? d.apps : []).slice(0, 10).map((a) => pick(a, APPS)))],
    });
  }
  return {
    v: version(body.v),
    os: pick(body.os, OS),
    app: pick(body.app, APPS),
    install: pick(body.install, INSTALLS),
    ctx: pick(body.ctx, CONTEXTS),
    bots: pick(body.bots, BOTS),
    servers: pick(body.servers, SERVERS, 'unknown'),
    largest: pick(body.largest, LARGEST, 'unknown'),
    age: pick(body.age, AGES),
    first: { week: first.week === true, month: first.month === true, ever: first.ever === true },
    days,
  };
}

export function cleanSetup(body) {
  return {
    v: version(body.v),
    os: pick(body.os, OS),
    install: pick(body.install, INSTALLS),
    flow: pick(body.flow, FLOWS),
    outcome: pick(body.outcome, OUTCOMES),
    apps: [...new Set((Array.isArray(body.apps) ? body.apps : []).slice(0, 5).map((a) => pick(a, SETUP_APPS)))],
  };
}

// The rows a report adds one to. A report from a source checkout is
// development: it is counted apart and touches nothing else.
export function pingRows(r, today, country) {
  if (r.install === 'source') return [[today, 'dev_pings', '']];
  const rows = [
    [today, 'pings', ''],
    [today, 'version', r.v],
    [today, 'os', r.os],
    [today, 'app', r.app],
    [today, 'install', r.install],
    [today, 'ctx', r.ctx],
    [today, 'country', country],
    [today, 'bots', r.bots],
    [today, 'servers', r.servers],
    [today, 'largest', r.largest],
    [today, 'age', r.age],
  ];
  if (r.first.week) rows.push([today, 'first_week', '']);
  if (r.first.month) rows.push([today, 'first_month', '']);
  if (r.first.ever) rows.push([today, 'first_ever', '']);
  for (const d of r.days) {
    rows.push([d.d, 'reports', '']);
    for (const [tool, band] of Object.entries(d.tools)) rows.push([d.d, 'tool', `${tool}|${band}`]);
    for (const [event, band] of Object.entries(d.gate)) rows.push([d.d, 'gate', `${event}|${band}`]);
    for (const [cls, band] of Object.entries(d.errors)) rows.push([d.d, 'error', `${cls}|${band}`]);
    for (const app of d.apps) rows.push([d.d, 'active_app', app]);
  }
  return rows;
}

export function setupRows(r, today) {
  if (r.install === 'source') return [[today, 'dev_pings', 'setup']];
  const rows = [
    [today, 'setup', `${r.flow}|${r.outcome}`],
    [today, 'setup_version', r.v],
    [today, 'setup_os', r.os],
    [today, 'setup_install', r.install],
  ];
  for (const app of r.apps) rows.push([today, 'setup_app', app]);
  return rows;
}

// ── stats ─────────────────────────────────────────────────────────────────

async function authorized(request, env) {
  if (!env.STATS_TOKEN) return false;
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.STATS_TOKEN);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function intParam(url, name, fallback, min, max) {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// The counts for the last `days` days: a line per day for the headline
// figures, and every breakdown summed over the span.
async function stats(db, days) {
  const from = isoDay(Date.now() - (days - 1) * DAY_MS);
  const { results } = await db.prepare('SELECT day, metric, key, n FROM daily WHERE day >= ?1 ORDER BY day').bind(from).all();
  const perDay = {};
  const totals = {};
  for (const { day, metric, key, n } of results) {
    if (['pings', 'first_week', 'first_month', 'first_ever', 'reports', 'dev_pings'].includes(metric) && key !== 'setup') {
      perDay[day] ??= { pings: 0, first_week: 0, first_month: 0, first_ever: 0, reports: 0, dev_pings: 0 };
      perDay[day][metric] += n;
      continue;
    }
    totals[metric] ??= {};
    totals[metric][key || '-'] = (totals[metric][key || '-'] ?? 0) + n;
  }
  return { from, days, perDay, totals };
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
