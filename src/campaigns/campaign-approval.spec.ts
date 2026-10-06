import { CampaignOwnership, CampaignStatus, CampaignWizardStep, StaffAccessLevel, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CampaignAccessService } from "../access/campaign-access.service";
import { StaffService } from "../staff/staff.service";
import { CampaignsService } from "./campaigns.service";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    brandProfileId: "brand-1",
    ownership: CampaignOwnership.brand_created,
    wizardStep: CampaignWizardStep.review,
    inviteAcceptedAt: null,
    createdByUserId: "user-brand",
    title: "Summer drop",
    category: "Fashion",
    platform: "instagram_reel",
    platforms: ["instagram_reel"],
    locationType: "pan_india",
    targetStates: [],
    status: CampaignStatus.draft,
    brief: "HOOK:\nShow the drop",
    briefHook: "Show the drop",
    doRules: "Show the product",
    avoidRules: "No competitor logos",
    sourceAssets: [{ type: "drive", url: "https://drive.google.com/file/d/abc/view" }],
    sourceVideoRequirement: "mandatory",
    sourceAudioRequirement: "not_required",
    autoReviewEnabled: true,
    referenceAssets: [],
    coverImageUrl: null,
    productUrl: null,
    ratePer1kPaise: 5_000,
    maxPayoutPaise: 5_000_000,
    budgetPaise: 10_000_000,
    budgetUsedPaise: 0,
    startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    submittedForReviewAt: null,
    reviewRejectionReason: null,
    reviewedAt: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    ...overrides,
  };
}

function setup(existing: Record<string, unknown>) {
  const prisma = {
    campaign: {
      findUnique: vi.fn().mockResolvedValue(existing),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row(), ...data })),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    brandProfile: { findUnique: vi.fn().mockResolvedValue({ id: "brand-1", userId: "user-brand" }) },
    staffBrandAssignment: {
      findUnique: vi.fn().mockResolvedValue({ accessLevel: StaffAccessLevel.full }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: { findMany: vi.fn().mockResolvedValue([{ id: "user-brand", role: UserRole.brand }]) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const realtime = { emitCampaignCreated: vi.fn(), emitCampaignUpdated: vi.fn(), emitCampaignPublished: vi.fn() };
  const activityLog = { log: vi.fn().mockResolvedValue(undefined) };
  const notifications = { create: vi.fn().mockResolvedValue(undefined), notifyAllAdmins: vi.fn().mockResolvedValue(undefined) };
  const service = new CampaignsService(
    prisma as never,
    new CampaignAccessService(prisma as never),
    realtime as never,
    activityLog as never,
    notifications as never,
  );
  return { prisma, service, realtime, activityLog, notifications };
}

const codeOf = (e: unknown) => (e as { getResponse(): { code: string } }).getResponse().code;
const pending = () => row({ status: CampaignStatus.pending_review, submittedForReviewAt: new Date() });

describe("brands and staff can't put a campaign live themselves", () => {
  it.each([UserRole.brand, UserRole.staff])("%s: draft → live is refused with CAMPAIGN_NEEDS_APPROVAL", async (role) => {
    const ctx = setup(row());
    const err = await ctx.service.update("u", role, "camp-1", { status: CampaignStatus.live } as never).catch((e) => e);
    expect(codeOf(err)).toBe("CAMPAIGN_NEEDS_APPROVAL");
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("a brand can't approve its own submission (pending → live)", async () => {
    const ctx = setup(pending());
    const err = await ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.live } as never).catch((e) => e);
    expect(codeOf(err)).toBe("CAMPAIGN_NEEDS_APPROVAL");
  });

  it("a brand can't create straight into pending_review either (only a saved draft is submitted)", async () => {
    const ctx = setup(row());
    const err = await ctx.service
      .create("user-brand", UserRole.brand, { title: "x", status: CampaignStatus.pending_review } as never)
      .catch((e) => e);
    expect(codeOf(err)).toBe("CAMPAIGN_NEEDS_APPROVAL");
  });

  it("staff creating a campaign for a brand can't skip approval (create runs with the admin role)", async () => {
    const ctx = setup(row());
    const staff = new StaffService(ctx.prisma as never, ctx.service);
    for (const status of [CampaignStatus.live, CampaignStatus.pending_review, CampaignStatus.paused]) {
      const err = await staff.createCampaignForBrand("staff-1", "brand-1", { title: "x", status } as never).catch((e) => e);
      expect(codeOf(err)).toBe("CAMPAIGN_NEEDS_APPROVAL");
    }
    expect(ctx.prisma.campaign.create).not.toHaveBeenCalled();
  });

  it("staff may submit a draft for approval", async () => {
    const ctx = setup(row());
    await ctx.service.update("staff-1", UserRole.staff, "camp-1", { status: CampaignStatus.pending_review } as never);
    expect(ctx.prisma.campaign.update.mock.calls[0][0].data.status).toBe(CampaignStatus.pending_review);
    expect(ctx.notifications.notifyAllAdmins).toHaveBeenCalled();
  });
});

describe("while waiting for approval the campaign is locked", () => {
  it.each([
    ["a title change", { title: "Sneaky edit" }],
    ["a payout change", { ratePer1kPaise: 999_999 }],
    ["a title change disguised with a status", { title: "x", status: CampaignStatus.draft }],
    ["re-submitting", { status: CampaignStatus.pending_review }],
  ])("brand: %s is refused with CAMPAIGN_LOCKED", async (_l, dto) => {
    const ctx = setup(pending());
    const err = await ctx.service.update("user-brand", UserRole.brand, "camp-1", dto as never).catch((e) => e);
    expect(codeOf(err)).toBe("CAMPAIGN_LOCKED");
    expect(err.getStatus()).toBe(409);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("withdraw (pending → draft) unlocks it and clears the submission time", async () => {
    const ctx = setup(pending());
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.draft } as never);
    const data = ctx.prisma.campaign.update.mock.calls[0][0].data;
    expect(data.status).toBe(CampaignStatus.draft);
    expect(data.submittedForReviewAt).toBeNull();
    expect(ctx.realtime.emitCampaignPublished).not.toHaveBeenCalled();
  });

  it("the brand may still end (close) a waiting campaign", async () => {
    const ctx = setup(pending());
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.closed } as never);
    expect(ctx.prisma.campaign.update.mock.calls[0][0].data.status).toBe(CampaignStatus.closed);
  });

  it("re-submitting after a rejection clears the old reason", async () => {
    const ctx = setup(row({ reviewRejectionReason: "Fix the brief" }));
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.pending_review } as never);
    expect(ctx.prisma.campaign.update.mock.calls[0][0].data.reviewRejectionReason).toBeNull();
  });
});

describe("admin approve / reject", () => {
  it("approve: goes live immediately, records who approved, tells creators and the brand, logs it", async () => {
    const ctx = setup(pending());
    const result = await ctx.service.approve("admin-1", "camp-1");
    const data = ctx.prisma.campaign.update.mock.calls[0][0].data;
    expect(data.status).toBe(CampaignStatus.live);
    expect(data.reviewedByUserId).toBe("admin-1");
    expect(data.reviewedAt).toBeInstanceOf(Date);
    expect(result.status).toBe(CampaignStatus.live);
    expect(ctx.realtime.emitCampaignPublished).toHaveBeenCalled();
    expect(ctx.notifications.create).toHaveBeenCalledWith(
      "user-brand",
      "brand",
      expect.objectContaining({ type: "campaign.approved", link: "/campaigns/camp-1" }),
      "brand-1",
    );
    expect(ctx.activityLog.log).toHaveBeenCalledWith("admin-1", "campaign.approved", expect.anything());
  });

  it("approve still runs the publish rules (an incomplete campaign can't be approved)", async () => {
    const ctx = setup(row({ status: CampaignStatus.pending_review, sourceAssets: [] }));
    await expect(ctx.service.approve("admin-1", "camp-1")).rejects.toThrow(/source asset/);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it.each([CampaignStatus.draft, CampaignStatus.live, CampaignStatus.closed])("approve refuses a %s campaign", async (status) => {
    const ctx = setup(row({ status }));
    await expect(ctx.service.approve("admin-1", "camp-1")).rejects.toThrow(/waiting for approval/);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("reject: back to draft with the reason, brand notified, nothing sent to creators", async () => {
    const ctx = setup(pending());
    const result = await ctx.service.reject("admin-1", "camp-1", "  Please add a clearer brief  ");
    const data = ctx.prisma.campaign.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: CampaignStatus.draft,
      submittedForReviewAt: null,
      reviewRejectionReason: "Please add a clearer brief",
      reviewedByUserId: "admin-1",
    });
    expect(result.reviewRejectionReason).toBe("Please add a clearer brief");
    expect(ctx.notifications.create).toHaveBeenCalledWith(
      "user-brand",
      "brand",
      expect.objectContaining({ type: "campaign.rejected", body: expect.stringContaining("Please add a clearer brief") }),
      "brand-1",
    );
    expect(ctx.realtime.emitCampaignPublished).not.toHaveBeenCalled();
    expect(ctx.prisma.user.findMany).toHaveBeenCalledTimes(1); // only the brand lookup, no creator fan-out
    expect(ctx.activityLog.log).toHaveBeenCalledWith("admin-1", "campaign.rejected", expect.anything());
  });

  it("reject refuses a campaign that isn't waiting", async () => {
    const ctx = setup(row({ status: CampaignStatus.live }));
    await expect(ctx.service.reject("admin-1", "camp-1", "nope nope")).rejects.toThrow(/waiting for approval/);
  });

  it("a failed brand notification never undoes an approval", async () => {
    const ctx = setup(pending());
    ctx.notifications.create.mockRejectedValue(new Error("push down"));
    await expect(ctx.service.approve("admin-1", "camp-1")).resolves.toMatchObject({ status: CampaignStatus.live });
  });
});
