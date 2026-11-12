import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type { APIEmoji, APIGuild } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import { resolveEmojiInput } from "../discord/emoji.js";

// Settings that belong to one kind of channel: voice quality and size, how
// long threads stay open, and a forum's defaults. Shared by create_channel
// and update_channel, so both take the same names and check them the same
// way before Discord sees them.

const VOICE = new Set([2, 13]);
const FORUM = new Set([15, 16]);
// Where threads live, so where an auto-archive default means something.
const THREADED = new Set([0, 5, 15, 16]);

export const REQUIRE_TAG_FLAG = 1 << 4;

export const channelSettingsFields = {
  bitrate_kbps: z.number().int().min(8).max(384).optional()
    .describe("Voice and stage audio quality in kbps. Up to 96 without boosts, 128, 256, and 384 at boost levels 1 to 3."),
  user_limit: z.number().int().min(0).max(10000).optional()
    .describe("Most people at once, 0 for no limit. Up to 99 in voice, 10000 in stage."),
  region: z.string().min(1).max(32).optional()
    .describe("Voice region id such as us-east or rotterdam, or automatic."),
  video_quality: z.enum(["auto", "full"]).optional()
    .describe("Camera quality in voice channels: auto, or full (720p)."),
  thread_archive_minutes: z.literal([60, 1440, 4320, 10080]).optional()
    .describe("How long new threads stay open without activity: 60, 1440 (a day), 4320, or 10080 (a week)."),
  default_reaction: z.string().max(64).optional()
    .describe("Forum: the emoji offered on every post, as a character or a custom emoji name; none to remove."),
  default_sort: z.enum(["latest_activity", "creation_date"]).optional()
    .describe("Forum: how posts are ordered."),
  default_layout: z.enum(["list", "gallery"]).optional()
    .describe("Forum: list or gallery view."),
  post_slowmode_seconds: z.number().int().min(0).max(21600).optional()
    .describe("Forum: the slowmode each new post starts with."),
  require_tag: z.boolean().optional()
    .describe("Forum: posts must carry at least one tag."),
};

export type ChannelSettingsInput = {
  bitrate_kbps?: number;
  user_limit?: number;
  region?: string;
  video_quality?: "auto" | "full";
  thread_archive_minutes?: 60 | 1440 | 4320 | 10080;
  default_reaction?: string;
  default_sort?: "latest_activity" | "creation_date";
  default_layout?: "list" | "gallery";
  post_slowmode_seconds?: number;
  require_tag?: boolean;
};

export function hasChannelSettings(input: ChannelSettingsInput): boolean {
  return Object.values(input).some((v) => v !== undefined);
}

// The most a server's boost level allows, in kbps. VIP servers get the top
// rate whatever their boosts.
export function maxBitrateKbps(premiumTier: number, features: string[]): number {
  if (features.includes("VIP_REGIONS")) return 384;
  return [96, 128, 256, 384][Math.max(0, Math.min(3, premiumTier))];
}

// Checks the settings against the channel type and builds the request body
// and the words for the summary. `current` is the channel's flags, when
// editing, so require_tag changes one bit and keeps the rest. Pure except
// for the emoji and guild lookups passed in.
export function channelSettingsBody(
  input: ChannelSettingsInput,
  type: number,
  ctx: {
    guild?: Pick<APIGuild, "premium_tier" | "features">;
    emojis?: APIEmoji[];
    currentFlags?: number;
    // A forum's tags, when editing one; creating says it has none yet.
    availableTags?: Array<{ moderated?: boolean }>;
    creating?: boolean;
  }
): { ok: true; body: Record<string, unknown>; changes: string[] } | { ok: false; reason: string } {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  const kind = VOICE.has(type) ? "voice" : FORUM.has(type) ? "forum" : "text";
  const voiceOnly = (["bitrate_kbps", "user_limit", "region", "video_quality"] as const).filter((k) => input[k] !== undefined);
  if (voiceOnly.length > 0 && kind !== "voice") {
    return { ok: false, reason: `${voiceOnly.join(", ")} only apply to voice and stage channels.` };
  }
  const forumOnly = (["default_reaction", "default_sort", "default_layout", "post_slowmode_seconds", "require_tag"] as const).filter((k) => input[k] !== undefined);
  if (forumOnly.length > 0 && kind !== "forum") {
    return { ok: false, reason: `${forumOnly.join(", ")} only apply to forum channels.` };
  }
  if (input.thread_archive_minutes !== undefined && !THREADED.has(type)) {
    return { ok: false, reason: "thread_archive_minutes applies to text, announcement, and forum channels." };
  }

  if (input.bitrate_kbps !== undefined) {
    const max = type === 13 ? 64 : ctx.guild ? maxBitrateKbps(ctx.guild.premium_tier ?? 0, ctx.guild.features ?? []) : 384;
    if (input.bitrate_kbps > max) {
      return {
        ok: false,
        reason:
          type === 13
            ? `Stage channels go up to 64 kbps.`
            : `This server allows up to ${max} kbps at its boost level; ${input.bitrate_kbps} is more.`,
      };
    }
    body.bitrate = input.bitrate_kbps * 1000;
    changes.push(`bitrate to ${input.bitrate_kbps} kbps`);
  }
  if (input.user_limit !== undefined) {
    if (type === 2 && input.user_limit > 99) return { ok: false, reason: "Voice channels hold at most 99 people (0 for no limit)." };
    body.user_limit = input.user_limit;
    changes.push(input.user_limit === 0 ? "no user limit" : `user limit to ${input.user_limit}`);
  }
  if (input.region !== undefined) {
    const auto = /^(auto|automatic|none)$/i.test(input.region);
    body.rtc_region = auto ? null : input.region.toLowerCase();
    changes.push(auto ? "region automatic" : `region to ${input.region.toLowerCase()}`);
  }
  if (input.video_quality !== undefined) {
    body.video_quality_mode = input.video_quality === "full" ? 2 : 1;
    changes.push(`video quality ${input.video_quality}`);
  }
  if (input.thread_archive_minutes !== undefined) {
    body.default_auto_archive_duration = input.thread_archive_minutes;
    changes.push(`threads archive after ${input.thread_archive_minutes} minutes`);
  }
  if (input.default_reaction !== undefined) {
    if (/^none$/i.test(input.default_reaction.trim())) {
      body.default_reaction_emoji = null;
      changes.push("default reaction removed");
    } else {
      const found = resolveEmojiInput(input.default_reaction, ctx.emojis ?? []);
      if (!found.ok) return { ok: false, reason: found.reason };
      const [name, id] = found.custom ? found.api.split(":") : [found.api, undefined];
      body.default_reaction_emoji = found.custom ? { emoji_id: id, emoji_name: null } : { emoji_id: null, emoji_name: name };
      changes.push(`default reaction ${found.display}`);
    }
  }
  if (input.default_sort !== undefined) {
    body.default_sort_order = input.default_sort === "creation_date" ? 1 : 0;
    changes.push(`posts sorted by ${input.default_sort.replace("_", " ")}`);
  }
  if (input.default_layout !== undefined) {
    body.default_forum_layout = input.default_layout === "gallery" ? 2 : 1;
    changes.push(`${input.default_layout} view`);
  }
  if (input.post_slowmode_seconds !== undefined) {
    body.default_thread_rate_limit_per_user = input.post_slowmode_seconds;
    changes.push(`new posts start with ${input.post_slowmode_seconds}s slowmode`);
  }
  if (input.require_tag === true && ctx.creating) {
    return {
      ok: false,
      reason:
        "A new forum has no tags, and Discord lets posts require a tag only once the forum has one " +
        "that anyone can use. Create the forum, add tags with create_forum_tag, then turn on " +
        "require_tag with update_channel.",
    };
  }
  if (input.require_tag === true && ctx.availableTags && !ctx.availableTags.some((t) => !t.moderated)) {
    return {
      ok: false,
      reason:
        "Discord lets posts require a tag only once the forum has a tag that anyone can use, not " +
        "only moderators. Add one with create_forum_tag first.",
    };
  }
  if (input.require_tag === false && ctx.creating) {
    // New forums do not require tags; nothing to send.
  } else if (input.require_tag !== undefined) {
    const flags = ctx.currentFlags ?? 0;
    body.flags = input.require_tag ? flags | REQUIRE_TAG_FLAG : flags & ~REQUIRE_TAG_FLAG;
    changes.push(input.require_tag ? "posts need a tag" : "tags optional");
  }
  return { ok: true, body, changes };
}

// What channelSettingsBody needs from Discord, read only when asked for.
export async function channelSettingsContext(rest: REST, guildId: string, input: ChannelSettingsInput): Promise<{ guild?: APIGuild; emojis?: APIEmoji[] }> {
  const [guild, emojis] = await Promise.all([
    input.bitrate_kbps !== undefined ? (rest.get(Routes.guild(guildId)) as Promise<APIGuild>) : Promise.resolve(undefined),
    input.default_reaction !== undefined && !/^none$/i.test(input.default_reaction.trim())
      ? (rest.get(Routes.guildEmojis(guildId)) as Promise<APIEmoji[]>)
      : Promise.resolve(undefined),
  ]);
  return { guild, emojis };
}
