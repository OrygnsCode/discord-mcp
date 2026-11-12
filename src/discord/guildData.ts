import type { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  APIRole,
  APIUser,
  RESTGetAPICurrentUserGuildsResult,
} from "discord-api-types/v10";

// Guild structure fetchers with a short TTL cache. Channels and roles get
// read constantly for name resolution but change rarely; thirty seconds of
// staleness is a fine trade against hammering the API on every tool call.

const TTL_MS = 30_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

// The guild channel endpoints return a union type that includes DM shapes
// we can never receive here. This narrow view keeps the rest of the code
// out of cast gymnastics.
export interface GuildChannelLite {
  id: string;
  name: string | null;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
}

// guildId -> bot's REST client -> that bot's view of the channel list.
const channelCache = new Map<string, Map<REST, CacheEntry<GuildChannelLite[]>>>();
const roleCache = new Map<string, CacheEntry<APIRole[]>>();
// The guild list and the bot's own user are per-bot, so their caches are
// keyed by the REST instance (one per bot token). Roles are the same for
// every bot and stay keyed by guild id alone; channels are per bot (above).
// WeakMap so a retired client's cache is collected with it.
const guildListCache = new WeakMap<
  REST,
  CacheEntry<RESTGetAPICurrentUserGuildsResult>
>();

function fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
  if (entry && Date.now() - entry.at < TTL_MS) return entry.value;
  return undefined;
}

// The channel list is what this bot can see, not the whole server: from
// November 16, 2026, Discord leaves channels a bot cannot view out of it
// (see hiddenChannels.ts). Two bots in one server therefore get different
// lists, so this cache is kept per bot (per REST client) within each guild.
// "fresh" is for callers that go by a channel's last_message_id, which
// changes with every message while the cached list stands still: asked
// that way the list is read again, and the cache takes the new copy.
export async function getChannels(
  rest: REST,
  guildId: string,
  opts: { fresh?: boolean } = {}
): Promise<GuildChannelLite[]> {
  const cached = opts.fresh ? undefined : fresh(channelCache.get(guildId)?.get(rest));
  if (cached) return cached;
  const value = (await rest.get(
    Routes.guildChannels(guildId)
  )) as GuildChannelLite[];
  let perBot = channelCache.get(guildId);
  if (!perBot) {
    perBot = new Map();
    channelCache.set(guildId, perBot);
  }
  perBot.set(rest, { at: Date.now(), value });
  return value;
}

export async function getRoles(
  rest: REST,
  guildId: string
): Promise<APIRole[]> {
  const cached = fresh(roleCache.get(guildId));
  if (cached) return cached;
  const value = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
  roleCache.set(guildId, { at: Date.now(), value });
  return value;
}

export async function getGuildList(
  rest: REST
): Promise<RESTGetAPICurrentUserGuildsResult> {
  const cached = fresh(guildListCache.get(rest));
  if (cached) return cached;
  // Discord lists 200 servers a page. Only the first page was read, so a
  // bot in more servers than that could not be routed to the rest of them.
  const value: RESTGetAPICurrentUserGuildsResult = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_GUILD_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(GUILD_PAGE) });
    if (after) query.set("after", after);
    const batch = (await rest.get(Routes.userGuilds(), { query })) as RESTGetAPICurrentUserGuildsResult;
    value.push(...batch);
    if (batch.length < GUILD_PAGE) break;
    after = batch[batch.length - 1].id;
  }
  guildListCache.set(rest, { at: Date.now(), value });
  return value;
}

const GUILD_PAGE = 200;
// 5,000 servers; a bot past that is sharded and beyond what one process of
// this server is for.
const MAX_GUILD_PAGES = 25;

// After the bot joins or leaves a server, its server list is stale.
export function invalidateGuildList(rest: REST): void {
  guildListCache.delete(rest);
}

// Write tools call this after creating or changing guild structure so the
// next read sees fresh data instead of a stale cache entry.
export function invalidateGuildCaches(guildId: string): void {
  channelCache.delete(guildId);
  roleCache.delete(guildId);
}

// Changes made anywhere else (the Discord app, another bot, the other copy
// of this server) arrive as gateway events, and clear the cache the same
// way, so a cached list is as current as the gateway is. That matters
// because Discord allows only 10 reads of a server's channel list a minute;
// reading it fresh on every plan instead ran into that limit. A full
// GUILD_CREATE, sent again after a reconnect, clears it too, since events
// may have been missed in between.
const STRUCTURE_EVENTS = new Set([
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "GUILD_ROLE_CREATE",
  "GUILD_ROLE_UPDATE",
  "GUILD_ROLE_DELETE",
  "GUILD_UPDATE",
  "GUILD_CREATE",
]);

//
// The bot's own roles are structure too. When they change, so may the
// channels it can see, and Discord dispatches nothing for a channel that
// went out of sight that way: the list has to be read again to find out.
// selfId is the bot's user id; other members' updates change nothing here.
export function handleCacheDispatch(type: string | undefined, data: unknown, selfId?: string): void {
  if (!type) return;
  if (type === "GUILD_MEMBER_UPDATE") {
    const m = data as { guild_id?: string; user?: { id?: string } } | null;
    if (selfId && m?.guild_id && m.user?.id === selfId) invalidateGuildCaches(m.guild_id);
    return;
  }
  if (!STRUCTURE_EVENTS.has(type)) return;
  const d = data as { guild_id?: string; id?: string } | null;
  const guildId = type.startsWith("GUILD_") && !type.startsWith("GUILD_ROLE_") ? d?.id : d?.guild_id;
  if (guildId) invalidateGuildCaches(guildId);
}

// Whether a cached entry for this guild exists, for tests.
export function __hasCachedChannels(guildId: string): boolean {
  return channelCache.has(guildId);
}

// The bot's own user, cached for an hour and keyed per bot. Needed constantly
// by preflight to compute the bot's effective permissions, and each bot has a
// distinct identity, so this must never be shared across clients.
const botUserCache = new WeakMap<REST, CacheEntry<APIUser>>();
const BOT_USER_TTL_MS = 60 * 60_000;

export async function getBotUser(rest: REST): Promise<APIUser> {
  const entry = botUserCache.get(rest);
  if (entry && Date.now() - entry.at < BOT_USER_TTL_MS) {
    return entry.value;
  }
  const value = (await rest.get(Routes.user("@me"))) as APIUser;
  botUserCache.set(rest, { at: Date.now(), value });
  return value;
}

export const CHANNEL_TYPE_LABELS: Record<number, string> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "announcement thread",
  11: "public thread",
  12: "private thread",
  13: "stage",
  15: "forum",
  16: "media",
};
