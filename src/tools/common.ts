import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type {
  APIEmbed,
  APIGuildMember,
  APIMessage,
  APIThreadChannel,
  RESTGetAPIGuildMembersSearchResult,
} from "discord-api-types/v10";
import { DiscordAPIError, type REST } from "@discordjs/rest";
import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import type { BotConfig, ServerConfig } from "../config.js";
import { describeRateLimit, getRestForToken, NoTokenError, UnsafeRouteError } from "../discord/client.js";
import { resolveBotGuild, resolveBotName } from "../discord/botRouting.js";
import {
  addResultNote,
  getResultNotes,
  runWithActingContext,
  setActingBot,
  setTargetServer,
} from "../discord/actingContext.js";
import {
  getChannels,
  getGuildList,
  getRoles,
  getBotUser,
  CHANNEL_TYPE_LABELS,
  type GuildChannelLite,
} from "../discord/guildData.js";
import {
  computeChannelPermissions,
  computeGuildPermissions,
} from "../discord/preflight.js";
import { resolveOne, resolvePerson, type Resolvable } from "../discord/resolve.js";
import {
  COMPONENTS_V2_FLAG,
  textFromComponents,
} from "../discord/components.js";
import { fail } from "../envelope.js";
import { settingSource } from "../settings.js";
import { gatewayKeepsCacheFresh, isGatewayBot } from "../discord/gateway.js";
import { MessageLinkError, parseMessageLink, rememberMessageLink } from "../discord/messageLinks.js";
import { oneLine, quoted } from "../discord/names.js";
import { pendingUpdateNotice, updateNoticeGiven } from "../updateCheck.js";
import { VERSION } from "../config.js";
import { summarizeHidden, type HiddenSummary } from "../discord/hiddenChannels.js";
import type { PreparedFiles } from "../discord/uploads.js";
import { collectImages } from "../discord/messageImages.js";

// Helpers shared by every tool module: guild entry, entity resolution,
// message digesting, and the error guard.

export const guildParam = z
  .string()
  .optional()
  .describe("Guild (server) name or ID. Omit to use the default guild.");

export const botParam = z
  .string()
  .optional()
  .describe(
    "Which bot to act as, by name, when more than one is configured. Omit " +
      "to use the default bot, or with a server, the bot that handles it."
  );

// A failure that already knows how to present itself. Thrown by helpers,
// caught by guarded(), returned to the client as a readable envelope.
export class ToolProblem extends Error {
  result: CallToolResult;
  constructor(result: CallToolResult) {
    super("tool problem");
    this.result = result;
  }
}

// Network failures below the API layer (connection timeouts, resets, DNS
// trouble) are transient and worth a retry; surfacing them as raw stack
// noise leaves the model guessing. Observed live during a flaky-network
// Desktop session as undici ConnectTimeoutErrors.
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const codes = [
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ];
  const code = (err as { code?: string }).code;
  if (code && codes.includes(code)) return true;
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  if (cause?.code && codes.includes(cause.code)) return true;
  if (err.name === "ConnectTimeoutError" || cause?.name === "ConnectTimeoutError") {
    return true;
  }
  return /connect timeout|fetch failed/i.test(err.message);
}

// The public archived threads of a channel, newest first. Discord hands
// them out a page at a time and says whether more remain; the first page
// used to be reported as all of them. Read up to a cap, with "more" saying
// whether older ones were left out.
export async function archivedThreads(
  rest: REST,
  channelId: string,
  cap = 300
): Promise<{ threads: APIThreadChannel[]; more: boolean }> {
  const threads: APIThreadChannel[] = [];
  let before: string | undefined;
  let more = false;
  while (threads.length < cap) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const page = (await rest.get(Routes.channelThreads(channelId, "public"), { query })) as {
      threads?: APIThreadChannel[];
      has_more?: boolean;
    };
    const batch = page.threads ?? [];
    threads.push(...batch);
    more = page.has_more === true;
    const oldest = batch[batch.length - 1]?.thread_metadata?.archive_timestamp;
    if (!more || !oldest) break;
    before = oldest;
  }
  return { threads, more };
}

// A message id as Discord issues them, or the message's link, which is what
// "Copy Message Link" gives and what people paste. Checked here so a wrong
// value (a name, a stray character, some other link) is answered with what
// is wanted instead of travelling into a request. The handler always gets
// the bare id; the channel a link named is kept for the check in
// messageLinks.ts.
export const SNOWFLAKE = /^\d{17,20}$/;
export const messageIdParam = z
  .string()
  .refine(
    (v) => SNOWFLAKE.test(v.trim()) || parseMessageLink(v) !== undefined,
    "A message ID is 17 to 20 digits, such as 1234567890123456789. The message's link (Copy Message Link in Discord) works too."
  )
  .transform((v) => {
    const link = parseMessageLink(v);
    if (!link) return v.trim();
    rememberMessageLink(link.messageId, link.channelId);
    return link.messageId;
  })
  .describe("Message ID, or the message's link.");

// Every destructive tool's confirm_token, described once.
export const confirmTokenParam = z
  .string()
  .optional()
  .describe(
    "The token from this exact action's preview. Where the app can show a " +
      "confirmation dialog, calling with it asks the user there, and it " +
      "happens only if they agree."
  );

// A tool's answer, or (from the safety gate) a request that the app ask the
// user something first and then call again.
export type ToolAnswer = CallToolResult | InputRequiredResult;

export function guarded<A>(
  handler: (args: A) => Promise<ToolAnswer>
): (args: A) => Promise<ToolAnswer> {
  return (args: A) =>
    runWithActingContext(async () => {
      let result: ToolAnswer;
      try {
        result = await handler(args);
      } catch (err) {
        result = problemResult(err);
      }
      // A newer version, when one is out, is mentioned once per session,
      // on the first result that can carry it.
      const update = pendingUpdateNotice(VERSION);
      if (update) addResultNote(update);
      // A failure carries the notes too: a refusal for a missing permission
      // is exactly when it matters which of two bots was asked.
      const noted = withResultNotes(result);
      if (update && noted !== result) updateNoticeGiven();
      return noted;
    });
}

// What a thrown error becomes as a tool result. Anything unrecognized is
// thrown on.
function problemResult(err: unknown): CallToolResult {
  if (err instanceof ToolProblem) return err.result;
  if (err instanceof UnsafeRouteError) return fail(err.message);
  if (err instanceof MessageLinkError) return fail(err.message);
  const rateLimited = describeRateLimit(err);
  if (rateLimited) return fail(rateLimited, { rate_limited: true });
  if (isNetworkError(err)) {
    return fail(
      "Could not reach Discord: the connection timed out at the " +
        "network level before any API was involved. This is usually " +
        "transient local network or routing trouble; retrying the " +
        "same call typically works.",
      { network_error: true }
    );
  }
  if (err instanceof DiscordAPIError) {
    if (err.status === 403) {
      return fail(
        "Discord refused access (403). The bot is missing a permission " +
          "for this, or cannot see the channel. Check the bot's role " +
          "and the channel's permission overrides.",
        { discord_error: { code: err.code, status: err.status } }
      );
    }
    return fail(`Discord API error ${err.status}: ${err.message}`, {
      discord_error: { code: err.code, status: err.status },
    });
  }
  throw err;
}

// Adds what the call noted along the way (see addResultNote) to the
// warnings of the envelope a tool returned. Anything that is not an
// envelope, such as a request for a confirmation dialog, passes through.
function withResultNotes(result: ToolAnswer): ToolAnswer {
  const notes = getResultNotes();
  if (notes.length === 0) return result;
  const content = (result as CallToolResult).content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!first || first.type !== "text") return result;
  try {
    const envelope = JSON.parse(first.text) as { summary?: unknown; warnings?: unknown };
    if (typeof envelope.summary !== "string" || !Array.isArray(envelope.warnings)) return result;
    for (const note of notes.map(oneLine)) if (!envelope.warnings.includes(note)) envelope.warnings.push(note);
    return {
      ...(result as CallToolResult),
      content: [{ ...first, text: JSON.stringify(envelope, null, 2) }, ...(content as CallToolResult["content"]).slice(1)],
    };
  } catch {
    return result;
  }
}

// What a tool gets after entering: the acting bot's client, the resolved
// server id, and the bot that owns the action. Existing tools destructure
// rest and guildId and ignore bot; the safety gate and previews use bot.
export interface Entered {
  rest: REST;
  guildId: string;
  guildName: string;
  bot: BotConfig;
}

// "shared" is for the two tools that treat a server several of the user's
// bots are in differently from the rest. "listening": live events arrive
// over the default bot's connection alone, so that bot is the one entered
// when it is there, whichever of them handles the server otherwise. "ask":
// the tool acts on the bot itself and cannot be taken back (leaving), so
// no bot is picked and the caller has to name one.
export async function enter(
  config: ServerConfig,
  guildArg: string | undefined,
  botArg?: string,
  opts: { shared?: "listening" | "ask" } = {}
): Promise<Entered> {
  if (config.bots.length === 0) {
    throw new ToolProblem(fail(new NoTokenError().message));
  }

  // An explicit bot selector narrows the search to that one bot.
  let candidates = config.bots;
  if (botArg) {
    const picked = resolveBotName(
      config.bots.map((b) => b.name),
      botArg
    );
    if (picked.kind === "none") {
      throw new ToolProblem(
        fail(
          `No bot named "${botArg}". Configured bots: ` +
            `${config.bots.map((b) => b.name).join(", ")}.`
        )
      );
    }
    if (picked.kind === "ambiguous") {
      throw new ToolProblem(
        fail(`"${botArg}" matches more than one bot. Use an exact name.`, {
          candidates: picked.candidates,
        })
      );
    }
    candidates = config.bots.filter((b) => b.name === picked.botName);
  }

  const wanted = guildArg ?? config.defaultGuild;
  if (!wanted) {
    throw new ToolProblem(
      fail(
        "No server specified and no default configured. Pass a server name " +
          `or ID, or set ${settingSource("GUILD")}.`
      )
    );
  }

  // Each candidate bot's servers, fetched through that bot's own client and
  // cached per bot. A bot whose list cannot be fetched (a reset token, a
  // transient error) contributes no servers rather than breaking routing for
  // the healthy bots; run_setup_check is where a bad token gets surfaced.
  const botGuilds = await Promise.all(
    candidates.map(async (b) => {
      try {
        const guilds = await getGuildList(getRestForToken(b.token));
        return {
          name: b.name,
          guilds: guilds.map((g) => ({ id: g.id, name: g.name })),
        };
      } catch {
        return { name: b.name, guilds: [] };
      }
    })
  );

  const defaultBot = config.bots.find((b) => b.isDefault)?.name;
  const prefer = { defaultBot, byServer: config.serverBots };
  let resolution = resolveBotGuild(
    botGuilds,
    wanted,
    opts.shared === "ask" ? {} : opts.shared === "listening" ? { defaultBot } : prefer
  );
  const heard = opts.shared === "listening" && resolution.kind === "match" && resolution.botName === defaultBot;
  if (opts.shared === "listening" && resolution.kind === "ambiguous-bot") {
    resolution = resolveBotGuild(botGuilds, wanted, prefer);
  }
  switch (resolution.kind) {
    case "match": {
      // Which bot ran is said whenever it was a choice between several.
      // A subscription says for itself whose connection it listens on.
      if (resolution.shared && !heard) {
        addResultNote(
          `Ran as the bot "${resolution.botName}". ${resolution.shared.bots.length} of your bots are in ` +
            `${quoted(resolution.guildName)} (${resolution.shared.bots.join(", ")}); ` +
            (resolution.shared.why === "configured"
              ? `bots.json gives that server to ${resolution.botName}.`
              : `${resolution.botName} is the default bot. To have another one handle it, ` +
                `set "servers": { "${resolution.guildId}": "<bot name>" } in bots.json.`)
        );
      }
      const bot = config.bots.find((b) => b.name === resolution.botName);
      if (!bot) {
        // Unreachable: the resolver only returns names it was given.
        throw new ToolProblem(
          fail(`Internal error resolving bot "${resolution.botName}".`)
        );
      }
      // Record the acting bot for the safety gate, but only when more than one
      // bot is configured. With a single bot there is nothing to disambiguate,
      // so single-bot previews and tokens stay exactly as before.
      if (config.bots.length > 1) {
        setActingBot({ bot: bot.name, server: resolution.guildName });
      }
      setTargetServer(resolution.guildName, resolution.guildId);
      return {
        rest: getRestForToken(bot.token),
        guildId: resolution.guildId,
        guildName: resolution.guildName,
        bot,
      };
    }
    case "ambiguous-bot":
      throw new ToolProblem(
        fail(
          `More than one of your bots is in ${quoted(resolution.guildName)}: ${resolution.bots.join(", ")}. ` +
            (opts.shared === "ask"
              ? "Pass bot to say which one."
              : "The default bot is not one of them, so nothing says which should handle it. Say so in " +
                `bots.json: "servers": { "${resolution.guildId}": "${resolution.bots[0]}" }, then restart. ` +
                "The few tools that act on a bot itself take a bot parameter instead."),
          {
            server: { id: resolution.guildId, name: resolution.guildName },
            bots: resolution.bots,
          }
        )
      );
    case "no-guild":
      throw new ToolProblem(
        fail(
          `No configured bot is in a server matching "${wanted}". ` +
            "Check the name, or invite one of your bots to that server first."
        )
      );
    case "ambiguous-guild":
      throw new ToolProblem(
        fail(
          `More than one server matches "${wanted}". Use an exact name or ID.`,
          { candidates: resolution.candidates }
        )
      );
  }
}

// Select a bot for operations that are not tied to a server (bot identity,
// diagnostics). Defaults to the default bot; an explicit name picks another.
// Throws a ToolProblem when nothing is configured or the name does not resolve.
export function enterBot(
  config: ServerConfig,
  botArg?: string
): { rest: REST; bot: BotConfig } {
  if (config.bots.length === 0) {
    throw new ToolProblem(fail(new NoTokenError().message));
  }
  let selected = config.bots.find((b) => b.isDefault) ?? config.bots[0];
  if (botArg) {
    const picked = resolveBotName(
      config.bots.map((b) => b.name),
      botArg
    );
    if (picked.kind === "none") {
      throw new ToolProblem(
        fail(
          `No bot named "${botArg}". Configured bots: ` +
            `${config.bots.map((b) => b.name).join(", ")}.`
        )
      );
    }
    if (picked.kind === "ambiguous") {
      throw new ToolProblem(
        fail(`"${botArg}" matches more than one bot. Use an exact name.`, {
          candidates: picked.candidates,
        })
      );
    }
    const found = config.bots.find((b) => b.name === picked.botName);
    if (found) selected = found;
  }
  return { rest: getRestForToken(selected.token), bot: selected };
}

export async function resolveChannel(
  rest: REST,
  guildId: string,
  query: string,
  allowedTypes?: number[]
): Promise<GuildChannelLite> {
  const channels = await getChannels(rest, guildId);
  const pool = channels.filter(
    (c) => !allowedTypes || allowedTypes.includes(c.type)
  );
  const resolution = resolveOne(
    query,
    pool.map((c) => ({
      id: c.id,
      name: c.name ?? "",
      type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
    }))
  );
  if ("match" in resolution) {
    const found = pool.find((c) => c.id === resolution.match.id);
    if (found) return found;
  }

  // Thread fallback: threads never appear in the guild channel list, so
  // a raw ID that did not match gets one direct lookup. Anything in this
  // guild that passes the type filter is accepted, which also covers
  // channels created moments ago that a stale cache missed.
  if (/^\d{17,20}$/.test(query.trim())) {
    try {
      const direct = (await rest.get(
        Routes.channel(query.trim())
      )) as GuildChannelLite & { guild_id?: string };
      if (
        direct.guild_id === guildId &&
        (!allowedTypes || allowedTypes.includes(direct.type))
      ) {
        return direct;
      }
    } catch {
      // Unknown channel; fall through to the normal error.
    }
  }

  const candidates = "candidates" in resolution ? resolution.candidates : [];
  if (candidates.length > 0) {
    throw new ToolProblem(
      fail(`Multiple channels match "${query}". Pick one by ID.`, { candidates })
    );
  }
  // Discord leaves channels the bot cannot view out of the channel list, so
  // "not found" may mean "hidden". Say so unless the bot is known to see
  // every channel.
  const hidden = hiddenChannelSummary(rest, guildId, channels);
  const hint =
    hidden.count === 0
      ? ""
      : hidden.count
        ? ` ${hidden.count} channel(s) in this server are hidden from the bot; if it is one of ` +
          "them, give the bot View Channel there."
        : " If it exists, it may be hidden from the bot: Discord leaves out channels the bot " +
          "cannot view.";
  throw new ToolProblem(fail(`No channel matching "${query}" in this server.${hint}`));
}

export function memberDisplayName(member: APIGuildMember): string {
  return (
    member.nick ??
    member.user?.global_name ??
    member.user?.username ??
    "(unknown)"
  );
}

export async function resolveMember(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIGuildMember> {
  // An ID, bare or as a mention (<@123>), is looked up directly.
  const trimmed = query.trim();
  const id = trimmed.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
  if (id) {
    return (await rest.get(Routes.guildMember(guildId, id))) as APIGuildMember;
  }

  // Discord's search matches the start of a username, a display name, or
  // a server nickname (checked live), and returns them in no stated order.
  const found = (await rest.get(Routes.guildMembersSearch(guildId), {
    query: new URLSearchParams({ query: trimmed, limit: String(MEMBER_SEARCH_LIMIT) }),
  })) as RESTGetAPIGuildMembersSearchResult;

  if (found.length === 0) {
    throw new ToolProblem(
      fail(`No member matching "${query}" in this server.`)
    );
  }
  if (found.length === 1) return found[0];

  const resolution = resolvePerson(
    trimmed,
    found.map(memberResolvable),
    found.length >= MEMBER_SEARCH_LIMIT
  );
  if ("match" in resolution) {
    const member = found.find((m) => m.user?.id === resolution.match.id);
    if (member) return member;
  }
  // Nobody stood out. Everyone Discord returned is offered, best first.
  const candidates =
    "candidates" in resolution && resolution.candidates.length > 0
      ? resolution.candidates
      : found.slice(0, 5).map((m) => ({ ...memberResolvable(m), score: 0 }));
  throw new ToolProblem(
    fail(`Several members match "${query}". Ask which one is meant, then use their user ID.`, {
      candidates: candidates.map(({ aliases: _aliases, ...rest }) => rest),
    })
  );
}

// How many members a name search asks Discord for. More than a handful,
// because the order is Discord's: with five, the person whose name is
// exactly the query could be left out behind five who merely start with it.
const MEMBER_SEARCH_LIMIT = 25;

// A member as the resolver sees them: found by username, display name, or
// server nickname alike. Before, only the username counted, so asking for
// "Sam" picked samantha_k (username) over the member everyone sees as Sam.
export function memberResolvable(m: APIGuildMember): Resolvable {
  return {
    id: m.user?.id ?? "",
    name: m.user?.username ?? "",
    type: "member",
    context: memberDisplayName(m),
    aliases: [m.nick, m.user?.global_name].filter((n): n is string => typeof n === "string" && n.length > 0),
  };
}

// Message types that read as system noise get a readable stand-in instead
// of empty content. 7 is the member join notification.
const SYSTEM_CONTENT: Record<number, string> = {
  7: "(joined the server)",
};

// Discord's content scanning flags, the same bits on attachments and embeds
// (documented 2026-10-28). Scanning can finish after a message is sent, so
// a message read early may not carry them yet.
const CONTENT_SCAN_FLAGS: Array<[number, string]> = [
  [1 << 4, "explicit"],
  [1 << 6, "gore"],
  [1 << 7, "self_harm"],
];

export function contentScanLabels(flags: number | undefined): string[] {
  return CONTENT_SCAN_FLAGS.filter(([bit]) => ((flags ?? 0) & bit) !== 0).map(([, label]) => label);
}

// Attachments and embeds Discord's scanning flagged, or an empty list.
export function flaggedMedia(m: APIMessage): Array<{ kind: string; name: string; flagged: string[] }> {
  const out: Array<{ kind: string; name: string; flagged: string[] }> = [];
  for (const a of m.attachments ?? []) {
    const flagged = contentScanLabels(a.flags);
    if (flagged.length > 0) out.push({ kind: "attachment", name: a.filename, flagged });
  }
  (m.embeds ?? []).forEach((e, i) => {
    const flagged = contentScanLabels((e as { flags?: number }).flags);
    if (flagged.length > 0) {
      out.push({ kind: "embed", name: e.title ?? e.url ?? `embed ${i + 1}`, flagged });
    }
  });
  return out;
}

// Said wherever messages are listed: the digest names attachments only by
// file name, and a model reading one has no way to know the picture can be
// fetched for it (seen with a real model: it said it could not see one).
export function imagesHint(messages: APIMessage[]): string {
  const n = messages.filter((m) => collectImages(m).length > 0).length;
  if (n === 0) return "";
  return (
    ` ${n === 1 ? "1 of them has" : `${n} of them have`} images; get_message with ` +
    "include_images shows them to you."
  );
}

// The words an embed shows: who it is by, its title, its body, its fields,
// and its footer, one to a line. Announcements, bot posts, and webhook
// messages are often an embed and nothing else, so without this a read of
// such a channel comes back as a row of blanks. An embed Discord made from
// a link (a preview) gets less room than one somebody wrote.
const EMBED_TEXT_MAX = 1500;
const LINK_PREVIEW_TEXT_MAX = 300;
const EMBEDS_READ_MAX = 5;

export function embedText(e: APIEmbed): string {
  const lines = [
    e.author?.name,
    e.title,
    e.description,
    ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`),
    e.footer?.text,
  ]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);
  const text = lines.join("\n");
  const max = e.type === undefined || e.type === "rich" ? EMBED_TEXT_MAX : LINK_PREVIEW_TEXT_MAX;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// The text of a message's embeds, for those that have any (an embed can be
// a picture alone), at most five.
export function embedTexts(embeds: APIEmbed[] | undefined): string[] {
  return (embeds ?? []).map(embedText).filter(Boolean).slice(0, EMBEDS_READ_MAX);
}

// A forwarded message carries what it forwards in a snapshot, and has no
// content of its own. This is that snapshot, read like a message.
export function forwardedOf(m: APIMessage) {
  const snap = m.message_snapshots?.[0]?.message;
  if (!snap) return undefined;
  const isV2 = ((snap.flags ?? 0) & COMPONENTS_V2_FLAG) !== 0;
  const texts = embedTexts(snap.embeds);
  return {
    content: snap.content || (isV2 ? textFromComponents(snap.components) : "") || "",
    ...(texts.length > 0 ? { embeds_text: texts } : {}),
    attachments: (snap.attachments ?? []).map((a) => a.filename),
    ...(m.message_reference?.channel_id ? { from_channel_id: m.message_reference.channel_id } : {}),
    ...(m.message_reference?.message_id ? { message_id: m.message_reference.message_id } : {}),
  };
}

export function digestMessage(m: APIMessage) {
  // A Components V2 message keeps its words in components rather than in
  // content, so read it out of there or the message digests as blank.
  const isV2 = ((m.flags ?? 0) & COMPONENTS_V2_FLAG) !== 0;
  const fromComponents = isV2 ? textFromComponents(m.components) : "";
  const flagged = flaggedMedia(m);
  const texts = embedTexts(m.embeds);
  const forwarded = forwardedOf(m);
  return {
    id: m.id,
    author: {
      id: m.author.id,
      name: m.author.global_name ?? m.author.username,
      bot: m.author.bot ?? false,
    },
    content: m.content || fromComponents || SYSTEM_CONTENT[m.type] || "",
    ...(isV2 ? { components_v2: true } : {}),
    created_at: m.timestamp,
    edited: Boolean(m.edited_timestamp),
    attachments: (m.attachments ?? []).map((a) => a.filename),
    ...(collectImages(m).length > 0 ? { images: collectImages(m).length } : {}),
    embeds: (m.embeds ?? []).length,
    ...(texts.length > 0 ? { embeds_text: texts } : {}),
    ...(forwarded ? { forwarded } : {}),
    // Only present when Discord's scanning flagged something, so ordinary
    // messages read exactly as before.
    ...(flagged.length > 0 ? { flagged_media: flagged } : {}),
    reactions: (m.reactions ?? []).map((r) => ({
      emoji: r.emoji.name ?? r.emoji.id ?? "?",
      count: r.count,
    })),
    ...(m.referenced_message
      ? {
          reply_to: {
            id: m.referenced_message.id,
            author:
              m.referenced_message.author.global_name ??
              m.referenced_message.author.username,
            excerpt: (m.referenced_message.content ?? "").slice(0, 80),
          },
        }
      : {}),
  };
}

// Channel types that carry a normal message stream: text, announcement,
// voice text chat, stage text chat, and the three thread kinds.
export const TEXT_BEARING_TYPES = [0, 5, 2, 13, 10, 11, 12];

// The thread kinds by themselves.
export const THREAD_TYPES = [10, 11, 12];

// Channels the acting bot cannot see, for tool output. Only the bot the
// gateway runs as has this knowledge (see hiddenChannels.ts); for any other
// bot the answer is "unknown", never a guessed zero. visibleChannels must be
// the bot's whole channel list, not a part of it: what it lacks is what
// counts as hidden.
export function hiddenChannelSummary(
  rest: REST,
  guildId: string,
  visibleChannels: GuildChannelLite[]
): HiddenSummary {
  if (!isGatewayBot(rest)) {
    return {
      count: null,
      note:
        "Unknown whether any channels are hidden from this bot: that comes from the " +
        "gateway connection, which runs for the default bot only.",
    };
  }
  const categories = new Map(
    visibleChannels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? c.id])
  );
  // Held against the list itself: what the gateway knows of and the list
  // lacks is hidden, whether or not Discord flagged it.
  return summarizeHidden(guildId, categories, {
    listed: new Set(visibleChannels.map((c) => c.id)),
    current: gatewayKeepsCacheFresh(rest),
  });
}

// Discord's own answer for a member's permissions, server-wide or in one
// channel (endpoints added 2026-10-30). In a channel Discord applies its
// implicit rules too: a denied View Channel, or Connect in voice, cancels
// what depends on it even where a role grants it. The local calculation
// does not model that, so Discord's answer is preferred whenever it comes.
// Undefined when Discord cannot answer, for example in a channel the bot
// itself cannot view, which these endpoints require.
export async function discordMemberPermissions(
  rest: REST,
  guildId: string,
  userId: string,
  channelId?: string
): Promise<bigint | undefined> {
  const path = channelId
    ? (`/channels/${channelId}/permissions/member/${userId}` as const)
    : (`/guilds/${guildId}/permissions/member/${userId}` as const);
  try {
    const result = (await rest.get(path)) as { permissions?: string };
    return typeof result.permissions === "string" ? BigInt(result.permissions) : undefined;
  } catch {
    return undefined;
  }
}

// Effective permissions for the bot itself, guild-wide or in a channel.
export async function botPermissions(
  rest: REST,
  guildId: string,
  channel?: GuildChannelLite
): Promise<bigint> {
  const [botUser, roles] = await Promise.all([
    getBotUser(rest),
    getRoles(rest, guildId),
  ]);
  const member = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;
  if (channel) {
    return computeChannelPermissions(
      botUser.id,
      member.roles,
      guildId,
      roles,
      channel.permission_overwrites ?? []
    );
  }
  return computeGuildPermissions(member.roles, guildId, roles);
}

export function requirePermissions(
  have: bigint,
  needed: Array<[bigint, string]>,
  where: string
): void {
  const missing = needed
    .filter(([bit]) => (have & bit) === 0n)
    .map(([, label]) => label);
  if (missing.length > 0) {
    throw new ToolProblem(
      fail(
        `The bot is missing the ${missing.join(", ")} permission(s) ${where}. ` +
          "Grant them through a role or a channel override, then retry."
      )
    );
  }
}

export function parseHexColor(value: string): number {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new ToolProblem(
      fail(`"${value}" is not a hex color. Use the form #5865f2.`)
    );
  }
  return parseInt(hex, 16);
}

// Embed input, shared by every tool that posts or edits a message.
//
// The objects are strict: a key they do not know is refused. They used to
// take a title, a body, a color, and a link and drop anything else without
// a word, so a caller who passed fields got a card with none and no hint
// why.
const EMBED_PICTURE = /^(https?|attachment):\/\/\S+$/i;
const pictureUrl = (name: string) =>
  z
    .string()
    .max(2048)
    .regex(EMBED_PICTURE, `${name} is an http or https link, or attachment://<filename> for a file sent with the same message.`);

export const embedsParam = z
  .array(
    z.strictObject({
      title: z.string().max(256).optional(),
      description: z.string().max(4096).optional(),
      color: z.string().optional().describe("Hex color like #5865f2."),
      url: z
        .string()
        .url()
        .regex(/^https?:\/\//i, "url is an http or https link.")
        .optional()
        .describe("Makes the title a link."),
      author: z.string().max(256).optional().describe("Small line above the title, such as who it is from."),
      fields: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(256),
            value: z.string().min(1).max(1024),
            inline: z.boolean().optional().describe("Sits beside its neighbours instead of on a row of its own."),
          })
        )
        .max(25)
        .optional()
        .describe("Up to 25 name and value pairs under the description."),
      footer: z.string().max(2048).optional().describe("Small line at the bottom."),
      image_url: pictureUrl("image_url")
        .optional()
        .describe("Large picture under the text: an http or https link, or attachment://<filename> for a file that comes with the message."),
      thumbnail_url: pictureUrl("thumbnail_url").optional().describe("Small picture in the top corner, given the same way."),
      timestamp: z
        .string()
        .optional()
        .describe('A time shown beside the footer: "now" for the current time, or ISO 8601, like 2026-11-09T18:00:00Z. With no zone it is read as UTC.'),
    })
  )
  .max(10)
  .optional()
  .describe(
    "Up to 10 embeds. Each needs a title, a description, an author, fields, a footer, or a picture. " +
      "Discord allows 6,000 characters of text across all of one message's embeds."
  );

export type EmbedInput = NonNullable<z.infer<typeof embedsParam>>;

// Discord counts the text of every embed on a message toward one limit.
// It counts characters, so an emoji is one and not the two units
// JavaScript's length gives it, and it trims each piece first: 6,000
// characters and fifty trailing spaces are let through, and a title that
// is only spaces counts as no title. Checked against Discord 2026-11-11.
const EMBEDS_TEXT_TOTAL_MAX = 6000;
const shown = (text: string | undefined): string => (text ?? "").trim();
const characters = (text: string): number => Array.from(text).length;

const ATTACHMENT_REF = /^attachment:\/\/(.+)$/i;

// The embeds as Discord takes them. What Discord would refuse is refused
// here, with which embed and why: one with nothing in it, a time that is
// not one, or too much text between them.
export function mapEmbeds(embeds: EmbedInput): APIEmbed[] {
  let total = 0;
  const mapped = embeds.map((e, i) => {
    const which = embeds.length > 1 ? `Embed ${i + 1}` : "The embed";
    const fields = e.fields ?? [];
    const title = shown(e.title);
    const description = shown(e.description);
    const author = shown(e.author);
    const footer = shown(e.footer);
    if (!(title || description || author || fields.length > 0 || footer || e.image_url || e.thumbnail_url)) {
      throw new ToolProblem(
        fail(`${which} has nothing in it. Give it a title, a description, an author, fields, a footer, or a picture.`)
      );
    }
    let timestamp: string | undefined;
    if (e.timestamp !== undefined) {
      timestamp = embedTime(e.timestamp);
      if (timestamp === undefined) {
        throw new ToolProblem(
          fail(`${which}: ${quoted(e.timestamp, 60)} is not a date and time. Use "now", or ISO 8601, like 2026-11-09T18:00:00Z.`)
        );
      }
    }
    total +=
      characters(title) +
      characters(description) +
      characters(author) +
      characters(footer) +
      fields.reduce((n, f) => n + characters(f.name.trim()) + characters(f.value.trim()), 0);
    return {
      ...(title ? { title: e.title } : {}),
      ...(description ? { description: e.description } : {}),
      ...(e.url !== undefined ? { url: e.url } : {}),
      ...(e.color ? { color: parseHexColor(e.color) } : {}),
      ...(author ? { author: { name: e.author } } : {}),
      ...(fields.length > 0
        ? { fields: fields.map((f) => ({ name: f.name, value: f.value, ...(f.inline !== undefined ? { inline: f.inline } : {}) })) }
        : {}),
      ...(footer ? { footer: { text: e.footer } } : {}),
      ...(e.image_url ? { image: { url: pictureAddress(e.image_url) } } : {}),
      ...(e.thumbnail_url ? { thumbnail: { url: pictureAddress(e.thumbnail_url) } } : {}),
      ...(timestamp ? { timestamp } : {}),
    } as APIEmbed;
  });
  if (total > EMBEDS_TEXT_TOTAL_MAX) {
    throw new ToolProblem(
      fail(
        `These embeds hold ${total} characters of text, and Discord allows 6,000 across all the embeds of one message. ` +
          "Shorten them, or send them as separate messages."
      )
    );
  }
  return mapped;
}

// A date, or a date and a time, as ISO 8601 writes them. A time with no
// zone is read as UTC, which is how Discord reads one (checked
// 2026-11-11), and not as the time of whatever machine this runs on: the
// same input has to mean the same instant on a desktop and in a container.
// Anything else is not a time, loose forms JavaScript would guess at
// included. The one word taken is "now": a model has no clock, and the
// time a card is posted is what its time usually is. Without it the model
// posts the card, reads the message's time back, and edits that in, which
// costs three calls and leaves the message marked as edited.
const EMBED_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

export function embedTime(text: string, now: number = Date.now()): string | undefined {
  const written = text.trim();
  if (written.toLowerCase() === "now") return new Date(now).toISOString();
  const match = EMBED_TIME.exec(written);
  if (!match) return undefined;
  const hasTime = written.length > 10;
  const at = Date.parse(hasTime && match[1] === undefined ? `${written}Z` : written);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

// attachment:// is written in lower case whatever case it came in; the
// file's name after it is kept, since Discord matches that exactly.
function pictureAddress(url: string): string {
  const ref = ATTACHMENT_REF.exec(url);
  return ref ? `attachment://${ref[1]}` : url;
}

// An embed picture given as attachment://name shows only when a file of
// exactly that name comes with the message. When none does, Discord takes
// the message, shows the embed without the picture, and reports nothing
// (checked 2026-11-11), so it is caught here. names are the files the
// message has; the answer is undefined when every picture has its file,
// and otherwise the sentence saying which do not, ending in the advice
// that fits: some when the message has files, none when it has not. The
// names are quoted: on an edit they come out of the message, and an embed
// someone else posted through a webhook can carry any text as a file name.
export function embedFilesProblem(
  embeds: EmbedInput | undefined,
  names: string[],
  advice: { some: string; none: string }
): string | undefined {
  const list = embeds ?? [];
  const missing: string[] = [];
  list.forEach((e, i) => {
    const which = list.length > 1 ? `embed ${i + 1}` : "the embed";
    for (const [part, url] of [["image_url", e.image_url], ["thumbnail_url", e.thumbnail_url]] as const) {
      const ref = url ? ATTACHMENT_REF.exec(url) : null;
      if (ref && !names.includes(ref[1])) missing.push(`attachment://${ref[1]} (${which}'s ${part})`);
    }
  });
  if (missing.length === 0) return undefined;
  return (
    `An embed picture points at a file that does not come with the message: ${missing.join(", ")}. ` +
    "Discord would show the embed without the picture and report nothing. " +
    (names.length > 0 ? `The files are named ${names.map((name) => quoted(name)).join(", ")}. ${advice.some}` : advice.none)
  );
}

// The names attachment:// can point at on a message that already exists:
// its attachments, and the files its embeds already show, which Discord
// moves out of the attachment list while an embed uses them.
export function messageFileNames(message: Pick<APIMessage, "channel_id" | "attachments" | "embeds">): string[] {
  const names = new Set((message.attachments ?? []).map((a) => a.filename));
  for (const e of message.embeds ?? []) {
    for (const url of [e.image?.url, e.thumbnail?.url]) {
      if (!url) continue;
      let at: URL;
      try {
        at = new URL(url);
      } catch {
        continue;
      }
      if (at.hostname !== "cdn.discordapp.com" && at.hostname !== "media.discordapp.net") continue;
      const m = /^\/(?:ephemeral-)?attachments\/(\d+)\/\d+\/([^/]+)$/.exec(at.pathname);
      if (!m || m[1] !== message.channel_id) continue;
      try {
        names.add(decodeURIComponent(m[2]));
      } catch {
        // A stray percent sign: the name as the address has it.
        names.add(m[2]);
      }
    }
  }
  return [...names];
}

// Posts a message body, with files when there are any. Discord answers a
// file over the server's upload limit with 40005; that is said plainly.
export async function postWithFiles(
  rest: REST,
  route: `/${string}`,
  body: unknown,
  prepared?: PreparedFiles,
  extra: { query?: URLSearchParams; auth?: boolean } = {}
): Promise<unknown> {
  try {
    return await rest.post(route, {
      body,
      ...(prepared ? { files: prepared.files } : {}),
      ...extra,
    });
  } catch (err) {
    if (prepared && err instanceof DiscordAPIError && (err.code === 40005 || err.status === 413)) {
      throw new ToolProblem(
        fail(
          "Discord refused the upload as too large for this server. Its limit is 20 MiB " +
            "per file unless the server's boost level raises it. Nothing was sent.",
          { files: prepared.summary, discord_error: { code: err.code, status: err.status } }
        )
      );
    }
    throw err;
  }
}
