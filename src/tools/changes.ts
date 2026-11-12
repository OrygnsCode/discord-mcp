import { z } from "zod";
import { quoted } from "../discord/names.js";
import { createHash } from "node:crypto";
import { Routes } from "discord-api-types/v10";
import type { APIGuild, APIGuildMember } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/server";
import type { REST } from "@discordjs/rest";
import type { ServerConfig } from "../config.js";
import {
  entryChannelType,
  getRecord,
  itemLabel,
  listRecords,
  loadAliases,
  lockForUndo,
  saveAlias,
  saveRecord,
  unlockUndo,
  writeRecord,
  type BuildRecord,
  type RecordEntry,
} from "../builder/records.js";
import { executeUndo, planInOrder, planUndo, type UndoLive } from "../builder/undo.js";
import {
  getBotUser,
  getChannels,
  getRoles,
  invalidateGuildCaches,
} from "../discord/guildData.js";
import { highestRolePosition } from "../discord/preflight.js";
import { gatewayKeepsCacheFresh } from "../discord/gateway.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam, confirmTokenParam } from "./common.js";

// Change history and undo. Every change to a server's structure made
// through discord-mcp leaves a record (see builder/records.ts): a build,
// and each single create, edit, or delete of a channel or role, a
// permission edit, a role given or taken, a server settings edit. These
// tools list the records and reverse one, whichever tool made it, so "undo
// that" works without the AI having to rebuild anything from memory.

const UNDO_TOKEN_TTL_MS = 10 * 60_000;

// --- helpers for the tools that make changes ---

// A channel as it is right now, read on its own. Single channel reads have
// their own generous quota, unlike the server's channel list.
export async function channelNow(
  rest: REST,
  id: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await rest.get(Routes.channel(id))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Saves one change. Never fails the tool that made it: the change already
// happened, so a record that cannot be saved becomes a warning instead.
export async function recordChange(
  rest: REST,
  guildId: string,
  tool: string,
  entries: RecordEntry[]
): Promise<{ changeId?: string; warning?: string }> {
  if (entries.length === 0) return {};
  try {
    const bot = await getBotUser(rest);
    const saved = saveRecord({ guildId, botUserId: bot.id, createdAt: Date.now(), tool, entries });
    return { changeId: saved.buildId };
  } catch {
    return { warning: "This change could not be recorded, so undo_change cannot reverse it." };
  }
}

// What a tool adds to its summary and data once a change is recorded.
export function undoNote(recorded: { changeId?: string }): string {
  return recorded.changeId ? ` undo_change with change_id ${recorded.changeId} reverses it.` : "";
}

export function changeData(recorded: { changeId?: string }): { change_id?: string } {
  return recorded.changeId ? { change_id: recorded.changeId } : {};
}

// The overwrites of a channel before and after a permission edit, as an
// update entry. Null when nothing changed.
export function overwriteEntry(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): RecordEntry | null {
  if (!before || !after) return null;
  const list = (c: Record<string, unknown>) =>
    ((c.permission_overwrites as Array<{ id: string; type: number; allow: string; deny: string }>) ?? []).map(
      (o) => ({ id: o.id, type: Number(o.type), allow: String(o.allow), deny: String(o.deny) })
    );
  const b = list(before);
  const a = list(after);
  const key = (x: typeof b) => JSON.stringify([...x].sort((p, q) => p.id.localeCompare(q.id)));
  if (key(b) === key(a)) return null;
  return {
    op: "updated",
    kind: Number(before.type) === 4 ? "category" : "channel",
    id: String(before.id),
    name: String(before.name ?? before.id),
    channelType: Number(before.type),
    fields: {},
    overwrites: { before: b, after: a },
  };
}

// --- the tools ---

function counts(r: BuildRecord) {
  return {
    created: r.entries.filter((e) => e.op === "created").length,
    changed: r.entries.filter((e) => e.op === "updated" || e.op === "member_role").length,
    deleted: r.entries.filter((e) => e.op === "deleted").length,
  };
}

function undoState(r: BuildRecord): string {
  if (r.undoneAt) return "undone";
  if (r.entries.some((e) => e.undo)) return "partly undone";
  return "not undone";
}

function describeEntry(e: RecordEntry): string {
  if (e.op === "member_role") {
    return e.change === "added" ? `gave ${quoted(e.name)} to ${quoted(e.memberName)}` : `took ${quoted(e.name)} from ${quoted(e.memberName)}`;
  }
  if (e.kind === "server") return "changed server settings";
  return `${e.op} ${itemLabel(e.kind, e.name, entryChannelType(e))}`;
}

async function undoLive(rest: REST, guildId: string, records: BuildRecord[]): Promise<UndoLive> {
  if (!gatewayKeepsCacheFresh(rest)) invalidateGuildCaches(guildId);
  const [channels, roles, botUser, guild] = await Promise.all([
    getChannels(rest, guildId),
    getRoles(rest, guildId),
    getBotUser(rest),
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
  ]);
  const member = (await rest.get(Routes.guildMember(guildId, botUser.id))) as APIGuildMember;
  let roleMemberCounts: Record<string, number> | undefined;
  try {
    roleMemberCounts = (await rest.get(Routes.guildRoleMemberCounts(guildId))) as Record<string, number>;
  } catch {
    roleMemberCounts = undefined;
  }
  // The current roles of every member a change gave or took a role from.
  const memberRoles: Record<string, string[] | null> = {};
  for (const r of records) {
    for (const e of r.entries) {
      if (e.op !== "member_role" || e.member in memberRoles) continue;
      try {
        const m = (await rest.get(Routes.guildMember(guildId, e.member))) as APIGuildMember;
        memberRoles[e.member] = m.roles;
      } catch (err) {
        if ((err as { code?: number }).code === 10007) memberRoles[e.member] = null;
      }
    }
  }
  return {
    // Copies: undo keeps its own view current as it writes.
    channels: [...channels],
    roles: [...roles],
    guildSettings: {
      system_channel_id: guild.system_channel_id,
      afk_channel_id: guild.afk_channel_id,
      safety_alerts_channel_id: guild.safety_alerts_channel_id,
      rules_channel_id: guild.rules_channel_id,
      public_updates_channel_id: guild.public_updates_channel_id,
    },
    guild: guild as unknown as Record<string, unknown>,
    memberRoles,
    aliases: loadAliases(guildId),
    botTop: highestRolePosition(member.roles, roles),
    roleMemberCounts,
  };
}

export function registerChangeTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "list_changes",
    {
      title: "List changes",
      description:
        "Recent changes made through discord-mcp on a server, newest first: " +
        "builds, and single creates, edits, and deletes of channels and roles, " +
        "permission edits, roles given or taken, server settings edits. Each " +
        "says what it did and whether it has been undone. The change_id is " +
        "what undo_change takes.",
      inputSchema: {
        guild: guildParam,
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, limit }) => {
      const { guildId } = await enter(config, guild);
      const records = listRecords(guildId).slice(0, limit ?? 10);
      return ok(`${records.length} recorded change(s).`, {
        changes: records.map((r) => ({
          change_id: r.buildId,
          at: new Date(r.createdAt).toISOString(),
          ...(r.tool ? { by: r.tool } : {}),
          ...counts(r),
          what: r.entries.slice(0, 10).map(describeEntry),
          undo: undoState(r),
        })),
      });
    })
  );

  server.registerTool(
    "undo_change",
    {
      title: "Undo change",
      description:
        "Undo changes made through discord-mcp, from their records: builds, " +
        "and any single create, edit, or delete of a channel or role, " +
        "permission edit, role given or taken, server settings edit. Use this " +
        "rather than redoing things by hand: it has an exact copy of what was " +
        "there. It deletes what a change created, puts back what it changed, " +
        "and recreates what it deleted. A setting goes back only if it still " +
        "holds the value the change set; anything changed since stays and is " +
        "reported. Recreated items get new ids, and a deleted channel's " +
        "messages cannot come back. Pass change_id for one change, since " +
        "(a time) to undo every change made from then on, such as everything " +
        "today, or change_ids for several; they are undone newest first. " +
        "With none, the latest change not yet undone. The first call changes " +
        "nothing and returns every step plus a confirm_token; repeat with the " +
        "token to run it. If a step fails (a rate limit, say), calling it " +
        "again finishes the rest.",
      inputSchema: {
        guild: guildParam,
        change_id: z.string().optional().describe("One change, from list_changes or the tool that made it."),
        since: z.string().optional().describe("ISO date-time: undo every change made at or after it."),
        change_ids: z.array(z.string()).max(50).optional().describe("Several changes."),
        dry_run: z.boolean().optional(),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, change_id, since, change_ids, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      if ([change_id, since, change_ids].filter((x) => x !== undefined).length > 1) {
        return fail("Pass one of change_id, since, or change_ids.");
      }

      // Which changes, newest first.
      let records: BuildRecord[];
      if (since !== undefined) {
        const from = Date.parse(since);
        if (Number.isNaN(from)) return fail(`"${since}" is not a date-time. Use ISO form, like 2026-11-08T00:00:00Z.`);
        records = listRecords(guildId).filter((r) => r.createdAt >= from && !r.undoneAt);
        if (records.length === 0) return fail(`No change made since ${new Date(from).toISOString()} is left to undo.`);
      } else if (change_ids !== undefined) {
        const found = [...new Set(change_ids)].map((id) => ({ id, record: getRecord(guildId, id) }));
        const missing = found.filter((f) => !f.record).map((f) => f.id);
        if (missing.length) {
          return fail(`No change ${missing.join(", ")} is recorded for this server. list_changes shows the recorded ones.`);
        }
        records = found.map((f) => f.record as BuildRecord).filter((r) => !r.undoneAt);
        if (records.length === 0) return fail("Every one of those changes has already been undone.");
      } else {
        const one = change_id
          ? getRecord(guildId, change_id)
          : listRecords(guildId).find((r) => !r.undoneAt);
        if (!one) {
          return fail(
            change_id
              ? `No change ${change_id} is recorded for this server. list_changes shows the recorded ones.`
              : "There is no change on this server left to undo."
          );
        }
        if (one.undoneAt) return fail(`Change ${one.buildId} has already been undone.`);
        records = [one];
      }
      records.sort((a, b) => b.createdAt - a.createdAt);

      // The preview: each change's steps against the server as undoing the
      // newer ones leaves it (see planInOrder). Each is checked again against
      // the real server when its turn comes.
      let live = await undoLive(rest, guildId, records);
      const previews = await planInOrder(guildId, records, live);
      // What the confirmation covers: these steps, as worded. The plan is
      // made again when the confirmed call arrives, and a server that moved
      // in between (a role to delete gained members, a channel gained
      // messages) gives different steps, so the earlier answer no longer
      // fits and a fresh preview is needed.
      const planKey = createHash("sha256")
        .update(JSON.stringify(previews.map((p) => [p.record.buildId, p.actions.map((a) => [a.type, a.name, a.lines])])))
        .digest("hex")
        .slice(0, 16);
      const tally = (type: string) =>
        previews.reduce((n, p) => n + p.actions.filter((a) => a.type === type || (type === "restore" && a.type === "member")).length, 0);
      const recreate = tally("recreate");
      const restore = tally("restore");
      const remove = tally("delete");
      const skip = tally("skip");
      const anything = recreate + restore + remove > 0 || records.length > 1;
      const when = (r: BuildRecord) => new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const label =
        records.length === 1
          ? `change ${records[0].buildId}${records[0].tool ? ` (${records[0].tool})` : ""} from ${when(records[0])}`
          : `${records.length} changes, newest first, from ${when(records[records.length - 1])} to ${when(records[0])}`;

      const counts = [
        recreate ? `recreate ${recreate}` : "",
        restore ? `restore ${restore}` : "",
        remove ? `delete ${remove}` : "",
        skip ? `leave ${skip} as they are` : "",
      ].filter(Boolean).join(", ");
      if (anything) {
        const gate = gateDestructive({
          tool: "undo_change",
          args: { changes: records.map((r) => r.buildId), guild: guildId, plan: planKey },
          dryRun: dry_run,
          confirmToken: confirm_token,
          previewSummary:
            `Would undo ${label}: ${counts}` +
            (records.length > 1 ? " (each change is checked again when its turn comes)" : "") +
            ".",
          dialogSummary:
            (records.length === 1
              ? `Undo the change made ${when(records[0])}`
              : `Undo ${records.length} changes, newest first, made from ${when(records[records.length - 1])} to ${when(records[0])}`) +
            `: ${counts}.`,
          note: "The preview lists every step; when you show it, show each line.",
          dialogLines: previews.flatMap((p) => p.actions.flatMap((a) => a.lines)),
          previewDetails: previews.map((p) => ({
            change_id: p.record.buildId,
            ...(p.record.tool ? { by: p.record.tool } : {}),
            steps: p.actions.map((a) => ({ action: a.type, name: a.name, what: a.lines })),
          })),
          ttlMs: UNDO_TOKEN_TTL_MS,
        });
        if (gate) return gate;
      }

      // Run them newest first, each planned against the server as the ones
      // before it left it. Stop at the first change with a failed step: an
      // older change assumes the newer ones are undone.
      const outcome: Array<{ change_id: string; by?: string; results: Array<Record<string, unknown>> }> = [];
      const failures: string[] = [];
      let stoppedAt: string | null = null;
      let busy: string | null = null;
      try {
        for (const listed of records) {
          if (!lockForUndo(guildId, listed.buildId)) {
            busy = listed.buildId;
            break;
          }
          let results;
          let record = listed;
          try {
            // Read again now that the lock is held: another run of this
            // same undo (a second copy of the server, or a retry after the
            // app gave up waiting) may have finished or moved it on since
            // this call first read it.
            const current = getRecord(guildId, listed.buildId) ?? listed;
            if (current.undoneAt) {
              outcome.push({ change_id: current.buildId, ...(current.tool ? { by: current.tool } : {}), results: [] });
              continue;
            }
            if ((current.undoRuns ?? 0) !== (listed.undoRuns ?? 0)) {
              live = await undoLive(rest, guildId, records);
            }
            record = current;
            const actions = planUndo(record, live);
            results = await executeUndo(rest, guildId, record, actions, live, writeRecord, (oldId, newId) =>
              saveAlias(guildId, oldId, newId)
            );
          } finally {
            unlockUndo(guildId, listed.buildId);
          }
          outcome.push({
            change_id: record.buildId,
            ...(record.tool ? { by: record.tool } : {}),
            results: results.map((r) => ({
              name: r.name,
              status: r.status,
              what: r.lines,
              ...(r.newId ? { new_id: r.newId } : {}),
            })),
          });
          const failed = results.filter((r) => r.status === "failed");
          if (failed.length > 0) {
            failures.push(...failed.map((f) => `${quoted(f.name)}: ${f.lines.join(" ")}`));
            stoppedAt = record.buildId;
            break;
          }
        }
      } finally {
        invalidateGuildCaches(guildId);
      }

      if (busy && outcome.length === 0) {
        return fail(
          `An undo of change ${busy} is already running, so this call changed nothing. ` +
            "Wait for it to finish, then check list_changes."
        );
      }
      if (busy) {
        failures.push(`An undo of change ${busy} is already running, so this call stopped before it.`);
        stoppedAt = busy;
      }
      const done = outcome.flatMap((o) => o.results).filter((r) => r.status === "done").length;
      const skipped = outcome.flatMap((o) => o.results).filter((r) => r.status === "skipped").length;
      const left = records.length - outcome.length + (stoppedAt && !busy ? 1 : 0);
      return ok(
        `Undid ${records.length === 1 ? `change ${records[0].buildId}` : `${outcome.length - (stoppedAt ? 1 : 0)} of ${records.length} changes`}: ` +
          `${done} step(s) done, ${skipped} left as they were` +
          (stoppedAt
            ? `. Stopped at change ${stoppedAt}${busy ? "" : " after a failed step"}; ${left} change(s) are left. Call undo_change the same way again to finish.`
            : ". Nothing is left to undo."),
        { changes: outcome },
        failures
      );
    })
  );
}
