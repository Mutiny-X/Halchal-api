import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { CampaignStatus, FormatDeliverableStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketplaceService } from "./marketplace.service";

function makePrisma() {
  return {
    formatDeliverable: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    marketplaceRepost: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

function makeParticipation() {
  return { getParticipationByCampaign: vi.fn() };
}

function makeInstagramOAuth() {
  return { publishReel: vi.fn().mockResolvedValue({ permalink: "https://instagram.com/reel/xyz" }) };
}

function makeYoutubeOAuth() {
  return { uploadShort: vi.fn().mockResolvedValue({ permalink: "https://youtube.com/shorts/xyz" }) };
}

function makeConfig(flags: Record<string, boolean> = {}) {
  return {
    get: vi.fn((key: string) => flags[key] ?? false),
  };
}

// An uploaded draft is a file on OUR storage — the host is checked.
process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com";
const uploadedDraftUrl = "https://cdn.example.com/creator-drafts/clip.mp4";

function baseSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "source-deliverable-1",
    platform: "instagram_reel",
    draftDriveUrl: uploadedDraftUrl,
    listedInMarketplace: true,
    delistedAt: null,
    status: FormatDeliverableStatus.proof_approved,
    participation: {
      creatorId: "creator-a",
      campaign: {
        id: "campaign-1",
        title: "Campaign",
        status: CampaignStatus.live,
        maxRepostsPerClip: 5,
      },
    },
    ...overrides,
  };
}

describe("MarketplaceService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let participation: ReturnType<typeof makeParticipation>;
  let instagramOAuth: ReturnType<typeof makeInstagramOAuth>;
  let youtubeOAuth: ReturnType<typeof makeYoutubeOAuth>;
  let config: ReturnType<typeof makeConfig>;
  let service: MarketplaceService;

  beforeEach(() => {
    prisma = makePrisma();
    participation = makeParticipation();
    instagramOAuth = makeInstagramOAuth();
    youtubeOAuth = makeYoutubeOAuth();
    config = makeConfig({ INSTAGRAM_PUBLISHING_ENABLED: true, YOUTUBE_PUBLISHING_ENABLED: true });
    service = new MarketplaceService(
      prisma as never,
      participation as never,
      instagramOAuth as never,
      youtubeOAuth as never,
      config as never,
    );
  });

  describe("listBrowsableListings", () => {
    it("propagates the not-joined gate from ParticipationService", async () => {
      participation.getParticipationByCampaign.mockRejectedValue(
        new NotFoundException({ code: "NOT_FOUND", message: "Participation not found" }),
      );

      await expect(
        service.listBrowsableListings("creator-b", "campaign-1", "profile-b"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.formatDeliverable.findMany).not.toHaveBeenCalled();
    });

    it("excludes listings that already hit their repost cap", async () => {
      participation.getParticipationByCampaign.mockResolvedValue({ id: "participation-b" });
      prisma.formatDeliverable.findMany.mockResolvedValue([
        {
          id: "under-cap",
          platform: "instagram_reel",
          draftDriveUrl: uploadedDraftUrl,
          viewCount: 100,
          likeCount: 10,
          participation: {
            creator: { displayName: "A", username: null, avatarUrl: null },
            campaign: { maxRepostsPerClip: 5 },
          },
          _count: { marketplaceListingReposts: 2 },
        },
        {
          id: "at-cap",
          platform: "instagram_reel",
          draftDriveUrl: uploadedDraftUrl,
          viewCount: 100,
          likeCount: 10,
          participation: {
            creator: { displayName: "A", username: null, avatarUrl: null },
            campaign: { maxRepostsPerClip: 5 },
          },
          _count: { marketplaceListingReposts: 5 },
        },
      ]);

      const result = await service.listBrowsableListings("creator-b", "campaign-1", "profile-b");

      expect(result.map((r) => r.sourceDeliverableId)).toEqual(["under-cap"]);
    });
  });

  describe("createRepost", () => {
    it("rejects reposting your own listing", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseSource());

      await expect(
        service.createRepost("creator-a", "source-deliverable-1", "profile-a"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(instagramOAuth.publishReel).not.toHaveBeenCalled();
    });

    it("rejects a listing that isn't approved/listed/live", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        baseSource({ status: FormatDeliverableStatus.proof_under_review }),
      );

      await expect(
        service.createRepost("creator-b", "source-deliverable-1", "profile-b"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects once the repost cap is reached", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseSource());
      prisma.marketplaceRepost.count.mockResolvedValue(5);

      await expect(
        service.createRepost("creator-b", "source-deliverable-1", "profile-b"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(instagramOAuth.publishReel).not.toHaveBeenCalled();
    });

    it("rejects when the poster has no open slot for that platform", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseSource());
      participation.getParticipationByCampaign.mockResolvedValue({
        id: "participation-b",
        deliverables: [
          { id: "slot-1", platform: "instagram_reel", status: FormatDeliverableStatus.draft_approved },
        ],
      });

      await expect(
        service.createRepost("creator-b", "source-deliverable-1", "profile-b"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(instagramOAuth.publishReel).not.toHaveBeenCalled();
    });

    it("rejects when publishing is disabled for the target platform", async () => {
      config = makeConfig({ INSTAGRAM_PUBLISHING_ENABLED: false });
      service = new MarketplaceService(
        prisma as never,
        participation as never,
        instagramOAuth as never,
        youtubeOAuth as never,
        config as never,
      );
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseSource());
      participation.getParticipationByCampaign.mockResolvedValue({
        id: "participation-b",
        deliverables: [
          { id: "slot-1", platform: "instagram_reel", status: FormatDeliverableStatus.draft_pending },
        ],
      });

      await expect(
        service.createRepost("creator-b", "source-deliverable-1", "profile-b"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(instagramOAuth.publishReel).not.toHaveBeenCalled();
    });

    it("publishes and records the claim on success", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseSource());
      participation.getParticipationByCampaign.mockResolvedValue({
        id: "participation-b",
        deliverables: [
          { id: "slot-1", platform: "instagram_reel", status: FormatDeliverableStatus.draft_rejected },
        ],
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        id: "slot-1",
        status: FormatDeliverableStatus.proof_under_review,
        livePostUrl: "https://instagram.com/reel/xyz",
      });
      prisma.marketplaceRepost.create.mockResolvedValue({ id: "repost-1" });
      prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));

      const result = await service.createRepost("creator-b", "source-deliverable-1", "profile-b");

      expect(instagramOAuth.publishReel).toHaveBeenCalledWith(
        "profile-b",
        uploadedDraftUrl,
        "Campaign",
      );
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith({
        where: { id: "slot-1" },
        data: expect.objectContaining({
          livePostUrl: "https://instagram.com/reel/xyz",
          status: FormatDeliverableStatus.proof_under_review,
        }),
      });
      expect(prisma.marketplaceRepost.create).toHaveBeenCalledWith({
        data: {
          sourceDeliverableId: "source-deliverable-1",
          posterDeliverableId: "slot-1",
          posterCreatorId: "creator-b",
        },
      });
      expect(result).toEqual({
        deliverableId: "slot-1",
        status: FormatDeliverableStatus.proof_under_review,
        livePostUrl: "https://instagram.com/reel/xyz",
        repostId: "repost-1",
      });
    });
  });
});
