import { ChannelFlags, GatewayDispatchEvents } from "discord-api-types/v10";

// Channels the bot cannot see.
//
// From November 16, 2026, Discord's channel list (GET /guilds/{id}/channels)
// leaves out every channel the bot lacks View Channel on, so the REST view of
// a server is silently incomplete. The gateway still dispatches those
// channels, obfuscated: the CHANNEL_OBFUSCATED flag (1 << 17) is set, and only
// id, type, position, and parent_id can be relied on. Discord asks bots that
// manage channels to tell their users about these.
//
// This registry keeps every channel the gateway has delivered, so tools can
// say how many channels exist that the bot cannot see, and in which
// category, instead of presenting part of a server as the whole of it.
//
// The flag by itself does not say which those are. A channel that goes out
// of sight because the bot lost a role, or a role lost a permission, is not
// dispatched again, so it stays unflagged here while Discord's list drops
// it. And until the list starts leaving channels out, a bot that opted into
// obfuscation early gets flagged channels over the gateway that the list
// still names. So what counts is the list the bot just read: a channel is
// hidden when the gateway knows it and that list does not have it.
//
// It only knows what the gateway has delivered, and the gateway runs for the
// default bot alone; callers say so when that knowledge is missing.

export interface HiddenChannel {
  id: string;
  type: number;
  parent_id: string | null;
  position: number;
}

interface KnownChannel extends HiddenChannel {
  obfuscated: boolean;
}

// Discord's channel list as the bot reads it now, to hold the gateway's
// knowledge against.
export interface ListedView {
  // The ids in that list.
  listed: ReadonlySet<string>;
  // Whether the gateway connection is up, which makes what it has delivered
  // current. While it is down a channel deleted in the meantime is still
  // known here and missing from the list, and that is not a hidden channel:
  // then only the flagged ones count.
  current: boolean;
}

const OBFUSCATED = ChannelFlags.ChannelObfuscated;

interface ChannelLike {
  id?: string;
  type?: number;
  parent_id?: string | null;
  position?: number;
  flags?: number;
}

export function isObfuscated(channel: { flags?: number } | undefined): boolean {
  return ((channel?.flags ?? 0) & OBFUSCATED) !== 0;
}

// guildId -> channelId -> channel. A guild present here has had a
// GUILD_CREATE since the gateway connected, so its channels are all here,
// and a missing guild means "unknown".
const byGuild = new Map<string, Map<string, KnownChannel>>();

function toKnown(channel: ChannelLike): KnownChannel | undefined {
  if (typeof channel.id !== "string") return undefined;
  return {
    id: channel.id,
    type: channel.type ?? 0,
    parent_id: channel.parent_id ?? null,
    position: channel.position ?? 0,
    obfuscated: isObfuscated(channel),
  };
}

// Called from the single gateway dispatch handler.
export function handleHiddenChannelDispatch(type: string, data: unknown): void {
  const d = data as Record<string, unknown> | null;
  if (!d) return;
  if (type === GatewayDispatchEvents.GuildCreate) {
    // An unavailable guild (an outage) carries no channel list.
    if (typeof d.id !== "string" || !Array.isArray(d.channels)) return;
    const fresh = new Map<string, KnownChannel>();
    for (const channel of d.channels as ChannelLike[]) {
      const known = toKnown(channel);
      if (known) fresh.set(known.id, known);
    }
    byGuild.set(d.id, fresh);
    return;
  }
  if (type === GatewayDispatchEvents.GuildDelete) {
    // Unavailable means an outage, not leaving; keep what is known.
    if (typeof d.id === "string" && d.unavailable !== true) byGuild.delete(d.id);
    return;
  }
  const guildId = typeof d.guild_id === "string" ? d.guild_id : undefined;
  if (!guildId) return;
  const guild = byGuild.get(guildId);
  if (!guild) return;
  const channel = d as ChannelLike;
  if (typeof channel.id !== "string") return;
  if (type === GatewayDispatchEvents.ChannelDelete) {
    guild.delete(channel.id);
  } else if (
    type === GatewayDispatchEvents.ChannelCreate ||
    type === GatewayDispatchEvents.ChannelUpdate
  ) {
    // An update with full data means the bot can see the channel now, and
    // one with the flag set that it no longer can.
    const known = toKnown(channel);
    if (known) guild.set(known.id, known);
  }
}

// The hidden channels of a guild, or undefined when the gateway has not
// delivered that guild (gateway off, still connecting, or a different bot).
// Without a view of the bot's channel list, these are the channels Discord
// flagged; with one, the channels that list is missing.
export function hiddenChannelsIn(guildId: string, view?: ListedView): HiddenChannel[] | undefined {
  const guild = byGuild.get(guildId);
  if (!guild) return undefined;
  const hidden: HiddenChannel[] = [];
  for (const channel of guild.values()) {
    const missing = view
      ? !view.listed.has(channel.id) && (channel.obfuscated || view.current)
      : channel.obfuscated;
    if (!missing) continue;
    hidden.push({
      id: channel.id,
      type: channel.type,
      parent_id: channel.parent_id,
      position: channel.position,
    });
  }
  return hidden;
}

export interface HiddenSummary {
  // Channels the bot cannot see. Null when unknown.
  count: number | null;
  // Hidden channels per category the bot can see, by category name, plus
  // any outside a category or inside a category that is itself hidden.
  by_category?: Record<string, number>;
  note: string;
}

// A summary for tool output. Category names come from the visible channel
// list; a hidden channel's own name is never available.
export function summarizeHidden(
  guildId: string,
  visibleCategories: Map<string, string>,
  view?: ListedView
): HiddenSummary {
  const hidden = hiddenChannelsIn(guildId, view);
  if (!hidden) {
    return {
      count: null,
      note:
        "Unknown whether any channels are hidden from the bot: that comes from the " +
        "gateway connection, which is off, still connecting, or belongs to another bot.",
    };
  }
  if (hidden.length === 0) {
    return { count: 0, note: "The bot can see every channel in this server." };
  }
  const byCategory: Record<string, number> = {};
  for (const channel of hidden) {
    const label = channel.parent_id
      ? (visibleCategories.get(channel.parent_id) ?? "(a category the bot cannot see)")
      : "(no category)";
    byCategory[label] = (byCategory[label] ?? 0) + 1;
  }
  return {
    count: hidden.length,
    by_category: byCategory,
    note:
      `${hidden.length} channel${hidden.length === 1 ? " is" : "s are"} hidden from the bot ` +
      "because it lacks View Channel there. Discord does not reveal their names or settings, " +
      "and they are missing from every channel list. Give the bot View Channel on them, or " +
      "a role that has it, to manage them.",
  };
}

// Test seam.
export function __resetHiddenChannels(): void {
  byGuild.clear();
}
