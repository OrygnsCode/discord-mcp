import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "../home.js";
import type { Blueprint } from "./blueprint.js";
import type { PlanStep, RemoveRequest } from "./planner.js";

// Staged plans, one JSON file each in the data folder. Files rather than
// memory because a plan has to outlive the process that made it: Claude
// Desktop runs two copies of every server, a restart drops memory, and a
// plan that changes existing things is the user's approval of exactly
// those changes, which must not vanish or be answered by the other copy
// with "no such plan".
//
// A plan that edits existing items is single use. Executing it claims the
// file with a rename, which only one process can win, so two calls cannot
// both apply it.

const PLAN_TTL_MS = 30 * 60_000;
const ID_PATTERN = /^[a-f0-9]{16}$/;

export interface StagedPlan {
  planId: string;
  guildId: string;
  botUserId?: string;
  blueprint: Blueprint;
  updateExisting: boolean;
  remove?: RemoveRequest;
  steps: PlanStep[];
  stepsHash: string;
  warnings: string[];
  createdAt: number;
}

function storeDir(): string {
  return join(dataDir(), "plans");
}

function fileFor(id: string, suffix = ".json"): string {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid plan id.");
  return join(storeDir(), `${id}${suffix}`);
}

export function isValidPlanId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// A stable digest of a step list: object keys sorted at every level, so the
// same steps always hash the same however they were built.
export function hashSteps(steps: PlanStep[]): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
      );
    }
    return typeof v === "bigint" ? v.toString() : v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(steps))).digest("hex");
}

function sweep(now: number): void {
  const dir = storeDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!/^[a-f0-9]{16}(\.used)?\.json$/.test(file)) continue;
    try {
      if (now - statSync(join(dir, file)).mtimeMs > PLAN_TTL_MS) unlinkSync(join(dir, file));
    } catch {
      // Another copy swept it first.
    }
  }
}

export function stagePlan(input: Omit<StagedPlan, "planId" | "createdAt" | "stepsHash">): StagedPlan {
  const now = Date.now();
  sweep(now);
  const plan: StagedPlan = {
    ...input,
    planId: randomBytes(8).toString("hex"),
    stepsHash: hashSteps(input.steps),
    createdAt: now,
  };
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(fileFor(plan.planId), JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

export type PlanLookup =
  | { status: "ok"; plan: StagedPlan }
  | { status: "used" }
  | { status: "missing" };

export function getPlan(planId: string): PlanLookup {
  if (!isValidPlanId(planId)) return { status: "missing" };
  const now = Date.now();
  sweep(now);
  const file = fileFor(planId);
  if (!existsSync(file)) {
    return existsSync(fileFor(planId, ".used.json")) ? { status: "used" } : { status: "missing" };
  }
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")) as StagedPlan;
    if (now - plan.createdAt > PLAN_TTL_MS) return { status: "missing" };
    return { status: "ok", plan };
  } catch {
    return { status: "missing" };
  }
}

// Claim a plan for execution. True for exactly one caller.
export function consumePlan(planId: string): boolean {
  if (!isValidPlanId(planId)) return false;
  try {
    renameSync(fileFor(planId), fileFor(planId, ".used.json"));
    return true;
  } catch {
    return false;
  }
}

export function planTtlMinutes(): number {
  return PLAN_TTL_MS / 60_000;
}
