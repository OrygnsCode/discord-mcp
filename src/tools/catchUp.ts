import { z } from "zod";
import { channelLabel } from "../discord/grants.js";
import { quoted } from "../discord/names.js";
import { Routes } from "discord-api-types/v10";
import type { APIMessage, APIThreadChannel, RESTGetAPIGuildThreadsResult } from "discord-api-types/v10";
import { DiscordAPIError } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getBotUser, getChannels, type GuildChannelLite } from "../discord/guildData.js";
import { COMPONENTS_V2_FLAG, textFromComponents } from "../discord/components.js";
import { ok, fail } from "../envelope.js";
import { collectImages } from "../discord/messageImages.js";
import { getPortalIntents, isGatewayBot } from "../discord/gateway.js";
import { embedText, enter, forwardedOf, guarded, guildParam, resolveChannel, resolveMember, memberDisplayName } from "./common.js";

// "What did I miss": recent messages across a server in one call. Every
// channel carries the id of its newest message, and ids encode their time,
// so quiet channels are skipped without reading them; only channels with
// something new cost a request.

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

// Channels with a message stream of their own: text, announcement, and the
// text chat of voice and stage channels. Forum posts are threads.
const STREAM_TYPES = new Set([0, 5, 2, 13]);
const THREAD_TYPES = new Set([10, 11, 12]);

export interface CatchUpChannel {
  id: string;
  name: string;
  kind: "channel" | "thread";
  parent?: string;
  lastActivity: number;
}

// Which channels had anything after `since`, newest activity first. Pure.
export function activeSince(
  channels: Array<{ id: string; name?: string | null; type: number; last_message_id?: string | null; parent_id?: string | null }>,
  since: number,
  names: Map<string, string>
): CatchUpChannel[] {
  const out: CatchUpChannel[] = [];
  for (const c of channels) {
    const thread = THREAD_TYPES.has(c.type);
    if (!thread && !STREAM_TYPES.has(c.type)) continue;
    if (!c.last_message_id || !/^\d{17,20}$/.test(c.last_message_id)) continue;
    const at = snowflakeTime(c.last_message_id);
    if (at < since) continue;
    out.push({
      id: c.id,
      name: c.name ?? c.id,
      kind: thread ? "thread" : "channel",
      ...(thread && c.parent_id ? { parent: names.get(c.parent_id) ?? c.parent_id } : {}),
      lastActivity: at,
    });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

// A message that reads as if Discord withheld its content: an ordinary
// message or reply from someone else that carries nothing at all. Without
// the Message Content intent, text, embeds, attachments, and components
// all arrive empty. Join notices, boosts, pins, stickers, forwards, and
// polls are empty in their own way with the intent on, so they do not
// count; counting them told people their intent was off because a few
// members had joined.
export function looksStripped(m: APIMessage, botId: string): boolean {
  if (m.author.id === botId) return false;
  const type = (m.type as number | undefined) ?? 0;
  if (type !== 0 && type !== 19) return false;
  return (
    !m.content &&
    !m.poll &&
    (m.attachments ?? []).length === 0 &&
    (m.embeds ?? []).length === 0 &&
    (m.sticker_items ?? []).length === 0 &&
    (m.components ?? []).length === 0 &&
    (m.message_snapshots ?? []).length === 0
  );
}

// Discord's own notices, said in words. Their content is empty or, for a
// new thread, just the thread's name, which reads like a message otherwise.
export function systemText(m: Pick<APIMessage, "type" | "content">): string | undefined {
  switch (m.type) {
    case 6:
      return "(pinned a message)";
    case 7:
      return "(joined the server)";
    case 8:
    case 9:
    case 10:
    case 11:
      return "(boosted the server)";
    case 18:
      return `(started the thread ${m.content})`;
    default:
      return undefined;
  }
}

// What a message without text is: something forwarded, a poll, an embed, a
// sticker, or files. An embed and a forward are given by their words, on
// one line; the caller cuts the whole to what a catch-up has room for.
export function wordsFor(
  m: Pick<APIMessage, "poll" | "embeds" | "sticker_items" | "attachments"> & Pick<Partial<APIMessage>, "message_snapshots" | "message_reference">
): string {
  const forwarded = forwardedOf(m as APIMessage);
  if (forwarded) {
    const said = [forwarded.content, ...(forwarded.embeds_text ?? []), forwarded.attachments.join(", ")]
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
    return `(forwarded: ${said || "nothing readable"})`;
  }
  if (m.poll) return `(a poll: ${m.poll.question.text ?? ""})`;
  const embed = (m.embeds ?? [])[0];
  if (embed) return `(an embed: ${embedText(embed).replace(/\s+/g, " ") || embed.url || "no title"})`;
  const sticker = (m.sticker_items ?? [])[0];
  if (sticker) return `(the sticker ${sticker.name})`;
  if ((m.attachments ?? []).length) return `(${m.attachments.map((a) => a.filename).join(", ")})`;
  return "";
}

function textOf(m: APIMessage): string {
  const notice = systemText(m);
  if (notice) return notice;
  const v2 = ((m.flags ?? 0) & COMPONENTS_V2_FLAG) !== 0;
  return (m.content || (v2 ? textFromComponents(m.components) : "") || wordsFor(m)).trim();
}

const MAX_TEXT = 300;

export function parseSince(input: string | undefined, hours: number | undefined, now = Date.now()): number | string {
  if (input) {
    const t = Date.parse(input);
    if (Number.isNaN(t)) return `"${input}" is not a date and time. Use ISO 8601, like 2026-11-09T18:00:00Z.`;
    if (t > now) return "since is in the future.";
    if (now - t > 14 * 24 * 3600_000) return "Catching up goes back at most 14 days.";
    return t;
  }
  return now - (hours ?? 24) * 3600_000;
}

// What to say about messages that arrived with nothing in them. When the
// bot's intents are known (it holds the gateway connection), that settles
// it; otherwise several such messages are a strong hint and no more.
export function blankWarning(blank: number, messageContentIntent: boolean | undefined): string[] {
  if (blank === 0 || messageContentIntent === true) return [];
  if (messageContentIntent === false) {
    return [
      `${blank} message(s) came back without their text, because the Message Content intent is off for this bot. ` +
        "Turn it on in the Developer Portal, Bot page, and restart this server.",
    ];
  }
  return blank > 3
    ? [`${blank} messages came back without text, which usually means the Message Content intent is off for this bot; run_setup_check says.`]
    : [];
}

export function registerCatchUpTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "catch_up",
    {
      title: "Catch up",
      description:
        "What happened in a server recently, in one call: every channel and " +
        "thread with new messages since a time (default the last 24 hours), " +
        "busiest first, with who talked, the messages themselves (trimmed), " +
        "@everyone pings, and, with mentions_of, the messages that mention a " +
        "member. Quiet channels are skipped without being read. Read only. " +
        "For one channel's full history use read_messages.",
      inputSchema: {
        guild: guildParam,
        hours: z.number().min(0.25).max(336).optional()
          .describe("How far back to look, in hours. Default 24, at most 14 days."),
        since: z.string().optional()
          .describe("Or an exact start time in ISO 8601, such as when the user was last here."),
        channels: z.array(z.string()).max(25).optional()
          .describe("Only these channels (names or IDs); a category means the channels in it. Default: every channel the bot can read."),
        mentions_of: z.string().optional()
          .describe("A member name or ID; messages that mention them are listed on their own."),
        per_channel: z.number().int().min(1).max(100).optional()
          .describe("Most messages read per channel. Default 30."),
        max_channels: z.number().int().min(1).max(30).optional()
          .describe("Most channels and threads read, taking the most recently active. Default 12."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, hours, since, channels, mentions_of, per_channel, max_channels }) => {
      const start = parseSince(since, hours);
      if (typeof start === "string") return fail(start);
      const { rest, guildId, guildName } = await enter(config, guild);
      // Which channels were active is told by each one's last message, so
      // the list has to be this moment's: one cached half a minute ago
      // would call a channel quiet that has had a message since.
      const all = await getChannels(rest, guildId, { fresh: true });
      const names = new Map(all.map((c) => [c.id, c.name ?? c.id]));

      let pool: GuildChannelLite[] = all;
      if (channels) {
        const picked = await Promise.all(channels.map((c) => resolveChannel(rest, guildId, c)));
        // A category has no messages of its own: naming one means its channels.
        pool = picked.flatMap((c) => (c.type === 4 ? all.filter((x) => x.parent_id === c.id) : [c]));
      }
      // Active threads come from one guild-wide read.
      let threads: APIThreadChannel[] = [];
      try {
        const active = (await rest.get(Routes.guildActiveThreads(guildId))) as RESTGetAPIGuildThreadsResult;
        threads = (active.threads as APIThreadChannel[]).filter((t) => !channels || pool.some((p) => p.id === t.parent_id));
      } catch {
        // Threads are a bonus; the channels still answer.
      }
      const seen = new Set<string>();
      const everything = [...pool, ...threads].filter((c) => !seen.has(c.id) && seen.add(c.id));
      const candidates = activeSince(everything as never, start, names);
      const cap = max_channels ?? 12;
      const limit = per_channel ?? 30;

      let watched: { id: string; name: string } | undefined;
      if (mentions_of) {
        const m = await resolveMember(rest, guildId, mentions_of);
        if (m.user) watched = { id: m.user.id, name: memberDisplayName(m) };
      }
      const me = await getBotUser(rest);

      const results: Array<Record<string, unknown>> = [];
      const unreadable: string[] = [];
      const mentionHits: Array<Record<string, unknown>> = [];
      const pings: Array<Record<string, unknown>> = [];
      let total = 0;
      let blank = 0;
      let imageMessages = 0;
      // Channels the bot cannot read do not use up the cap.
      let tried = 0;
      for (const c of candidates) {
        if (results.length >= cap) break;
        tried++;
        let batch: APIMessage[];
        try {
          batch = (await rest.get(Routes.channelMessages(c.id), {
            query: new URLSearchParams({ limit: String(limit) }),
          })) as APIMessage[];
        } catch (err) {
          if (err instanceof DiscordAPIError && (err.status === 403 || err.status === 404)) {
            unreadable.push(c.kind === "thread" ? quoted(c.name) : channelLabel(c));
            continue;
          }
          throw err;
        }
        const recent = batch.filter((m) => Date.parse(m.timestamp) >= start).reverse();
        if (recent.length === 0) continue;
        total += recent.length;
        imageMessages += recent.filter((m) => collectImages(m).length > 0).length;
        const authors = new Map<string, number>();
        for (const m of recent) {
          const who = m.author.global_name ?? m.author.username;
          authors.set(who, (authors.get(who) ?? 0) + 1);
          const text = textOf(m);
          if (looksStripped(m, me.id)) blank++;
          const where = c.kind === "thread" ? `${quoted(c.name)} (thread in #${c.parent ?? "?"})` : channelLabel(c);
          if (m.mention_everyone) pings.push({ channel: where, author: who, at: m.timestamp, text: text.slice(0, MAX_TEXT) });
          if (watched && (m.mentions ?? []).some((u) => u.id === watched?.id)) {
            mentionHits.push({ channel: where, author: who, at: m.timestamp, text: text.slice(0, MAX_TEXT), id: m.id });
          }
        }
        results.push({
          id: c.id,
          name: c.name,
          kind: c.kind,
          ...(c.parent ? { parent: c.parent } : {}),
          messages_read: recent.length,
          // A full page all inside the window means there were more.
          more_not_read: recent.length === batch.length && batch.length === limit,
          people: [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, messages: n })),
          messages: recent.map((m) => {
            const text = textOf(m);
            return {
              id: m.id,
              author: m.author.global_name ?? m.author.username,
              at: m.timestamp,
              text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text,
              ...(m.attachments.length ? { attachments: m.attachments.length } : {}),
              ...(collectImages(m).length ? { images: collectImages(m).length } : {}),
              ...(m.referenced_message ? { reply_to: m.referenced_message.author.global_name ?? m.referenced_message.author.username } : {}),
            };
          }),
        });
      }

      // Which channels get read is decided by how recently they were
      // active, the only thing known before reading. What comes back is in
      // order of how much was said, as the description promises; equal
      // counts keep the more recent first.
      results.sort((a, b) => (b.messages_read as number) - (a.messages_read as number));

      const window = new Date(start).toISOString();
      const left = candidates.length - tried;
      const busiest = [...results]
        .sort((a, b) => (b.messages_read as number) - (a.messages_read as number))
        .slice(0, 3)
        .map((r) => `${r.kind === "thread" ? quoted(String(r.name)) : channelLabel({ name: String(r.name) })} (${r.messages_read})`);
      const summary =
        results.length === 0
          ? `Nothing new in ${quoted(guildName)} since ${window}.`
          : `Since ${window} in ${quoted(guildName)}: ${total} message(s) across ${results.length} channel(s) and thread(s). ` +
            `Busiest: ${busiest.join(", ")}.` +
            (pings.length ? ` ${pings.length} @everyone or @here ping(s).` : "") +
            (imageMessages ? ` ${imageMessages} message(s) have images; get_message with include_images shows them to you.` : "") +
            (watched ? ` ${mentionHits.length} message(s) mention ${quoted(watched.name)}.` : "");
      return ok(
        summary,
        {
          server: { id: guildId, name: guildName },
          since: window,
          channels: results,
          ...(pings.length ? { everyone_pings: pings } : {}),
          ...(watched ? { mentions: { member: watched, messages: mentionHits } } : {}),
          quiet_channels_skipped: pool.filter((c) => STREAM_TYPES.has(c.type)).length - candidates.filter((c) => c.kind === "channel").length,
        },
        [
          ...(left > 0 ? [`${left} more active channel(s) or thread(s) were not read; raise max_channels (up to 30) or name channels.`] : []),
          ...(results.some((r) => r.more_not_read) ? ["Some channels had more messages than per_channel; read_messages reads further."] : []),
          ...(unreadable.length ? [`The bot cannot read the history of ${unreadable.join(", ")}.`] : []),
          ...blankWarning(blank, isGatewayBot(rest) ? getPortalIntents()?.messageContent : undefined),
        ]
      );
    })
  );
}
