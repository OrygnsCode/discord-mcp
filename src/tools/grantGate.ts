import { Routes } from "discord-api-types/v10";
import type { APIGuild, APIRole } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import { getChannels, getRoles, type GuildChannelLite } from "../discord/guildData.js";
import type { Scene } from "../discord/grants.js";
import { gatewayKeepsCacheFresh } from "../discord/gateway.js";
import { hiddenChannelSummary } from "./common.js";

// Loading what the grant checks in ../discord/grants.ts work on, for the
// tools that can hand out power or access.

// The server's roles and channels, and its owner when the check is about a
// member (the owner holds every permission whatever their roles say). The
// cached roles are as current as the gateway keeps them; for a bot without
// it they can be half a minute old, so they are read fresh, since a role
// given a power moments ago must count. The channels a change touches are
// read fresh by the tools themselves.
export async function loadScene(
  rest: REST,
  guildId: string,
  opts: { owner?: boolean } = {}
): Promise<Scene> {
  const [roles, channels, guild] = await Promise.all([
    gatewayKeepsCacheFresh(rest) ? getRoles(rest, guildId) : (rest.get(Routes.guildRoles(guildId)) as Promise<APIRole[]>),
    getChannels(rest, guildId),
    opts.owner ? (rest.get(Routes.guild(guildId)) as Promise<APIGuild>) : Promise.resolve(undefined),
  ]);
  return { guildId, ownerId: guild?.owner_id, roles, channels };
}

// Said when some channels are hidden from the bot, so the check could not
// look at them.
export function hiddenNote(rest: REST, guildId: string, scene: Scene): string | undefined {
  const hidden = hiddenChannelSummary(rest, guildId, scene.channels as GuildChannelLite[]);
  if (!hidden.count) return undefined;
  return (
    `${hidden.count} channel(s) are hidden from the bot, so this cannot say ` +
    "what it would open there."
  );
}

// What tool descriptions say about the confirmation, so every tool that can
// hand out power words it the same way.
export const POWER_EXAMPLES =
  "moderator or admin powers (such as banning, kicking, or timing out " +
  "members, deleting other people's messages, or managing the server, " +
  "roles, or channels)";

export const CONFIRM_STEPS =
  "the first call changes nothing and returns a preview and a " +
  "confirm_token, and repeating the call with the token makes the change";

// How many members hold a role, from Discord's per-role counts, or
// undefined when that is not available. For previews ("3 members have it").
export async function roleMemberCount(rest: REST, guildId: string, roleId: string): Promise<number | undefined> {
  try {
    const counts = (await rest.get(Routes.guildRoleMemberCounts(guildId))) as Record<string, number>;
    return counts[roleId] ?? 0;
  } catch {
    return undefined;
  }
}

export function holdersPhrase(count: number | undefined): string {
  if (count === undefined) return "";
  if (count === 0) return " Nobody has the role yet.";
  return count === 1 ? " 1 member has it now." : ` ${count} members have it now.`;
}
