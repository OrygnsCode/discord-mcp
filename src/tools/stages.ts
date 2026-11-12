import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIStageInstance } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getChannels } from "../discord/guildData.js";
import { ok, fail } from "../envelope.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import {
  confirmTokenParam,
  enter,
  guarded,
  guildParam,
  resolveChannel,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Stage instances: the live "now speaking" session on a stage channel.

const P = PermissionFlagsBits;

export function registerStageTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "list_stages",
    {
      title: "List live stages",
      description: "Stage channels that currently have a live stage running.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const stageChannels = (await getChannels(rest, guildId)).filter(
        (c) => c.type === 13
      );
      const live: Array<{ channel: string; topic: string }> = [];
      for (const ch of stageChannels) {
        try {
          const instance = (await rest.get(
            Routes.stageInstance(ch.id)
          )) as APIStageInstance;
          live.push({ channel: ch.name ?? ch.id, topic: instance.topic });
        } catch {
          // No live instance on this stage channel.
        }
      }
      return ok(`${live.length} live stage(s).`, { stages: live });
    })
  );

  server.registerTool(
    "start_stage",
    {
      title: "Start stage",
      description:
        "Open a live stage on a stage channel with a topic. Members can " +
        "then be invited to speak.",
      inputSchema: {
        channel: z.string().describe("Stage channel name or ID."),
        guild: guildParam,
        topic: z.string().min(1).max(120),
        notify: z.boolean().optional()
          .describe("Notify members that the stage started. Needs Mention Everyone."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, topic, notify }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [13]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `on ${quoted(ch.name)}`);

      const instance = (await rest.post(Routes.stageInstances(), {
        body: {
          channel_id: ch.id,
          topic,
          privacy_level: 2,
          send_start_notification: notify ?? false,
        },
        reason: "Stage started via discord-mcp",
      })) as APIStageInstance;
      return ok(`Started a stage on ${quoted(ch.name)}: ${quoted(instance.topic, 120)}.`, {
        channel: { id: ch.id, name: ch.name },
        topic: instance.topic,
      });
    })
  );

  server.registerTool(
    "update_stage",
    {
      title: "Update stage",
      description: "Change the topic of a live stage.",
      inputSchema: {
        channel: z.string().describe("Stage channel name or ID."),
        guild: guildParam,
        topic: z.string().min(1).max(120),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, topic }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [13]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `on ${quoted(ch.name)}`);

      const instance = (await rest.patch(Routes.stageInstance(ch.id), {
        body: { topic },
        reason: "Stage updated via discord-mcp",
      })) as APIStageInstance;
      return ok(`Updated the stage topic on ${quoted(ch.name)}.`, {
        topic: instance.topic,
      });
    })
  );

  server.registerTool(
    "end_stage",
    {
      title: "End stage",
      description:
        "End the live stage on a stage channel. It ends for everyone " +
        "listening, so the first call returns a preview and a " +
        "confirm_token; repeating the call with the token ends it.",
      inputSchema: {
        channel: z.string().describe("Stage channel name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [13]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `on ${quoted(ch.name)}`);

      let topic: string | undefined;
      try {
        topic = ((await rest.get(Routes.stageInstance(ch.id))) as APIStageInstance).topic;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          return fail(`There is no live stage on ${quoted(ch.name)}.`);
        }
        throw err;
      }
      const gate = gateDestructive({
        tool: "end_stage",
        args: { channel: ch.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: `Would end the live stage ${quoted(topic, 120)} on ${quoted(ch.name)}, for everyone listening.`,
        previewDetails: { channel: { id: ch.id, name: ch.name }, topic },
      });
      if (gate) return gate;

      try {
        await rest.delete(Routes.stageInstance(ch.id), {
          reason: "Stage ended via discord-mcp",
        });
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          return fail(`There is no live stage on ${quoted(ch.name)}.`);
        }
        throw err;
      }
      return ok(`Ended the stage on ${quoted(ch.name)}.`, { ended: true });
    })
  );
}
