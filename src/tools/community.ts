import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIRole,
  APIEmoji,
  APIExtendedInvite,
  APIInvite,
  APIMessage,
  APIWebhook,
  RESTPostAPIChannelInviteJSONBody,
  RESTPostAPIWebhookWithTokenJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getBotUser, getChannels, getGuildList } from "../discord/guildData.js";
import { channelLabel, grantLines, grantPhrase, grantsForGivingRoles, grantsKey, hasGrants, joinWords, type Scene } from "../discord/grants.js";
import { ALL_PERMISSIONS } from "../discord/preflight.js";
import { CONFIRM_STEPS, POWER_EXAMPLES, loadScene } from "./grantGate.js";
import { resolveOne } from "../discord/resolve.js";
import {
  fetchImageAsDataUri,
  MAX_EMOJI_BYTES,
  MAX_AVATAR_BYTES,
} from "../discord/images.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  enterBot,
  guarded,
  guildParam,
  resolveChannel,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  embedsParam,
  embedFilesProblem,
  mapEmbeds,
  confirmTokenParam,
  postWithFiles,
} from "./common.js";
import { filesParam, prepareFiles, type PreparedFiles } from "../discord/uploads.js";

// Invites, webhooks, and custom emojis.

const P = PermissionFlagsBits;

function inviteDigest(invite: APIExtendedInvite) {
  // Roles handed to whoever joins with it, an invite field since 2026.
  const roles = (invite as { roles?: Array<{ id: string; name?: string }> }).roles ?? [];
  return {
    code: invite.code,
    url: `https://discord.gg/${invite.code}`,
    channel: invite.channel
      ? { id: invite.channel.id, name: invite.channel.name }
      : null,
    inviter: invite.inviter?.username ?? null,
    uses: invite.uses ?? 0,
    max_uses: invite.max_uses ?? 0,
    expires_at: invite.expires_at ?? null,
    ...(roles.length ? { gives_roles: roles.map((r) => ({ id: r.id, name: r.name ?? r.id })) } : {}),
  };
}

// Who an invite is limited to: Discord answers with a CSV of user ids for
// an invite made for particular people. Undefined for any other invite, or
// when the bot may not read it.
async function inviteTargets(rest: REST, code: string): Promise<string[] | undefined> {
  try {
    const csv = (await rest.get(Routes.inviteTargetUsers(code))) as unknown;
    const text = typeof csv === "string" ? csv : Buffer.isBuffer(csv) ? csv.toString("utf8") : csv instanceof ArrayBuffer ? Buffer.from(csv).toString("utf8") : "";
    const ids = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d{17,20}$/.test(l));
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

// A lifetime in the largest unit that reads cleanly. Rounding to hours
// said "0 hour(s)" for a five-minute invite.
export function describeDuration(seconds: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(seconds, "second");
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 86400) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return unit(hours, "hour");
  }
  const days = Math.round((seconds / 86400) * 10) / 10;
  return unit(days, "day");
}

// The code out of an invite link or a bare code. Invite codes are letters,
// digits, and dashes; anything else is not one.
function inviteCode(input: string): string {
  const clean = input.trim().replace(/^(https?:\/\/)?(www\.)?(discord\.gg\/|discord(app)?\.com\/invite\/)/i, "").replace(/[/?#].*$/, "");
  if (!/^[A-Za-z0-9-]{2,64}$/.test(clean)) {
    throw new ToolProblem(fail(`"${input}" is not an invite link or code.`));
  }
  return clean;
}

// Webhook tokens grant posting rights to anyone holding them, so they
// never leave this module. Everything returned to the model is the
// token-free view.
function webhookDigest(hook: APIWebhook) {
  return {
    id: hook.id,
    name: hook.name,
    channel_id: hook.channel_id,
    application_owned: Boolean(hook.application_id),
  };
}

async function listGuildWebhooks(rest: REST, guildId: string): Promise<APIWebhook[]> {
  return (await rest.get(Routes.guildWebhooks(guildId))) as APIWebhook[];
}

async function resolveWebhook(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIWebhook> {
  const hooks = await listGuildWebhooks(rest, guildId);
  const resolution = resolveOne(
    query,
    hooks.map((h) => ({ id: h.id, name: h.name ?? "", type: "webhook" }))
  );
  if ("match" in resolution) {
    const hook = hooks.find((h) => h.id === resolution.match.id);
    if (hook) return hook;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No webhook matching "${query}" in this server.`)
      : fail(`Multiple webhooks match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerCommunityTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "create_invite",
    {
      title: "Create invite",
      description:
        "Create an invite link for a channel. Defaults are deliberate: " +
        "expires in 24 hours, unlimited uses. A never-expiring invite must " +
        "be asked for explicitly with max_age_seconds 0. roles gives roles " +
        "to whoever joins with it, and for_users limits it to particular " +
        `people. An invite whose roles would give ${POWER_EXAMPLES}, or ` +
        `open channels, needs confirming: ${CONFIRM_STEPS}.`,
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        max_age_seconds: z.number().int().min(0).max(604800).optional()
          .describe("Lifetime in seconds, 0 for never. Default 86400 (24h)."),
        max_uses: z.number().int().min(0).max(100).optional()
          .describe("Use limit, 0 for unlimited. Default 0."),
        temporary: z.boolean().optional()
          .describe("Members who join leave again when they disconnect."),
        roles: z.array(z.string()).min(1).max(10).optional()
          .describe("Role names or IDs given to everyone who joins with this invite. Needs Manage Roles."),
        for_users: z.array(z.string().regex(/^\d{17,20}$/, "a Discord user ID")).min(1).max(1000).optional()
          .describe("User IDs of the only people who can use it (up to 1000). They need not be in the server yet."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, max_age_seconds, max_uses, temporary, roles, for_users, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.CreateInstantInvite, "Create Invite"]],
        `in ${channelLabel(target)}`
      );

      // Roles on join: Discord needs Manage Roles and refuses roles stronger
      // than the bot, and so does the bot's own place in the role list.
      let given: Array<{ id: string; name: string }> = [];
      let scene: Scene | undefined;
      if (roles) {
        const serverPerms = await botPermissions(rest, guildId);
        requirePermissions(serverPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");
        scene = await loadScene(rest, guildId);
        const all = scene.roles as APIRole[];
        const me = await getBotUser(rest);
        const mine = ((await rest.get(Routes.guildMember(guildId, me.id))) as { roles: string[] }).roles;
        const top = Math.max(0, ...all.filter((r) => mine.includes(r.id)).map((r) => r.position));
        for (const query of roles) {
          const res = resolveOne(query, all.filter((r) => r.id !== guildId).map((r) => ({ id: r.id, name: r.name, type: "role" })));
          if (!("match" in res)) {
            const candidates = "candidates" in res ? res.candidates : [];
            return fail(candidates.length ? `More than one role matches "${query}". Use its ID.` : `No role matching "${query}".`, { candidates });
          }
          const role = all.find((r) => r.id === res.match.id) as APIRole;
          if (role.managed) return fail(`${quoted(role.name)} belongs to an integration and cannot be handed out.`);
          if (role.position >= top) {
            return fail(`${quoted(role.name)} is not below the bot's highest role, so Discord will not let the bot hand it out.`);
          }
          if (serverPerms !== ALL_PERMISSIONS && (BigInt(role.permissions) & ~serverPerms) !== 0n) {
            return fail(`${quoted(role.name)} has permissions the bot itself lacks, and Discord refuses to hand out a role stronger than the bot.`);
          }
          if (!given.some((g) => g.id === role.id)) given.push({ id: role.id, name: role.name });
        }
      }

      const age = max_age_seconds ?? 86400;
      const lifetime = age === 0 ? "never expires" : `expires in ${describeDuration(age)}`;
      const uses = max_uses ? `${max_uses} use(s)` : "unlimited uses";
      const targets = for_users ? [...new Set(for_users)] : undefined;
      const people = targets ? (targets.length === 1 ? "1 person" : `${targets.length} people`) : "";
      const who = targets ? `only the ${people} it is for` : "anyone with the link";
      const recipients = targets ? `the ${people} it is for, when they join` : "anyone with the link who joins with it";

      if (scene && given.length > 0) {
        const grants = grantsForGivingRoles(scene, given.map((g) => g.id));
        if (hasGrants(grants)) {
          const gate = gateDestructive({
            tool: "create_invite",
            args: {
              channel: target.id,
              roles: given.map((g) => g.id).sort(),
              for_users: targets ? [...targets].sort() : null,
              max_age: age,
              max_uses: max_uses ?? 0,
              temporary: temporary ?? false,
              grants: grantsKey(grants),
            },
            dryRun: dry_run,
            confirmToken: confirm_token,
            previewSummary:
              `Would create an invite to ${channelLabel(target)} that gives ${joinWords(given.map((g) => quoted(g.name)))} ` +
              `to ${recipients}, which lets them ${grantPhrase(grants)}. It ${lifetime}, ${uses}.`,
            dialogLines: grantLines(grants),
            previewDetails: { channel: { id: target.id, name: target.name }, roles: given, for_users: targets?.length ?? null, grants: grantLines(grants) },
          });
          if (gate) return gate;
        }
      }
      if (dry_run) {
        return ok(
          `Dry run: would create an invite to ${channelLabel(target)} for ${who}` +
            (given.length ? `, giving ${joinWords(given.map((g) => quoted(g.name)))}` : "") +
            `. It ${lifetime}, ${uses}. Nothing was created.`,
          { executed: false }
        );
      }

      const body: RESTPostAPIChannelInviteJSONBody & { target_user_ids?: string[] } = {
        max_age: age,
        max_uses: max_uses ?? 0,
        temporary: temporary ?? false,
        unique: true,
        ...(given.length ? { role_ids: given.map((g) => g.id) } : {}),
        ...(targets ? { target_user_ids: targets } : {}),
      };
      const invite = (await rest.post(Routes.channelInvites(target.id), {
        body,
        reason: "Created via discord-mcp",
      })) as APIExtendedInvite;

      // An invite meant for particular people is read back before it is
      // handed over. The list travels in a field Discord could stop
      // honouring, and an invite created without it is open to anyone with
      // the link, roles included, while this tool would report it as
      // limited. Discord applies the list at once (checked live with a
      // thousand people), so anything but the same list back means the
      // invite is not what was asked for, and it is revoked.
      if (targets) {
        const limitedTo = await inviteTargets(rest, invite.code);
        const wanted = new Set(targets);
        const asAsked =
          limitedTo !== undefined && limitedTo.length === wanted.size && limitedTo.every((id) => wanted.has(id));
        if (!asAsked) {
          let revoked = true;
          try {
            await rest.delete(Routes.invite(invite.code), {
              reason: "Revoked via discord-mcp: not limited to the people it was for",
            });
          } catch {
            revoked = false;
          }
          return fail(
            `Discord created the invite but did not confirm that ${who} can use it` +
              (revoked
                ? ", so it was revoked. No invite is left; try again."
                : `, and revoking it failed. Revoke https://discord.gg/${invite.code} by hand: anyone with the link may be able to use it.`),
            { created: false, revoked, ...(revoked ? {} : { code: invite.code }) }
          );
        }
      }

      return ok(
        `Invite https://discord.gg/${invite.code} for ${channelLabel(target)}, ` +
          `${lifetime}, ${uses}` +
          (targets ? `, usable by ${who}` : "") +
          (given.length ? `, giving ${joinWords(given.map((g) => quoted(g.name)))} to everyone who joins with it` : "") +
          ".",
        { ...inviteDigest(invite), ...(targets ? { for_users: targets.length } : {}) }
      );
    })
  );

  server.registerTool(
    "list_invites",
    {
      title: "List invites",
      description: "Active invites for the server or one channel.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().optional()
          .describe("Limit to one channel."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      let invites: APIExtendedInvite[];
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel);
        invites = (await rest.get(Routes.channelInvites(target.id))) as APIExtendedInvite[];
      } else {
        invites = (await rest.get(Routes.guildInvites(guildId))) as APIExtendedInvite[];
      }

      const giving = invites.filter((i) => ((i as { roles?: unknown[] }).roles ?? []).length > 0).length;
      return ok(
        `${invites.length} active invite(s)` + (giving ? `, ${giving} of them giving roles to whoever joins` : "") + ".",
        { invites: invites.map(inviteDigest) }
      );
    })
  );

  server.registerTool(
    "get_invite",
    {
      title: "Get invite",
      description:
        "Inspect an invite code: where it leads, how used it is, the roles " +
        "it gives, and whether it is limited to particular people.",
      inputSchema: {
        code: z.string().describe("The invite code, with or without discord.gg/."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ code }) => {
      // An invite can be looked up by any bot, with or without a default
      // server set, so this does not go through a server at all.
      const { rest } = enterBot(config);
      const clean = inviteCode(code);
      const invite = (await rest.get(Routes.invite(clean), {
        query: new URLSearchParams({ with_counts: "true" }),
      })) as APIInvite;

      // The roles it gives and who it is for are only told to the server's
      // own managers, so they are read when the bot is in that server.
      let givesRoles: Array<{ id: string; name: string }> | undefined;
      let targets: string[] | undefined;
      const inServer = invite.guild ? (await getGuildList(rest)).some((g) => g.id === invite.guild?.id) : false;
      if (inServer && invite.guild) {
        try {
          const listed = (await rest.get(Routes.guildInvites(invite.guild.id))) as APIExtendedInvite[];
          givesRoles = inviteDigest(listed.find((i) => i.code === clean) ?? ({ code: clean } as APIExtendedInvite)).gives_roles;
        } catch {
          // Needs Manage Server.
        }
        targets = await inviteTargets(rest, clean);
      }

      return ok(
        `Invite ${clean} leads to ${invite.guild?.name ? quoted(invite.guild.name) : "an unknown server"}` +
          (invite.channel?.name ? `, channel ${channelLabel(invite.channel)}` : "") +
          `. About ${invite.approximate_member_count ?? "?"} members.` +
          (givesRoles?.length ? ` It gives ${joinWords(givesRoles.map((r) => quoted(r.name)))} to whoever joins with it.` : "") +
          (targets ? ` Only ${targets.length === 1 ? "1 person" : `${targets.length} people`} can use it.` : ""),
        {
          ...(givesRoles?.length ? { gives_roles: givesRoles } : {}),
          ...(targets ? { for_users: targets } : {}),
          code: clean,
          guild: invite.guild ? { id: invite.guild.id, name: invite.guild.name } : null,
          channel: invite.channel
            ? { id: invite.channel.id, name: invite.channel.name }
            : null,
          members_approximate: invite.approximate_member_count ?? null,
          online_approximate: invite.approximate_presence_count ?? null,
          expires_at: invite.expires_at ?? null,
        }
      );
    })
  );

  server.registerTool(
    "delete_invite",
    {
      title: "Delete invite",
      description:
        "Revoke an invite link. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token revokes it.",
      inputSchema: {
        code: z.string().describe("The invite code to revoke."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ code, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId, guildName } = await enter(config, guild);
      const clean = inviteCode(code);

      // The invite must be this server's. Discord revokes any invite the
      // bot has rights over, whichever server it belongs to, so without
      // this a code from another server the bot is in was revoked there
      // while the confirmation named this one.
      let invite: APIInvite;
      try {
        invite = (await rest.get(Routes.invite(clean), {
          query: new URLSearchParams({ with_counts: "true" }),
        })) as APIInvite;
      } catch (err) {
        if ((err as { status?: number }).status === 404) return fail(`There is no invite ${clean}; it may have expired or been revoked already.`);
        throw err;
      }
      if (invite.guild?.id !== guildId) {
        return fail(
          `The invite ${clean} belongs to ${invite.guild?.name ? quoted(invite.guild.name) : "another server"}, not ${quoted(guildName)}. ` +
            "Nothing was revoked. To revoke it, name that server."
        );
      }

      // Discord accepts Manage Channels on the invite's channel, or Manage
      // Server.
      const perms = await botPermissions(rest, guildId);
      if ((perms & (P.ManageChannels | P.ManageGuild)) === 0n) {
        requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], "in this server");
      }

      const gate = gateDestructive({
        tool: "delete_invite",
        args: { code: clean },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would revoke the invite ${clean}` +
          (invite.channel?.name ? ` to ${channelLabel(invite.channel)}` : "") +
          (invite.inviter?.username ? `, made by ${quoted(invite.inviter.username)}` : "") +
          ". Anyone holding the link can no longer use it.",
        previewDetails: { code: clean, channel: invite.channel?.name ?? null, inviter: invite.inviter?.username ?? null },
      });
      if (gate) return gate;

      await rest.delete(Routes.invite(clean), {
        reason: reason ?? "Revoked via discord-mcp",
      });
      return ok(`Revoked the invite ${clean}.`, { revoked: true, code: clean });
    })
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description:
        "Webhooks in the server or one channel. Tokens are never included.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      let hooks: APIWebhook[];
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel);
        hooks = (await rest.get(Routes.channelWebhooks(target.id))) as APIWebhook[];
      } else {
        hooks = await listGuildWebhooks(rest, guildId);
      }

      const channels = await getChannels(rest, guildId);
      const names = new Map(channels.map((c) => [c.id, c.name]));
      return ok(`${hooks.length} webhook(s).`, {
        webhooks: hooks.map((h) => ({
          ...webhookDigest(h),
          channel_name: names.get(h.channel_id ?? "") ?? null,
        })),
      });
    })
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create webhook",
      description:
        "Create an incoming webhook on a channel. Webhooks post with any " +
        "display name and avatar, which is how messages 'as someone' work " +
        "legitimately.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(80),
        avatar_url: z.string().url().optional()
          .describe("Image for the webhook's default avatar, up to 1 MB."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, name, avatar_url }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], `in ${channelLabel(target)}`);

      let avatar: string | undefined;
      if (avatar_url) {
        const image = await fetchImageAsDataUri(avatar_url, MAX_AVATAR_BYTES);
        if (!image.ok) return fail(image.error);
        avatar = image.dataUri;
      }

      const hook = (await rest.post(Routes.channelWebhooks(target.id), {
        body: { name, ...(avatar ? { avatar } : {}) },
        reason: "Created via discord-mcp",
      })) as APIWebhook;

      return ok(`Created webhook ${quoted(hook.name)} on ${channelLabel(target)}.`, webhookDigest(hook));
    })
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update webhook",
      description: "Rename a webhook, change its avatar, or move it to another channel.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(80).optional(),
        channel: z.string().optional()
          .describe("Move the webhook to this channel."),
        avatar_url: z.string().url().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ webhook, guild, name, channel, avatar_url }) => {
      const { rest, guildId } = await enter(config, guild);
      const hook = await resolveWebhook(rest, guildId, webhook);
      if (name === undefined && channel === undefined && avatar_url === undefined) {
        return fail("Pass at least one field to change.");
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      let channelId: string | undefined;
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
        channelId = target.id;
      }
      let avatar: string | undefined;
      if (avatar_url) {
        const image = await fetchImageAsDataUri(avatar_url, MAX_AVATAR_BYTES);
        if (!image.ok) return fail(image.error);
        avatar = image.dataUri;
      }

      const updated = (await rest.patch(Routes.webhook(hook.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(channelId !== undefined ? { channel_id: channelId } : {}),
          ...(avatar !== undefined ? { avatar } : {}),
        },
        reason: "Updated via discord-mcp",
      })) as APIWebhook;

      return ok(`Updated webhook ${quoted(updated.name)}.`, webhookDigest(updated));
    })
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description:
        "Delete a webhook. Anything still posting through it stops " +
        "working. Safe to call directly: the first call changes nothing " +
        "and returns a preview plus a confirm_token; repeating the call " +
        "with the token deletes it.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ webhook, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const hook = await resolveWebhook(rest, guildId, webhook);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_webhook",
        args: { webhook: hook.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the webhook ${quoted(hook.name)} (${hook.id}). Integrations ` +
          "posting through it break immediately.",
        previewDetails: webhookDigest(hook),
      });
      if (gate) return gate;

      await rest.delete(Routes.webhook(hook.id), {
        reason: reason ?? "Deleted via discord-mcp",
      });
      return ok(`Deleted the webhook ${quoted(hook.name)}.`, { deleted: true, id: hook.id });
    })
  );

  server.registerTool(
    "send_webhook_message",
    {
      title: "Send webhook message",
      description:
        "Post through a webhook with an optional display name and avatar " +
        "override, and up to 10 files fetched from public URLs. Mentions " +
        "are suppressed.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000).optional(),
        embeds: embedsParam,
        username_override: z.string().min(1).max(80).optional(),
        avatar_url_override: z.string().url().optional(),
        files: filesParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      webhook,
      guild,
      content,
      embeds,
      username_override,
      avatar_url_override,
      files,
    }) => {
      if (!content && (!embeds || embeds.length === 0) && !files) {
        return fail("Pass content, embeds, or files.");
      }
      // An embed that cannot be sent is refused before any request.
      const cards = embeds && embeds.length > 0 ? mapEmbeds(embeds) : undefined;
      const { rest, guildId } = await enter(config, guild);
      const hook = await resolveWebhook(rest, guildId, webhook);
      if (!hook.token) {
        return fail(
          `The webhook ${quoted(hook.name)} is owned by another application, so ` +
            "its posting token is not available to this bot."
        );
      }

      const body: RESTPostAPIWebhookWithTokenJSONBody = {
        ...(content ? { content } : {}),
        ...(cards ? { embeds: cards } : {}),
        ...(username_override ? { username: username_override } : {}),
        ...(avatar_url_override ? { avatar_url: avatar_url_override } : {}),
        allowed_mentions: { parse: [] },
      };
      let prepared: PreparedFiles | undefined;
      if (files) {
        const got = await prepareFiles(files);
        if (!got.ok) return fail(`Nothing was posted. ${got.error}`);
        prepared = got.value;
        (body as { attachments?: unknown }).attachments = prepared.attachments;
      }
      const lost = embedFilesProblem(embeds, prepared?.attachments.map((a) => a.filename) ?? [], {
        some: "Use one of those exact names, or give a file a filename to match.",
        none: "Pass the picture in files with that filename, or use an http or https link.",
      });
      if (lost) return fail(`Nothing was posted. ${lost}`);
      const sent = (await postWithFiles(rest, Routes.webhook(hook.id, hook.token), body, prepared, {
        query: new URLSearchParams({ wait: "true" }),
        auth: false,
      })) as APIMessage;

      return ok(
        `Posted through ${quoted(hook.name)}` +
          (username_override ? ` as "${username_override}"` : "") +
          (prepared ? ` with ${prepared.files.length} file(s)` : "") +
          `.`,
        {
          id: sent.id,
          channel_id: sent.channel_id,
          jump_link: `https://discord.com/channels/${guildId}/${sent.channel_id}/${sent.id}`,
        }
      );
    })
  );

  server.registerTool(
    "list_emojis",
    {
      title: "List emojis",
      description: "Custom emojis in the server, with usage syntax.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      return ok(`${emojis.length} custom emoji(s).`, {
        emojis: emojis.map((e) => ({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          usage: e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
        })),
      });
    })
  );

  server.registerTool(
    "create_emoji",
    {
      title: "Create emoji",
      description:
        "Upload a custom emoji from an image URL. Discord's limit for " +
        "emoji files is 256 KB; png, jpeg, gif, and webp work.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(32).regex(/^[A-Za-z0-9_]+$/,
          "Letters, digits, and underscores only."),
        image_url: z.string().url(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, image_url }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.CreateGuildExpressions, "Create Expressions"]],
        "in this server"
      );

      const image = await fetchImageAsDataUri(image_url, MAX_EMOJI_BYTES);
      if (!image.ok) return fail(image.error);

      const emoji = (await rest.post(Routes.guildEmojis(guildId), {
        body: { name, image: image.dataUri },
        reason: "Created via discord-mcp",
      })) as APIEmoji;

      return ok(
        `Created the emoji :${emoji.name}: . Use it as <:${emoji.name}:${emoji.id}>.`,
        { id: emoji.id, name: emoji.name }
      );
    })
  );

  server.registerTool(
    "update_emoji",
    {
      title: "Update emoji",
      description: "Rename a custom emoji.",
      inputSchema: {
        emoji: z.string().describe("Current emoji name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(32).regex(/^[A-Za-z0-9_]+$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ emoji, guild, name }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      const resolution = resolveOne(
        emoji,
        emojis
          .filter((e) => e.id && e.name)
          .map((e) => ({ id: e.id as string, name: e.name as string, type: "emoji" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single emoji matches "${emoji}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      await rest.patch(Routes.guildEmoji(guildId, resolution.match.id), {
        body: { name },
        reason: "Renamed via discord-mcp",
      });
      return ok(`Renamed the emoji to :${name}:.`, {
        id: resolution.match.id,
        name,
      });
    })
  );

  server.registerTool(
    "delete_emoji",
    {
      title: "Delete emoji",
      description:
        "Delete a custom emoji. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token deletes it.",
      inputSchema: {
        emoji: z.string().describe("Emoji name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ emoji, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      const resolution = resolveOne(
        emoji,
        emojis
          .filter((e) => e.id && e.name)
          .map((e) => ({ id: e.id as string, name: e.name as string, type: "emoji" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single emoji matches "${emoji}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_emoji",
        args: { emoji: resolution.match.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the emoji :${resolution.match.name}:. Messages ` +
          "that used it keep a broken reference.",
        previewDetails: { id: resolution.match.id, name: resolution.match.name },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildEmoji(guildId, resolution.match.id), {
        reason: "Deleted via discord-mcp",
      });
      return ok(`Deleted the emoji :${resolution.match.name}:.`, {
        deleted: true,
        id: resolution.match.id,
      });
    })
  );
}
