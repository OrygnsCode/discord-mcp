import { PermissionFlagsBits } from "discord-api-types/v10";
import { quoted } from "./names.js";
import { ALL_PERMISSIONS, compareRolesLowToHigh, type RoleLite } from "./preflight.js";
import {
  CHANNEL_POWERS,
  POWER_PERMISSIONS,
  channelLabel,
  describePowers,
  joinWords,
  permissionsIn,
  serverPermissionsOf,
  type ChannelLite,
  type Scene,
} from "./grants.js";

// A server's security posture, read the way an attacker or a careless
// change would use it: who holds power, how many of them, how someone
// could raise their own power, and which defaults Discord leaves off.
// Pure, so every rule is unit tested; the tool gathers the inputs.

const P = PermissionFlagsBits;

export type Severity = "high" | "medium" | "low" | "info";
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export interface Finding {
  // Stable, so a later run can be compared with this one.
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
  targets?: Array<{ kind: "role" | "channel" | "bot" | "invite" | "webhook"; id: string; name: string; members?: number }>;
}

export interface AuditRole extends RoleLite {
  name: string;
  managed?: boolean;
  tags?: { bot_id?: string; integration_id?: string } | null;
}

export interface AuditInput {
  guildId: string;
  guildName: string;
  ownerId?: string;
  memberCount?: number;
  verificationLevel?: number;
  explicitContentFilter?: number;
  mfaLevel?: number;
  roles: AuditRole[];
  channels: ChannelLite[];
  // Members holding each role (Discord leaves out roles nobody holds and
  // @everyone). Undefined when it could not be read.
  roleCounts?: Record<string, number>;
  botUserId: string;
  botRoleIds: string[];
  // Undefined when the bot could not read them, which the report says.
  onboarding?: { enabled: boolean; prompts: Array<{ title: string; options: Array<{ title: string; role_ids?: string[] }> }> };
  invites?: Array<{ code: string; max_age?: number; max_uses?: number; uses?: number; inviter?: { username?: string } | null; channel?: { name?: string | null } | null; roles?: Array<{ id: string; name?: string }> }>;
  webhooks?: Array<{ id: string; name?: string | null; type: number; channel_id?: string | null; user?: { username?: string } | null }>;
  automodRules?: Array<{ name: string; trigger_type: number; enabled: boolean }>;
  hiddenChannels?: number | null;
}

// The powers that let someone hurt other people or take the server: these
// make a finding high. The rest of POWER_PERMISSIONS make it medium.
const SEVERE =
  P.Administrator |
  P.ManageGuild |
  P.ManageRoles |
  P.ManageChannels |
  P.ManageWebhooks |
  P.BanMembers |
  P.KickMembers |
  P.ModerateMembers;

// What makes someone a moderator for the 2FA rule: Discord's own list for
// "Require 2FA for moderator actions" covers these.
const MODERATOR = SEVERE | P.ManageMessages | P.ManageThreads | P.ManageNicknames;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function holdersText(n: number | undefined): string {
  if (n === undefined) return "";
  return ` (${plural(n, "member")})`;
}

function powersOf(bits: bigint, scope: "server" | "channel" = "server"): string {
  return joinWords(describePowers(bits, scope));
}

// Where a role sits, for the escalation rule: everything below it.
function below(roles: AuditRole[], role: AuditRole): AuditRole[] {
  return roles.filter((r) => compareRolesLowToHigh(r, role) < 0);
}

export function auditServer(input: AuditInput): { findings: Finding[]; checked: string[]; unchecked: string[] } {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const unchecked: string[] = [];
  const scene: Scene = { guildId: input.guildId, ownerId: input.ownerId, roles: input.roles, channels: input.channels };
  const everyone = input.roles.find((r) => r.id === input.guildId);
  const everyonePerms = everyone ? BigInt(everyone.permissions) : 0n;
  const counts = input.roleCounts;
  const total = input.memberCount;
  const manual = input.roles.filter((r) => r.id !== input.guildId && !r.managed);
  const bits = (r: AuditRole) => BigInt(r.permissions);

  // Powers everyone holds.
  checked.push("powers held by @everyone, server-wide and in each channel");
  const everyonePower = everyonePerms & POWER_PERMISSIONS;
  if (everyonePower !== 0n) {
    findings.push({
      id: "everyone-server-power",
      severity: (everyonePower & SEVERE) !== 0n ? "high" : "medium",
      title: `Everyone in the server can ${powersOf(everyonePower)}`,
      detail:
        "These are set on @everyone, so every member has them, including anyone who joined a minute ago" +
        (total !== undefined ? ` (${plural(total, "member")} now)` : "") +
        ".",
      fix: `Take ${powersOf(everyonePower)} off @everyone, and give them to a staff role instead.`,
      targets: [{ kind: "role", id: input.guildId, name: "@everyone", ...(total !== undefined ? { members: total } : {}) }],
    });
  }
  if ((everyonePerms & P.Administrator) === 0n) {
    const byChannel: Array<{ channel: ChannelLite; bits: bigint }> = [];
    for (const channel of input.channels) {
      if (channel.type === 4) continue;
      const extra = permissionsIn(scene, { roleIds: [] }, channel) & CHANNEL_POWERS & ~everyonePerms;
      if (extra !== 0n) byChannel.push({ channel, bits: extra });
    }
    if (byChannel.length > 0) {
      const worst = byChannel.some((c) => (c.bits & (P.ManageRoles | P.ManageChannels | P.ManageWebhooks)) !== 0n);
      findings.push({
        id: "everyone-channel-power",
        severity: worst ? "high" : "medium",
        title: `Everyone has moderator powers in ${plural(byChannel.length, "channel")}`,
        detail: byChannel
          .slice(0, 10)
          .map((c) => `In ${channelLabel(c.channel)}, anyone can ${powersOf(c.bits, "channel")}.`)
          .join(" ") +
          (byChannel.length > 10 ? ` And ${byChannel.length - 10} more.` : "") +
          (worst
            ? " Manage Webhooks lets someone post as anyone, under any name and avatar; Manage Permissions lets them open the channel to themselves for good."
            : ""),
        fix: "Remove those allows from the @everyone overwrite in each channel.",
        targets: byChannel.map((c) => ({ kind: "channel" as const, id: c.channel.id, name: c.channel.name ?? c.channel.id })),
      });
    }
  }

  // Powerful roles held by a large part of the server.
  if (counts && total !== undefined) {
    checked.push("powerful roles held by many members");
    const threshold = Math.max(10, Math.ceil(total * 0.25));
    for (const role of manual) {
      const power = bits(role) & POWER_PERMISSIONS;
      const n = counts[role.id] ?? 0;
      if (power === 0n || n < threshold) continue;
      findings.push({
        id: `wide-role-power:${role.id}`,
        severity: (power & SEVERE) !== 0n ? "high" : "medium",
        title: `${quoted(role.name)} lets ${plural(n, "member")} ${powersOf(power)}`,
        detail:
          `${quoted(role.name)} looks like an everyday role: ${Math.round((n / Math.max(total, 1)) * 100)}% of the server has it, ` +
          "and every one of them holds these powers.",
        fix: `Move ${powersOf(power)} from ${quoted(role.name)} to a smaller staff role.`,
        targets: [{ kind: "role", id: role.id, name: role.name, members: n }],
      });
    }
  } else {
    unchecked.push("how many members hold each role (Discord did not return the counts)");
  }

  // Administrator.
  checked.push("roles with Administrator");
  const admins = manual.filter((r) => (bits(r) & P.Administrator) !== 0n);
  if (admins.length > 0) {
    const holders = counts ? admins.reduce((sum, r) => sum + (counts[r.id] ?? 0), 0) : undefined;
    const many = holders !== undefined && holders > 5 && total !== undefined && holders > total * 0.1;
    findings.push({
      id: "admin-roles",
      severity: many ? "medium" : "info",
      title:
        `${plural(admins.length, "role")} ${admins.length === 1 ? "has" : "have"} Administrator` +
        (holders !== undefined ? `, held by ${plural(holders, "member")}` : ""),
      detail:
        admins.map((r) => `${quoted(r.name)}${holdersText(counts?.[r.id] ?? (counts ? 0 : undefined))}`).join(", ") +
        ". Administrator skips every channel setting and can do anything a member could." +
        (holders !== undefined && admins.length > 1 ? " Someone holding two of these roles is counted twice." : ""),
      fix: many
        ? "Give most of these people a moderator role with only the powers they use."
        : "Nothing to change if these are the people you trust with the whole server.",
      targets: admins.map((r) => ({ kind: "role" as const, id: r.id, name: r.name, ...(counts ? { members: counts[r.id] ?? 0 } : {}) })),
    });
  }

  // Manage Roles above stronger roles: holders can give themselves those.
  checked.push("roles that can hand out stronger roles than their own (Manage Roles)");
  for (const role of manual) {
    const own = bits(role);
    if ((own & P.ManageRoles) === 0n || (own & P.Administrator) !== 0n) continue;
    const stronger = below(manual, role)
      .map((low) => ({ low, gain: bits(low) & POWER_PERMISSIONS & ~own }))
      .filter((x) => x.gain !== 0n);
    if (stronger.length === 0) continue;
    const toAdmin = stronger.filter((x) => (x.gain & P.Administrator) !== 0n);
    const n = counts?.[role.id];
    const nobody = counts !== undefined && (n ?? 0) === 0;
    const shown = (toAdmin.length > 0 ? toAdmin : stronger).slice(0, 5);
    findings.push({
      id: `role-escalation:${role.id}`,
      severity: nobody ? "low" : toAdmin.length > 0 ? "high" : "medium",
      title:
        toAdmin.length > 0
          ? `${quoted(role.name)} can make itself Administrator`
          : `${quoted(role.name)} can give itself powers it does not have`,
      detail:
        `${quoted(role.name)} has Manage Roles, and Discord lets Manage Roles hand out any role below the holder's highest role, ` +
        "themselves included. Below it sit " +
        joinWords(shown.map((x) => `${quoted(x.low.name)} (${powersOf(x.gain)})`)) +
        (stronger.length > shown.length ? `, and ${stronger.length - shown.length} more` : "") +
        "." +
        (nobody ? " Nobody has the role now." : n !== undefined ? ` ${plural(n, "member")} ${n === 1 ? "has" : "have"} it.` : ""),
      fix: `Move ${joinWords(shown.map((x) => quoted(x.low.name)))} above ${quoted(role.name)} in the role list, or take Manage Roles off ${quoted(role.name)}.`,
      targets: [{ kind: "role", id: role.id, name: role.name, ...(n !== undefined ? { members: n } : {}) }, ...shown.map((x) => ({ kind: "role" as const, id: x.low.id, name: x.low.name }))],
    });
  }

  // Bots.
  checked.push("bots with Administrator or moderator powers");
  const botPerms = serverPermissionsOf(scene, { memberId: input.botUserId, roleIds: input.botRoleIds });
  if (botPerms === ALL_PERMISSIONS && input.ownerId !== input.botUserId) {
    findings.push({
      id: "this-bot-admin",
      severity: "low",
      title: "This bot has Administrator",
      detail:
        "That is a valid choice, but whoever holds the bot's token controls the whole server. Every tool " +
        "here also works without it, as long as the bot can see the channels it manages.",
      fix:
        "To limit that, give the bot's role the recommended permission set (the setup wizard's first " +
        "choice) and take Administrator off.",
      targets: [{ kind: "bot", id: input.botUserId, name: "this bot" }],
    });
  }
  const otherBots = input.roles.filter(
    (r) => r.managed && r.tags?.bot_id && r.tags.bot_id !== input.botUserId && (bits(r) & POWER_PERMISSIONS) !== 0n
  );
  const adminBots = otherBots.filter((r) => (bits(r) & P.Administrator) !== 0n);
  if (adminBots.length > 0) {
    findings.push({
      id: "other-bots-admin",
      severity: "medium",
      title: `${plural(adminBots.length, "other bot")} ${adminBots.length === 1 ? "has" : "have"} Administrator`,
      detail:
        `${joinWords(adminBots.map((r) => quoted(r.name)))}. A bot with Administrator is as dangerous as its least careful ` +
        "developer: a leaked token or a hacked bot can delete the server.",
      fix: "Give each bot only the permissions its features need; most never need Administrator.",
      targets: adminBots.map((r) => ({ kind: "bot" as const, id: r.tags?.bot_id ?? r.id, name: r.name })),
    });
  }
  const powerBots = otherBots.filter((r) => (bits(r) & P.Administrator) === 0n && (bits(r) & SEVERE) !== 0n);
  if (powerBots.length > 0) {
    findings.push({
      id: "other-bots-power",
      severity: "info",
      title: `${plural(powerBots.length, "other bot")} can moderate`,
      detail: powerBots.map((r) => `${quoted(r.name)} can ${powersOf(bits(r) & POWER_PERMISSIONS)}`).join(". ") + ".",
      fix: "Check that each still needs these, and remove bots no one uses.",
      targets: powerBots.map((r) => ({ kind: "bot" as const, id: r.tags?.bot_id ?? r.id, name: r.name })),
    });
  }

  // Roles anyone can pick for themselves.
  if (input.onboarding) {
    checked.push("roles members can pick themselves in onboarding");
    if (input.onboarding.enabled) {
      const offered = new Map<string, string>();
      for (const prompt of input.onboarding.prompts) {
        for (const option of prompt.options) for (const id of option.role_ids ?? []) offered.set(id, `${prompt.title}: ${option.title}`);
      }
      const risky = manual.filter((r) => offered.has(r.id) && (bits(r) & POWER_PERMISSIONS) !== 0n);
      if (risky.length > 0) {
        findings.push({
          id: "onboarding-power",
          severity: risky.some((r) => (bits(r) & SEVERE) !== 0n) ? "high" : "medium",
          title: `Anyone can give themselves ${joinWords(risky.map((r) => quoted(r.name)))} in onboarding`,
          detail: risky.map((r) => `${quoted(r.name)} (picked under ${quoted(offered.get(r.id))}) lets them ${powersOf(bits(r) & POWER_PERMISSIONS)}.`).join(" "),
          fix: "Take the powers off those roles, or take the roles out of onboarding.",
          targets: risky.map((r) => ({ kind: "role" as const, id: r.id, name: r.name })),
        });
      }
    }
  } else {
    unchecked.push("onboarding (the bot could not read it)");
  }

  // Invites.
  if (input.invites) {
    checked.push("invites: roles they hand out and how long they last");
    const roleById = new Map(input.roles.map((r) => [r.id, r]));
    const granting = input.invites
      .map((inv) => ({ inv, roles: (inv.roles ?? []).map((r) => roleById.get(r.id)).filter((r): r is AuditRole => r !== undefined) }))
      .filter((x) => x.roles.length > 0);
    const risky = granting.filter((x) => x.roles.some((r) => (bits(r) & POWER_PERMISSIONS) !== 0n));
    if (risky.length > 0) {
      findings.push({
        id: "invite-power",
        severity: "high",
        title: `${plural(risky.length, "invite")} ${risky.length === 1 ? "gives" : "give"} a powerful role to whoever uses ${risky.length === 1 ? "it" : "them"}`,
        detail: risky
          .map((x) => `discord.gg/${x.inv.code} gives ${joinWords(x.roles.map((r) => quoted(r.name)))}` + (x.inv.inviter?.username ? `, made by ${quoted(x.inv.inviter.username)}` : "") + ".")
          .join(" ") + " Anyone the link reaches gets those powers.",
        fix: "Delete those invites, or take the powers off the roles they give.",
        targets: risky.map((x) => ({ kind: "invite" as const, id: x.inv.code, name: `discord.gg/${x.inv.code}` })),
      });
    }
    const forever = input.invites.filter((inv) => (inv.max_age ?? 0) === 0 && (inv.max_uses ?? 0) === 0);
    if (forever.length > 0) {
      findings.push({
        id: "invites-permanent",
        severity: "info",
        title: `${plural(forever.length, "invite")} never ${forever.length === 1 ? "expires" : "expire"} and ${forever.length === 1 ? "has" : "have"} no use limit`,
        detail:
          forever
            .slice(0, 10)
            .map((inv) => `discord.gg/${inv.code}` + (inv.inviter?.username ? ` by ${quoted(inv.inviter.username)}` : "") + (inv.uses !== undefined ? `, used ${inv.uses} times` : ""))
            .join("; ") + (forever.length > 10 ? `; and ${forever.length - 10} more` : "") + ".",
        fix: "Fine for a public server's main invite. Delete the ones nobody uses any more.",
        targets: forever.map((inv) => ({ kind: "invite" as const, id: inv.code, name: `discord.gg/${inv.code}` })),
      });
    }
  } else {
    unchecked.push("invites (that needs Manage Server)");
  }

  // Webhooks.
  if (input.webhooks) {
    checked.push("webhooks");
    const incoming = input.webhooks.filter((w) => w.type === 1);
    if (incoming.length > 0) {
      const channelName = (id?: string | null) => input.channels.find((c) => c.id === id)?.name ?? id ?? "?";
      findings.push({
        id: "webhooks",
        severity: "info",
        title: `${plural(incoming.length, "webhook")} can post in this server`,
        detail:
          "Anyone holding a webhook's URL can post under any name and picture, no account needed. " +
          incoming
            .slice(0, 10)
            .map((w) => `${w.name ? quoted(w.name) : w.id} in #${channelName(w.channel_id)}` + (w.user?.username ? `, made by ${quoted(w.user.username)}` : ""))
            .join("; ") +
          (incoming.length > 10 ? `; and ${incoming.length - 10} more` : "") +
          ".",
        fix: "Delete webhooks nothing uses. If a URL may have leaked, delete that webhook and make a new one.",
        targets: incoming.map((w) => ({ kind: "webhook" as const, id: w.id, name: w.name ?? w.id })),
      });
    }
  } else {
    unchecked.push("webhooks (that needs Manage Webhooks)");
  }

  // Discord's own safety settings.
  checked.push("verification level, media filter, and 2FA for moderators");
  if (input.verificationLevel === 0) {
    findings.push({
      id: "verification-none",
      severity: "medium",
      title: "Anyone can post the moment they join",
      detail: "The verification level is None: a brand-new account with no verified email can talk in every channel it can see.",
      fix: "Set the verification level to at least Low (verified email), with update_server or in Server Settings, Safety Setup.",
    });
  } else if (input.verificationLevel === 1) {
    findings.push({
      id: "verification-low",
      severity: "low",
      title: "Verification only asks for an email",
      detail: "New accounts can post at once. Medium also makes accounts wait until they are 5 minutes old, which slows down raids.",
      fix: "Consider Medium, with update_server or in Server Settings, Safety Setup.",
    });
  }
  if (input.explicitContentFilter === 0) {
    findings.push({
      id: "media-filter-off",
      severity: "medium",
      title: "Explicit images are not filtered",
      detail: "Discord's explicit media filter is off, so explicit images posted anywhere are shown to everyone.",
      fix: "Turn on the explicit media filter for all members, with update_server or in Server Settings, Safety Setup.",
    });
  } else if (input.explicitContentFilter === 1) {
    findings.push({
      id: "media-filter-partial",
      severity: "low",
      title: "Explicit images are only filtered for members without roles",
      detail: "Anyone with any role can post explicit images unfiltered.",
      fix: "Filter media from all members, with update_server or in Server Settings, Safety Setup.",
    });
  }
  const moderatorRoles = manual.filter((r) => (bits(r) & MODERATOR) !== 0n);
  if (input.mfaLevel === 0 && moderatorRoles.length > 0) {
    findings.push({
      id: "mod-2fa-off",
      severity: "medium",
      title: "Moderators do not need two-factor authentication",
      detail:
        `${plural(moderatorRoles.length, "role")} can moderate (${joinWords(moderatorRoles.slice(0, 5).map((r) => quoted(r.name)))}` +
        `${moderatorRoles.length > 5 ? ", and more" : ""}). Without 2FA, a stolen password is enough to ban, delete, and wreck the server.`,
      fix: "The owner can turn on Require 2FA for moderator actions in Server Settings, Safety Setup. Bots cannot change it.",
    });
  }

  // AutoMod.
  if (input.automodRules) {
    checked.push("AutoMod rules");
    const enabled = input.automodRules.filter((r) => r.enabled);
    if (enabled.length === 0) {
      findings.push({
        id: "automod-none",
        severity: "low",
        title: "No AutoMod rules are on",
        detail: "Nothing blocks spam, mass mentions, or slurs before a moderator sees them.",
        fix: "Turn on AutoMod's spam and mention spam rules, and a keyword rule for words you never want posted.",
      });
    } else if (!enabled.some((r) => r.trigger_type === 5)) {
      findings.push({
        id: "automod-no-mention-limit",
        severity: "low",
        title: "Nothing limits mass mentions",
        detail: "There is no mention spam rule, the usual first move in a raid.",
        fix: "Add AutoMod's mention spam rule.",
      });
    }
  } else {
    unchecked.push("AutoMod rules (that needs Manage Server)");
  }

  if (input.hiddenChannels === null) {
    unchecked.push("whether any channels are hidden from this bot");
  } else if ((input.hiddenChannels ?? 0) > 0) {
    unchecked.push(`${plural(input.hiddenChannels ?? 0, "channel")} hidden from this bot`);
  }

  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { findings, checked, unchecked };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

// Who can see and use one channel, judged role by role: someone holding
// that role and nothing else. Members are judged one by one by the tool
// when asked, since roles combine.
export interface RoleAccess {
  id: string;
  name: string;
  see: boolean;
  post: boolean;
  admin: boolean;
  powers: string[];
  members?: number;
}

export function channelAccessByRole(
  scene: Scene,
  channel: ChannelLite,
  counts?: Record<string, number>
): { everyone: RoleAccess; roles: RoleAccess[] } {
  const voice = channel.type === 2 || channel.type === 13;
  // In a forum, Send Messages is what starts a post.
  const postBit = voice ? P.Connect : P.SendMessages;
  // A role's powers here are named beyond what everyone holds server-wide,
  // so @everyone's own (mention @everyone, say) do not repeat on every row.
  const everyoneBase = BigInt(scene.roles.find((r) => r.id === scene.guildId)?.permissions ?? "0");
  const judge = (id: string, name: string, roleIds: string[]): RoleAccess => {
    const server = serverPermissionsOf(scene, { roleIds });
    const here = permissionsIn(scene, { roleIds }, channel);
    const admin = server === ALL_PERMISSIONS;
    return {
      id,
      name,
      see: here !== 0n,
      post: (here & postBit) !== 0n,
      admin,
      powers: admin ? [] : describePowers(here & CHANNEL_POWERS & (roleIds.length ? ~everyoneBase : ALL_PERMISSIONS), "channel"),
      ...(counts && id !== scene.guildId ? { members: counts[id] ?? 0 } : {}),
    };
  };
  const everyone = judge(scene.guildId, "@everyone", []);
  const roles = [...scene.roles]
    .filter((r) => r.id !== scene.guildId)
    .sort((a, b) => compareRolesLowToHigh(b, a))
    .map((r) => judge(r.id, (r as AuditRole).name ?? r.id, [r.id]));
  return { everyone, roles };
}
