import { z } from "zod";
import { quoted } from "../discord/names.js";
import { Routes } from "discord-api-types/v10";
import type {
  APIGuild,
  APIGuildMember,
  APIGuildOnboarding,
  APIGuildWelcomeScreen,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { REST } from "@discordjs/rest";
import type { ServerConfig } from "../config.js";
import { blueprintSchema, type Blueprint } from "../builder/blueprint.js";
import {
  buildPlan,
  type LiveState,
  type PlanStep,
  type RemoveRequest,
} from "../builder/planner.js";
import { executePlan } from "../builder/executor.js";
import { checkAfterBuild } from "../builder/verify.js";
import { REFERENCE_LAYOUTS, getLayout } from "../builder/layouts.js";
import { itemLabel, saveRecord, type ItemKind } from "../builder/records.js";
import {
  consumePlan,
  getPlan,
  hashSteps,
  planTtlMinutes,
  stagePlan,
} from "../builder/store.js";
import {
  getChannels,
  getRoles,
  getBotUser,
  invalidateGuildCaches,
} from "../discord/guildData.js";
import { gatewayKeepsCacheFresh, isGatewayBot } from "../discord/gateway.js";
import { hiddenChannelsIn } from "../discord/hiddenChannels.js";
import { ALL_PERMISSIONS, computeGuildPermissions } from "../discord/preflight.js";
import { ok, fail } from "../envelope.js";
import {
  confirmInstruction,
  confirmMode,
  confirmsInDialog,
  gateDestructive,
  safeModeEnabled,
} from "../safety.js";
import { appCanShowDialog } from "../requestContext.js";
import { enter, guarded, guildParam } from "./common.js";

// Builder tools, part one: reference layouts and plan staging. The AI
// client owns the creative work of turning a conversation into a
// blueprint; these tools own correctness. plan_server_build never changes
// anything on Discord, no matter what is in the blueprint.

// The server as it is right now. The channel and role lists come from the
// cache when gateway events keep it current; otherwise they are read
// fresh, since a change someone made in Discord seconds earlier must not
// slip past the check that a plan still matches the server.
async function liveStateFor(
  rest: REST,
  guildId: string,
  remove?: RemoveRequest
): Promise<LiveState & { botUserId: string }> {
  if (!gatewayKeepsCacheFresh(rest)) invalidateGuildCaches(guildId);
  const [channels, roles, botUser, guildData] = await Promise.all([
    getChannels(rest, guildId),
    getRoles(rest, guildId),
    getBotUser(rest),
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
  ]);
  const botMember = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;
  const features = guildData.features as string[];
  const community = features.includes("COMMUNITY");

  // What points at which channel, for deletions.
  // field names the server setting when undo can point it back.
  const channelUses: Array<{ id: string; use: string; required: boolean; field?: string }> = [];
  const use = (id: string | null | undefined, what: string, required = false, field?: string) => {
    if (id) channelUses.push({ id, use: what, required, ...(field ? { field } : {}) });
  };
  use(guildData.system_channel_id, "system messages channel", false, "system_channel_id");
  use(guildData.rules_channel_id, "rules channel", community, "rules_channel_id");
  use(guildData.public_updates_channel_id, "community updates channel", community, "public_updates_channel_id");
  use(guildData.afk_channel_id, "AFK channel", false, "afk_channel_id");
  use(guildData.safety_alerts_channel_id, "safety alerts channel", false, "safety_alerts_channel_id");
  use(guildData.widget_channel_id, "widget invite channel");
  if ((remove?.channels?.length ?? 0) > 0 && community) {
    try {
      const onboarding = (await rest.get(Routes.guildOnboarding(guildId))) as APIGuildOnboarding;
      for (const id of onboarding.default_channel_ids ?? []) use(id, "onboarding default channel");
      for (const prompt of onboarding.prompts ?? []) {
        for (const option of prompt.options ?? []) {
          for (const id of option.channel_ids ?? []) use(id, "channel an onboarding answer opens");
        }
      }
    } catch {
      // Not readable by this bot; the plan simply cannot mention it.
    }
    try {
      const welcome = (await rest.get(Routes.guildWelcomeScreen(guildId))) as APIGuildWelcomeScreen;
      for (const w of welcome.welcome_channels ?? []) use(w.channel_id, "welcome screen channel");
    } catch {
      // As above.
    }
  }

  let roleMemberCounts: Record<string, number> | undefined;
  if ((remove?.roles?.length ?? 0) > 0) {
    try {
      roleMemberCounts = (await rest.get(Routes.guildRoleMemberCounts(guildId))) as Record<string, number>;
    } catch {
      roleMemberCounts = undefined;
    }
  }

  return {
    channels,
    roles,
    guildFeatures: features,
    botPermissions: computeGuildPermissions(botMember.roles, guildId, roles),
    hiddenChannels: isGatewayBot(rest)
      ? hiddenChannelsIn(guildId, {
          listed: new Set(channels.map((c) => c.id)),
          current: gatewayKeepsCacheFresh(rest),
        })
      : undefined,
    guildId,
    botUserId: botUser.id,
    botRoleIds: botMember.roles,
    channelUses,
    roleMemberCounts,
  };
}

// Plans the blueprint, reading channels about to be deleted one at a time.
// Whether a channel has ever had a message comes from its last_message_id,
// which changes with every message, and messages do not clear the cached
// channel list (only structure changes do), so a deletion's "what it loses"
// is read from the channel itself. Single channel reads have a quota of
// their own, unlike the channel list.
async function planFresh(
  rest: REST,
  blueprint: Blueprint,
  live: LiveState,
  options: { updateExisting: boolean; remove?: RemoveRequest }
) {
  const first = buildPlan(blueprint, live, options);
  const ids = first.steps
    .filter((s) => s.action === "delete_channel" && s.id)
    .map((s) => s.id as string);
  if (ids.length === 0) return first;
  const latest = new Map<string, string | null>();
  for (const id of ids) {
    try {
      const c = (await rest.get(Routes.channel(id))) as { last_message_id?: string | null };
      latest.set(id, c.last_message_id ?? null);
    } catch {
      // Gone already; the plan says what it can.
    }
  }
  live.channels = live.channels.map((c) =>
    latest.has(c.id) ? { ...c, last_message_id: latest.get(c.id) } as typeof c : c
  );
  return buildPlan(blueprint, live, options);
}

function countBy(steps: PlanStep[], pick: (s: PlanStep) => boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps.filter(pick)) {
    const kind = s.action.replace(/^(create|update|delete)_/, "");
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function countText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([kind, n]) => `${n} ${kind === "category" ? (n === 1 ? "category" : "categories") : n === 1 ? kind : `${kind}s`}`)
    .join(", ");
}

function risksOf(steps: PlanStep[]): string[] {
  return steps.flatMap((s) => (s.risks ?? []).map((r) => `${quoted(s.name)}: ${r}`));
}

// Whether a plan needs the user's go-ahead: it changes or deletes existing
// items, or one of the things it creates gives people already on the server
// something powerful (see hands_out in planner.ts). A plan that only adds
// and hands out nothing runs from its plan id.
function handsOutPower(steps: PlanStep[]): boolean {
  return steps.some((s) => !s.exists && (s.hands_out?.length ?? 0) > 0);
}

const CHANNEL_TYPE_CODES: Record<string, number> = { voice: 2, category: 4, stage: 13 };

// One line per step for the confirmation dialog, risks included.
function stepLine(s: PlanStep): string {
  const kind = s.action.replace(/^(create|update|delete)_/, "") as ItemKind;
  const verb = s.action.startsWith("create_") ? "Create" : s.action.startsWith("update_") ? "Change" : "Delete";
  const code =
    typeof s.details.type_code === "number" ? s.details.type_code : CHANNEL_TYPE_CODES[String(s.details.type)];
  const fields = (s.changes ?? []).map((c) => c.field);
  return (
    `${verb} ${itemLabel(kind, s.name, code)}` +
    (fields.length > 0 ? `: ${fields.join(", ")}` : "") +
    ((s.risks ?? []).length > 0 ? ` (${(s.risks ?? []).join("; ")})` : "") +
    "."
  );
}

export function registerBuilderTools(
  server: McpServer,
  config: ServerConfig
): void {
  server.registerTool(
    "list_reference_layouts",
    {
      title: "List reference layouts",
      description:
        "Curated server blueprints to start from: vetted structures for " +
        "common server kinds. Fetch one with get_reference_layout, adapt " +
        "names and channels to the user's theme, then stage it with " +
        "plan_server_build.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(
        `${REFERENCE_LAYOUTS.length} reference layouts available.`,
        {
          layouts: REFERENCE_LAYOUTS.map((l) => ({
            id: l.id,
            title: l.title,
            audience: l.audience,
          })),
        }
      )
  );

  server.registerTool(
    "get_reference_layout",
    {
      title: "Get reference layout",
      description:
        "One reference layout in full: the blueprint plus the reasoning " +
        "behind its structure. Adapt it rather than applying it verbatim; " +
        "the user's theme and wording should win.",
      inputSchema: {
        layout_id: z.string().describe("Layout ID from list_reference_layouts."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ layout_id }) => {
      const layout = getLayout(layout_id);
      if (!layout) {
        return fail(`No layout named "${layout_id}".`, {
          available: REFERENCE_LAYOUTS.map((l) => l.id),
        });
      }
      return ok(`Layout ${layout.id}: ${layout.title}.`, layout);
    }
  );

  server.registerTool(
    "plan_server_build",
    {
      title: "Plan server build",
      description:
        "Validate a blueprint against the live server and stage an ordered " +
        "build plan. Checks Discord limits, name collisions, role " +
        "references, feature requirements, and the bot's permissions, and " +
        "reports every problem at once. Changes nothing on Discord. Use it " +
        "for any multi-step structure, even a small one: the plan shows the " +
        "user every step before anything happens. By default existing " +
        "channels and roles with matching names are reused as they are. " +
        "With update_existing, existing items are changed to match the " +
        "blueprint too: renames (items carrying an id from " +
        "export_server_blueprint), permissions, colors, topics, slowmode, " +
        "category moves, and who can see or post. An item changes only the " +
        "settings it lists; list one empty to clear it. To delete roles, " +
        "categories, or channels, list them in remove; leaving something out " +
        "of a blueprint never deletes it. Each change shows before and " +
        "after, each deletion what it loses, with risks flagged. A plan that " +
        "changes or deletes runs only by its plan_id, exactly as shown, or " +
        "not at all.",
      inputSchema: {
        guild: guildParam,
        blueprint: blueprintSchema.describe(
          "The desired structure: roles, categories, channels."
        ),
        update_existing: z.boolean().optional()
          .describe("Also change existing items to match the blueprint. Default false: reuse them as they are."),
        remove: z
          .object({
            roles: z.array(z.string()).max(100).optional(),
            categories: z.array(z.string()).max(50).optional(),
            channels: z.array(z.string()).max(500).optional(),
          })
          .optional()
          .describe("Items to delete, by name or id. Deletions run last. The blueprint may be empty when only deleting."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, blueprint, update_existing, remove }) => {
      const { rest, guildId } = await enter(config, guild);
      const live = await liveStateFor(rest, guildId, remove);
      const updateExisting = update_existing === true;
      const result = await planFresh(rest, blueprint, live, { updateExisting, remove });

      if (result.errors.length > 0) {
        return fail(
          `The blueprint has ${result.errors.length} problem(s). Nothing ` +
            "was staged. Fix them and plan again.",
          { errors: result.errors, warnings: result.warnings }
        );
      }

      const plan = stagePlan({
        guildId,
        botUserId: live.botUserId,
        blueprint,
        updateExisting,
        ...(remove ? { remove } : {}),
        steps: result.steps,
        warnings: result.warnings,
      });
      const creating = result.steps.filter((s) => s.action.startsWith("create_") && !s.exists);
      const updating = result.steps.filter((s) => s.action.startsWith("update_"));
      const deleting = result.steps.filter((s) => s.action.startsWith("delete_"));
      const reusing = result.steps.filter((s) => s.exists);
      const risks = risksOf(result.steps);

      const parts = [
        creating.length > 0 ? `create ${countText(countBy(creating, () => true))}` : "",
        updating.length > 0 ? `change ${countText(countBy(updating, () => true))}` : "",
        deleting.length > 0 ? `delete ${countText(countBy(deleting, () => true))}` : "",
      ].filter(Boolean);
      const handsOut = handsOutPower(result.steps);
      const changesExisting = updateExisting || updating.length > 0 || deleting.length > 0 || handsOut;
      const how = changesExisting
        ? (handsOut && !(updateExisting || updating.length > 0 || deleting.length > 0)
            ? "It gives people already on the server powers in what it creates"
            : "It changes or deletes existing items") +
          ", so it runs only as execute_build_plan " +
          "with this plan_id, and only if the server still matches what the " +
          "plan saw; otherwise nothing runs and it needs planning again."
        : "Run execute_build_plan with this plan_id.";
      // Plans that only create are not confirmed in a dialog; plans that
      // change or delete existing items are, when the app can show one.
      const confirmation = confirmInstruction(
        "running execute_build_plan with this plan_id",
        changesExisting && confirmsInDialog()
      );
      const blocked =
        changesExisting && safeModeEnabled() && confirmMode() === "dialog" && !appCanShowDialog()
          ? " This setup allows changes to existing items only after the user agrees in a " +
            "confirmation dialog shown by the app, and this app cannot show one, so " +
            "execute_build_plan will refuse this plan."
          : "";

      return ok(
        `Plan ${plan.planId} staged: ${parts.join("; ") || "nothing to do"}` +
          (reusing.length > 0 && !updateExisting
            ? `, reusing ${reusing.length} existing item(s)`
            : "") +
          (risks.length > 0 ? `. ${risks.length} change(s) flagged as risky` : "") +
          `. Nothing has been changed yet. ${confirmation} ${how}${blocked} The plan expires in ` +
          `${planTtlMinutes()} minutes.`,
        {
          plan_id: plan.planId,
          guild_id: guildId,
          // An edit plan made from a whole export would otherwise list every
          // untouched item as reused; only what changes is worth reading.
          // The saved plan keeps every step either way.
          steps: updateExisting || deleting.length > 0 ? result.steps.filter((s) => !s.exists) : result.steps,
          to_create: creating.length,
          to_update: updating.length,
          to_delete: deleting.length,
          reused: reusing.length,
          ...(risks.length > 0 ? { risks } : {}),
        },
        result.warnings
      );
    })
  );

  server.registerTool(
    "execute_build_plan",
    {
      title: "Execute build plan",
      description:
        "Execute a staged plan by plan_id, or pass a blueprint directly to " +
        "build it additively. A plan that changes existing items runs " +
        "exactly as staged or not at all: it is checked against the server " +
        "again and refused if anything it would touch has changed since. " +
        "Building goes in dependency order: roles, then categories, then " +
        "channels, creating before changing. If a step fails, the run stops " +
        "and the report says exactly what was created, changed, failed, and " +
        "never attempted; plan again to finish. Afterwards the server is " +
        "compared with the blueprint and anything that did not take effect " +
        "is reported. A build that changes anything returns a change_id that " +
        "undo_change reverses.",
      inputSchema: {
        guild: guildParam,
        plan_id: z.string().optional()
          .describe("A plan staged by plan_server_build."),
        blueprint: blueprintSchema.optional()
          .describe(
            "Build this blueprint directly, skipping the staging step. Only adds; never changes existing items. " +
              "Refused when the blueprint gives @everyone or an existing role powers in a new channel: stage that with plan_server_build."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, plan_id, blueprint }) => {
      if (!plan_id && !blueprint) {
        return fail("Pass plan_id (from plan_server_build) or a blueprint.");
      }
      if (plan_id && blueprint) {
        return fail("Pass either plan_id or blueprint, not both.");
      }

      let toBuild: Blueprint;
      let guildArg = guild;
      let staged: ReturnType<typeof getPlan> | undefined;
      if (plan_id) {
        staged = getPlan(plan_id);
        if (staged.status === "used") {
          return fail(
            `Plan ${plan_id} has already been executed. Plans that change ` +
              "existing items run once; plan again to make further changes."
          );
        }
        if (staged.status === "missing") {
          return fail(
            `No staged plan ${plan_id}. Plans expire after ` +
              `${planTtlMinutes()} minutes; stage it again with ` +
              "plan_server_build."
          );
        }
        toBuild = staged.plan.blueprint;
        guildArg = guildArg ?? staged.plan.guildId;
      } else {
        toBuild = blueprint as Blueprint;
      }

      const { rest, guildId } = await enter(config, guildArg);
      const plan = staged?.status === "ok" ? staged.plan : undefined;
      if (plan && plan.guildId !== guildId) {
        return fail(
          `Plan ${plan.planId} was made for another server (${plan.guildId}). Nothing was built.`
        );
      }

      // Always re-validate against the server as it is right now. The
      // staged steps may be minutes old; the server may have changed.
      const remove = plan?.remove;
      const live = await liveStateFor(rest, guildId, remove);
      const updateExisting = plan?.updateExisting === true;
      if (plan?.botUserId && plan.botUserId !== live.botUserId) {
        return fail(
          `Plan ${plan.planId} was made for a different bot. Nothing was built; plan again as this bot.`
        );
      }
      const validated = await planFresh(rest, toBuild, live, { updateExisting, remove });
      if (validated.errors.length > 0) {
        return fail(
          `Validation against the current server state found ` +
            `${validated.errors.length} problem(s). Nothing was built.`,
          { errors: validated.errors, warnings: validated.warnings }
        );
      }

      // A plan that changes existing items was approved as shown. If the
      // server moved since, what would run now is not what was approved.
      const changesExisting =
        updateExisting ||
        validated.steps.some((s) => s.action.startsWith("update_") || s.action.startsWith("delete_")) ||
        handsOutPower(validated.steps);
      if (!plan && safeModeEnabled() && handsOutPower(validated.steps)) {
        // A blueprint passed straight in has had no preview at all.
        return fail(
          "This blueprint gives people already on the server powers in what it creates: " +
            validated.steps.flatMap((s) => (s.exists ? [] : (s.hands_out ?? []).map((h) => `${quoted(s.name)}: ${h}`))).join("; ") +
            ". Nothing was built. Stage it with plan_server_build so that can be reviewed, then run the plan."
        );
      }
      if (plan && changesExisting) {
        if (hashSteps(validated.steps) !== plan.stepsHash) {
          return fail(
            `The server changed since plan ${plan.planId} was made, so it no ` +
              "longer does exactly what was approved. Nothing was built. Plan " +
              "again and review the new steps.",
            { planned_steps: plan.steps.length, steps_now: validated.steps.length }
          );
        }
        // The plan was the preview. When the app can show a dialog, the user
        // agrees there; the steps were just checked against the server, and
        // are checked again when the app calls back with the answer.
        const shown = validated.steps.filter((s) => !s.exists);
        const doing = (verb: string, prefix: string) => {
          const counts = countBy(shown, (s) => s.action.startsWith(prefix));
          return Object.keys(counts).length > 0 ? `${verb} ${countText(counts)}` : "";
        };
        const gate = gateDestructive({
          tool: "execute_build_plan",
          args: { plan_id: plan.planId, steps: plan.stepsHash },
          dialogOnly: true,
          previewSummary:
            "Run the build plan: " +
            [doing("create", "create_"), doing("change", "update_"), doing("delete", "delete_")]
              .filter(Boolean)
              .join("; ") +
            ".",
          previewDetails: { plan_id: plan.planId, steps: shown },
          dialogLines: shown.map(stepLine),
        });
        if (gate) return gate;
        if (!consumePlan(plan.planId)) {
          return fail(
            `Plan ${plan.planId} is already being executed or was just used. Nothing more was built.`
          );
        }
      }

      const report = await executePlan(
        rest,
        guildId,
        live.botUserId,
        toBuild,
        validated.steps,
        live.roles,
        live.channels,
        {
          settable: live.botPermissions === ALL_PERMISSIONS ? undefined : live.botPermissions,
          channelUses: live.channelUses,
        }
      );
      invalidateGuildCaches(guildId);

      // The record undo_change works from. Written even when the run
      // halted, since what did happen may need undoing most of all.
      let buildId: string | undefined;
      if (report.record.length > 0) {
        try {
          buildId = saveRecord({
            guildId,
            botUserId: live.botUserId,
            createdAt: Date.now(),
            tool: "execute_build_plan",
            ...(plan ? { planId: plan.planId } : {}),
            entries: report.record,
          }).buildId;
        } catch {
          report.warnings.push("The build record could not be saved, so undo_change cannot reverse this build.");
        }
      }

      // The check after building (see verify.ts).
      let check: Record<string, unknown> = { skipped: true };
      try {
        const afterLive = await liveStateFor(rest, guildId);
        check = { ...checkAfterBuild(toBuild, live, afterLive, report.results) };
      } catch {
        check = { skipped: true, reason: "Could not re-read the server after building." };
      }

      if (report.failed) {
        const failedStep = report.results.find((r) => r.status === "failed");
        const remaining = report.results.filter(
          (r) => r.status === "not_attempted"
        ).length;
        return fail(
          `Build halted at step ${failedStep?.order} ` +
            `(${failedStep?.action} ${quoted(failedStep?.name)}): ` +
            `${failedStep?.error} ${report.created} item(s) were created, ` +
            `${report.updated} changed, and ${report.deleted} deleted before the failure; ` +
            `${remaining} step(s) were not attempted. Fix the cause and plan ` +
            "again; finished work will not be repeated.",
          { report: report.results, check, ...(buildId ? { change_id: buildId } : {}), warnings: report.warnings }
        );
      }

      return ok(
        `Build complete: ${report.created} item(s) created, ` +
          `${report.updated} changed, ${report.deleted} deleted, ${report.reused} reused.` +
          (check.in_sync === false
            ? " The server does not match the blueprint everywhere; check.remaining says where and why."
            : "") +
          (buildId ? ` undo_change with change_id ${buildId} reverses it.` : ""),
        {
          ...(buildId ? { change_id: buildId } : {}),
          report: report.results,
          created: report.created,
          updated: report.updated,
          deleted: report.deleted,
          reused: report.reused,
          check,
          ...(report.rolesCreated > 0
            ? {
                role_positions: report.stacked
                  ? "explicit"
                  : "by creation order (roles share position 1; the client " +
                    "ranks them as the blueprint listed them)",
              }
            : {}),
        },
        [...validated.warnings, ...report.warnings]
      );
    })
  );
}
