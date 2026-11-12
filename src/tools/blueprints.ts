import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { getChannels, getRoles, getBotUser } from "../discord/guildData.js";
import { blueprintSchema, type Blueprint } from "../builder/blueprint.js";
import { exportBlueprint } from "../builder/export.js";
import { diffBlueprint } from "../builder/diff.js";
import {
  listBlueprints,
  findBlueprint,
  saveBlueprint,
  deleteBlueprint,
} from "../builder/blueprintStore.js";
import { gateDestructive } from "../safety.js";
import { quoted } from "../discord/names.js";
import { ok, fail } from "../envelope.js";
import { enter, enterBot, guarded, guildParam, hiddenChannelSummary, confirmTokenParam } from "./common.js";
import { Routes } from "discord-api-types/v10";
import { DiscordAPIError } from "@discordjs/rest";
import { templateCode, templateSettings, templateToLive, type SerializedTemplateGuild } from "../builder/template.js";

// The blueprint store: save designs, snapshot live servers into
// blueprints, and detect drift between a design and reality.

function blueprintCounts(blueprint: Blueprint) {
  const channels =
    (blueprint.channels?.length ?? 0) +
    (blueprint.categories ?? []).reduce((sum, c) => sum + c.channels.length, 0);
  return {
    roles: blueprint.roles?.length ?? 0,
    categories: blueprint.categories?.length ?? 0,
    channels,
  };
}

export function registerBlueprintTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "save_blueprint",
    {
      title: "Save blueprint",
      description:
        "Save a blueprint to the local store for reuse: apply it to other " +
        "servers with execute_build_plan or track drift with " +
        "diff_blueprint. Names are unique.",
      inputSchema: {
        name: z.string().min(1).max(100),
        description: z.string().max(300).optional(),
        blueprint: blueprintSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ name, description, blueprint }) => {
      const saved = saveBlueprint(name, blueprint as Blueprint, description);
      if ("error" in saved) return fail(saved.error);
      return ok(
        `Saved the blueprint ${quoted(saved.name)} (${saved.id}).`,
        {
          id: saved.id,
          name: saved.name,
          counts: blueprintCounts(saved.blueprint),
        }
      );
    })
  );

  server.registerTool(
    "list_blueprints",
    {
      title: "List blueprints",
      description: "Saved blueprints in the local store.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const all = listBlueprints();
      return ok(`${all.length} saved blueprint(s).`, {
        blueprints: all.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          created_at: b.created_at,
          counts: blueprintCounts(b.blueprint),
        })),
      });
    }
  );

  server.registerTool(
    "get_blueprint",
    {
      title: "Get blueprint",
      description: "One saved blueprint in full, by name or ID.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint name or ID."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ blueprint }) => {
      const found = findBlueprint(blueprint);
      if (!found) {
        return fail(`No saved blueprint matching "${blueprint}".`, {
          available: listBlueprints().map((b) => b.name),
        });
      }
      return ok(`Blueprint ${quoted(found.name)} (${found.id}).`, found);
    })
  );

  server.registerTool(
    "delete_blueprint",
    {
      title: "Delete blueprint",
      description:
        "Delete a saved blueprint from the local store. Safe to call " +
        "directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes " +
        "it. Servers built from it are untouched.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint name or ID."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ blueprint, dry_run, confirm_token }) => {
      const found = findBlueprint(blueprint);
      if (!found) return fail(`No saved blueprint matching "${blueprint}".`);

      const gate = gateDestructive({
        tool: "delete_blueprint",
        args: { blueprint: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the saved blueprint ${quoted(found.name)}. Servers ` +
          "built from it are untouched; only the stored design goes.",
        previewDetails: { id: found.id, name: found.name },
      });
      if (gate) return gate;

      deleteBlueprint(found.id);
      return ok(`Deleted the blueprint ${quoted(found.name)}.`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "export_server_blueprint",
    {
      title: "Export server blueprint",
      description:
        "Snapshot a live server's structure into a blueprint: roles, " +
        "categories, channels, and their visibility, with permission " +
        "overwrites decompiled back into private_to and read_only where " +
        "they fit and warnings where they do not. Each item carries its id, " +
        "so editing the export and planning it with update_existing renames " +
        "and changes those exact items. Optionally save the result straight " +
        "to the store with save_as.",
      inputSchema: {
        guild: guildParam,
        save_as: z.string().min(1).max(100).optional()
          .describe("Save the export under this blueprint name."),
        include_ids: z.boolean().optional()
          .describe("Default true. False for a design meant for other servers."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, save_as, include_ids }) => {
      const { rest, guildId } = await enter(config, guild);
      const [channels, roles, botUser] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);

      const { blueprint, warnings } = exportBlueprint(channels, roles, guildId, {
        botUserId: botUser.id,
        includeIds: include_ids !== false,
        ...(save_as ? { name: save_as } : {}),
      });

      // The export must always be a valid blueprint; a parse failure here
      // is a bug in this server, not a user mistake.
      const parsed = blueprintSchema.safeParse(blueprint);
      if (!parsed.success) {
        return fail(
          "The exported structure failed blueprint validation, which is a " +
            "bug worth reporting.",
          { issues: parsed.error.issues.slice(0, 5) }
        );
      }

      let savedId: string | null = null;
      if (save_as) {
        const saved = saveBlueprint(save_as, blueprint);
        if ("error" in saved) return fail(saved.error);
        savedId = saved.id;
      }

      // Channels hidden from the bot are absent from the channel list, so
      // they are absent from the export too. Never present it as complete
      // without saying so.
      const hidden = hiddenChannelSummary(rest, guildId, channels);
      if (hidden.count) {
        warnings.push(
          `${hidden.count} channel(s) hidden from the bot (no View Channel) are not in this ` +
            "export: Discord does not reveal them. Give the bot View Channel there for a complete export."
        );
      } else if (hidden.count === null) {
        warnings.push(
          "Any channels hidden from the bot (no View Channel) are not in this export; whether " +
            "there are any is only known through the default bot's gateway connection."
        );
      }

      const counts = blueprintCounts(blueprint);
      return ok(
        `Exported the server: ${counts.roles} role(s), ` +
          `${counts.categories} categor(ies), ${counts.channels} channel(s)` +
          (savedId ? `, saved as "${save_as}" (${savedId})` : "") +
          ".",
        { blueprint, ...(savedId ? { saved_id: savedId } : {}) },
        warnings
      );
    })
  );

  server.registerTool(
    "import_server_template",
    {
      title: "Import server template",
      description:
        "Turn a Discord server template link (discord.new/CODE or " +
        "discord.com/template/CODE) into a blueprint: its roles, categories, " +
        "channels, and who can see and post where. Nothing is built; plan " +
        "the result with plan_server_build to build it on a server, after " +
        "editing it if wanted. Optionally save it with save_as. The " +
        "template's server settings (verification level, media filter, " +
        "notifications) are listed for update_server, since blueprints do " +
        "not carry them.",
      inputSchema: {
        template: z.string().min(2).max(200).describe("The template link or its code."),
        save_as: z.string().min(1).max(100).optional()
          .describe("Save the blueprint under this name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ template, save_as }) => {
      const code = templateCode(template);
      if (!code) return fail(`"${template}" is not a template link or code.`);
      const { rest } = enterBot(config);
      let fetched: {
        code: string;
        name: string;
        description?: string | null;
        usage_count?: number;
        creator?: { username?: string } | null;
        updated_at?: string;
        is_dirty?: boolean | null;
        serialized_source_guild: SerializedTemplateGuild;
      };
      try {
        fetched = (await rest.get(Routes.template(code))) as typeof fetched;
      } catch (err) {
        if (err instanceof DiscordAPIError && (err.status === 404 || err.code === 10057)) {
          return fail(`No template with the code ${code}. It may have been deleted, or the link was mistyped.`);
        }
        throw err;
      }
      const live = templateToLive(fetched.serialized_source_guild);
      const { blueprint, warnings } = exportBlueprint(live.channels, live.roles, live.guildId, {
        includeIds: false,
        name: save_as ?? fetched.name,
      });
      const parsed = blueprintSchema.safeParse(blueprint);
      if (!parsed.success) {
        return fail("The template did not convert into a valid blueprint, which is a bug worth reporting.", {
          issues: parsed.error.issues.slice(0, 5),
        });
      }
      let savedId: string | null = null;
      if (save_as) {
        const saved = saveBlueprint(save_as, blueprint);
        if ("error" in saved) return fail(saved.error);
        savedId = saved.id;
      }
      const settings = templateSettings(fetched.serialized_source_guild);
      const counts = blueprintCounts(blueprint);
      return ok(
        `Template ${quoted(fetched.name)}` +
          (fetched.creator?.username ? ` by ${quoted(fetched.creator.username)}` : "") +
          (fetched.usage_count !== undefined ? `, used ${fetched.usage_count} time(s)` : "") +
          `: ${counts.roles} role(s), ${counts.categories} categor(ies), ${counts.channels} channel(s)` +
          (savedId ? `, saved as "${save_as}" (${savedId})` : "") +
          ". Nothing was built; plan_server_build builds it.",
        {
          template: {
            code: fetched.code,
            name: fetched.name,
            description: fetched.description ?? null,
            usage_count: fetched.usage_count ?? null,
            creator: fetched.creator?.username ?? null,
            updated_at: fetched.updated_at ?? null,
            ...(fetched.is_dirty ? { out_of_date: true } : {}),
          },
          blueprint,
          ...(Object.keys(settings).length ? { server_settings: settings } : {}),
          ...(savedId ? { saved_id: savedId } : {}),
        },
        [
          ...warnings,
          ...(fetched.is_dirty ? ["The template's source server has changed since it was last synced, so it may be out of date."] : []),
        ]
      );
    })
  );

  server.registerTool(
    "diff_blueprint",
    {
      title: "Diff blueprint",
      description:
        "Compare a blueprint against the live server: what the blueprint " +
        "expects but the server lacks (missing), what exists but differs " +
        "(changed, with the fields), and what the server has that the " +
        "blueprint never mentioned (extra, informational). Reads the " +
        "blueprint as the whole truth, so a setting it leaves out counts as " +
        "its default. The drift detector for config-as-code workflows. To act " +
        "on it, plan_server_build applies changes with update_existing and " +
        "deletes extras listed in remove.",
      inputSchema: {
        blueprint: z
          .union([z.string(), blueprintSchema])
          .describe("A saved blueprint's name or ID, or a blueprint itself."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ blueprint, guild }) => {
      const found =
        typeof blueprint === "string"
          ? findBlueprint(blueprint)
          : { name: blueprint.name ?? "the blueprint", blueprint: blueprint as Blueprint };
      if (!found) {
        return fail(`No saved blueprint matching "${blueprint as string}".`, {
          available: listBlueprints().map((b) => b.name),
        });
      }
      const { rest, guildId } = await enter(config, guild);
      const [channels, roles] = await Promise.all([
        getChannels(rest, guildId),
        getRoles(rest, guildId),
      ]);

      const diff = diffBlueprint(found.blueprint, channels, roles, guildId);
      const missingCount =
        diff.missing.roles.length +
        diff.missing.categories.length +
        diff.missing.channels.length;
      const extraCount =
        diff.extra.roles.length +
        diff.extra.categories.length +
        diff.extra.channels.length;

      // A channel that exists but is hidden from the bot looks missing here.
      const notes: string[] = [];
      const missingChannels = diff.missing.channels.length + diff.missing.categories.length;
      if (missingChannels > 0) {
        const hidden = hiddenChannelSummary(rest, guildId, channels);
        if (hidden.count) {
          notes.push(
            `${hidden.count} channel(s) in this server are hidden from the bot, so a channel ` +
              "listed as missing may exist among them."
          );
        } else if (hidden.count === null) {
          notes.push(
            "A channel listed as missing may exist but be hidden from the bot (no View " +
              "Channel); that is only known through the default bot's gateway connection."
          );
        }
      }

      return ok(
        diff.in_sync
          ? `The server matches ${quoted(found.name)}` +
              (extraCount > 0
                ? `, with ${extraCount} extra item(s) the blueprint does not mention.`
                : " exactly.")
          : `Drift from ${quoted(found.name)}: ${missingCount} missing, ` +
              `${diff.changed.length} changed, ${extraCount} extra.`,
        diff,
        notes
      );
    })
  );
}
