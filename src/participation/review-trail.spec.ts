import { describe, expect, it } from "vitest";

import { attributionFrom, buildTrails } from "./review-trail";

const row = (action: string, targetId: string, at: string, actor: object | null, metadata: object | null = null) =>
  ({ action, targetId, createdAt: new Date(at), actor, metadata }) as never;

describe("review trail", () => {
  it("names who approved or rejected each step, latest decision winning", () => {
    const trails = buildTrails([
      row("submission.rejected", "d1", "2026-10-01T10:00:00Z", { displayName: "Asha", email: "a@x.com", role: "staff" }, { reason: "Hook too late" }),
      row("submission.approved", "d1", "2026-10-02T10:00:00Z", { displayName: null, email: "ravi@x.com", role: "staff" }),
      row("proof.approved", "d1", "2026-10-03T10:00:00Z", { displayName: "Boss", email: "b@x.com", role: "admin" }),
      row("payout.paid", "d1", "2026-10-04T10:00:00Z", { displayName: "Boss", email: "b@x.com", role: "admin" }),
      row("task.completed", "d1", "2026-10-04T11:00:00Z", { displayName: "X", email: null, role: "staff" }),
      row("submission.approved", "d2", "2026-10-02T10:00:00Z", null),
    ]);

    expect(trails.get("d1")).toHaveLength(3);
    expect(trails.get("d1")![0]).toMatchObject({ step: "work_rejected", byName: "Asha", byRole: "team", reason: "Hook too late" });

    const who = attributionFrom(trails.get("d1"));
    expect(who.workReviewedBy).toMatchObject({ step: "work_approved", byName: "ravi@x.com", byRole: "team" });
    expect(who.proofReviewedBy).toMatchObject({ step: "proof_approved", byName: "Boss", byRole: "admin" });

    expect(attributionFrom(trails.get("d2")).workReviewedBy?.byName).toBe("Someone on the team");
    expect(attributionFrom(undefined)).toEqual({ workReviewedBy: null, proofReviewedBy: null });
  });
});
