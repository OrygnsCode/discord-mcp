import { z } from "zod";
import { Routes, PermissionFlagsBits, GuildFeature } from "discord-api-types/v10";
import type {
  APIGuild,
  APIGuildIntegration,
  APIGuildPreview,
  APIGuildWelcomeScreen,
  APITemplate,
} from "discord-api-types/v10";
import { DiscordAPIError } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { setPresence } from "../discord/gateway.js";
import { gateDestructive } from "../safety.js";
import { plainText, quoted } from "../discord/names.js";
import { channelLabel, grantLines, grantPhrase, grantsForGivingRoles, grantsKey, hasGrants, joinWords } from "../discord/grants.js";
import { CONFIRM_STEPS, loadScene } from "./grantGate.js";
import { changeData, recordChange, undoNote } from "./changes.js";
import { ok, fail } from "../envelope.js";
import { fetchImageAsDataUri, savedImageBefore } from "../discord/images.js";
import { templateCode } from "../builder/template.js";

// Discord does not document a size cap for server images; this server holds
// at most this much in memory for one.
const MAX_SERVER_IMAGE_BYTES = 10 * 1024 * 1024;
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  confirmTokenParam,
} from "./common.js";

// Guild settings: identity, widget, welcome screen, onboarding,
// integrations, templates, pruning, and the bot's own presence.

const P = PermissionFlagsBits;

// A template named by its code or by its link (discord.new/CODE,
// discord.com/template/CODE). The code is taken out by templateCode.
const TEMPLATE_REF =
  /^\s*(?:(?:https?:\/\/)?(?:discord\.new|discord(?:app)?\.com\/template)\/)?[A-Za-z0-9-]{2,64}\s*$/i;

const VERIFICATION_LEVELS: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  very_high: 4,
};

const MEDIA_FILTERS: Record<string, number> = { off: 0, members_without_roles: 1, all_members: 2 };

function templateDigest(t: APITemplate) {
  return {
    code: t.code,
    name: t.name,
    description: t.description ?? null,
    usage_count: t.usage_count,
    out_of_sync: t.is_dirty ?? false,
    updated_at: t.updated_at,
  };
}

// Welcome screens only exist on Community servers; the raw 403/404 from
// Discord is unhelpful, so both read and write translate it.
function welcomeScreenProblem(err: unknown): string | null {
  if (err instanceof DiscordAPIError && (err.status === 404 || err.status === 403)) {
    return (
      "This server has no welcome screen. Discord only offers one on " +
      "Community servers (Server Settings, Enable Community)."
    );
  }
  return null;
}

export function registerSettingsTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "update_server",
    {
      title: "Update server",
      description:
        "Edit server settings: name, description, icon, banner, invite " +
        "background, AFK behavior, system and rules channels, verification " +
        "level, explicit media filter, and default notifications. Images " +
        "come from public URLs. Only passed fields change. Descriptions " +
        "need a Community server; the banner and invite background need boosts. " +
        "A lower verification level, a weaker media filter, or turning " +
        `Community off lowers the server's protection, so that needs confirming: ${CONFIRM_STEPS}. ` +
        "Raising them, and every other setting, happens at once.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(100).optional(),
        description: z.string().max(300).optional(),
        verification_level: z
          .enum(["none", "low", "medium", "high", "very_high"])
          .optional(),
        afk_timeout_seconds: z
          .literal([60, 300, 900, 1800, 3600])
          .optional(),
        afk_channel: z.string().optional()
          .describe("Voice channel name or ID, or none to clear."),
        system_channel: z.string().optional()
          .describe("Channel for join notices, or none to clear."),
        community: z.boolean().optional()
          .describe(
            "Enable or disable the Community feature. Enabling needs " +
            "rules_channel and public_updates_channel."
          ),
        rules_channel: z.string().optional()
          .describe("Text channel for the rules, when enabling Community."),
        public_updates_channel: z.string().optional()
          .describe("Text channel for Discord's mod updates, when enabling Community."),
        icon_url: z.string().optional()
          .describe("Public URL of the new server icon (png, jpeg, gif, webp), or none to remove it. A gif needs the animated icon feature."),
        banner_url: z.string().optional()
          .describe("Public URL of the banner shown at the top of the channel list, or none. Needs boost level 2."),
        invite_background_url: z.string().optional()
          .describe("Public URL of the invite page background (the splash), or none. Needs boost level 1."),
        discovery_background_url: z.string().optional()
          .describe("Public URL of the Server Discovery background, or none. Needs a discoverable server."),
        explicit_media_filter: z.enum(["off", "members_without_roles", "all_members"]).optional()
          .describe("Which members' images Discord scans for explicit content."),
        default_notifications: z.enum(["all_messages", "only_mentions"]).optional()
          .describe("What new members are notified of by default."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      description,
      verification_level,
      afk_timeout_seconds,
      afk_channel,
      system_channel,
      community,
      rules_channel,
      public_updates_channel,
      icon_url,
      banner_url,
      invite_background_url,
      discovery_background_url,
      explicit_media_filter,
      default_notifications,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      // The server as it is now, read once, by whichever check needs it first.
      let loaded: APIGuild | undefined;
      const serverNow = async (): Promise<APIGuild> => (loaded ??= (await rest.get(Routes.guild(guildId))) as APIGuild);

      // Images: each needs a server feature Discord grants with boosts or
      // Discovery, checked first so a missing one is named instead of
      // failing with a bare form error.
      const images: Array<[string, string | undefined, string, string | undefined, string]> = [
        ["icon", icon_url, "icon", undefined, "icon"],
        ["banner", banner_url, "banner", "BANNER", "banner (it needs boost level 2)"],
        ["splash", invite_background_url, "invite background", "INVITE_SPLASH", "invite background (it needs boost level 1)"],
        ["discovery_splash", discovery_background_url, "discovery background", "DISCOVERABLE", "discovery background (it needs a server in Server Discovery)"],
      ];
      if (images.some(([, url]) => url !== undefined)) {
        const current = await serverNow();
        for (const [field, url, label, feature, need] of images) {
          if (url === undefined) continue;
          if (/^none$/i.test(url.trim())) {
            body[field] = null;
            changes.push(`${label} removed`);
            continue;
          }
          if (feature && !current.features.includes(feature as GuildFeature)) {
            return fail(`This server cannot have a ${need}. Nothing was changed.`);
          }
          const image = await fetchImageAsDataUri(url, MAX_SERVER_IMAGE_BYTES);
          if (!image.ok) return fail(`The ${label}: ${image.error} Nothing was changed.`);
          if (image.dataUri.startsWith("data:image/gif") && field === "icon" && !current.features.includes("ANIMATED_ICON" as GuildFeature)) {
            return fail("An animated icon needs boost level 1 (the animated icon feature). Use a still image. Nothing was changed.");
          }
          if (image.dataUri.startsWith("data:image/gif") && field === "banner" && !current.features.includes("ANIMATED_BANNER" as GuildFeature)) {
            return fail("An animated banner needs boost level 3. Use a still image. Nothing was changed.");
          }
          body[field] = image.dataUri;
          changes.push(`new ${label}`);
        }
      }
      if (explicit_media_filter !== undefined) {
        body.explicit_content_filter = MEDIA_FILTERS[explicit_media_filter];
        changes.push(`explicit media filter ${explicit_media_filter.replace(/_/g, " ")}`);
      }
      if (default_notifications !== undefined) {
        body.default_message_notifications = default_notifications === "only_mentions" ? 1 : 0;
        changes.push(`default notifications ${default_notifications.replace(/_/g, " ")}`);
      }

      // The Community feature is toggled through the features array and
      // carries prerequisites Discord enforces: a rules channel, a public
      // updates channel, members-only notifications, full content
      // filtering, and at least low verification.
      if (community !== undefined) {
        const current = await serverNow();
        if (community) {
          if (!rules_channel || !public_updates_channel) {
            return fail(
              "Enabling Community needs rules_channel and " +
                "public_updates_channel (text channels)."
            );
          }
          // Discord requires these three of a Community server, so enabling
          // it sets them. A different value passed in the same call cannot
          // hold: it used to be overridden while the result reported it as
          // set. And a setting changed only because Community needs it is
          // named, since the caller did not ask for it.
          if (explicit_media_filter !== undefined && explicit_media_filter !== "all_members") {
            return fail(
              "A Community server has to scan everyone's media, so explicit_media_filter can only be " +
                "all_members when enabling Community. Nothing was changed."
            );
          }
          if (default_notifications !== undefined && default_notifications !== "only_mentions") {
            return fail(
              "A Community server has to notify on mentions only by default, so default_notifications can only be " +
                "only_mentions when enabling Community. Nothing was changed."
            );
          }
          const rules = await resolveChannel(rest, guildId, rules_channel, [0]);
          const updates = await resolveChannel(
            rest,
            guildId,
            public_updates_channel,
            [0]
          );
          body.features = [...new Set([...current.features, "COMMUNITY"])];
          body.rules_channel_id = rules.id;
          body.public_updates_channel_id = updates.id;
          body.explicit_content_filter = 2;
          body.default_message_notifications = 1;
          changes.push("Community enabled");
          if (explicit_media_filter === undefined && current.explicit_content_filter !== 2) {
            changes.push("explicit media filter all members (Community requires it)");
          }
          if (default_notifications === undefined && current.default_message_notifications !== 1) {
            changes.push("default notifications only mentions (Community requires it)");
          }
          if (current.verification_level < 1) {
            body.verification_level = 1;
            if (verification_level === undefined) changes.push("verification level low (Community requires it)");
          }
        } else {
          body.features = current.features.filter((f) => f !== "COMMUNITY");
          changes.push("Community disabled");
        }
      }
      if (name !== undefined) {
        body.name = name;
        changes.push(`name to ${quoted(name)}`);
      }
      if (description !== undefined) {
        body.description = description;
        changes.push("description");
      }
      if (verification_level !== undefined) {
        body.verification_level = VERIFICATION_LEVELS[verification_level];
        changes.push(`verification to ${verification_level}`);
      }
      if (afk_timeout_seconds !== undefined) {
        body.afk_timeout = afk_timeout_seconds;
        changes.push(`afk timeout to ${afk_timeout_seconds}s`);
      }
      if (afk_channel !== undefined) {
        if (afk_channel.toLowerCase() === "none") {
          body.afk_channel_id = null;
          changes.push("afk channel cleared");
        } else {
          const target = await resolveChannel(rest, guildId, afk_channel, [2]);
          body.afk_channel_id = target.id;
          changes.push(`afk channel to ${quoted(target.name)}`);
        }
      }
      if (system_channel !== undefined) {
        if (system_channel.toLowerCase() === "none") {
          body.system_channel_id = null;
          changes.push("system channel cleared");
        } else {
          const target = await resolveChannel(rest, guildId, system_channel, [0]);
          body.system_channel_id = target.id;
          changes.push(`system channel to ${channelLabel(target)}`);
        }
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      // Settings that guard the server can be raised at once. Lowering one
      // waits for the user: it is how a server is opened up for a raid.
      const lowered: string[] = [];
      if (body.verification_level !== undefined || body.explicit_content_filter !== undefined || community === false) {
        const now = await serverNow();
        const nameOf = (table: Record<string, number>, value: number) =>
          (Object.entries(table).find(([, v]) => v === value)?.[0] ?? String(value)).replace(/_/g, " ");
        const verification = body.verification_level as number | undefined;
        if (verification !== undefined && verification < now.verification_level) {
          lowered.push(
            `verification goes down from ${nameOf(VERIFICATION_LEVELS, now.verification_level)} to ${nameOf(VERIFICATION_LEVELS, verification)}`
          );
        }
        const filter = body.explicit_content_filter as number | undefined;
        if (filter !== undefined && filter < now.explicit_content_filter) {
          lowered.push(
            `the explicit media filter goes down from ${nameOf(MEDIA_FILTERS, now.explicit_content_filter)} to ${nameOf(MEDIA_FILTERS, filter)}`
          );
        }
        if (community === false && now.features.includes("COMMUNITY" as GuildFeature)) {
          lowered.push(
            "Community goes off, which stops what needs a Community server (onboarding, membership screening, " +
              "Server Discovery, Discord's safety alerts) and clears the rules channel and the moderator updates " +
              "channel, so turning it back on needs both set again"
          );
        }
      }
      if (lowered.length > 0) {
        const gate = gateDestructive({
          tool: "update_server",
          args: {
            name: name ?? null,
            description: description ?? null,
            verification_level: verification_level ?? null,
            afk_timeout_seconds: afk_timeout_seconds ?? null,
            afk_channel: afk_channel ?? null,
            system_channel: system_channel ?? null,
            community: community ?? null,
            rules_channel: rules_channel ?? null,
            public_updates_channel: public_updates_channel ?? null,
            icon_url: icon_url ?? null,
            banner_url: banner_url ?? null,
            invite_background_url: invite_background_url ?? null,
            discovery_background_url: discovery_background_url ?? null,
            explicit_media_filter: explicit_media_filter ?? null,
            default_notifications: default_notifications ?? null,
          },
          dryRun: dry_run,
          confirmToken: confirm_token,
          previewSummary:
            `Would change ${changes.join(", ")}. That lowers the server's protection: ${lowered.join("; ")}.`,
          previewDetails: { changes, lowers: lowered },
        });
        if (gate) return gate;
      }

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")}. Nothing was changed.`,
          { executed: false }
        );
      }

      const guildBefore = { ...(await serverNow()) } as unknown as Record<string, unknown>;
      // Images are saved now: once replaced, Discord no longer serves them.
      Object.assign(guildBefore, await savedImageBefore("server", guildId, guildId, Object.keys(body), guildBefore));
      const updated = (await rest.patch(Routes.guild(guildId), {
        body,
        reason: "Updated via discord-mcp",
      })) as APIGuild;
      const guildAfter = updated as unknown as Record<string, unknown>;
      const recorded = await recordChange(rest, guildId, "update_server", [
        {
          op: "updated",
          kind: "server",
          id: guildId,
          name: updated.name,
          fields: Object.fromEntries(
            Object.keys(body).map((k) => [k, { before: guildBefore[k] ?? null, after: guildAfter[k] ?? body[k] }])
          ),
        },
      ]);
      return ok(`Updated the server: ${changes.join(", ")}.` + undoNote(recorded), {
        id: updated.id,
        name: updated.name,
        changed: changes,
        ...changeData(recorded),
      }, recorded.warning ? [recorded.warning] : []);
    })
  );

  server.registerTool(
    "get_server_preview",
    {
      title: "Get server preview",
      description:
        "A server's preview: name, description, and approximate member " +
        "counts. Works for servers the bot is in; other servers need to " +
        "be discoverable.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      try {
        const preview = (await rest.get(
          Routes.guildPreview(guildId)
        )) as APIGuildPreview;
        return ok(
          `${quoted(preview.name)}: about ${preview.approximate_member_count} members.`,
          {
            id: preview.id,
            name: preview.name,
            description: preview.description ?? null,
            members_approximate: preview.approximate_member_count,
            online_approximate: preview.approximate_presence_count,
          }
        );
      } catch (err) {
        if (err instanceof DiscordAPIError && err.status === 404) {
          return fail(
            "This server has no public preview; previews exist only for " +
              "discoverable servers."
          );
        }
        throw err;
      }
    })
  );

  server.registerTool(
    "get_server_widget",
    {
      title: "Get server widget",
      description: "Widget settings: enabled state and invite channel.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const widget = (await rest.get(Routes.guildWidgetSettings(guildId))) as {
        enabled: boolean;
        channel_id: string | null;
      };
      return ok(
        `Widget is ${widget.enabled ? "enabled" : "disabled"}.`,
        widget
      );
    })
  );

  server.registerTool(
    "update_server_widget",
    {
      title: "Update server widget",
      description:
        "Enable or disable the widget, or point its invite channel. An " +
        "enabled widget shows the server's name, who is online, and its " +
        "voice channels to anyone on the web, and with an invite channel " +
        "it lets anyone join. So turning it on, or pointing it at an " +
        `invite channel while it is on, needs confirming: ${CONFIRM_STEPS}. ` +
        "Turning it off or clearing the channel happens at once.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        channel: z.string().optional()
          .describe("Invite channel name or ID, or none to clear."),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, channel, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");
      if (enabled === undefined && channel === undefined) {
        return fail("Pass enabled or channel to change.");
      }

      let channelId: string | null | undefined;
      let channelName: string | undefined;
      if (channel !== undefined) {
        if (channel.toLowerCase() === "none") {
          channelId = null;
        } else {
          const target = await resolveChannel(rest, guildId, channel);
          channelId = target.id;
          channelName = target.name ?? undefined;
        }
      }

      // The widget is a public page. Switching it on, or giving a page that
      // is on an invite to hand out, opens the server to people nobody
      // invited, so the user is asked. Closing it is never asked.
      const now = (await rest.get(Routes.guildWidgetSettings(guildId))) as { enabled: boolean; channel_id: string | null };
      const onAfter = enabled ?? now.enabled;
      const inviteAfter = channelId !== undefined ? channelId : now.channel_id;
      const turnsOn = onAfter && !now.enabled;
      const newInvite = onAfter && inviteAfter !== null && inviteAfter !== now.channel_id;
      if (turnsOn || newInvite) {
        // The invite channel may be one set earlier, which this call did
        // not name.
        if (inviteAfter !== null && channelName === undefined) {
          channelName = (await resolveChannel(rest, guildId, inviteAfter).catch(() => undefined))?.name ?? undefined;
        }
        const invite =
          inviteAfter === null
            ? undefined
            : channelName !== undefined
              ? `#${plainText(channelName)}`
              : `the channel with id ${inviteAfter}`;
        const gate = gateDestructive({
          tool: "update_server_widget",
          args: { enabled: enabled ?? null, channel: channelId === undefined ? null : channelId ?? "none" },
          confirmToken: confirm_token,
          previewSummary: turnsOn
            ? "Would turn the server widget on. Anyone on the web with the server's id could then see its name, " +
              "who is online, and its voice channels" +
              (invite ? `, and join through an invite to ${invite} that the widget hands out.` : ". It would hand out no invite.")
            : `Would make the server widget, which is on, hand out an invite to ${invite} to anyone on the web who opens it.`,
          previewDetails: { now, after: { enabled: onAfter, channel_id: inviteAfter } },
        });
        if (gate) return gate;
      }

      const widget = (await rest.patch(Routes.guildWidgetSettings(guildId), {
        body: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(channelId !== undefined ? { channel_id: channelId } : {}),
        },
        reason: "Updated via discord-mcp",
      })) as { enabled: boolean; channel_id: string | null };

      return ok(
        `Widget is now ${widget.enabled ? "enabled" : "disabled"}.`,
        widget
      );
    })
  );

  server.registerTool(
    "get_welcome_screen",
    {
      title: "Get welcome screen",
      description: "The Community welcome screen, when the server has one.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      try {
        const screen = (await rest.get(
          Routes.guildWelcomeScreen(guildId)
        )) as APIGuildWelcomeScreen;
        return ok(
          `Welcome screen with ${screen.welcome_channels.length} channel card(s).`,
          {
            description: screen.description ?? null,
            channels: screen.welcome_channels.map((c) => ({
              channel_id: c.channel_id,
              description: c.description,
            })),
          }
        );
      } catch (err) {
        const problem = welcomeScreenProblem(err);
        if (problem) return fail(problem);
        throw err;
      }
    })
  );

  server.registerTool(
    "update_welcome_screen",
    {
      title: "Update welcome screen",
      description:
        "Edit the Community welcome screen: the description and up to " +
        "five channel cards.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        description: z.string().max(140).optional(),
        channels: z
          .array(
            z.object({
              channel: z.string(),
              description: z.string().min(1).max(50),
            })
          )
          .max(5)
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, description, channels }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");
      if (enabled === undefined && description === undefined && channels === undefined) {
        return fail("Pass at least one field to change.");
      }

      let welcomeChannels:
        | Array<{ channel_id: string; description: string; emoji_id: null; emoji_name: null }>
        | undefined;
      if (channels) {
        welcomeChannels = [];
        for (const entry of channels) {
          const target = await resolveChannel(rest, guildId, entry.channel, TEXT_BEARING_TYPES);
          welcomeChannels.push({
            channel_id: target.id,
            description: entry.description,
            emoji_id: null,
            emoji_name: null,
          });
        }
      }

      try {
        await rest.patch(Routes.guildWelcomeScreen(guildId), {
          body: {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(welcomeChannels !== undefined
              ? { welcome_channels: welcomeChannels }
              : {}),
          },
          reason: "Updated via discord-mcp",
        });
      } catch (err) {
        const problem = welcomeScreenProblem(err);
        if (problem) return fail(problem);
        throw err;
      }
      return ok("Updated the welcome screen.", { updated: true });
    })
  );

  server.registerTool(
    "get_onboarding",
    {
      title: "Get onboarding",
      description: "The new-member onboarding flow, when configured.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const onboarding = (await rest.get(Routes.guildOnboarding(guildId))) as {
        enabled: boolean;
        prompts: Array<{ title: string; options: unknown[] }>;
        default_channel_ids: string[];
      };
      return ok(
        `Onboarding is ${onboarding.enabled ? "enabled" : "disabled"} with ` +
          `${onboarding.prompts.length} prompt(s).`,
        {
          enabled: onboarding.enabled,
          prompts: onboarding.prompts.map((p) => ({
            title: p.title,
            options: p.options.length,
          })),
          default_channel_ids: onboarding.default_channel_ids,
        }
      );
    })
  );

  server.registerTool(
    "update_onboarding",
    {
      title: "Update onboarding",
      description:
        "Configure the new-member onboarding flow on a Community server: " +
        "prompts with options that grant channels and roles, the default " +
        "channels every member sees, and the enabled state. Discord's app " +
        "asks for at least seven default channels when configuring this " +
        "by hand; the API has been observed to accept fewer. Members pick " +
        "these options themselves, so offering a role that gives moderator " +
        "or admin powers, or opens channels hidden from everyone, needs " +
        "confirming: the first call changes nothing and returns a preview " +
        "and a confirm_token, and repeating the call with the token saves it.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        mode: z.enum(["default", "advanced"]).optional()
          .describe(
            "default counts only default channels toward the constraints; " +
            "advanced counts prompt option channels too."
          ),
        default_channels: z.array(z.string()).max(50).optional()
          .describe("Channel names or IDs every new member gets."),
        prompts: z
          .array(
            z.object({
              title: z.string().min(1).max(100),
              type: z.enum(["multiple_choice", "dropdown"]).optional()
                .describe("Default multiple_choice."),
              required: z.boolean().optional(),
              single_select: z.boolean().optional(),
              options: z
                .array(
                  z.object({
                    title: z.string().min(1).max(50),
                    description: z.string().max(100).optional(),
                    channels: z.array(z.string()).optional()
                      .describe("Channels this option grants."),
                    roles: z.array(z.string()).optional()
                      .describe("Roles this option grants."),
                  })
                )
                .min(1)
                .max(50),
            })
          )
          .max(15)
          .optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, mode, default_channels, prompts, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [
          [P.ManageGuild, "Manage Server"],
          [P.ManageRoles, "Manage Roles"],
          [P.ManageChannels, "Manage Channels"],
        ],
        "in this server"
      );
      if (
        enabled === undefined &&
        mode === undefined &&
        default_channels === undefined &&
        prompts === undefined
      ) {
        return fail("Pass at least one field to change.");
      }

      // Names resolve to IDs up front so a typo fails the whole call
      // instead of producing a half-configured flow.
      let defaultChannelIds: string[] | undefined;
      if (default_channels) {
        defaultChannelIds = [];
        for (const entry of default_channels) {
          defaultChannelIds.push((await resolveChannel(rest, guildId, entry)).id);
        }
      }

      let builtPrompts:
        | Array<Record<string, unknown>>
        | undefined;
      if (prompts) {
        const { getRoles } = await import("../discord/guildData.js");
        const { resolveOne } = await import("../discord/resolve.js");
        const roles = await getRoles(rest, guildId);
        builtPrompts = [];
        for (const [promptIndex, prompt] of prompts.entries()) {
          const options: Array<Record<string, unknown>> = [];
          for (const [optionIndex, option] of prompt.options.entries()) {
            if (!option.channels?.length && !option.roles?.length) {
              return fail(
                `Option "${option.title}" grants nothing; every option ` +
                  "needs at least one channel or role."
              );
            }
            const channelIds: string[] = [];
            for (const entry of option.channels ?? []) {
              channelIds.push((await resolveChannel(rest, guildId, entry)).id);
            }
            const roleIds: string[] = [];
            for (const entry of option.roles ?? []) {
              const resolution = resolveOne(
                entry,
                roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
              );
              if (!("match" in resolution)) {
                return fail(`No single role matches "${entry}".`);
              }
              roleIds.push(resolution.match.id);
            }
            // New prompts and options still need id fields; Discord
            // replaces placeholder values with real snowflakes.
            options.push({
              id: String(optionIndex),
              title: option.title,
              ...(option.description ? { description: option.description } : {}),
              channel_ids: channelIds,
              role_ids: roleIds,
            });
          }
          builtPrompts.push({
            id: String(promptIndex),
            type: prompt.type === "dropdown" ? 1 : 0,
            title: prompt.title,
            options,
            single_select: prompt.single_select ?? false,
            required: prompt.required ?? false,
            in_onboarding: true,
          });
        }
      }

      // Roles anyone can now pick for themselves, in onboarding and later
      // under Channels & Roles. One that gives powers, or opens channels
      // hidden from everyone, hands that to whoever picks it. Prompts count
      // as on offer whenever onboarding is not being turned off, in case
      // Discord shows them while it is off.
      type Prompts = Array<{ options?: Array<{ role_ids?: string[] }> }>;
      const current = (await rest.get(Routes.guildOnboarding(guildId))) as { enabled?: boolean; prompts?: Prompts };
      const offered = (list: Prompts | undefined) =>
        new Set((list ?? []).flatMap((p) => (p.options ?? []).flatMap((o) => o.role_ids ?? [])));
      const before = current.enabled ? offered(current.prompts) : new Set<string>();
      const after = enabled === false ? new Set<string>() : offered((builtPrompts as Prompts | undefined) ?? current.prompts);
      const newly = [...after].filter((id) => !before.has(id));
      if (newly.length > 0) {
        const scene = await loadScene(rest, guildId);
        const offers = newly.flatMap((id) => {
          const role = scene.roles.find((r) => r.id === id);
          const grants = grantsForGivingRoles(scene, [id]);
          return role && hasGrants(grants) ? [{ role, grants }] : [];
        });
        if (offers.length > 0) {
          const names = offers.map((o) => quoted(String(o.role.name)));
          const said = offers.map((o) => `${quoted(String(o.role.name))} would let them ${grantPhrase(o.grants)}.`);
          const gate = gateDestructive({
            tool: "update_onboarding",
            args: {
              enabled: enabled ?? null,
              mode: mode ?? null,
              default_channels: defaultChannelIds ?? null,
              prompts: builtPrompts ? JSON.stringify(builtPrompts) : null,
              offers: offers.map((o) => `${o.role.id}:${grantsKey(o.grants)}`).sort(),
            },
            confirmToken: confirm_token,
            previewSummary:
              `Would let anyone in the server pick ${joinWords(names)} for themselves, in onboarding ` +
              `and later under Channels & Roles. ${said.join(" ")}`,
            dialogLines: offers.length > 1 ? offers.flatMap((o) => [`${quoted(String(o.role.name))}:`, ...grantLines(o.grants)]) : grantLines(offers[0].grants),
            previewDetails: {
              roles: offers.map((o) => ({ id: o.role.id, name: o.role.name, grants: grantLines(o.grants) })),
            },
          });
          if (gate) return gate;
        }
      }

      const onboarding = (await rest.put(Routes.guildOnboarding(guildId), {
        body: {
          ...(builtPrompts !== undefined ? { prompts: builtPrompts } : {}),
          ...(defaultChannelIds !== undefined
            ? { default_channel_ids: defaultChannelIds }
            : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(mode !== undefined ? { mode: mode === "advanced" ? 1 : 0 } : {}),
        },
        reason: "Onboarding updated via discord-mcp",
      })) as { enabled: boolean; prompts: Array<{ title: string }> };

      return ok(
        `Onboarding is now ${onboarding.enabled ? "enabled" : "disabled"} ` +
          `with ${onboarding.prompts.length} prompt(s).`,
        {
          enabled: onboarding.enabled,
          prompts: onboarding.prompts.map((p) => p.title),
        }
      );
    })
  );

  server.registerTool(
    "list_integrations",
    {
      title: "List integrations",
      description: "Installed integrations: bots, Twitch and YouTube links.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const integrations = (await rest.get(
        Routes.guildIntegrations(guildId)
      )) as APIGuildIntegration[];
      return ok(`${integrations.length} integration(s).`, {
        integrations: integrations.map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          enabled: i.enabled ?? null,
          application: i.application?.name ?? null,
        })),
      });
    })
  );

  server.registerTool(
    "delete_integration",
    {
      title: "Delete integration",
      description:
        "Remove an integration from the server. Safe to call directly: " +
        "the first call changes nothing and returns a preview plus a " +
        "confirm_token; repeating the call with the token removes it.",
      inputSchema: {
        integration_id: z.string().regex(/^\d{17,20}$/, "An integration ID is 17 to 20 digits.").describe("Integration ID from list_integrations."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ integration_id, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const integrations = (await rest.get(
        Routes.guildIntegrations(guildId)
      )) as APIGuildIntegration[];
      const target = integrations.find((i) => i.id === integration_id.trim());
      if (!target) {
        return fail(`No integration ${integration_id}. See list_integrations.`);
      }

      const gate = gateDestructive({
        tool: "delete_integration",
        args: { integration: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would remove the ${plainText(target.type)} integration ${quoted(target.name)}. ` +
          "Anything it powers stops working.",
        previewDetails: { id: target.id, name: target.name, type: target.type },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildIntegration(guildId, target.id), {
        reason: reason ?? "Removed via discord-mcp",
      });
      return ok(`Removed the integration ${quoted(target.name)}.`, {
        deleted: true,
        id: target.id,
      });
    })
  );

  server.registerTool(
    "list_server_templates",
    {
      title: "List server templates",
      description: "Discord templates created from this server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const templates = (await rest.get(
        Routes.guildTemplates(guildId)
      )) as APITemplate[];
      return ok(`${templates.length} template(s).`, {
        templates: templates.map(templateDigest),
      });
    })
  );

  server.registerTool(
    "create_server_template",
    {
      title: "Create server template",
      description:
        "Snapshot this server's structure as a Discord template others " +
        "can create servers from. One template per server.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100),
        description: z.string().max(120).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, description }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const template = (await rest.post(Routes.guildTemplates(guildId), {
        body: { name, ...(description ? { description } : {}) },
      })) as APITemplate;
      return ok(
        `Template ${quoted(template.name)} created: ` +
          `https://discord.new/${template.code}`,
        templateDigest(template)
      );
    })
  );

  server.registerTool(
    "sync_server_template",
    {
      title: "Sync server template",
      description: "Update a template to match the server's current structure.",
      inputSchema: {
        code: z.string().regex(TEMPLATE_REF, "A template code is letters, digits, and dashes, or a discord.new link.").describe("Template code from list_server_templates, or its discord.new link."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ code, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const template = (await rest.put(
        Routes.guildTemplate(guildId, templateCode(code) ?? code.trim())
      )) as APITemplate;
      return ok(`Template ${quoted(template.name)} synced to the current server state.`, templateDigest(template));
    })
  );

  server.registerTool(
    "delete_server_template",
    {
      title: "Delete server template",
      description:
        "Delete a server template; its share link stops working. Safe to " +
        "call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "deletes it.",
      inputSchema: {
        code: z.string().regex(TEMPLATE_REF, "A template code is letters, digits, and dashes, or a discord.new link.").describe("Template code, or its discord.new link."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ code, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      // The code, whether it came bare or inside its link.
      const clean = templateCode(code) ?? code.trim();
      const gate = gateDestructive({
        tool: "delete_server_template",
        args: { code: clean },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the template ${clean}; anyone holding its ` +
          "discord.new link can no longer use it.",
        previewDetails: { code: clean },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildTemplate(guildId, clean));
      return ok(`Deleted the template ${clean}.`, {
        deleted: true,
        code: clean,
      });
    })
  );

  server.registerTool(
    "prune_members",
    {
      title: "Prune members",
      description:
        "Remove members inactive for a number of days who hold no roles. " +
        "Needs Kick Members and Manage Server, or Administrator where the " +
        "owner has made pruning admin-only. " +
        "Safe to call directly: the first call counts who would go using " +
        "Discord's own preview and returns a confirm_token; repeating the " +
        "call with the token prunes for real.",
      inputSchema: {
        guild: guildParam,
        days: z.number().int().min(1).max(30)
          .describe("Inactivity threshold in days."),
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, days, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [
          [P.KickMembers, "Kick Members"],
          [P.ManageGuild, "Manage Server"],
        ],
        "in this server"
      );

      // Since August 2026 a server owner can require Administrator for
      // pruning (the PRUNE_REQUIRES_ADMIN feature), and then Discord refuses
      // even the count. Checked first so the answer names that setting
      // instead of relaying a bare permission error.
      const guildInfo = (await rest.get(Routes.guild(guildId))) as APIGuild;
      if (
        guildInfo.features.includes(GuildFeature.PruneRequiresAdmin) &&
        (perms & P.Administrator) !== P.Administrator
      ) {
        return fail(
          "This server's owner has set pruning to require Administrator, and the bot " +
            "does not have Administrator here, so Discord refuses both the preview and " +
            "the prune. The owner can grant it, or turn that setting off.",
          { required_permission: "Administrator" }
        );
      }

      // Discord's native prune-count endpoint makes the preview exact.
      const count = (await rest.get(Routes.guildPrune(guildId), {
        query: new URLSearchParams({ days: String(days) }),
      })) as { pruned: number };

      const gate = gateDestructive({
        tool: "prune_members",
        args: { guild: guildId, days },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would prune exactly ${count.pruned} member(s) inactive for ` +
          `${days}+ day(s) holding no roles. They can rejoin with invites.`,
        previewDetails: { would_prune: count.pruned, days },
      });
      if (gate) return gate;

      // Discord allows only a few prune executions per guild in a several
      // minute window (error 30040), and the rate limiter would otherwise
      // quietly queue the request for that entire window. A short abort
      // turns the wait into an answer.
      try {
        const result = (await rest.post(Routes.guildPrune(guildId), {
          body: { days, compute_prune_count: true },
          reason: reason ?? "Pruned via discord-mcp",
          signal: AbortSignal.timeout(15_000),
        })) as { pruned: number | null };
        return ok(`Pruned ${result.pruned ?? "an unknown number of"} member(s).`, {
          pruned: result.pruned,
          days,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // No answer in 15 seconds has two causes that look the same from
          // here, and only one of them means nothing happened.
          return fail(
            "Discord did not answer the prune within 15 seconds, so whether it ran is not known. " +
              "Either the server is large and the prune is still running, or Discord's allowance of a " +
              "few prunes per server every several minutes is used up and it never started. " +
              "Preview again in a few minutes: a count of 0 means it went through.",
            { outcome: "unknown" }
          );
        }
        throw err;
      }
    })
  );

  server.registerTool(
    "set_bot_presence",
    {
      title: "Set bot presence",
      description:
        "Change the bot's status dot and custom status text. Needs the " +
        "gateway connection this server keeps by default.",
      inputSchema: {
        status: z.enum(["online", "idle", "dnd", "invisible"]),
        activity_text: z.string().max(128).optional()
          .describe("Custom status text shown under the bot's name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ status, activity_text }) => {
      const problem = await setPresence({ status, activityText: activity_text });
      if (problem) return fail(problem);
      return ok(
        `Presence set to ${status}` +
          (activity_text ? ` with status "${activity_text}"` : "") +
          ".",
        { status, activity_text: activity_text ?? null }
      );
    })
  );
}
