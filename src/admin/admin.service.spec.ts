import { BadRequestException, NotFoundException } from "@nestjs/common";
import { NewClipperIntakeStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AdminService } from "./admin.service";

function makeService() {
  const prisma = {
    campaign: { update: vi.fn() },
    brandProfile: { findUnique: vi.fn(), update: vi.fn() },
    user: { update: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
    $queryRaw: vi.fn().mockResolvedValue([{ total: 0n }]),
  };
  const realtime = { emitCampaignUpdated: vi.fn() };
  const service = new AdminService(
    prisma as never,
    {} as never, // campaigns
    {} as never, // email
    {} as never, // wallet
    {} as never, // activityLog
    {} as never, // notifications
    realtime as never,
    {} as never, // support
    {} as never, // bulkNotifications
    {} as never, // faqs
    {} as never, // adminRoles
    {} as never, // marketplace
    {} as never, // payouts
  );
  return { service, prisma, realtime };
}

describe("AdminService.setCampaignClipperIntake", () => {
  it("sets manually_extended with the given allowance when > 0", async () => {
    const { service, prisma, realtime } = makeService();
    prisma.campaign.update.mockResolvedValue({
      id: "camp-1",
      brandProfileId: "brand-1",
      budgetPaise: 1_000_000,
      newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended,
      extraClipperAllowance: 5,
    });

    const result = await service.setCampaignClipperIntake("camp-1", 5);

    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { extraClipperAllowance: 5, newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended },
    });
    expect(result.newClipperIntakeStatus).toBe(NewClipperIntakeStatus.manually_extended);
    expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "camp-1", newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended }),
    );
  });

  it("sets closed_at_threshold when the allowance is set to 0", async () => {
    const { service, prisma } = makeService();
    prisma.campaign.update.mockResolvedValue({
      id: "camp-1",
      brandProfileId: "brand-1",
      budgetPaise: 1_000_000,
      newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold,
      extraClipperAllowance: 0,
    });

    await service.setCampaignClipperIntake("camp-1", 0);

    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { extraClipperAllowance: 0, newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold },
    });
  });

  it("throws NotFoundException for an unknown campaign", async () => {
    const { service, prisma } = makeService();
    prisma.campaign.update.mockRejectedValue({ code: "P2025" });

    await expect(service.setCampaignClipperIntake("missing", 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("AdminService.setCampaignPoolOverflow", () => {
  it("toggles allowExcessViewsToFillPool and emits the update", async () => {
    const { service, prisma, realtime } = makeService();
    prisma.campaign.update.mockResolvedValue({
      id: "camp-1",
      brandProfileId: "brand-1",
      budgetPaise: 1_000_000,
      allowExcessViewsToFillPool: true,
    });

    const result = await service.setCampaignPoolOverflow("camp-1", true);

    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: "camp-1" },
      data: { allowExcessViewsToFillPool: true },
    });
    expect(result.allowExcessViewsToFillPool).toBe(true);
    expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "camp-1", allowExcessViewsToFillPool: true }),
    );
  });
});

describe("AdminService.deleteBrand", () => {
  it("throws NotFoundException for an unknown brand", async () => {
    const { service, prisma } = makeService();
    prisma.brandProfile.findUnique.mockResolvedValue(null);

    await expect(service.deleteBrand("missing")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("blocks deletion when the brand has existing campaigns", async () => {
    const { service, prisma } = makeService();
    prisma.brandProfile.findUnique.mockResolvedValue({
      id: "brand-1",
      userId: "user-1",
      _count: { campaigns: 1 },
    });

    await expect(service.deleteBrand("brand-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("soft-deletes and scrubs PII when the brand has no campaigns", async () => {
    const { service, prisma } = makeService();
    prisma.brandProfile.findUnique.mockResolvedValue({
      id: "brand-1",
      userId: "user-1",
      _count: { campaigns: 0 },
    });

    const result = await service.deleteBrand("brand-1");

    expect(result).toEqual({ deleted: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ isActive: false, email: null, phone: null }),
    });
    expect(prisma.brandProfile.update).toHaveBeenCalledWith({
      where: { id: "brand-1" },
      data: expect.objectContaining({ companyName: "Deleted brand", companyEmail: null }),
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("AdminService.payoutCampaign", () => {
  function makePayoutService() {
    const tx = {
      formatDeliverable: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketplaceRepost: { update: vi.fn() },
    };
    const prisma = {
      formatDeliverable: {
        findMany: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const wallet = {
      creditEarning: vi.fn().mockResolvedValue(undefined),
      creditEarningInTx: vi.fn().mockResolvedValue(undefined),
    };
    const notifications = { create: vi.fn().mockResolvedValue(undefined) };
    const realtime = { emitDeliverablePaid: vi.fn() };
    const service = new AdminService(
      prisma as never,
      {} as never, // campaigns
      {} as never, // email
      wallet as never,
      {} as never, // activityLog
      notifications as never,
      realtime as never,
      {} as never, // support
      {} as never, // bulkNotifications
      {} as never, // faqs
      {} as never, // adminRoles
      {} as never, // marketplace
      {} as never, // payouts
    );
    return { service, prisma, tx, wallet, notifications, realtime };
  }

  const campaignSelect = {
    title: "Campaign",
    ratePer1kPaise: 100,
    maxPayoutPaise: 100_000,
    brandProfileId: "brand-1",
  };

  it("pays a non-marketplace deliverable the normal single-credit way", async () => {
    const { service, prisma, wallet, tx } = makePayoutService();
    prisma.formatDeliverable.findMany.mockResolvedValue([
      {
        id: "deliverable-1",
        participationId: "participation-1",
        platform: "instagram_reel",
        viewCount: 1000,
        status: "proof_approved",
        marketplaceRepostClaim: null,
        participation: { creatorId: "creator-b", campaignId: "campaign-1", campaign: campaignSelect },
      },
    ]);

    const result = await service.payoutCampaign("campaign-1");

    expect(prisma.formatDeliverable.updateMany).toHaveBeenCalledWith({
      where: { id: "deliverable-1", paidAt: null },
      data: { paidAt: expect.any(Date), paidAmountPaise: 100 },
    });
    expect(wallet.creditEarning).toHaveBeenCalledWith(
      "creator-b",
      100,
      "deliverable-1",
      expect.stringContaining("Payout"),
    );
    expect(wallet.creditEarningInTx).not.toHaveBeenCalled();
    expect(tx.marketplaceRepost.update).not.toHaveBeenCalled();
    expect(result).toEqual({ paidCount: 1, totalPaidPaise: 100 });
  });

  it("splits a marketplace repost's payout 70/30 and credits both wallets atomically", async () => {
    const { service, prisma, wallet, tx } = makePayoutService();
    prisma.formatDeliverable.findMany.mockResolvedValue([
      {
        id: "poster-deliverable-1",
        participationId: "participation-b",
        platform: "instagram_reel",
        viewCount: 1000,
        status: "proof_approved",
        marketplaceRepostClaim: {
          id: "repost-1",
          sourceDeliverable: { participation: { creatorId: "creator-a" } },
        },
        participation: { creatorId: "creator-b", campaignId: "campaign-1", campaign: campaignSelect },
      },
    ]);

    const result = await service.payoutCampaign("campaign-1");

    expect(tx.formatDeliverable.updateMany).toHaveBeenCalledWith({
      where: { id: "poster-deliverable-1", paidAt: null },
      data: { paidAt: expect.any(Date), paidAmountPaise: 100 },
    });
    expect(tx.marketplaceRepost.update).toHaveBeenCalledWith({
      where: { id: "repost-1" },
      data: { posterSharePaise: 70, originalCreatorSharePaise: 30 },
    });
    expect(wallet.creditEarningInTx).toHaveBeenCalledWith(
      tx,
      "creator-b",
      70,
      "poster-deliverable-1",
      expect.stringContaining("marketplace repost"),
    );
    expect(wallet.creditEarningInTx).toHaveBeenCalledWith(
      tx,
      "creator-a",
      30,
      "repost-1",
      expect.stringContaining("Marketplace repost share"),
    );
    expect(wallet.creditEarning).not.toHaveBeenCalled();
    expect(result).toEqual({ paidCount: 1, totalPaidPaise: 100 });
  });

  it("does not double-pay a marketplace deliverable that's already paid (concurrent CAS loses)", async () => {
    const { service, prisma, wallet, tx } = makePayoutService();
    tx.formatDeliverable.updateMany.mockResolvedValue({ count: 0 });
    prisma.formatDeliverable.findMany.mockResolvedValue([
      {
        id: "poster-deliverable-1",
        participationId: "participation-b",
        platform: "instagram_reel",
        viewCount: 1000,
        status: "proof_approved",
        marketplaceRepostClaim: {
          id: "repost-1",
          sourceDeliverable: { participation: { creatorId: "creator-a" } },
        },
        participation: { creatorId: "creator-b", campaignId: "campaign-1", campaign: campaignSelect },
      },
    ]);

    const result = await service.payoutCampaign("campaign-1");

    expect(wallet.creditEarningInTx).not.toHaveBeenCalled();
    expect(tx.marketplaceRepost.update).not.toHaveBeenCalled();
    expect(result).toEqual({ paidCount: 0, totalPaidPaise: 0 });
  });
  it("leaves a deliverable with nothing earned unpaid instead of locking it at ₹0", async () => {
    const { service, prisma, wallet, notifications } = makePayoutService();
    prisma.formatDeliverable.findMany.mockResolvedValue([
      {
        id: "deliverable-0",
        participationId: "participation-1",
        platform: "instagram_reel",
        viewCount: 0,
        status: "proof_approved",
        marketplaceRepostClaim: null,
        participation: { creatorId: "creator-b", campaignId: "campaign-1", campaign: campaignSelect },
      },
    ]);

    const result = await service.payoutCampaign("campaign-1");

    expect(prisma.formatDeliverable.updateMany).not.toHaveBeenCalled();
    expect(wallet.creditEarning).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(result).toEqual({ paidCount: 0, totalPaidPaise: 0 });
  });

  it("pays only the chosen profile's row when a creator has two profiles in the campaign", async () => {
    const { service, prisma } = makePayoutService();
    prisma.formatDeliverable.findMany.mockResolvedValue([]);

    await service.payoutCampaign("campaign-1", "creator-b", "profile-2");

    expect(prisma.formatDeliverable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          participation: { campaignId: "campaign-1", creatorId: "creator-b", creatorProfileId: "profile-2" },
        }),
      }),
    );
  });
});
