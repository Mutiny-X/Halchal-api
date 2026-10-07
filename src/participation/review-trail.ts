import type { Prisma, UserRole } from "@prisma/client";

/** Who did what to a clip, read back from the activity log — every approve
 * and reject is logged there with the admin or team member who did it.
 * (Payouts aren't included: only the admin pays.) */
export type TrailStep = "work_approved" | "work_rejected" | "proof_approved" | "proof_rejected";

export type TrailEntry = {
  step: TrailStep;
  byName: string;
  /** "admin" or "team" — so "Asha (team)" reads differently from an admin. */
  byRole: "admin" | "team";
  at: string;
  reason: string | null;
};

export type ReviewAttribution = {
  /** Latest decision on the work, and on the proof of work. */
  workReviewedBy: TrailEntry | null;
  proofReviewedBy: TrailEntry | null;
};

const ACTION_STEP: Record<string, TrailStep> = {
  "submission.approved": "work_approved",
  "submission.rejected": "work_rejected",
  "proof.approved": "proof_approved",
  "proof.rejected": "proof_rejected",
};

export const TRAIL_ACTIONS = Object.keys(ACTION_STEP);
export const TRAIL_TARGET_TYPE = "FormatDeliverable";

type LogRow = {
  action: string;
  targetId: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  actor: { displayName: string | null; email: string | null; role: UserRole } | null;
};

function toEntry(row: LogRow): TrailEntry | null {
  const step = ACTION_STEP[row.action];
  if (!step) return null;
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : null;
  const reason = meta && typeof meta.reason === "string" ? meta.reason : null;
  return {
    step,
    byName: row.actor?.displayName?.trim() || row.actor?.email || "Someone on the team",
    byRole: row.actor?.role === "admin" ? "admin" : "team",
    at: row.createdAt.toISOString(),
    reason,
  };
}

/** Log rows (oldest first) → each clip's trail, oldest first. */
export function buildTrails(rows: LogRow[]): Map<string, TrailEntry[]> {
  const trails = new Map<string, TrailEntry[]>();
  for (const row of rows) {
    const entry = toEntry(row);
    if (!entry) continue;
    const list = trails.get(row.targetId) ?? [];
    list.push(entry);
    trails.set(row.targetId, list);
  }
  return trails;
}

/** The most recent decision per step. A resubmitted clip's earlier
 * rejection stays in the trail but isn't "who reviewed it" any more. */
export function attributionFrom(trail: TrailEntry[] | undefined): ReviewAttribution {
  const last = (steps: TrailStep[]) => [...(trail ?? [])].reverse().find((e) => steps.includes(e.step)) ?? null;
  return {
    workReviewedBy: last(["work_approved", "work_rejected"]),
    proofReviewedBy: last(["proof_approved", "proof_rejected"]),
  };
}
