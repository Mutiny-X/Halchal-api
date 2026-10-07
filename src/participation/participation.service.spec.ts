import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  CampaignStatus,
  FormatDeliverableStatus,
  NewClipperIntakeStatus,
  UserRole,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParticipationService } from "./participation.service";
import { ReviewDeliverableAction } from "./dto/review-deliverable.dto";

function makePrisma() {
  return {
    campaign: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    campaignParticipation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    formatDeliverable: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
    },
    deliverableRejectionEvent: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    deliverableInsightSnapshot: { create: vi.fn().mockResolvedValue({}) },
    payoutMethod: { findFirst: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ total: 0n }]),
  };
}

function makeCampaignAccess() {
  return {
    getBrandProfileIdForUser: vi.fn(),
    assertCanAccessCampaign: vi.fn(),
  };
}

function makeRealtime() {
  return {
    emitParticipationJoined: vi.fn(),
    emitDeliverableSubmitted: vi.fn(),
    emitDeliverableReviewed: vi.fn(),
    emitDeliverableLiveProof: vi.fn(),
    emitDeliverableMetricsUpdated: vi.fn(),
    emitCampaignUpdated: vi.fn(),
  };
}

function makeCreatorProfiles() {
  return {
    assertOwnership: vi.fn().mockResolvedValue({ id: "profile-1", userId: "creator-1" }),
  };
}

function makeAutoReview() {
  return {
    runProofPipeline: vi.fn().mockResolvedValue(undefined),
    runDraftPipeline: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInstagramOAuth() {
  return {
    getMediaInsightsForPost: vi.fn().mockResolvedValue(null),
  };
}

describe("ParticipationService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let campaignAccess: ReturnType<typeof makeCampaignAccess>;
  let realtime: ReturnType<typeof makeRealtime>;
  let creatorProfiles: ReturnType<typeof makeCreatorProfiles>;
  let autoReview: ReturnType<typeof makeAutoReview>;
  let instagramOAuth: ReturnType<typeof makeInstagramOAuth>;
  let apify: { getViewCount: ReturnType<typeof vi.fn> };
  let service: ParticipationService;

  beforeEach(() => {
    prisma = makePrisma();
    // Default: creator already has complete bank details on file, so the
    // join-gate check (added alongside making PAN mandatory) doesn't
    // interfere with tests unrelated to that gate. Tests that specifically
    // exercise the gate override this per-case.
    prisma.payoutMethod.findFirst.mockResolvedValue({
      id: "payout-1",
      type: "bank",
      panNumber: "ABCPV1234D",
    });
    campaignAccess = makeCampaignAccess();
    realtime = makeRealtime();
    creatorProfiles = makeCreatorProfiles();
    autoReview = makeAutoReview();
    instagramOAuth = makeInstagramOAuth();
    apify = { getViewCount: vi.fn().mockResolvedValue({ viewCount: 0, platform: "unknown" }) };
    service = new ParticipationService(
      prisma as never,
      campaignAccess as never,
      realtime as never,
      apify as never,
      { log: async () => undefined } as never,
      { create: async () => undefined } as never,
      creatorProfiles as never,
      autoReview as never,
      instagramOAuth as never,
    );
  });

  describe("joinCampaign", () => {
    it("rejects the join when the creator has no bank payout method on file", async () => {
      prisma.payoutMethod.findFirst.mockResolvedValue(null);

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
    });

    it("rejects the join when the bank method exists but has no PAN on file", async () => {
      prisma.payoutMethod.findFirst.mockResolvedValue({
        id: "payout-1",
        type: "bank",
        panNumber: null,
      });

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates participation with deliverables per platform", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel", "youtube_shorts"],
        platform: "instagram_reel",
        brandProfileId: "brand-1",
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);
      prisma.campaignParticipation.create.mockResolvedValue({
        id: "part-1",
        campaignId: "camp-1",
        creatorId: "creator-1",
        creatorProfileId: "profile-1",
        platformsSnapshot: ["instagram_reel", "youtube_shorts"],
        joinedAt: new Date("2026-06-09"),
        campaign: {
          id: "camp-1",
          title: "Test",
          status: CampaignStatus.live,
          platforms: ["instagram_reel", "youtube_shorts"],
          platform: "instagram_reel",
          ratePer1kPaise: 5000,
          maxPayoutPaise: 100000,
          brandProfile: { companyName: "Brand", logoUrl: null },
        },
        creatorProfile: {
          id: "profile-1",
          platform: "instagram",
          handle: "demo_creator",
          label: null,
          avatarUrl: null,
        },
        deliverables: [
          {
            id: "d1",
            platform: "instagram_reel",
            status: FormatDeliverableStatus.draft_pending,
            draftDriveUrl: null,
            livePostUrl: null,
            rejectionReason: null,
            draftSubmittedAt: null,
            draftReviewedAt: null,
            liveSubmittedAt: null,
            rejectionEvents: [],
          },
          {
            id: "d2",
            platform: "youtube_shorts",
            status: FormatDeliverableStatus.draft_pending,
            draftDriveUrl: null,
            livePostUrl: null,
            rejectionReason: null,
            draftSubmittedAt: null,
            draftReviewedAt: null,
            liveSubmittedAt: null,
            rejectionEvents: [],
          },
        ],
      });

      const result = await service.joinCampaign("creator-1", "camp-1", "profile-1");

      expect(result.id).toBe("part-1");
      expect(result.deliverables).toHaveLength(2);
      expect(prisma.campaignParticipation.create).toHaveBeenCalled();
      expect(realtime.emitParticipationJoined).toHaveBeenCalled();
    });

    it("throws conflict when already joined", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue({
        id: "part-existing",
        campaignId: "camp-1",
        creatorId: "creator-1",
        creatorProfileId: "profile-1",
        platformsSnapshot: ["instagram_reel"],
        joinedAt: new Date(),
        campaign: {
          id: "camp-1",
          title: "Test",
          status: CampaignStatus.live,
          platforms: ["instagram_reel"],
          platform: "instagram_reel",
          ratePer1kPaise: 5000,
          maxPayoutPaise: 100000,
          brandProfile: null,
        },
        creatorProfile: {
          id: "profile-1",
          platform: "instagram",
          handle: "demo_creator",
          label: null,
          avatarUrl: null,
        },
        deliverables: [],
      });

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("throws not found for non-live campaign", async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("blocks joining when intake is closed_at_threshold", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold,
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.campaignParticipation.create).not.toHaveBeenCalled();
    });

    it("blocks joining once live pool usage crosses the threshold even if the stored status is still 'open'", async () => {
      // The stored newClipperIntakeStatus only flips reactively (normally on
      // a deliverable's view refresh) — a campaign whose pool crossed 80%
      // with no recent view refresh would still read "open" here. The join
      // path must re-check live usage rather than trust the stale field.
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        brandProfileId: "brand-1",
        newClipperIntakeStatus: NewClipperIntakeStatus.open,
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([{ total: 8400000n }]); // 84% of budgetPaise

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.campaignParticipation.create).not.toHaveBeenCalled();
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: "camp-1" },
        data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold },
      });
      expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "camp-1",
          newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold,
        }),
      );
    });

    it("allows joining under manually_extended and consumes one unit of the allowance", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended,
        extraClipperAllowance: 3,
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
      prisma.campaign.findUnique.mockResolvedValue({ extraClipperAllowance: 2 });
      prisma.campaignParticipation.create.mockResolvedValue({
        id: "part-1",
        campaignId: "camp-1",
        creatorId: "creator-1",
        creatorProfileId: "profile-1",
        platformsSnapshot: ["instagram_reel"],
        joinedAt: new Date("2026-06-09"),
        campaign: {
          id: "camp-1", title: "Test", status: CampaignStatus.live,
          platforms: ["instagram_reel"], platform: "instagram_reel",
          ratePer1kPaise: 5000, maxPayoutPaise: 100000, brandProfile: null,
        },
        creatorProfile: { id: "profile-1", platform: "instagram", handle: "demo_creator", label: null, avatarUrl: null },
        deliverables: [],
      });

      const result = await service.joinCampaign("creator-1", "camp-1", "profile-1");

      expect(result.id).toBe("part-1");
      expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: "camp-1", extraClipperAllowance: { gt: 0 } },
        data: { extraClipperAllowance: { decrement: 1 } },
      });
      // Allowance still has 2 left after this join — intake stays manually_extended.
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold } }),
      );
    });

    it("closes intake again once the last manually_extended slot is used", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended,
        extraClipperAllowance: 1,
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
      prisma.campaign.findUnique.mockResolvedValue({ extraClipperAllowance: 0 });
      prisma.campaignParticipation.create.mockResolvedValue({
        id: "part-1",
        campaignId: "camp-1",
        creatorId: "creator-1",
        creatorProfileId: "profile-1",
        platformsSnapshot: ["instagram_reel"],
        joinedAt: new Date("2026-06-09"),
        campaign: {
          id: "camp-1", title: "Test", status: CampaignStatus.live,
          platforms: ["instagram_reel"], platform: "instagram_reel",
          ratePer1kPaise: 5000, maxPayoutPaise: 100000, brandProfile: null,
        },
        creatorProfile: { id: "profile-1", platform: "instagram", handle: "demo_creator", label: null, avatarUrl: null },
        deliverables: [],
      });

      await service.joinCampaign("creator-1", "camp-1", "profile-1");

      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: "camp-1" },
        data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold },
      });
    });

    it("blocks joining when the manually_extended allowance is already exhausted (race lost)", async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: "camp-1",
        status: CampaignStatus.live,
        platforms: ["instagram_reel"],
        platform: "instagram_reel",
        newClipperIntakeStatus: NewClipperIntakeStatus.manually_extended,
        extraClipperAllowance: 0,
        budgetPaise: 10000000,
        poolThresholdBps: 8000,
      });
      prisma.campaignParticipation.findUnique.mockResolvedValue(null);
      prisma.campaign.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.joinCampaign("creator-1", "camp-1", "profile-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.campaignParticipation.create).not.toHaveBeenCalled();
    });
  });

  describe("getLeaderboard", () => {
    it("ranks two profiles owned by the same user as independent entries", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creator: { id: "user-1", displayName: "Ravi", username: "ravi", avatarUrl: null },
          creatorProfile: { id: "profile-a", platform: "instagram", handle: "ravi_main", label: null },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }],
        },
        {
          creator: { id: "user-1", displayName: "Ravi", username: "ravi", avatarUrl: null },
          creatorProfile: { id: "profile-b", platform: "instagram", handle: "ravi_memes", label: "Meme page" },
          deliverables: [{ viewCount: 5000, paidAmountPaise: null }],
        },
      ]);

      const result = await service.getLeaderboard("camp-1", "profile-b");

      expect(result.totalParticipants).toBe(2);
      expect(result.entries.map((e) => e.creatorProfileId)).toEqual([
        "profile-b",
        "profile-a",
      ]);
      expect(result.currentUser?.creatorProfileId).toBe("profile-b");
      expect(result.currentUser?.displayName).toBe("Meme page");
    });

    it("returns null currentUser when no creatorProfileId is supplied", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creator: { id: "user-1", displayName: "Ravi", username: "ravi", avatarUrl: null },
          creatorProfile: { id: "profile-a", platform: "instagram", handle: "ravi_main", label: null },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }],
        },
      ]);

      const result = await service.getLeaderboard("camp-1");

      expect(result.currentUser).toBeNull();
    });

    it("excludes soft-deleted creators from the query", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([]);

      await service.getLeaderboard("camp-1");

      expect(prisma.campaignParticipation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaignId: "camp-1", creator: { isActive: true } },
        }),
      );
    });

    it("shows a verified creator's permanent id instead of their real name", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creator: {
            id: "user-1",
            displayName: "Ravi Kumar",
            username: "ravi",
            avatarUrl: null,
            verifiedCreatorId: "482910384",
          },
          creatorProfile: { id: "profile-a", platform: "instagram", handle: "ravi_main", label: null },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }],
        },
        {
          creator: {
            id: "user-2",
            displayName: "Priya Singh",
            username: "priya",
            avatarUrl: null,
            verifiedCreatorId: null,
          },
          creatorProfile: { id: "profile-b", platform: "instagram", handle: "priya_x", label: null },
          deliverables: [{ viewCount: 500, paidAmountPaise: null }],
        },
      ]);

      const result = await service.getLeaderboard("camp-1");

      expect(result.entries.find((e) => e.creatorProfileId === "profile-a")?.displayName).toBe(
        "#482910384",
      );
      expect(result.entries.find((e) => e.creatorProfileId === "profile-b")?.displayName).toBe(
        "Priya Singh",
      );
    });

    it("still prefers a brand-set profile label over the verified id", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creator: {
            id: "user-1",
            displayName: "Ravi Kumar",
            username: "ravi",
            avatarUrl: null,
            verifiedCreatorId: "482910384",
          },
          creatorProfile: { id: "profile-a", platform: "instagram", handle: "ravi_main", label: "Meme page" },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }],
        },
      ]);

      const result = await service.getLeaderboard("camp-1");

      expect(result.entries[0].displayName).toBe("Meme page");
    });

    it("only counts proof_approved deliverables toward a creator's total", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([]);

      await service.getLeaderboard("camp-1");

      expect(prisma.campaignParticipation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            deliverables: expect.objectContaining({
              where: { status: FormatDeliverableStatus.proof_approved },
            }),
          }),
        }),
      );
    });

    it("ranks by total earnings, not raw views — a real paid amount can outrank more views", async () => {
      prisma.campaign.findUnique.mockResolvedValue({
        ratePer1kPaise: 5000,
        maxPayoutPaise: 100000,
      });
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creator: { id: "user-1", displayName: "More Views", username: "a", avatarUrl: null },
          creatorProfile: { id: "profile-a", platform: "instagram", handle: "a", label: null },
          // 5000 views, no real payout yet — estimate: 5000/1000 * 5000 = 25000 paise.
          deliverables: [{ viewCount: 5000, paidAmountPaise: null }],
        },
        {
          creator: { id: "user-2", displayName: "Less Views More Paid", username: "b", avatarUrl: null },
          creatorProfile: { id: "profile-b", platform: "instagram", handle: "b", label: null },
          // Fewer views, but a real paid amount higher than the other's estimate.
          deliverables: [{ viewCount: 1000, paidAmountPaise: 50000 }],
        },
      ]);

      const result = await service.getLeaderboard("camp-1");

      expect(result.entries.map((e) => e.creatorProfileId)).toEqual(["profile-b", "profile-a"]);
    });
  });

  describe("getOverallLeaderboard", () => {
    it("excludes soft-deleted creators from the query", async () => {
      prisma.campaignParticipation.findMany.mockResolvedValue([]);

      await service.getOverallLeaderboard("user-1");

      expect(prisma.campaignParticipation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { creator: { isActive: true, verifiedCreatorId: { not: null } } },
        }),
      );
    });

    it("shows a verified creator's permanent id instead of their real name", async () => {
      // Not-yet-verified creators (like user-2 here) are excluded at the
      // query's where clause in real usage — this mock doesn't enforce
      // that, so this also doubles as coverage that the mapping itself
      // never falls back to a real name for a creator that does have an id.
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creatorId: "user-1",
          creator: {
            id: "user-1",
            displayName: "Ravi Kumar",
            username: "ravi",
            avatarUrl: null,
            verifiedCreatorId: "482910384",
          },
          campaign: { ratePer1kPaise: 5000, maxPayoutPaise: 100000 },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }],
        },
        {
          creatorId: "user-2",
          creator: {
            id: "user-2",
            displayName: "Priya Singh",
            username: "priya",
            avatarUrl: null,
            verifiedCreatorId: null,
          },
          campaign: { ratePer1kPaise: 5000, maxPayoutPaise: 100000 },
          deliverables: [{ viewCount: 500, paidAmountPaise: null }],
        },
      ]);

      const result = await service.getOverallLeaderboard("user-1");

      expect(result.entries.find((e) => e.creatorId === "user-1")?.displayName).toBe(
        "#482910384",
      );
      expect(result.entries.find((e) => e.creatorId === "user-2")?.displayName).toBe(
        "Priya Singh",
      );
    });

    it("only counts proof_approved deliverables toward a creator's total", async () => {
      prisma.campaignParticipation.findMany.mockResolvedValue([]);

      await service.getOverallLeaderboard("user-1");

      expect(prisma.campaignParticipation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            deliverables: expect.objectContaining({
              where: { status: FormatDeliverableStatus.proof_approved },
            }),
          }),
        }),
      );
    });

    it("ranks by total earnings, not raw views — confirmed live: a better campaign rate can outrank more views", async () => {
      prisma.campaignParticipation.findMany.mockResolvedValue([
        {
          creatorId: "user-1",
          creator: {
            id: "user-1",
            displayName: "More Views",
            username: "a",
            avatarUrl: null,
            verifiedCreatorId: "111111111",
          },
          // Low rate campaign — lots of views, modest earnings.
          campaign: { ratePer1kPaise: 1000, maxPayoutPaise: 1000000 },
          deliverables: [{ viewCount: 10000, paidAmountPaise: null }], // 10000 paise
        },
        {
          creatorId: "user-2",
          creator: {
            id: "user-2",
            displayName: "Better Rate",
            username: "b",
            avatarUrl: null,
            verifiedCreatorId: "222222222",
          },
          // High rate campaign — fewer views, more actual earnings.
          campaign: { ratePer1kPaise: 20000, maxPayoutPaise: 1000000 },
          deliverables: [{ viewCount: 1000, paidAmountPaise: null }], // 20000 paise
        },
      ]);

      const result = await service.getOverallLeaderboard("user-1");

      expect(result.entries.map((e) => e.creatorId)).toEqual(["user-2", "user-1"]);
      expect(result.entries[0].rank).toBe(1);
    });
  });

  describe("submitDraft", () => {
    it("moves rejected deliverable back to under_review", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_rejected,
        rejectionEvents: [
          {
            draftDriveUrl: "https://drive.google.com/file/d/old/view",
          },
        ],
        participation: {
          creatorId: "creator-1",
          campaignId: "camp-1",
          campaign: { status: CampaignStatus.live, brandProfileId: "brand-1" },
        },
        participationId: "part-1",
        platform: "instagram_reel",
      });
      prisma.formatDeliverable.findUniqueOrThrow.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
        participationId: "part-1",
        platform: "instagram_reel",
      });

      const result = await service.submitDraft("creator-1", "d1", {
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
      });

      expect(result.status).toBe(FormatDeliverableStatus.under_review);
      expect(realtime.emitDeliverableSubmitted).toHaveBeenCalled();
    });

    it("rejects non-Google Drive URLs", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_pending,
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.live },
        },
      });

      await expect(
        service.submitDraft("creator-1", "d1", {
          draftDriveUrl: "https://dropbox.com/s/abc",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("blocks resubmit with same Drive URL as last rejection", async () => {
      const rejectedUrl = "https://drive.google.com/file/d/same/view";
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_rejected,
        rejectionEvents: [{ draftDriveUrl: rejectedUrl }],
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.live },
        },
      });

      await expect(
        service.submitDraft("creator-1", "d1", {
          draftDriveUrl: rejectedUrl,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("blocks draft submit when campaign is closed", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_pending,
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.paused },
        },
      });

      await expect(
        service.submitDraft("creator-1", "d1", {
          draftDriveUrl: "https://drive.google.com/a",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("submitLiveProof", () => {
    it("blocks live proof before approval", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValueOnce({
        id: "d1",
        platform: "instagram_reel",
        status: FormatDeliverableStatus.under_review,
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.live },
        },
      });

      await expect(
        service.submitLiveProof("creator-1", "d1", {
          livePostUrl: "https://instagram.com/reel/1",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("accepts live proof when draft_approved", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValueOnce({
        id: "d1",
        platform: "instagram_reel",
        status: FormatDeliverableStatus.draft_approved,
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.live },
        },
      });
      prisma.formatDeliverable.findUniqueOrThrow.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.live_submitted,
        livePostUrl: "https://instagram.com/reel/1",
      });

      const result = await service.submitLiveProof("creator-1", "d1", {
        livePostUrl: "https://instagram.com/reel/1",
      });

      expect(result.status).toBe(FormatDeliverableStatus.live_submitted);
    });

    it("accepts a resubmission after proof_rejected and clears the old rejection reason", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValueOnce({
        id: "d1",
        platform: "instagram_reel",
        status: FormatDeliverableStatus.proof_rejected,
        rejectionReason: "resubmit",
        participation: {
          creatorId: "creator-1",
          campaign: { status: CampaignStatus.live },
        },
      });
      prisma.formatDeliverable.findUniqueOrThrow.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.proof_under_review,
        livePostUrl: "https://instagram.com/reel/2",
      });

      const result = await service.submitLiveProof("creator-1", "d1", {
        livePostUrl: "https://instagram.com/reel/2",
      });

      expect(prisma.formatDeliverable.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rejectionReason: null }),
        }),
      );
      expect(result.status).toBe(FormatDeliverableStatus.proof_under_review);
    });
  });

  describe("refreshDeliverableViews", () => {
    function mockDeliverable(
      overrides: Partial<{
        viewCount: number; reach: number; likeCount: number; commentCount: number; shareCount: number;
      }> = {},
    ) {
      const base = {
        id: "d1",
        creatorId: undefined as unknown, // set per-call below
        status: FormatDeliverableStatus.live_submitted,
        platform: "instagram_reel",
        livePostUrl: "https://instagram.com/reel/1",
        viewCount: 0,
        reach: 0,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        participation: {
          creatorId: "creator-1",
          creatorProfileId: "profile-1",
          campaign: {
            id: "camp-1",
            status: CampaignStatus.live,
            budgetPaise: 1_000_000,
            brandProfileId: "brand-1",
            ratePer1kPaise: 1_000,
            maxPayoutPaise: 50_000,
            newClipperIntakeStatus: NewClipperIntakeStatus.open as NewClipperIntakeStatus,
            poolThresholdBps: 8000,
          },
        },
      };
      return { ...base, ...overrides };
    }

    it("uses Instagram Insights exclusively — never calls Apify — when the creator's connected account has the post", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 42_000, reach: 40_000, likeCount: 100, commentCount: 5, shareCount: 2, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 42_000, reach: 40_000, likeCount: 100, commentCount: 5, shareCount: 2,
      });

      const result = await service.refreshDeliverableViews("creator-1", "d1");

      expect(instagramOAuth.getMediaInsightsForPost).toHaveBeenCalledWith(
        "profile-1",
        "https://instagram.com/reel/1",
      );
      expect(apify.getViewCount).not.toHaveBeenCalled();
      expect(result.viewCount).toBe(42_000);
      expect(result.metricsSource).toBe("instagram_insights");
    });

    it("keeps the last known metrics with metricsSource: unavailable when Instagram Insights has no data — never writes zeros, never falls back to Apify", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        mockDeliverable({
          viewCount: 50_000, reach: 40_000, likeCount: 2_000, commentCount: 100, shareCount: 10,
        } as never),
      );
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(null);

      const result = await service.refreshDeliverableViews("creator-1", "d1");

      expect(apify.getViewCount).not.toHaveBeenCalled();
      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(realtime.emitDeliverableMetricsUpdated).not.toHaveBeenCalled();
      expect(result.viewCount).toBe(50_000);
      expect(result.likeCount).toBe(2_000);
      expect(result.metricsSource).toBe("unavailable");
    });

    it("writes only the metrics Instagram reported on a partial response — missing ones keep their last known value", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        mockDeliverable({
          viewCount: 50_000, reach: 40_000, likeCount: 2_000, commentCount: 100, shareCount: 10,
        } as never),
      );
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({ viewCount: 60_000, platform: "instagram" });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 60_000, reach: 40_000, likeCount: 2_000, commentCount: 100, shareCount: 10,
      });

      const result = await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { viewCount: 60_000 } }),
      );
      expect(result.viewCount).toBe(60_000);
      expect(result.likeCount).toBe(2_000);
    });

    it("appends a history snapshot with saves, the media id and the raw metrics on a complete response", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 42_000, reach: 40_000, likeCount: 100, commentCount: 5, shareCount: 2, saveCount: 9,
        platformMediaId: "media-42",
        rawMetrics: { views: 42_000, reach: 40_000, likes: 100, comments: 5, shares: 2, saved: 9 },
        platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 42_000, reach: 40_000, likeCount: 100, commentCount: 5, shareCount: 2,
      });

      await service.refreshDeliverableViews("creator-1", "d1");

      // saveCount/platformMediaId/rawMetrics are history-only — never written to the deliverable row.
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { viewCount: 42_000, reach: 40_000, likeCount: 100, commentCount: 5, shareCount: 2 },
        }),
      );
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: {
          deliverableId: "d1",
          platform: "instagram_reel",
          livePostUrl: "https://instagram.com/reel/1",
          platformMediaId: "media-42",
          viewCount: 42_000,
          reach: 40_000,
          likeCount: 100,
          commentCount: 5,
          shareCount: 2,
          saveCount: 9,
          source: "instagram_insights_manual",
          status: "success",
          errorCode: null,
          rawMetrics: { views: 42_000, reach: 40_000, likes: 100, comments: 5, shares: 2, saved: 9 },
        },
      });
    });

    it("records a partial snapshot, carrying the last known values for what Instagram didn't return", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 60_000, rawMetrics: { views: 60_000 }, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 60_000, reach: 40_000, likeCount: 2_000, commentCount: 100, shareCount: 10,
      });

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "partial",
          viewCount: 60_000,
          likeCount: 2_000,
          rawMetrics: { views: 60_000 },
        }),
      });
    });

    it("records an 'unavailable' snapshot with the last known values when Instagram returns nothing", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        mockDeliverable({ viewCount: 50_000, likeCount: 2_000 } as never),
      );
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(null);

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "unavailable",
          errorCode: "no_data",
          platformMediaId: null,
          viewCount: 50_000,
          likeCount: 2_000,
          rawMetrics: {},
        }),
      });
    });

    it("does not write a snapshot for non-Instagram platforms", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        mockDeliverable({ platform: "youtube_shorts", livePostUrl: "https://youtube.com/shorts/abc" } as never),
      );
      apify.getViewCount.mockResolvedValue({
        viewCount: 5_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "youtube",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 5_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.deliverableInsightSnapshot.create).not.toHaveBeenCalled();
    });

    it("still saves the metrics and returns normally when the snapshot write itself fails", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({ viewCount: 70, platform: "instagram" });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 70, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      prisma.deliverableInsightSnapshot.create.mockRejectedValueOnce(new Error("db down"));

      const result = await service.refreshDeliverableViews("creator-1", "d1");

      expect(result.viewCount).toBe(70);
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledTimes(1);
    });

    it("still writes a genuine zero when Instagram itself reports 0", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 0, likeCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 0, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { viewCount: 0, likeCount: 0 } }),
      );
    });

    it("uses Apify (not Instagram Insights) for non-Instagram platforms", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        mockDeliverable({ platform: "youtube_shorts", livePostUrl: "https://youtube.com/shorts/abc" } as never),
      );
      apify.getViewCount.mockResolvedValue({
        viewCount: 5_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "youtube",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 5_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      const result = await service.refreshDeliverableViews("creator-1", "d1");

      expect(instagramOAuth.getMediaInsightsForPost).not.toHaveBeenCalled();
      expect(apify.getViewCount).toHaveBeenCalledWith("https://youtube.com/shorts/abc");
      expect(result.metricsSource).toBe("apify");
    });

    it("reports payoutCapped: false when the estimate is under maxPayoutPaise", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 10_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 10_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      // 10_000 views * 1_000 paise/1k = 10_000 paise, well under the 50_000 cap.
      const result = await service.refreshDeliverableViews("creator-1", "d1");
      expect(result.payoutCapped).toBe(false);
    });

    it("reports payoutCapped: true once the estimate reaches maxPayoutPaise, even though views keep climbing", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 500_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 500_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      // 500_000 views * 1_000 paise/1k = 500_000 paise, far past the 50_000 cap.
      const result = await service.refreshDeliverableViews("creator-1", "d1");
      expect(result.payoutCapped).toBe(true);
      // Analytics themselves are never capped — the real view count is what was written.
      expect(result.viewCount).toBe(500_000);
    });

    it("closes intake at 80% pool utilization without pausing the campaign", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      // Pool is at 85% of the 1_000_000 paise budget — above the 8000bps (80%) threshold, below 100%.
      prisma.$queryRaw.mockResolvedValue([{ total: 850_000n }]);

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: "camp-1" },
        data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold },
      });
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: CampaignStatus.paused }) }),
      );
      expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "camp-1",
          newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold,
          poolUtilizationBps: 8500,
        }),
      );
    });

    it("does not re-close intake if it was already manually_extended", async () => {
      const deliverable = mockDeliverable();
      deliverable.participation.campaign.newClipperIntakeStatus = NewClipperIntakeStatus.manually_extended;
      prisma.formatDeliverable.findUnique.mockResolvedValue(deliverable);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      prisma.$queryRaw.mockResolvedValue([{ total: 850_000n }]);

      await service.refreshDeliverableViews("creator-1", "d1");

      // Only the open -> closed_at_threshold transition is automatic; an
      // admin-extended campaign shouldn't be silently overridden by it.
      expect(prisma.campaign.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold } }),
      );
    });

    it("automatically closes at 100% and reports closed status in the realtime payload", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(mockDeliverable());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      prisma.$queryRaw.mockResolvedValue([{ total: 1_000_000n }]);

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: "camp-1" },
        data: { status: CampaignStatus.closed },
      });
      expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "camp-1", status: CampaignStatus.closed, poolUtilizationBps: 10000 }),
      );
    });
  });

  describe("refreshActiveDeliverableMetrics (background sweep)", () => {
    function trackableDeliverable(overrides: Record<string, unknown> = {}) {
      return {
        id: "d1",
        status: FormatDeliverableStatus.proof_under_review,
        platform: "instagram_reel",
        livePostUrl: "https://instagram.com/reel/1",
        participation: {
          id: "part-1",
          creatorId: "creator-1",
          creatorProfileId: "profile-1",
          campaignId: "camp-1",
          campaign: {
            id: "camp-1",
            status: CampaignStatus.live,
            budgetPaise: 1_000_000,
            brandProfileId: "brand-1",
            ratePer1kPaise: 1_000,
            maxPayoutPaise: 50_000,
            newClipperIntakeStatus: NewClipperIntakeStatus.open as NewClipperIntakeStatus,
            poolThresholdBps: 8000,
          },
        },
        ...overrides,
      };
    }

    async function runSweepWithFakeTimers() {
      vi.useFakeTimers();
      const promise = service.refreshActiveDeliverableMetrics();
      await vi.runAllTimersAsync();
      await promise;
      vi.useRealTimers();
    }

    it("excludes closed campaigns from the sweep query — a deliverable can sit in proof_approved forever, so without this it keeps burning Instagram/Apify calls after the campaign is done", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            participation: expect.objectContaining({
              campaign: { status: { not: CampaignStatus.closed } },
            }),
          }),
        }),
      );
    });

    it("does nothing when there are no trackable deliverables", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(instagramOAuth.getMediaInsightsForPost).not.toHaveBeenCalled();
    });

    it("never throws — even when the initial deliverable lookup itself fails (e.g. a dropped DB connection)", async () => {
      // Confirmed live: a transient "Server has closed the connection"
      // error hitting this exact query silently skipped five consecutive
      // 5-minute cron cycles with no log at all, since only the per-item
      // work inside the loop was wrapped in try/catch — not this lookup.
      prisma.formatDeliverable.findMany.mockRejectedValue(new Error("Server has closed the connection"));

      await expect(runSweepWithFakeTimers()).resolves.toBeUndefined();

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
    });

    it("refreshes every trackable deliverable and emits metrics_updated for each", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        trackableDeliverable({ id: "d1" }),
        trackableDeliverable({ id: "d2", livePostUrl: "https://instagram.com/reel/2" }),
      ]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0,
      });

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(2);
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledTimes(2);
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ deliverableId: "d1", viewCount: 100 }),
      );
      // Regression check: a real live sweep over 29 deliverables once
      // caused 29 separate campaign:updated broadcasts (each one going to
      // every connected creator app-wide) — which is what showed up as
      // screens reloading multiple times in a row. Nothing changed the
      // pool's intake status here, so this must emit zero of them, not
      // one per deliverable.
      expect(realtime.emitCampaignUpdated).not.toHaveBeenCalled();
    });

    it("emits campaign:updated at most once per campaign even when several of its deliverables are refreshed in the same sweep", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        trackableDeliverable({ id: "d1" }),
        trackableDeliverable({ id: "d2", livePostUrl: "https://instagram.com/reel/2" }),
        trackableDeliverable({ id: "d3", livePostUrl: "https://instagram.com/reel/3" }),
      ]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0,
      });
      // Pool usage past the 80% threshold — a genuine intake-status change,
      // so this is exactly the case where campaign:updated SHOULD fire.
      prisma.$queryRaw.mockResolvedValue([{ total: 850_000n }]);

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(3);
      // All three deliverables share campaign-1 — one broadcast, not three.
      expect(realtime.emitCampaignUpdated).toHaveBeenCalledTimes(1);
      expect(realtime.emitCampaignUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "camp-1", newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold }),
      );
    });

    async function runHourlyWithFakeTimers() {
      vi.useFakeTimers();
      const promise = service.refreshActiveDeliverableViews();
      await vi.runAllTimersAsync();
      await promise;
      vi.useRealTimers();
    }

    it("hourly views sweep writes only the view count to the deliverable, and appends an hourly history row that vouches for views only", async () => {
      prisma.formatDeliverable.findMany
        .mockResolvedValueOnce([trackableDeliverable({ id: "d1" })])
        .mockResolvedValue([]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 900, reach: 800, likeCount: 50, commentCount: 5, shareCount: 2, saveCount: 7,
        platformMediaId: "media-1", rawMetrics: { views: 900, reach: 800 }, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 900, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      await runHourlyWithFakeTimers();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(1);
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "d1" }, data: { viewCount: 900 } }),
      );
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "instagram_insights_hourly",
          status: "success",
          viewCount: 900,
          saveCount: 0,
          platformMediaId: "media-1",
          rawMetrics: { views: 900 },
        }),
      });
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledTimes(1);
    });

    it("hourly views sweep leaves everything untouched and records an unavailable hourly row when Instagram doesn't report views", async () => {
      prisma.formatDeliverable.findMany
        .mockResolvedValueOnce([trackableDeliverable({ id: "d1" })])
        .mockResolvedValue([]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        likeCount: 50, platform: "instagram",
      });

      await runHourlyWithFakeTimers();

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "instagram_insights_hourly",
          status: "unavailable",
          errorCode: "no_data",
        }),
      });
    });

    it("daily sweep writes every metric and appends one history row per deliverable", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        trackableDeliverable({ id: "d1" }),
        trackableDeliverable({ id: "d2", livePostUrl: "https://instagram.com/reel/2" }),
      ]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0, saveCount: 3,
        rawMetrics: { views: 100 }, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0,
      });

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { viewCount: 100, reach: 90, likeCount: 10, commentCount: 1, shareCount: 0 },
        }),
      );
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(2);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: "instagram_insights_daily", status: "success" }),
      });
    });

    it("skips a sweep that's triggered while the previous one of the same kind is still running", async () => {
      let release!: () => void;
      prisma.formatDeliverable.findMany.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve([]); }),
      );

      const first = service.refreshActiveDeliverableMetrics();
      await service.refreshActiveDeliverableMetrics(); // overlaps — must return without querying again
      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledTimes(1);

      release();
      await first;

      // Once the first run finishes, the next one is allowed again.
      prisma.formatDeliverable.findMany.mockResolvedValue([]);
      await service.refreshActiveDeliverableMetrics();
      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledTimes(2);
    });

    it("an hourly views sweep in progress doesn't block the daily full sweep", async () => {
      let release!: () => void;
      prisma.formatDeliverable.findMany.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve([]); }),
      );
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      const hourly = service.refreshActiveDeliverableViews();
      await service.refreshActiveDeliverableMetrics();
      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledTimes(2);

      release();
      await hourly;
    });

    it("leaves a deliverable's stored metrics untouched when Instagram returns nothing for it, while still refreshing the rest", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        trackableDeliverable({ id: "d1", viewCount: 50_000 }),
        trackableDeliverable({ id: "d2", livePostUrl: "https://instagram.com/reel/2" }),
      ]);
      instagramOAuth.getMediaInsightsForPost
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ viewCount: 70, platform: "instagram" });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d2", viewCount: 70, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });

      await runSweepWithFakeTimers();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(1);
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "d2" }, data: { viewCount: 70 } }),
      );
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledTimes(1);
    });

    it("continues the sweep past one deliverable's failure — one bad post doesn't stop the rest", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        trackableDeliverable({ id: "d1", platform: "youtube_shorts", livePostUrl: "https://youtube.com/shorts/bad" }),
        trackableDeliverable({ id: "d2" }),
      ]);
      apify.getViewCount.mockRejectedValueOnce(new Error("scrape failed"));
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({
        viewCount: 50, reach: 40, likeCount: 5, commentCount: 0, shareCount: 0, platform: "instagram",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d2", viewCount: 50, reach: 40, likeCount: 5, commentCount: 0, shareCount: 0,
      });

      await expect(runSweepWithFakeTimers()).resolves.toBeUndefined();

      // d1 (youtube, throws) never got persisted; d2 (instagram, succeeds) still did.
      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(1);
      expect(realtime.emitDeliverableMetricsUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ deliverableId: "d2" }),
      );
    });
  });

  describe("end-of-campaign final metrics fetch", () => {
    function finalCandidate(overrides: Record<string, unknown> = {}) {
      return {
        id: "d1",
        status: FormatDeliverableStatus.proof_approved,
        platform: "instagram_reel",
        livePostUrl: "https://instagram.com/reel/1",
        viewCount: 100,
        reach: 90,
        likeCount: 10,
        commentCount: 1,
        shareCount: 0,
        participation: {
          id: "part-1",
          creatorId: "creator-1",
          creatorProfileId: "profile-1",
          campaignId: "camp-1",
          campaign: { id: "camp-1", status: CampaignStatus.closed, brandProfileId: "brand-1" },
        },
        _count: { insightSnapshots: 0 },
        ...overrides,
      };
    }

    const fullInsights = {
      viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10, saveCount: 40,
      platformMediaId: "media-1",
      rawMetrics: { views: 5_000, reach: 4_000, likes: 300, comments: 20, shares: 10, saved: 40 },
      platform: "instagram" as const,
    };

    async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
      vi.useFakeTimers();
      const promise = run();
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      return result;
    }

    function liveDeliverableInCampaign() {
      return {
        id: "d1",
        status: FormatDeliverableStatus.live_submitted,
        platform: "instagram_reel",
        livePostUrl: "https://instagram.com/reel/1",
        viewCount: 0, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
        participation: {
          creatorId: "creator-1",
          creatorProfileId: "profile-1",
          campaign: {
            id: "camp-1",
            status: CampaignStatus.live,
            budgetPaise: 1_000_000,
            brandProfileId: "brand-1",
            ratePer1kPaise: 1_000,
            maxPayoutPaise: 50_000,
            newClipperIntakeStatus: NewClipperIntakeStatus.open,
            poolThresholdBps: 8000,
          },
        },
      };
    }

    it("is started in the background when the budget pool closes a campaign", async () => {
      const spy = vi.spyOn(service, "finalizeCampaignMetrics").mockResolvedValue(undefined);
      prisma.formatDeliverable.findUnique.mockResolvedValue(liveDeliverableInCampaign());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({ viewCount: 1_000, platform: "instagram" });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      prisma.$queryRaw.mockResolvedValue([{ total: 1_000_000n }]);

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("camp-1");
    });

    it("is not started while the campaign is still under budget", async () => {
      const spy = vi.spyOn(service, "finalizeCampaignMetrics").mockResolvedValue(undefined);
      prisma.formatDeliverable.findUnique.mockResolvedValue(liveDeliverableInCampaign());
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue({ viewCount: 1_000, platform: "instagram" });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 1_000, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0,
      });
      prisma.$queryRaw.mockResolvedValue([{ total: 500_000n }]);

      await service.refreshDeliverableViews("creator-1", "d1");

      expect(spy).not.toHaveBeenCalled();
    });

    it("writes every metric and one 'final' history row for each deliverable of the campaign", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([
        finalCandidate({ id: "d1" }),
        finalCandidate({ id: "d2", livePostUrl: "https://instagram.com/reel/2" }),
      ]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(fullInsights);
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10,
      });

      await withFakeTimers(() => service.finalizeCampaignMetrics("camp-1"));

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(2);
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10 },
        }),
      );
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(2);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "instagram_insights_final",
          status: "success",
          saveCount: 40,
          viewCount: 5_000,
        }),
      });
      // It never touches the campaign itself — closing is not its job.
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(realtime.emitCampaignUpdated).not.toHaveBeenCalled();
    });

    it("only asks for Instagram deliverables of that campaign that don't already have a successful final row", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await service.finalizeCampaignMetrics("camp-1");

      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            platform: { startsWith: "instagram" },
            livePostUrl: { not: null },
            participation: { campaignId: "camp-1" },
            insightSnapshots: {
              none: { source: "instagram_insights_final", status: { in: ["success", "partial"] } },
            },
          }),
        }),
      );
    });

    it("retries an empty Instagram answer — three attempts in all — and records success if a later one works", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([finalCandidate()]);
      instagramOAuth.getMediaInsightsForPost
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fullInsights);
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10,
      });

      await withFakeTimers(() => service.finalizeCampaignMetrics("camp-1"));

      expect(instagramOAuth.getMediaInsightsForPost).toHaveBeenCalledTimes(3);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: "instagram_insights_final", status: "success" }),
      });
    });

    it("after three empty answers it keeps the last known metrics and records one 'unavailable' final row", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([finalCandidate({ viewCount: 4_200, likeCount: 280 })]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(null);

      await withFakeTimers(() => service.finalizeCampaignMetrics("camp-1"));

      expect(instagramOAuth.getMediaInsightsForPost).toHaveBeenCalledTimes(3);
      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: "instagram_insights_final",
          status: "unavailable",
          errorCode: "no_data",
          viewCount: 4_200,
          likeCount: 280,
        }),
      });
    });

    it("a second call for the same campaign while the first is still running does nothing", async () => {
      let release!: () => void;
      prisma.formatDeliverable.findMany.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve([]); }),
      );

      const first = service.finalizeCampaignMetrics("camp-1");
      await service.finalizeCampaignMetrics("camp-1");
      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledTimes(1);

      release();
      await first;
    });

    it("never throws, even when the lookup itself fails", async () => {
      prisma.formatDeliverable.findMany.mockRejectedValue(new Error("db down"));

      await expect(service.finalizeCampaignMetrics("camp-1")).resolves.toBeUndefined();
    });

    it("the hourly job also finalizes closed campaigns that never got a successful final fetch", async () => {
      prisma.formatDeliverable.findMany
        .mockResolvedValueOnce([]) // the live-views sweep: nothing active
        .mockResolvedValueOnce([finalCandidate({ id: "d1" })]); // recovery
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(fullInsights);
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1", viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10,
      });

      await withFakeTimers(() => service.refreshActiveDeliverableViews());

      expect(prisma.formatDeliverable.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            participation: { campaign: { status: CampaignStatus.closed } },
          }),
        }),
      );
      expect(prisma.deliverableInsightSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: "instagram_insights_final", status: "success" }),
      });
    });

    it("recovery gives up on a deliverable after 24 failed final fetches", async () => {
      prisma.formatDeliverable.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          finalCandidate({ id: "d-tried-out", _count: { insightSnapshots: 24 } }),
          finalCandidate({ id: "d-still-trying", _count: { insightSnapshots: 23 } }),
        ]);
      instagramOAuth.getMediaInsightsForPost.mockResolvedValue(fullInsights);
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d-still-trying", viewCount: 5_000, reach: 4_000, likeCount: 300, commentCount: 20, shareCount: 10,
      });

      await withFakeTimers(() => service.refreshActiveDeliverableViews());

      expect(prisma.formatDeliverable.update).toHaveBeenCalledTimes(1);
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "d-still-trying" } }),
      );
    });

    it("recovery never throws, even when its own lookup fails", async () => {
      prisma.formatDeliverable.findMany
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("db down"));

      await expect(withFakeTimers(() => service.refreshActiveDeliverableViews())).resolves.toBeUndefined();
    });
  });

  describe("reviewDeliverable", () => {
    it("approves under_review deliverable", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.formatDeliverable.findUniqueOrThrow.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_approved,
        participationId: "part-1",
        platform: "instagram_reel",
      });

      const result = await service.reviewDeliverable(
        "brand-1",
        UserRole.brand,
        "d1",
        ReviewDeliverableAction.approve,
      );

      expect(result.status).toBe(FormatDeliverableStatus.draft_approved);
      expect(campaignAccess.assertCanAccessCampaign).toHaveBeenCalled();
      expect(realtime.emitDeliverableReviewed).toHaveBeenCalled();
    });

    it("requires rejection reason on reject", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        participation: { campaign: { id: "camp-1" } },
      });

      await expect(
        service.reviewDeliverable(
          "brand-1",
          UserRole.brand,
          "d1",
          ReviewDeliverableAction.reject,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("creates rejection history on reject", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
        participation: {
          campaign: { id: "camp-1" },
          campaignId: "camp-1",
          creatorId: "creator-1",
        },
        participationId: "part-1",
        platform: "instagram_reel",
      });
      prisma.deliverableRejectionEvent.findMany.mockResolvedValue([]);
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          deliverableRejectionEvent: { create: vi.fn() },
          formatDeliverable: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: vi.fn().mockResolvedValue({
              id: "d1",
              status: FormatDeliverableStatus.draft_rejected,
              participationId: "part-1",
              platform: "instagram_reel",
            }),
          },
        };
        return fn(tx);
      });

      const result = await service.reviewDeliverable(
        "brand-1",
        UserRole.brand,
        "d1",
        ReviewDeliverableAction.reject,
        "Wrong aspect ratio",
      );

      expect(result.status).toBe(FormatDeliverableStatus.draft_rejected);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("blocks duplicate rejection reason", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.deliverableRejectionEvent.findMany.mockResolvedValue([
        { rejectionReason: "Wrong aspect ratio" },
      ]);

      await expect(
        service.reviewDeliverable(
          "brand-1",
          UserRole.brand,
          "d1",
          ReviewDeliverableAction.reject,
          "wrong  aspect ratio",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("proof review", () => {
    function proofDeliverable(status: FormatDeliverableStatus) {
      return {
        id: "d1",
        status,
        platform: "instagram_reel",
        participationId: "part-1",
        participation: {
          id: "part-1",
          creatorId: "creator-1",
          campaignId: "camp-1",
          campaign: { id: "camp-1", title: "Camp", brandProfileId: "brand-1" },
        },
      };
    }

    it.each([
      FormatDeliverableStatus.draft_pending,
      FormatDeliverableStatus.under_review,
      FormatDeliverableStatus.draft_approved,
      FormatDeliverableStatus.proof_approved,
      FormatDeliverableStatus.proof_rejected,
    ])("refuses to reject proof that isn't awaiting review (%s)", async (status) => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(proofDeliverable(status));

      await expect(
        service.rejectProof("brand-user", UserRole.brand, "d1", "Wrong post"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.formatDeliverable.updateMany).not.toHaveBeenCalled();
    });

    it("requires a real reason to reject proof", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        proofDeliverable(FormatDeliverableStatus.proof_under_review),
      );

      await expect(
        service.rejectProof("brand-user", UserRole.brand, "d1", "   "),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects proof under review with a trimmed reason", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        proofDeliverable(FormatDeliverableStatus.proof_under_review),
      );
      prisma.formatDeliverable.findUniqueOrThrow.mockResolvedValue({
        ...proofDeliverable(FormatDeliverableStatus.proof_rejected),
      });

      const result = await service.rejectProof("brand-user", UserRole.brand, "d1", "  Wrong post  ");

      expect(prisma.formatDeliverable.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "d1", status: { in: [FormatDeliverableStatus.proof_under_review, FormatDeliverableStatus.live_submitted] } },
          data: expect.objectContaining({ rejectionReason: "Wrong post" }),
        }),
      );
      expect(result.status).toBe(FormatDeliverableStatus.proof_rejected);
    });

    it("lets only one of two simultaneous approvals through", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        proofDeliverable(FormatDeliverableStatus.proof_under_review),
      );
      prisma.formatDeliverable.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approveProof("brand-user", UserRole.brand, "d1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(realtime.emitDeliverableLiveProof).not.toHaveBeenCalled();
    });
  });

  describe("submitLiveProof link checks", () => {
    const approved = {
      id: "d1",
      platform: "instagram_reel",
      status: FormatDeliverableStatus.draft_approved,
      participation: { creatorId: "creator-1", campaign: { status: CampaignStatus.live } },
    };

    it("refuses a link from another platform", async () => {
      prisma.formatDeliverable.findFirst.mockResolvedValueOnce(approved);

      await expect(
        service.submitLiveProof("creator-1", "d1", { livePostUrl: "https://youtube.com/shorts/abc" }),
      ).rejects.toThrow(/Instagram/);
      expect(prisma.formatDeliverable.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a post already submitted elsewhere", async () => {
      prisma.formatDeliverable.findFirst
        .mockResolvedValueOnce(approved)
        .mockResolvedValueOnce({ id: "other" });

      await expect(
        service.submitLiveProof("creator-1", "d1", { livePostUrl: "https://instagram.com/reel/abc" }),
      ).rejects.toThrow(/already submitted/);
      expect(prisma.formatDeliverable.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("listDeliverablesForBrand", () => {
    it("keeps a brand's campaign page to that campaign", async () => {
      campaignAccess.getBrandProfileIdForUser.mockResolvedValue("brand-1");
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await service.listDeliverablesForBrand("brand-user", UserRole.brand, { campaignId: "camp-1" });

      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            participation: {
              campaignId: "camp-1",
              campaign: { brandProfileId: { in: ["brand-1"] } },
            },
          },
        }),
      );
    });

    it("lets an admin see one campaign without a brand filter", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await service.listDeliverablesForBrand("admin", UserRole.admin, { campaignId: "camp-1" });

      expect(prisma.formatDeliverable.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { participation: { campaignId: "camp-1" } } }),
      );
    });
  });

  describe("setAdminDraftCopy", () => {
    it("checks campaign access before saving the url", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
      });

      await service.setAdminDraftCopy(
        "brand-1",
        UserRole.brand,
        "d1",
        "https://pub-example.r2.dev/admin-draft-copies/x.mp4",
      );

      expect(campaignAccess.assertCanAccessCampaign).toHaveBeenCalled();
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "d1" },
          data: { adminUploadedDraftUrl: "https://pub-example.r2.dev/admin-draft-copies/x.mp4" },
        }),
      );
    });

    it("re-triggers the draft pipeline when the deliverable is still under_review", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.under_review,
      });

      await service.setAdminDraftCopy("brand-1", UserRole.brand, "d1", "https://example.com/x.mp4");

      expect(autoReview.runDraftPipeline).toHaveBeenCalledWith("d1");
      expect(autoReview.runProofPipeline).not.toHaveBeenCalled();
    });

    it("re-triggers the proof pipeline when the deliverable is at the proof stage", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.proof_under_review,
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.proof_under_review,
      });

      await service.setAdminDraftCopy("brand-1", UserRole.brand, "d1", "https://example.com/x.mp4");

      expect(autoReview.runProofPipeline).toHaveBeenCalledWith("d1");
      expect(autoReview.runDraftPipeline).not.toHaveBeenCalled();
    });

    it("does not re-trigger any pipeline once the deliverable is already fully reviewed", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_approved,
        participation: { campaign: { id: "camp-1" } },
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "d1",
        status: FormatDeliverableStatus.draft_approved,
      });

      await service.setAdminDraftCopy("brand-1", UserRole.brand, "d1", "https://example.com/x.mp4");

      expect(autoReview.runDraftPipeline).not.toHaveBeenCalled();
      expect(autoReview.runProofPipeline).not.toHaveBeenCalled();
    });

    it("throws when the deliverable doesn't exist", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(null);

      await expect(
        service.setAdminDraftCopy("brand-1", UserRole.brand, "missing", "https://example.com/x.mp4"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
