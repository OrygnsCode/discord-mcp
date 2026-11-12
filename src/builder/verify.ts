import type { Blueprint } from "./blueprint.js";
import type { StepResult } from "./executor.js";
import { buildPlan, type LiveState, type PlanStep } from "./planner.js";

// The check after a build: plan the same blueprint against the server as it
// is now, as an edit, and compare with the same plan made just before the
// build ran.
//
// - An item the build created or changed that still shows a change: the
//   change did not take.
// - An item the build left alone that shows a change it did not show
//   before: something else changed it while the build ran. Discord applying
//   a category's change to a synced channel is one way that happens; a
//   person editing the server at the same moment is another.
// - Anything still to create was not created; anything deleted that is
//   still there was not deleted.
//
// Comparing with the plan made before is what keeps an add-only build quiet
// about the items it was asked to leave as they are.

export interface AfterCheck {
  in_sync: boolean;
  remaining?: Array<{
    action: string;
    name: string;
    changes?: PlanStep["changes"];
    why: string;
  }>;
}

function asEdit(blueprint: Blueprint, live: LiveState): PlanStep[] {
  return buildPlan(blueprint, live, { updateExisting: true }).steps;
}

const isUpdate = (s: PlanStep) => s.action.startsWith("update_") && s.id !== undefined;
const changeKey = (s: PlanStep) => `${s.action}:${s.id}:${JSON.stringify(s.changes ?? [])}`;

export function checkAfterBuild(
  blueprint: Blueprint,
  before: LiveState,
  after: LiveState,
  results: StepResult[]
): AfterCheck {
  const touched = new Set(
    results.filter((r) => r.status === "created" || r.status === "updated").map((r) => r.id)
  );
  const shownBefore = new Set(asEdit(blueprint, before).filter(isUpdate).map(changeKey));
  const remaining: NonNullable<AfterCheck["remaining"]> = [];
  for (const s of asEdit(blueprint, after)) {
    if (isUpdate(s) && touched.has(s.id)) {
      remaining.push({ action: s.action, name: s.name, ...(s.changes ? { changes: s.changes } : {}), why: "The build's change did not take." });
    } else if (isUpdate(s) && !shownBefore.has(changeKey(s))) {
      remaining.push({
        action: s.action,
        name: s.name,
        ...(s.changes ? { changes: s.changes } : {}),
        why: "The build did not change it, but it changed while the build ran, so it no longer matches the blueprint.",
      });
    } else if (s.action.startsWith("create_") && !s.exists) {
      remaining.push({ action: s.action, name: s.name, why: "It was not created." });
    }
  }
  const present = new Set([...after.channels.map((c) => c.id), ...after.roles.map((r) => r.id)]);
  for (const r of results) {
    if (r.status === "deleted" && r.id && present.has(r.id)) {
      remaining.push({ action: r.action, name: r.name, why: "It was not deleted." });
    }
  }
  return remaining.length === 0 ? { in_sync: true } : { in_sync: false, remaining };
}
