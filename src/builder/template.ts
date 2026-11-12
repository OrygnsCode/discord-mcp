import type { GuildChannelLite } from "../discord/guildData.js";
import type { RoleLite } from "../discord/preflight.js";

// Discord server templates (discord.new links) as the live-server shape the
// export decompiler reads, so a template becomes a blueprint the same way a
// real server does.
//
// A template is a snapshot with its ids replaced by small numbers: roles
// count from 0 (@everyone) and channels from 1, overwrites name roles by
// those numbers, and a channel names its category the same way. Every
// channel position comes back as 0 (seen on a template made live), so the
// order of the arrays is the order of the server, and that is what is kept.

export interface SerializedTemplateGuild {
  name?: string;
  description?: string | null;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  afk_timeout?: number;
  roles: Array<{ id: number | string; name: string; permissions: string | number; color?: number; hoist?: boolean; mentionable?: boolean }>;
  channels: Array<{
    id: number | string;
    type: number;
    name: string;
    position?: number;
    topic?: string | null;
    nsfw?: boolean;
    rate_limit_per_user?: number;
    bitrate?: number;
    user_limit?: number;
    parent_id?: number | string | null;
    permission_overwrites?: Array<{ id: number | string; type?: number | string; allow: string | number; deny: string | number }>;
  }>;
}

// The id the template uses for @everyone, standing in for the server id.
export const TEMPLATE_EVERYONE = "0";

export function templateToLive(guild: SerializedTemplateGuild): { guildId: string; roles: RoleLite[]; channels: GuildChannelLite[] } {
  const roles = guild.roles.map((r, i) => ({
    id: String(r.id),
    name: r.name,
    permissions: String(r.permissions),
    // Lowest first, as the array comes; @everyone is 0.
    position: i,
    color: r.color ?? 0,
    hoist: r.hoist ?? false,
    mentionable: r.mentionable ?? false,
    managed: false,
  }));
  const channels = guild.channels.map((c, i) => ({
    id: String(c.id),
    name: c.name,
    type: c.type,
    position: i,
    parent_id: c.parent_id === null || c.parent_id === undefined ? null : String(c.parent_id),
    ...(c.topic ? { topic: c.topic } : {}),
    nsfw: c.nsfw ?? false,
    rate_limit_per_user: c.rate_limit_per_user ?? 0,
    permission_overwrites: (c.permission_overwrites ?? []).map((o) => ({
      id: String(o.id),
      type: Number(o.type ?? 0),
      allow: String(o.allow),
      deny: String(o.deny),
    })),
  })) as GuildChannelLite[];
  return { guildId: TEMPLATE_EVERYONE, roles, channels };
}

// The template code from a link or a bare code.
export function templateCode(input: string): string | undefined {
  const trimmed = input.trim();
  const fromLink = trimmed.match(/(?:discord\.new|discord(?:app)?\.com\/template)\/([A-Za-z0-9-]+)/i);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9-]{2,64}$/.test(trimmed) ? trimmed : undefined;
}

const VERIFICATION = ["none", "low", "medium", "high", "very_high"];
const FILTER = ["off", "members_without_roles", "all_members"];

// Server settings a template carries that a blueprint does not, said so the
// AI can apply them with update_server.
export function templateSettings(guild: SerializedTemplateGuild): Record<string, string> {
  const out: Record<string, string> = {};
  if (guild.verification_level !== undefined && VERIFICATION[guild.verification_level]) out.verification_level = VERIFICATION[guild.verification_level];
  if (guild.explicit_content_filter !== undefined && FILTER[guild.explicit_content_filter]) out.explicit_media_filter = FILTER[guild.explicit_content_filter];
  if (guild.default_message_notifications !== undefined) out.default_notifications = guild.default_message_notifications === 1 ? "only_mentions" : "all_messages";
  return out;
}
