/* Security checks for the clip review state machine and stored-file handling.
 * Each test asserts the SECURE behaviour; a failing test confirms a weakness. */
import { FormatDeliverableStatus as S } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  DRAFT_REVIEWABLE,
  PROOF_FILLABLE,
  PROOF_REVIEWABLE,
  transitionDeliverable,
} from "../participation/deliverable-transition";
import { ObjectStorageService } from "../storage/object-storage.service";

describe("Clip review state machine", () => {
  const client = (count: number) => ({
    formatDeliverable: {
      updateMany: vi.fn().mockResolvedValue({ count }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "d1", status: S.draft_approved }),
    },
  });
  it("a change only applies if the clip is still in an allowed state (no double approve/reject)", async () => {
    const c = client(0);
    await expect(transitionDeliverable(c as never, "d1", DRAFT_REVIEWABLE, { status: S.draft_approved }, "Already reviewed")).rejects.toThrow();
  });
  it("the allowed-state check is part of the database write itself", async () => {
    const c = client(1);
    await transitionDeliverable(c as never, "d1", DRAFT_REVIEWABLE, { status: S.draft_approved }, "x");
    expect(c.formatDeliverable.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: { in: DRAFT_REVIEWABLE } }, data: { status: S.draft_approved } });
  });
  it("work can only be reviewed while it is under review", () => {
    expect(DRAFT_REVIEWABLE).toEqual([S.under_review]);
  });
  it("proof can only be reviewed while proof is under review", () => {
    for (const s of PROOF_REVIEWABLE) expect([S.proof_under_review, S.live_submitted]).toContain(s);
  });
  it("proof can't be submitted for work that was never approved", () => {
    for (const s of [S.draft_pending, S.under_review, S.draft_rejected]) expect(PROOF_FILLABLE).not.toContain(s);
  });
  it("an approved proof can't be resubmitted (it would change a paid clip)", () => {
    expect(PROOF_FILLABLE).not.toContain(S.proof_approved);
  });
});

describe("Stored files", () => {
  const storage = new ObjectStorageService({ get: vi.fn(() => undefined) } as never);
  it("clean-up refuses to delete identity documents", async () => {
    await expect(storage.deleteCreatorWorkFile("/uploads/aadhaar-documents/123-abc.jpg")).resolves.toBe(false);
  });
  it("clean-up refuses path tricks", async () => {
    for (const u of ["/uploads/creator-drafts/../kyc-documents/a.jpg", "/uploads/creator-drafts/..%2Fx", "/uploads/creator-drafts/.env"]) {
      await expect(storage.deleteCreatorWorkFile(u)).resolves.toBe(false);
    }
  });
  it("clean-up refuses files on other websites", async () => {
    await expect(storage.deleteCreatorWorkFile("https://evil.example/creator-drafts/a.mp4")).resolves.toBe(false);
  });
  it("direct uploads refuse to sign an HTML file", async () => {
    await expect(storage.presignUpload("creator-drafts", "x.html", "text/html")).rejects.toThrow();
  });
});
