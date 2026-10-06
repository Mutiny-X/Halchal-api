import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { CampaignOwnership, CampaignStatus, CampaignWizardStep, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignAccessService } from "../access/campaign-access.service";
import { CampaignsService, countRulePoints, hasUsableSourceAsset } from "./campaigns.service";

/** A campaign row with every publish requirement satisfied. */
function completeDraft(overrides: Record<string, unknown> = {}) {
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
    doRules: "Show the product\nTag the brand",
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
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    ...overrides,
  };
}

function setup() {
  const prisma = {
    campaign: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    brandProfile: { findUnique: vi.fn() },
    staffBrandAssignment: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const access = new CampaignAccessService(prisma as never);
  const realtime = {
    emitCampaignCreated: vi.fn(),
    emitCampaignUpdated: vi.fn(),
    emitCampaignPublished: vi.fn(),
  };
  const activityLog = { log: vi.fn().mockResolvedValue(undefined) };
  const notifications = { create: vi.fn().mockResolvedValue(undefined), notifyAllAdmins: vi.fn().mockResolvedValue(undefined) };
  const service = new CampaignsService(
    prisma as never,
    access,
    realtime as never,
    activityLog as never,
    notifications as never,
  );
  // update() echoes what was written, like Prisma does.
  prisma.campaign.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...completeDraft(),
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  }));
  prisma.campaign.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...completeDraft(),
    ...data,
  }));
  return { prisma, service, realtime, notifications };
}

async function expectValidationError(promise: Promise<unknown>, message: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(BadRequestException);
  await promise.catch((e: BadRequestException) => {
    expect((e.getResponse() as { message: string }).message).toMatch(message);
  });
}

describe("campaign list scoping (fail closed)", () => {
  it("a brand user with no BrandProfile sees nothing, never every brand's campaigns", async () => {
    const { prisma, service } = setup();
    prisma.brandProfile.findUnique.mockResolvedValue(null);

    await service.listForUser("orphan-brand-user", UserRole.brand, { page: 1, limit: 6 });

    const where = prisma.campaign.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "__none__" });
    expect(prisma.campaign.findMany.mock.calls[0][0].where).toEqual(where);
  });

  it("a brand user sees only its own brand's campaigns", async () => {
    const { prisma, service } = setup();
    prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });

    await service.listForUser("user-brand", UserRole.brand, { page: 1, limit: 6 });

    expect(prisma.campaign.count.mock.calls[0][0].where).toMatchObject({ brandProfileId: "brand-1" });
  });

  it("staff see only their assigned brands", async () => {
    const { prisma, service } = setup();
    prisma.staffBrandAssignment.findMany.mockResolvedValue([{ brandProfileId: "b1" }, { brandProfileId: "b2" }]);

    await service.listForUser("staff-1", UserRole.staff, { page: 1, limit: 6 });

    expect(prisma.campaign.count.mock.calls[0][0].where).toMatchObject({ brandProfileId: { in: ["b1", "b2"] } });
  });

  it("admins are unscoped, and the status/search filters still apply", async () => {
    const { prisma, service } = setup();

    await service.listForUser("admin-1", UserRole.admin, { page: 1, limit: 6, status: CampaignStatus.live, search: " drop " });

    expect(prisma.campaign.count.mock.calls[0][0].where).toEqual({
      status: CampaignStatus.live,
      title: { contains: "drop", mode: "insensitive" },
    });
  });
});

describe("campaign owner checks on create", () => {
  it("staff must name a brand", async () => {
    const { service } = setup();
    await expectValidationError(
      service.create("staff-1", UserRole.staff, { title: "x" } as never),
      /Choose a brand/,
    );
  });

  it("staff can't create for a brand they aren't assigned to", async () => {
    const { prisma, service } = setup();
    prisma.staffBrandAssignment.findUnique.mockResolvedValue(null);
    await expect(
      service.create("staff-1", UserRole.staff, { title: "x", brandProfileId: "brand-9" } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("view-only staff can't create", async () => {
    const { prisma, service } = setup();
    prisma.staffBrandAssignment.findUnique.mockResolvedValue({ accessLevel: "view_only" });
    await expect(
      service.create("staff-1", UserRole.staff, { title: "x", brandProfileId: "brand-1" } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an admin naming a brand that doesn't exist gets 404, not a database error", async () => {
    const { prisma, service } = setup();
    prisma.brandProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.create("admin-1", UserRole.admin, { title: "x", brandProfileId: "nope" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.campaign.create).not.toHaveBeenCalled();
  });

  it("an admin reassigning a campaign to a brand that doesn't exist gets 404", async () => {
    const { prisma, service } = setup();
    prisma.campaign.findUnique.mockResolvedValue(completeDraft());
    prisma.brandProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.update("admin-1", UserRole.admin, "camp-1", { brandProfileId: "nope" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });
});

describe("server-side publish rules", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
  });

  const publish = (existing: Record<string, unknown>, dto: Record<string, unknown> = {}) => {
    ctx.prisma.campaign.findUnique.mockResolvedValue(completeDraft(existing));
    // Brands submit for approval — the same completeness rules apply.
    return ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.pending_review, ...dto } as never);
  };

  it("a brand submits a complete draft for approval; admins are notified; nothing goes live", async () => {
    await publish({});
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
    expect(ctx.prisma.campaign.update.mock.calls[0][0].data).toMatchObject({ status: CampaignStatus.pending_review });
    expect(ctx.prisma.campaign.update.mock.calls[0][0].data.submittedForReviewAt).toBeInstanceOf(Date);
    expect(ctx.notifications.notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ link: "/admin/campaigns/camp-1" }));
    expect(ctx.realtime.emitCampaignPublished).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty title", { title: "  " }, /title is required/],
    ["no creative brief", { briefHook: "" }, /Creative brief is required/],
    ["no Do points", { doRules: " \n - \n" }, /'Do' point/],
    ["no Avoid points", { avoidRules: null }, /'Avoid' point/],
    ["no source assets", { sourceAssets: [] }, /source asset/],
    ["only blank source asset URLs", { sourceAssets: [{ type: "drive", url: "  " }] }, /source asset/],
    ["state targeting with no states", { locationType: "states", targetStates: [] }, /target state/],
    ["max payout under ₹1,000", { maxPayoutPaise: 99_999, budgetPaise: 10_000_000 }, /at least ₹1,000/],
    ["budget below max payout", { maxPayoutPaise: 5_000_000, budgetPaise: 4_999_999 }, /budget must be at least the max payout/],
  ])("refuses a first publish with %s", async (_label, existing, message) => {
    await expectValidationError(publish(existing), message);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("checks the values being sent in the same request, not just what's stored", async () => {
    // Stored draft is complete, but this request clears the Do rules while publishing.
    await expectValidationError(publish({}, { doRules: "" }), /'Do' point/);
  });

  it("accepts the request's own fixes in the same publish call", async () => {
    await publish({ doRules: null }, { doRules: "Show the product" });
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
  });

  it("lets a paused campaign resume even if it predates the newer content rules", async () => {
    ctx.prisma.campaign.findUnique.mockResolvedValue(
      completeDraft({ status: CampaignStatus.paused, doRules: null, avoidRules: null, sourceAssets: [] }),
    );
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", { status: CampaignStatus.live } as never);
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
  });

  it("a brand can't create a campaign straight into live", async () => {
    const err = await ctx.service.create("user-brand", UserRole.brand, { title: "x", status: CampaignStatus.live } as never).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "CAMPAIGN_NEEDS_APPROVAL" });
    expect(ctx.prisma.campaign.create).not.toHaveBeenCalled();
  });

  it("applies the same rules when an admin creates a campaign straight into live", async () => {
    await expectValidationError(
      ctx.service.create("admin-1", UserRole.admin, {
        brandProfileId: "brand-1",
        title: "Direct",
        status: CampaignStatus.live,
        briefHook: "Hook",
        doRules: "Do this",
        avoidRules: "Avoid that",
        ratePer1kPaise: 5_000,
        maxPayoutPaise: 5_000_000,
        budgetPaise: 10_000_000,
        startDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      } as never),
      /source asset/,
    );
    expect(ctx.prisma.campaign.create).not.toHaveBeenCalled();
  });

  it("doesn't apply publish rules to ordinary draft saves", async () => {
    ctx.prisma.campaign.findUnique.mockResolvedValue(completeDraft({ doRules: null, sourceAssets: [] }));
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", { title: "Half written" } as never);
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
  });
});

describe("publish-rule helpers", () => {
  it("countRulePoints matches the website's bullet parsing", () => {
    expect(countRulePoints("- Show product\n• Use natural light\n\n  \nAvoid shaky cam")).toBe(3);
    expect(countRulePoints(" - \n•\n")).toBe(0);
    expect(countRulePoints(null)).toBe(0);
  });

  it("hasUsableSourceAsset ignores malformed entries", () => {
    expect(hasUsableSourceAsset([{ url: "https://x" }])).toBe(true);
    expect(hasUsableSourceAsset([{ url: "" }, null, "x", { url: 5 }])).toBe(false);
    expect(hasUsableSourceAsset({ url: "https://x" })).toBe(false);
  });
});

describe("creator notifications on publish (item 19)", () => {
  const change = async (status: CampaignStatus, to: CampaignStatus, userId: string, role: UserRole) => {
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    ctx.prisma.campaign.findUnique.mockResolvedValue(completeDraft({ status }));
    await ctx.service.update(userId, role, "camp-1", { status: to } as never);
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget fan-out start
    return ctx;
  };

  it("notifies every creator when an admin APPROVES (first time live)", async () => {
    const ctx = await change(CampaignStatus.pending_review, CampaignStatus.live, "admin-a", UserRole.admin);
    expect(ctx.prisma.user.findMany).toHaveBeenCalled();
    expect(ctx.realtime.emitCampaignPublished).toHaveBeenCalled();
  });

  it("does NOT re-blast creators (push + paid WhatsApp) when a paused campaign resumes", async () => {
    const ctx = await change(CampaignStatus.paused, CampaignStatus.live, "notify-b", UserRole.brand);
    expect(ctx.prisma.user.findMany).not.toHaveBeenCalled();
    expect(ctx.realtime.emitCampaignPublished).toHaveBeenCalled();
  });

  it("caps how many campaigns one brand account can submit per hour (10)", async () => {
    const userId = `limit-${Date.now()}`;
    for (let i = 0; i < 10; i += 1) {
      await change(CampaignStatus.draft, CampaignStatus.pending_review, userId, UserRole.brand);
    }
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    ctx.prisma.campaign.findUnique.mockResolvedValue(completeDraft());
    const err = await ctx.service
      .update(userId, UserRole.brand, "camp-1", { status: CampaignStatus.pending_review } as never)
      .catch((e) => e);
    expect(err.getStatus?.()).toBe(429);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("the cap doesn't count resumes, and admins aren't limited", async () => {
    const userId = `nocount-${Date.now()}`;
    for (let i = 0; i < 12; i += 1) await change(CampaignStatus.paused, CampaignStatus.live, userId, UserRole.brand);
    const ctx = await change(CampaignStatus.draft, CampaignStatus.pending_review, userId, UserRole.brand);
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
    for (let i = 0; i < 12; i += 1) {
      const a = await change(CampaignStatus.draft, CampaignStatus.live, "admin-many", UserRole.admin);
      expect(a.prisma.campaign.update).toHaveBeenCalled();
    }
  });
});

describe("campaign link rules are enforced on save (item 15)", () => {
  it("refuses a new off-site link on update, keeps an existing legacy one", async () => {
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    ctx.prisma.campaign.findUnique.mockResolvedValue(
      completeDraft({ sourceAssets: [{ type: "drive", url: "drive.google.com/legacy" }] }),
    );
    // Re-sending the legacy link is fine…
    await ctx.service.update("user-brand", UserRole.brand, "camp-1", {
      sourceAssets: [{ type: "drive", url: "drive.google.com/legacy" }],
    } as never);
    expect(ctx.prisma.campaign.update).toHaveBeenCalledTimes(1);
    // …a new off-site one isn't.
    await expectValidationError(
      ctx.service.update("user-brand", UserRole.brand, "camp-1", {
        referenceAssets: [{ type: "image", url: "https://evil.example.com/x.png" }],
      } as never),
      /Sample content/,
    );
    expect(ctx.prisma.campaign.update).toHaveBeenCalledTimes(1);
  });

  it("refuses an off-site cover on create", async () => {
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    await expectValidationError(
      ctx.service.create("user-brand", UserRole.brand, { title: "x", coverImageUrl: "https://evil.example.com/c.png" } as never),
      /Cover image/,
    );
    expect(ctx.prisma.campaign.create).not.toHaveBeenCalled();
  });
});

describe("campaign start date (can't start in the past)", () => {
  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const updateWith = (existing: Record<string, unknown>, dto: Record<string, unknown>) => {
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    ctx.prisma.campaign.findUnique.mockResolvedValue(completeDraft(existing));
    return { ctx, run: ctx.service.update("user-brand", UserRole.brand, "camp-1", dto as never) };
  };

  it("refuses setting a past start date on a draft", async () => {
    const { ctx, run } = updateWith({}, { startDate: day(-3) });
    await expectValidationError(run, /can't be in the past/);
    expect(ctx.prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("refuses a past start date on create", async () => {
    const ctx = setup();
    ctx.prisma.brandProfile.findUnique.mockResolvedValue({ id: "brand-1" });
    await expectValidationError(ctx.service.create("user-brand", UserRole.brand, { title: "x", startDate: day(-1) } as never), /past/);
  });

  it("refuses a start date more than 12 months away (typos like year 20260)", async () => {
    await expectValidationError(updateWith({}, { startDate: day(400) }).run, /within the next 12 months/);
  });

  it("accepts today and future dates", async () => {
    const today = updateWith({}, { startDate: new Date().toISOString() });
    await today.run;
    expect(today.ctx.prisma.campaign.update).toHaveBeenCalled();
    const later = updateWith({}, { startDate: day(30) });
    await later.run;
    expect(later.ctx.prisma.campaign.update).toHaveBeenCalled();
  });

  it("a live campaign that already started can still be edited (unchanged past date is fine)", async () => {
    const started = new Date(Date.now() - 7 * 86_400_000);
    const { ctx, run } = updateWith(
      { status: CampaignStatus.live, startDate: started },
      { title: "renamed", startDate: started.toISOString().slice(0, 10) },
    );
    await run;
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
  });

  it("first publish needs a start date, and not one that has already passed", async () => {
    await expectValidationError(updateWith({ startDate: null }, { status: CampaignStatus.pending_review }).run, /Choose a start date/);
    await expectValidationError(
      updateWith({ startDate: new Date(Date.now() - 2 * 86_400_000) }, { status: CampaignStatus.pending_review }).run,
      /start date has passed/,
    );
  });

  it("resuming a paused campaign whose start date is past is still allowed", async () => {
    const { ctx, run } = updateWith(
      { status: CampaignStatus.paused, startDate: new Date(Date.now() - 30 * 86_400_000) },
      { status: CampaignStatus.live },
    );
    await run;
    expect(ctx.prisma.campaign.update).toHaveBeenCalled();
  });
});
