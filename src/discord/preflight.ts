import { PermissionFlagsBits } from "discord-api-types/v10";
import { quoted } from "./names.js";

// Permission math, kept pure so it can be unit tested without a network.
// Implements Discord's documented resolution order: base permissions from
// roles, Administrator shortcut, then channel overwrites applied as
// everyone overwrite, aggregated role overwrites, member overwrite.

export const ALL_PERMISSIONS: bigint = Object.values(
  PermissionFlagsBits
).reduce((acc, bit) => acc | bit, 0n);

export interface RoleLite {
  id: string;
  permissions: string;
  position: number;
  managed?: boolean;
  name?: string;
}

// Discord's hierarchy rule as the client applies it: a higher position
// outranks, and roles sharing a position are ordered by id, the older
// (smaller) id ranking higher. The second clause matters more than it
// sounds. Every role created through the API arrives at position 1, so any
// batch of new roles ties, and a sort on position alone shows them in
// whatever order the API happened to return. Sorts low to high; swap the
// arguments for high to low.
export function compareRolesLowToHigh(
  a: { position: number; id: string },
  b: { position: number; id: string }
): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.id === b.id) return 0;
  return BigInt(a.id) > BigInt(b.id) ? -1 : 1;
}

// A member's highest role in that order; undefined when they hold none but
// @everyone.
export function highestRole<R extends { id: string; position: number }>(
  memberRoleIds: readonly string[],
  roles: readonly R[]
): R | undefined {
  let top: R | undefined;
  for (const role of roles) {
    if (memberRoleIds.includes(role.id) && (!top || compareRolesLowToHigh(role, top) > 0)) top = role;
  }
  return top;
}

// Whether a role is strictly below a member's highest role, which is what
// Discord asks before that member (a bot included) may manage it.
export function belowRole(
  role: { id: string; position: number },
  top: { id: string; position: number } | undefined
): boolean {
  return top !== undefined && compareRolesLowToHigh(role, top) < 0;
}

// Why a role is not below the bot's highest, for a refusal. `top` is the
// bot's highest role.
export function notBelowBot(role: { id: string; position: number; name?: string }, top: { id: string; position: number; name?: string } | undefined): string {
  const name = quoted(role.name ?? role.id);
  if (!top) return `The bot has no role here, so it cannot manage ${name}. Give the bot a role above it.`;
  if (top.id === role.id) return `${name} is the bot's own highest role; Discord lets a bot manage only roles below its highest.`;
  if (role.position > top.position) {
    return `The bot's highest role (position ${top.position}) is below ${name} (position ${role.position}). Discord will reject this. Move the bot's role above the target role.`;
  }
  return (
    `${name} shares position ${top.position} with the bot's highest role, ${quoted(top.name ?? top.id)}, and ranks above it ` +
    "(between roles at one position, the older ranks higher). Discord will reject this. Move the bot's role above it."
  );
}

export interface OverwriteLite {
  id: string;
  // 0 is a role overwrite, 1 is a member overwrite.
  type: number;
  allow: string;
  deny: string;
}

export function computeGuildPermissions(
  memberRoleIds: string[],
  guildId: string,
  roles: RoleLite[]
): bigint {
  let perms = 0n;
  for (const role of roles) {
    // The @everyone role shares its ID with the guild and applies to all.
    if (role.id === guildId || memberRoleIds.includes(role.id)) {
      perms |= BigInt(role.permissions);
    }
  }
  if ((perms & PermissionFlagsBits.Administrator) !== 0n) {
    return ALL_PERMISSIONS;
  }
  return perms;
}

export function computeChannelPermissions(
  memberId: string,
  memberRoleIds: string[],
  guildId: string,
  roles: RoleLite[],
  overwrites: OverwriteLite[]
): bigint {
  const base = computeGuildPermissions(memberRoleIds, guildId, roles);
  // Administrator bypasses every overwrite.
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;

  let perms = base;

  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny);
    perms |= BigInt(everyone.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && memberRoleIds.includes(o.id)) {
      roleAllow |= BigInt(o.allow);
      roleDeny |= BigInt(o.deny);
    }
  }
  perms &= ~roleDeny;
  perms |= roleAllow;

  const mine = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (mine) {
    perms &= ~BigInt(mine.deny);
    perms |= BigInt(mine.allow);
  }

  return perms;
}

export function highestRolePosition(
  memberRoleIds: string[],
  roles: RoleLite[]
): number {
  let highest = 0;
  for (const role of roles) {
    if (memberRoleIds.includes(role.id) && role.position > highest) {
      highest = role.position;
    }
  }
  return highest;
}

// Whether the bot may take a moderation action (kick, ban, timeout)
// against a target member. Pure, so the exact rules are unit tested.
// Discord's rule for moderation is strict hierarchy: the actor's highest
// role must be strictly higher than the target's, the owner is untouchable,
// and nothing moderates itself.
export interface ModerationCheck {
  ok: boolean;
  reason?: string;
}

export function canModerate(input: {
  action: string;
  targetId: string;
  targetTopPosition: number;
  botId: string;
  botTopPosition: number;
  ownerId: string;
  // The two highest roles' ids, when they hold one: at one position, the
  // older role ranks higher (compareRolesLowToHigh).
  targetTopRoleId?: string;
  botTopRoleId?: string;
}): ModerationCheck {
  if (input.targetId === input.botId) {
    return { ok: false, reason: `The bot cannot ${input.action} itself.` };
  }
  if (input.targetId === input.ownerId) {
    const pastTense: Record<string, string> = {
      kick: "kicked",
      ban: "banned",
      timeout: "timed out",
    };
    const verb = pastTense[input.action] ?? `${input.action}ed`;
    return {
      ok: false,
      reason: `The server owner cannot be ${verb} by anyone.`,
    };
  }
  const below =
    input.targetTopRoleId !== undefined && input.botTopRoleId !== undefined
      ? belowRole({ id: input.targetTopRoleId, position: input.targetTopPosition }, { id: input.botTopRoleId, position: input.botTopPosition })
      : input.targetTopPosition < input.botTopPosition;
  if (!below) {
    const tie = input.targetTopPosition === input.botTopPosition && input.targetTopRoleId !== undefined && input.botTopRoleId !== undefined;
    return {
      ok: false,
      reason:
        `The target's highest role (position ${input.targetTopPosition}) ` +
        `is not below the bot's (position ${input.botTopPosition})` +
        (tie ? " (they share a position, and the target's is the older role, which ranks higher)" : "") +
        `. Discord ` +
        `only allows moderating members with strictly lower roles. Move ` +
        `the bot's role up or the target's down.`,
    };
  }
  return { ok: true };
}

// Permission names. Tools accept human-friendly names like "manage messages"
// or "MANAGE_MESSAGES" and translate them to bits. The canonical public
// spelling is snake_case.

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const nameToBit = new Map<string, bigint>();
const canonicalNames: string[] = [];
for (const [key, bit] of Object.entries(PermissionFlagsBits)) {
  nameToBit.set(normalizeName(key), bit);
  canonicalNames.push(toSnakeCase(key));
}
canonicalNames.sort();

export function listPermissionNames(): string[] {
  return [...canonicalNames];
}

export function parsePermissionNames(names: string[]): {
  bits: bigint;
  unknown: string[];
} {
  let bits = 0n;
  const unknown: string[] = [];
  for (const name of names) {
    const bit = nameToBit.get(normalizeName(name));
    if (bit === undefined) unknown.push(name);
    else bits |= bit;
  }
  return { bits, unknown };
}

export function describePermissions(bits: bigint): string[] {
  const out: string[] = [];
  for (const [key, bit] of Object.entries(PermissionFlagsBits)) {
    if ((bits & bit) !== 0n) out.push(toSnakeCase(key));
  }
  return out;
}

// Vetted permission bundles for create_role. Administrator is deliberately
// in no preset; granting it requires spelling it out in the permissions
// list, so it never happens by reflex.
const P = PermissionFlagsBits;

const MEMBER_PRESET =
  P.ViewChannel |
  P.SendMessages |
  P.SendMessagesInThreads |
  P.CreatePublicThreads |
  P.ReadMessageHistory |
  P.AddReactions |
  P.EmbedLinks |
  P.AttachFiles |
  P.UseExternalEmojis |
  P.UseApplicationCommands |
  P.Connect |
  P.Speak |
  P.Stream |
  P.UseVAD |
  P.ChangeNickname;

const MODERATOR_PRESET =
  MEMBER_PRESET |
  P.ManageMessages |
  P.PinMessages |
  // Since 2026-02-23 Manage Messages no longer lets people skip slowmode;
  // this does. Bots are never slowed, so it matters for human moderators.
  P.BypassSlowmode |
  P.ManageThreads |
  P.ModerateMembers |
  P.KickMembers |
  P.MuteMembers |
  P.DeafenMembers |
  P.MoveMembers |
  P.ManageNicknames |
  P.ViewAuditLog;

const ADMIN_PRESET =
  MODERATOR_PRESET |
  P.BanMembers |
  P.ManageChannels |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageWebhooks |
  // Discord split Create from Manage on 2026-02-23: Create* makes new events
  // and expressions, Manage* edits and deletes ones made by others. An admin
  // needs both, to create and to manage.
  P.ManageEvents |
  P.CreateEvents |
  P.ManageGuildExpressions |
  P.CreateGuildExpressions |
  P.CreateInstantInvite |
  // Needed by set_voice_channel_status. This preset is also the bot's
  // recommended invite, so without it that tool could never work.
  P.SetVoiceChannelStatus |
  // A read-only channel denies @everyone the whole send family, private
  // threads included, and Discord lets a bot deny only what it has itself.
  P.CreatePrivateThreads;

export const PERMISSION_PRESETS: Record<string, bigint> = {
  none: 0n,
  member: MEMBER_PRESET,
  moderator: MODERATOR_PRESET,
  admin: ADMIN_PRESET,
};
