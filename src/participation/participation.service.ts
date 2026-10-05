import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  CampaignStatus,
  FormatDeliverableStatus,
  NewClipperIntakeStatus,
  Prisma,
  UserRole,
} from "@prisma/client";

import { ActivityLogService } from "../activity/activity-log.service";
import { AutoReviewService, MAX_STUCK_RETRIES } from "../auto-review/auto-review.service";
import { CampaignAccessService } from "../access/campaign-access.service";
import { normalizeCampaignPlatforms } from "../campaigns/campaign-platforms";
import { ApifyService, type PlatformViewResult } from "../common/apify.service";
import { getCampaignPoolUsage } from "../common/campaign-pool";
import { computeEstimatedPaise } from "../common/earnings";
import { CreatorProfilesService } from "../creator-profiles/creator-profiles.service";
import { InstagramOAuthService } from "../creator-profiles/instagram-oauth.service";
import { InAppNotificationService } from "../notifications/in-app-notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { FILLABLE_DELIVERABLE_STATUSES } from "./deliverable-status";
import { DRAFT_URL_MESSAGE, isUploadedFileUrl, isValidDraftUrl } from "./drive-url";
import { ReviewDeliverableAction } from "./dto/review-deliverable.dto";
import type { SubmitDraftDto } from "./dto/submit-draft.dto";
import type { SubmitLiveProofDto } from "./dto/submit-live-proof.dto";
import {
  computeParticipationSummary,
  isParticipationCompleted,
} from "./participation-summary";
import {
  isDuplicateRejectionReason,
  REJECTION_HISTORY_LIMIT,
} from "./rejection-reason";

function formatPlatform(platform: string): string {
  const labels: Record<string, string> = {
    instagram_reel: "Instagram Reel",
    instagram_reels: "Instagram Reel",
    instagram_post: "Instagram Post",
    youtube_shorts: "YouTube Shorts",
    twitter_tweet: "Twitter / X",
  };
  return labels[platform] ?? platform.replace(/_/g, " ");
}

const rejectionEventsInclude = {
  orderBy: { rejectedAt: "desc" as const },
  take: REJECTION_HISTORY_LIMIT,
  include: {
    reviewedBy: { select: { displayName: true } },
  },
} satisfies Prisma.DeliverableRejectionEventFindManyArgs;

const participationInclude = {
  campaign: {
    select: {
      id: true,
      title: true,
      status: true,
      platforms: true,
      platform: true,
      ratePer1kPaise: true,
      maxPayoutPaise: true,
      coverImageUrl: true,
      brandProfile: { select: { companyName: true, logoUrl: true } },
    },
  },
  creatorProfile: {
    select: { id: true, platform: true, handle: true, label: true, avatarUrl: true },
  },
  deliverables: {
    orderBy: { platform: "asc" as const },
    include: {
      rejectionEvents: rejectionEventsInclude,
    },
  },
} satisfies Prisma.CampaignParticipationInclude;

type ParticipationWithRelations = Prisma.CampaignParticipationGetPayload<{
  include: typeof participationInclude;
}>;

@Injectable()
export class ParticipationService {
  private readonly logger = new Logger(ParticipationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignAccess: CampaignAccessService,
    private readonly realtime: RealtimeService,
    private readonly apify: ApifyService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: InAppNotificationService,
    private readonly creatorProfiles: CreatorProfilesService,
    private readonly autoReview: AutoReviewService,
    private readonly instagramOAuth: InstagramOAuthService,
  ) {}

  private deliverableEventPayload(
    deliverable: {
      id: string;
      platform: string;
      status: FormatDeliverableStatus;
      participationId: string;
    },
    participation: {
      creatorId: string;
      campaignId: string;
      campaign: { brandProfileId: string | null };
    },
  ) {
    return {
      deliverableId: deliverable.id,
      participationId: deliverable.participationId,
      campaignId: participation.campaignId,
      creatorId: participation.creatorId,
      brandProfileId: participation.campaign.brandProfileId,
      platform: deliverable.platform,
      status: deliverable.status,
    };
  }

  private formatRejectionHistory(
    events: Array<{
      id: string;
      rejectionReason: string;
      draftDriveUrl: string;
      rejectedAt: Date;
      reviewedBy: { displayName: string | null } | null;
    }>,
  ) {
    return events.map((e) => ({
      id: e.id,
      rejectionReason: e.rejectionReason,
      draftDriveUrl: e.draftDriveUrl,
      rejectedAt: e.rejectedAt.toISOString(),
      reviewedByDisplayName: e.reviewedBy?.displayName ?? null,
    }));
  }

  private formatDeliverable(
    d: ParticipationWithRelations["deliverables"][0],
    campaign?: { ratePer1kPaise: number; maxPayoutPaise: number },
  ) {
    const ratePer1kPaise = campaign?.ratePer1kPaise ?? 0;
    const estimatedPaise = ratePer1kPaise > 0
      ? Math.min(
          Math.floor((d.viewCount / 1000) * ratePer1kPaise),
          campaign?.maxPayoutPaise ?? Infinity,
        )
      : 0;

    return {
      id: d.id,
      platform: d.platform,
      status: d.status,
      draftDriveUrl: d.draftDriveUrl,
      livePostUrl: d.livePostUrl,
      rejectionReason: d.rejectionReason,
      draftSubmittedAt: d.draftSubmittedAt?.toISOString() ?? null,
      draftReviewedAt: d.draftReviewedAt?.toISOString() ?? null,
      liveSubmittedAt: d.liveSubmittedAt?.toISOString() ?? null,
      proofReviewedAt: d.proofReviewedAt?.toISOString() ?? null,
      viewCount: d.viewCount,
      reach: d.reach,
      likeCount: d.likeCount,
      commentCount: d.commentCount,
      shareCount: d.shareCount,
      estimatedPaise,
      ratePer1kPaise,
      paidAt: d.paidAt?.toISOString() ?? null,
      paidAmountPaise: d.paidAmountPaise,
      rejectionHistory: this.formatRejectionHistory(d.rejectionEvents),
    };
  }

  private formatParticipation(participation: ParticipationWithRelations) {
    const summary = computeParticipationSummary(
      participation.deliverables,
      participation.campaign.status,
    );
    return {
      id: participation.id,
      campaignId: participation.campaignId,
      joinedAt: participation.joinedAt.toISOString(),
      platformsSnapshot: participation.platformsSnapshot,
      summary,
      creatorProfile: {
        id: participation.creatorProfile.id,
        platform: participation.creatorProfile.platform,
        handle: participation.creatorProfile.handle,
        label: participation.creatorProfile.label,
        avatarUrl: participation.creatorProfile.avatarUrl,
      },
      campaign: {
        id: participation.campaign.id,
        title: participation.campaign.title,
        status: participation.campaign.status,
        platforms: normalizeCampaignPlatforms(
          participation.campaign.platforms,
          participation.campaign.platform,
        ),
        brandCompanyName:
          participation.campaign.brandProfile?.companyName ?? null,
        brandLogoUrl: participation.campaign.brandProfile?.logoUrl ?? null,
        coverImageUrl: participation.campaign.coverImageUrl ?? null,
        ratePer1kDisplay: `₹${participation.campaign.ratePer1kPaise / 100} / 1K views`,
        ratePer1kPaise: participation.campaign.ratePer1kPaise,
        maxPayoutPaise: participation.campaign.maxPayoutPaise,
      },
      deliverables: participation.deliverables.map((d) =>
        this.formatDeliverable(d, participation.campaign),
      ),
    };
  }

  private async loadParticipation(
    where: Prisma.CampaignParticipationWhereInput,
  ): Promise<ParticipationWithRelations> {
    const participation = await this.prisma.campaignParticipation.findFirst({
      where,
      include: participationInclude,
    });
    if (!participation) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Participation not found",
      });
    }
    return participation;
  }

  private assertCampaignOpenForCreator(campaignStatus: CampaignStatus) {
    if (campaignStatus !== CampaignStatus.live) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Campaign is not open for submissions",
      });
    }
  }

  async joinCampaign(
    creatorId: string,
    campaignId: string,
    creatorProfileId: string,
  ) {
    await this.creatorProfiles.assertOwnership(creatorId, creatorProfileId);

    // A creator who earns from this campaign but never added bank details
    // (or added them before PAN became mandatory there) has no way to get
    // paid out, and no PAN on file for TDS/tax reporting — better to block
    // the join up front than let them submit work and only discover this
    // at withdrawal time.
    const bankMethod = await this.prisma.payoutMethod.findFirst({
      where: { userId: creatorId, type: "bank" },
    });
    if (!bankMethod || !bankMethod.panNumber) {
      throw new BadRequestException({
        code: "BANK_DETAILS_REQUIRED",
        message: "Add your bank details (including PAN) before joining a campaign.",
      });
    }

    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId },
    });
    if (!campaign || campaign.status !== CampaignStatus.live) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not available",
      });
    }

    const existing = await this.prisma.campaignParticipation.findUnique({
      where: {
        campaignId_creatorProfileId: { campaignId, creatorProfileId },
      },
      include: participationInclude,
    });
    if (existing) {
      throw new ConflictException({
        code: "ALREADY_JOINED",
        message: "This profile already joined this campaign",
        details: { participation: this.formatParticipation(existing) },
      });
    }

    // The stored intake status only flips reactively — normally when a
    // deliverable's views get refreshed (see _evaluateCampaignPoolThresholds)
    // — so a campaign that crossed the 80% pool threshold with no recent
    // view refresh would still read "open" here and let new clippers in
    // past the cutoff. Re-evaluate against live pool usage on every join
    // attempt so the gate can't go stale.
    const poolState = await this._evaluateCampaignPoolThresholds(campaign);
    const intakeStatus = poolState.newClipperIntakeStatus;
    if (intakeStatus !== campaign.newClipperIntakeStatus || poolState.paused) {
      this.realtime.emitCampaignUpdated({
        id: campaign.id,
        brandProfileId: campaign.brandProfileId,
        ...(poolState.paused ? { status: CampaignStatus.paused } : {}),
        newClipperIntakeStatus: intakeStatus,
        poolUtilizationBps: poolState.utilizationBps,
      });
    }
    if (poolState.paused) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not available",
      });
    }

    if (intakeStatus === NewClipperIntakeStatus.closed_at_threshold) {
      throw new BadRequestException({
        code: "INTAKE_CLOSED",
        message: "This campaign's budget pool is nearly full and isn't accepting new clippers right now.",
      });
    }

    if (intakeStatus === NewClipperIntakeStatus.manually_extended) {
      // Atomic: only succeeds if the allowance is still > 0, so two creators
      // joining at the same instant can't both consume the last slot.
      const consumed = await this.prisma.campaign.updateMany({
        where: { id: campaignId, extraClipperAllowance: { gt: 0 } },
        data: { extraClipperAllowance: { decrement: 1 } },
      });
      if (consumed.count === 0) {
        throw new BadRequestException({
          code: "INTAKE_CLOSED",
          message: "This campaign's budget pool is nearly full and isn't accepting new clippers right now.",
        });
      }
      const remaining = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { extraClipperAllowance: true },
      });
      if ((remaining?.extraClipperAllowance ?? 0) <= 0) {
        await this.prisma.campaign.update({
          where: { id: campaignId },
          data: { newClipperIntakeStatus: NewClipperIntakeStatus.closed_at_threshold },
        });
      }
    }

    const platforms = normalizeCampaignPlatforms(
      campaign.platforms,
      campaign.platform,
    );

    const participation = await this.prisma.campaignParticipation.create({
      data: {
        campaignId,
        creatorId,
        creatorProfileId,
        platformsSnapshot: platforms,
        deliverables: {
          create: platforms.map((platform) => ({
            platform,
            status: FormatDeliverableStatus.draft_pending,
          })),
        },
      },
      include: participationInclude,
    });

    this.realtime.emitParticipationJoined({
      participationId: participation.id,
      campaignId,
      creatorId,
      brandProfileId: campaign.brandProfileId,
    });

    return this.formatParticipation(participation);
  }

  async getParticipationByCampaign(
    creatorId: string,
    campaignId: string,
    creatorProfileId: string,
  ) {
    const participation = await this.loadParticipation({
      campaignId,
      creatorId,
      creatorProfileId,
    });
    return this.formatParticipation(participation);
  }

  async submitDraft(
    creatorId: string,
    deliverableId: string,
    dto: SubmitDraftDto,
  ) {
    const deliverable = await this.prisma.formatDeliverable.findFirst({
      where: { id: deliverableId },
      include: {
        rejectionEvents: {
          orderBy: { rejectedAt: "desc" },
          take: 1,
        },
        participation: {
          include: { campaign: true },
        },
      },
    });

    if (!deliverable || deliverable.participation.creatorId !== creatorId) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Deliverable not found",
      });
    }

    this.assertCampaignOpenForCreator(
      deliverable.participation.campaign.status,
    );

    if (!FILLABLE_DELIVERABLE_STATUSES.includes(deliverable.status)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "This format cannot accept a new draft right now",
      });
    }

    if (!isValidDraftUrl(dto.draftDriveUrl)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: DRAFT_URL_MESSAGE,
      });
    }

    const trimmedUrl = dto.draftDriveUrl.trim();

    if (dto.listedInMarketplace && !isUploadedFileUrl(trimmedUrl)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message:
          "Listing in the marketplace needs your draft uploaded through the app, not a Google Drive link.",
      });
    }

    const lastRejected = deliverable.rejectionEvents[0];
    if (
      deliverable.status === FormatDeliverableStatus.draft_rejected &&
      lastRejected &&
      lastRejected.draftDriveUrl.trim() === trimmedUrl
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message:
          "This Drive link was already rejected. Upload an updated creative or use a new link.",
      });
    }

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: {
        draftDriveUrl: trimmedUrl,
        status: FormatDeliverableStatus.under_review,
        rejectionReason: null,
        draftSubmittedAt: new Date(),
        listedInMarketplace: dto.listedInMarketplace ?? false,
      },
    });

    this.realtime.emitDeliverableSubmitted(
      this.deliverableEventPayload(updated, deliverable.participation),
    );

    // Shadow-mode automated review — fire-and-forget, never awaited. Never
    // changes this response, the deliverable's status, or the human review
    // flow below; it only ever produces a logged AutoReviewResult row.
    void this.autoReview.runDraftPipeline(updated.id);

    return {
      id: updated.id,
      status: updated.status,
      draftDriveUrl: updated.draftDriveUrl,
    };
  }

  async submitLiveProof(
    creatorId: string,
    deliverableId: string,
    dto: SubmitLiveProofDto,
  ) {
    const deliverable = await this.prisma.formatDeliverable.findFirst({
      where: { id: deliverableId },
      include: {
        participation: {
          include: { campaign: true },
        },
      },
    });

    if (!deliverable || deliverable.participation.creatorId !== creatorId) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Deliverable not found",
      });
    }

    this.assertCampaignOpenForCreator(
      deliverable.participation.campaign.status,
    );

    const proofFillableStatuses: FormatDeliverableStatus[] = [
      FormatDeliverableStatus.draft_approved,
      FormatDeliverableStatus.proof_rejected,
    ];
    if (!proofFillableStatuses.includes(deliverable.status)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Live proof can only be submitted after draft approval",
      });
    }

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: {
        livePostUrl: dto.livePostUrl.trim(),
        status: FormatDeliverableStatus.proof_under_review,
        liveSubmittedAt: new Date(),
        rejectionReason: null,
      },
    });

    this.realtime.emitDeliverableLiveProof(
      this.deliverableEventPayload(updated, deliverable.participation),
    );

    // Shadow-mode automated review — fire-and-forget, never awaited. Never
    // changes this response, the deliverable's status, or the human review
    // flow below; it only ever produces a logged AutoReviewResult row.
    void this.autoReview.runProofPipeline(updated.id);

    return {
      id: updated.id,
      status: updated.status,
      livePostUrl: updated.livePostUrl,
    };
  }

  async listForCreator(
    creatorId: string,
    tab: "active" | "completed" = "active",
    creatorProfileId?: string,
  ) {
    const participations = await this.prisma.campaignParticipation.findMany({
      where: { creatorId, ...(creatorProfileId ? { creatorProfileId } : {}) },
      include: participationInclude,
      orderBy: { joinedAt: "desc" },
    });

    return participations
      .map((p) => this.formatParticipation(p))
      .filter((p) => {
        const completed = isParticipationCompleted(p.summary);
        return tab === "completed" ? completed : !completed;
      })
      .map((p) => ({
        id: p.id,
        summary: p.summary,
        campaignId: p.campaignId,
        campaignTitle: p.campaign.title,
        brandCompanyName: p.campaign.brandCompanyName,
        brandLogoUrl: p.campaign.brandLogoUrl,
        coverImageUrl: p.campaign.coverImageUrl,
        platforms: p.campaign.platforms,
        joinedAt: p.joinedAt,
        creatorProfile: p.creatorProfile,
        deliverables: p.deliverables.map((d) => ({
          id: d.id,
          platform: d.platform,
          status: d.status,
          priorRejectionCount: d.rejectionHistory.length,
        })),
      }));
  }

  async getForCreator(creatorId: string, participationId: string) {
    const participation = await this.loadParticipation({
      id: participationId,
      creatorId,
    });
    return this.formatParticipation(participation);
  }

  private async resolveBrandProfileIds(
    userId: string,
    role: UserRole,
  ): Promise<string[] | null> {
    if (role === UserRole.admin) {
      return null;
    }
    if (role === UserRole.staff) {
      const assignments = await this.prisma.staffBrandAssignment.findMany({
        where: { staffUserId: userId },
        select: { brandProfileId: true },
      });
      return assignments.map((a) => a.brandProfileId);
    }
    const brandProfileId =
      await this.campaignAccess.getBrandProfileIdForUser(userId);
    return brandProfileId ? [brandProfileId] : [];
  }

  /** Public, unauthenticated read-only deliverables list for a campaign's share link. No phone numbers, no rate/budget fields. */
  async getPublicDeliverables(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign || campaign.status === CampaignStatus.draft) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not available",
      });
    }

    const deliverables = await this.prisma.formatDeliverable.findMany({
      where: { participation: { campaignId } },
      include: {
        _count: { select: { rejectionEvents: true } },
        participation: {
          include: {
            creator: { select: { id: true, displayName: true, username: true } },
            deliverables: {
              select: { id: true, platform: true, status: true },
              orderBy: { platform: "asc" },
            },
          },
        },
      },
      orderBy: { draftSubmittedAt: "desc" },
    });

    return deliverables.map((d) => {
      const estimatedPaise = campaign.ratePer1kPaise > 0
        ? Math.min(Math.floor((d.viewCount / 1000) * campaign.ratePer1kPaise), campaign.maxPayoutPaise)
        : 0;
      return {
        id: d.id,
        platform: d.platform,
        status: d.status,
        draftDriveUrl: d.draftDriveUrl,
        livePostUrl: d.livePostUrl,
        rejectionReason: d.rejectionReason,
        draftSubmittedAt: d.draftSubmittedAt?.toISOString() ?? null,
        participationId: d.participationId,
        joinedAt: d.participation.joinedAt.toISOString(),
        creatorName:
          d.participation.creator.displayName ??
          d.participation.creator.username ??
          "Creator",
        priorRejectionCount: d._count.rejectionEvents,
        viewCount: d.viewCount,
        likeCount: d.likeCount,
        commentCount: d.commentCount,
        shareCount: d.shareCount,
        estimatedPaise,
        siblingDeliverables: d.participation.deliverables.map((s) => ({
          id: s.id,
          platform: s.platform,
          status: s.status,
        })),
      };
    });
  }

  async listDeliverablesForBrand(
    userId: string,
    role: UserRole,
    filters?: { status?: FormatDeliverableStatus; campaignId?: string },
  ) {
    const brandProfileIds = await this.resolveBrandProfileIds(userId, role);
    if (brandProfileIds && brandProfileIds.length === 0) {
      return [];
    }

    // When fetching by campaignId with no explicit status, return all statuses.
    // Otherwise default to under_review for the global submissions list.
    const statusFilter =
      filters?.status
        ? { status: filters.status }
        : filters?.campaignId
          ? {}
          : { status: FormatDeliverableStatus.under_review };

    const deliverables = await this.prisma.formatDeliverable.findMany({
      where: {
        ...statusFilter,
        ...(filters?.campaignId
          ? {
              participation: { campaignId: filters.campaignId },
            }
          : {}),
        ...(brandProfileIds
          ? {
              participation: {
                campaign: { brandProfileId: { in: brandProfileIds } },
              },
            }
          : {}),
      },
      include: {
        _count: { select: { rejectionEvents: true } },
        participation: {
          include: {
            campaign: { select: { id: true, title: true, ratePer1kPaise: true, maxPayoutPaise: true } },
            creator: {
              select: { id: true, displayName: true, username: true },
            },
            creatorProfile: {
              select: { id: true, platform: true, handle: true, label: true, avatarUrl: true },
            },
            deliverables: {
              select: { id: true, platform: true, status: true },
              orderBy: { platform: "asc" },
            },
          },
        },
      },
      orderBy: { draftSubmittedAt: "desc" },
      take: 100,
    });

    return deliverables.map((d) => {
      const ratePer1kPaise = d.participation.campaign.ratePer1kPaise;
      const estimatedPaise = ratePer1kPaise > 0
        ? Math.min(
            Math.floor((d.viewCount / 1000) * ratePer1kPaise),
            d.participation.campaign.maxPayoutPaise,
          )
        : 0;
      return {
      id: d.id,
      platform: d.platform,
      status: d.status,
      draftDriveUrl: d.draftDriveUrl,
      draftSubmittedAt: d.draftSubmittedAt?.toISOString() ?? null,
      campaignId: d.participation.campaign.id,
      campaignTitle: d.participation.campaign.title,
      participationId: d.participationId,
      joinedAt: d.participation.joinedAt.toISOString(),
      creatorId: d.participation.creator.id,
      creatorName:
        d.participation.creator.displayName ??
        d.participation.creator.username ??
        "Creator",
      creatorProfile: {
        id: d.participation.creatorProfile.id,
        platform: d.participation.creatorProfile.platform,
        handle: d.participation.creatorProfile.handle,
        label: d.participation.creatorProfile.label,
        avatarUrl: d.participation.creatorProfile.avatarUrl,
      },
      priorRejectionCount: d._count.rejectionEvents,
      viewCount: d.viewCount,
      likeCount: d.likeCount,
      commentCount: d.commentCount,
      shareCount: d.shareCount,
      estimatedPaise,
      siblingDeliverables: d.participation.deliverables.map((s) => ({
        id: s.id,
        platform: s.platform,
        status: s.status,
      })),
      };
    });
  }

  async getDeliverableForBrand(
    userId: string,
    role: UserRole,
    deliverableId: string,
  ) {
    const deliverable = await this.prisma.formatDeliverable.findFirst({
      where: { id: deliverableId },
      include: {
        rejectionEvents: rejectionEventsInclude,
        autoReviewResults: { orderBy: { createdAt: "desc" } },
        participation: {
          include: {
            campaign: true,
            creator: {
              select: {
                id: true,
                displayName: true,
                username: true,
                phone: true,
              },
            },
            creatorProfile: {
              select: { id: true, platform: true, handle: true, label: true, avatarUrl: true },
            },
            deliverables: { orderBy: { platform: "asc" } },
          },
        },
      },
    });

    if (!deliverable) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Deliverable not found",
      });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
    );

    return {
      id: deliverable.id,
      platform: deliverable.platform,
      status: deliverable.status,
      draftDriveUrl: deliverable.draftDriveUrl,
      adminUploadedDraftUrl: deliverable.adminUploadedDraftUrl,
      livePostUrl: deliverable.livePostUrl,
      rejectionReason: deliverable.rejectionReason,
      draftSubmittedAt: deliverable.draftSubmittedAt?.toISOString() ?? null,
      draftReviewedAt: deliverable.draftReviewedAt?.toISOString() ?? null,
      liveSubmittedAt: deliverable.liveSubmittedAt?.toISOString() ?? null,
      proofReviewedAt: deliverable.proofReviewedAt?.toISOString() ?? null,
      participationId: deliverable.participationId,
      rejectionHistory: this.formatRejectionHistory(
        deliverable.rejectionEvents,
      ),
      campaign: {
        id: deliverable.participation.campaign.id,
        title: deliverable.participation.campaign.title,
        status: deliverable.participation.campaign.status,
        ratePer1kDisplay: `₹${deliverable.participation.campaign.ratePer1kPaise / 100} / 1K views`,
        budgetPaise: deliverable.participation.campaign.budgetPaise,
      },
      viewCount: deliverable.viewCount,
      likeCount: deliverable.likeCount,
      commentCount: deliverable.commentCount,
      shareCount: deliverable.shareCount,
      estimatedPaise: computeEstimatedPaise(
        deliverable.viewCount,
        deliverable.participation.campaign.ratePer1kPaise,
        deliverable.participation.campaign.maxPayoutPaise,
      ),
      creator: deliverable.participation.creator,
      creatorProfile: {
        id: deliverable.participation.creatorProfile.id,
        platform: deliverable.participation.creatorProfile.platform,
        handle: deliverable.participation.creatorProfile.handle,
        label: deliverable.participation.creatorProfile.label,
        avatarUrl: deliverable.participation.creatorProfile.avatarUrl,
      },
      siblingDeliverables: deliverable.participation.deliverables.map((s) => ({
        id: s.id,
        platform: s.platform,
        status: s.status,
        draftDriveUrl: s.draftDriveUrl,
        rejectionReason: s.rejectionReason,
      })),
      // Shadow-mode auto-review history — most recent first, one row per
      // pipeline run (draft submit, proof submit, or a resubmit of either).
      // Purely informational: never drives status, only what a human sees
      // alongside their own review. Empty when AUTO_REVIEW_ENABLED is off,
      // or before the first submission's pipeline run has finished.
      autoReview: deliverable.autoReviewResults.map((r) => ({
        id: r.id,
        stage: r.stage,
        decision: r.decision,
        tier1Results: r.tier1Results,
        tier2Results: r.tier2Results,
        modelVersion: r.modelVersion,
        createdAt: r.createdAt.toISOString(),
      })),
      // Lets the client tell "still retrying" apart from "gave up" — the
      // catch-up sweep stops once a stage's attempt count reaches this, so a
      // needs_review result short of it is still actively being worked, not
      // stalled.
      autoReviewMaxRetries: MAX_STUCK_RETRIES,
    };
  }

  async reviewDeliverable(
    userId: string,
    role: UserRole,
    deliverableId: string,
    action: ReviewDeliverableAction,
    rejectionReason?: string,
  ) {
    const deliverable = await this.prisma.formatDeliverable.findFirst({
      where: { id: deliverableId },
      include: {
        participation: { include: { campaign: true } },
      },
    });

    if (!deliverable) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Deliverable not found",
      });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
      { requireWrite: true },
    );

    if (deliverable.status !== FormatDeliverableStatus.under_review) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Deliverable is not in a reviewable state",
      });
    }

    if (action === ReviewDeliverableAction.approve) {
      const updated = await this.prisma.formatDeliverable.update({
        where: { id: deliverableId },
        data: {
          status: FormatDeliverableStatus.draft_approved,
          draftReviewedAt: new Date(),
          reviewedByUserId: userId,
          rejectionReason: null,
        },
      });
      this.realtime.emitDeliverableReviewed(
        this.deliverableEventPayload(updated, deliverable.participation),
      );
      await this.activityLog.log(userId, "submission.approved", {
        targetType: "FormatDeliverable",
        targetId: updated.id,
        brandProfileId: deliverable.participation.campaign.brandProfileId ?? undefined,
        metadata: { campaignTitle: deliverable.participation.campaign.title, platform: updated.platform },
      });
      await this.notifications.create(deliverable.participation.creatorId, "creator", {
        type: "draft_approved",
        title: "Draft approved 🎉",
        body: `Your ${formatPlatform(updated.platform)} draft for ${deliverable.participation.campaign.title} was approved. Post it live and submit the link to get paid.`,
        link: `/participations/${deliverable.participation.id}`,
        sendWhatsapp: true,
      });
      return { id: updated.id, status: updated.status };
    }

    if (!rejectionReason?.trim()) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "rejectionReason required when rejecting",
      });
    }

    const trimmedReason = rejectionReason.trim();
    const priorEvents = await this.prisma.deliverableRejectionEvent.findMany({
      where: { deliverableId },
      select: { rejectionReason: true },
    });

    if (
      isDuplicateRejectionReason(
        trimmedReason,
        priorEvents.map((e) => e.rejectionReason),
      )
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message:
          "This rejection reason was already used for this format. Update your feedback or approve if the issue is resolved.",
      });
    }

    const draftDriveUrl = deliverable.draftDriveUrl?.trim() ?? "";
    const reviewedAt = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.deliverableRejectionEvent.create({
        data: {
          deliverableId,
          draftDriveUrl,
          rejectionReason: trimmedReason,
          reviewedByUserId: userId,
        },
      });

      return tx.formatDeliverable.update({
        where: { id: deliverableId },
        data: {
          status: FormatDeliverableStatus.draft_rejected,
          rejectionReason: trimmedReason,
          draftReviewedAt: reviewedAt,
          reviewedByUserId: userId,
        },
      });
    });

    this.realtime.emitDeliverableReviewed(
      this.deliverableEventPayload(updated, deliverable.participation),
    );
    await this.activityLog.log(userId, "submission.rejected", {
      targetType: "FormatDeliverable",
      targetId: updated.id,
      brandProfileId: deliverable.participation.campaign.brandProfileId ?? undefined,
      metadata: { campaignTitle: deliverable.participation.campaign.title, platform: updated.platform, reason: trimmedReason },
    });
    await this.notifications.create(deliverable.participation.creatorId, "creator", {
      type: "draft_rejected",
      title: "Draft needs changes",
      // Full reason stays on rejectionReason, shown once the app is opened
      // — push/WhatsApp/the notification list just need to flag it.
      body: `Your ${formatPlatform(updated.platform)} draft for ${deliverable.participation.campaign.title} needs changes. Open the app to see what needs fixing.`,
      // No "open the app" — the WhatsApp template already appends that.
      whatsappBody: `Your ${formatPlatform(updated.platform)} draft for ${deliverable.participation.campaign.title} needs changes.`,
      link: `/participations/${deliverable.participation.id}`,
      sendWhatsapp: true,
    });
    return { id: updated.id, status: updated.status };
  }

  /** Lets a brand/admin/staff reviewer attach their own copy of a Drive-linked
   * draft — the auto-review pipeline can't fetch Drive links itself (needs
   * OAuth/service-account access, and larger files return an HTML
   * virus-scan interstitial instead of raw bytes for a plain fetch). This
   * doesn't touch draftDriveUrl, which stays the creator's actual submission
   * record — it only gives the pipeline something fetchable to check
   * against. Re-triggers the pipeline immediately if the deliverable is
   * still awaiting review, fire-and-forget, same as a real submission. */
  async setAdminDraftCopy(
    userId: string,
    role: UserRole,
    deliverableId: string,
    url: string,
  ): Promise<{ id: string; adminUploadedDraftUrl: string }> {
    const deliverable = await this.prisma.formatDeliverable.findUnique({
      where: { id: deliverableId },
      include: { participation: { include: { campaign: true } } },
    });
    if (!deliverable) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
      { requireWrite: true },
    );

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: { adminUploadedDraftUrl: url },
    });

    if (updated.status === FormatDeliverableStatus.under_review) {
      void this.autoReview.runDraftPipeline(updated.id);
    } else if (
      updated.status === FormatDeliverableStatus.proof_under_review ||
      updated.status === FormatDeliverableStatus.live_submitted
    ) {
      void this.autoReview.runProofPipeline(updated.id);
    }

    return { id: updated.id, adminUploadedDraftUrl: url };
  }

  async countUnderReviewForCreator(creatorId: string, creatorProfileId?: string): Promise<number> {
    return this.prisma.formatDeliverable.count({
      where: {
        status: FormatDeliverableStatus.under_review,
        participation: { creatorId, ...(creatorProfileId ? { creatorProfileId } : {}) },
      },
    });
  }

  async getLeaderboard(
    campaignId: string,
    currentCreatorProfileId?: string,
    limit = 20,
  ) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { ratePer1kPaise: true, maxPayoutPaise: true },
    });
    if (!campaign) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Campaign not found" });
    }

    const participations = await this.prisma.campaignParticipation.findMany({
      where: { campaignId, creator: { isActive: true } },
      include: {
        creator: {
          select: { id: true, displayName: true, username: true, avatarUrl: true, verifiedCreatorId: true },
        },
        creatorProfile: {
          select: { id: true, platform: true, handle: true, label: true },
        },
        // Only proof_approved counts toward a rank — a rejected or
        // still-pending submission's views/estimated-earnings shouldn't
        // inflate a creator's total, since it's exactly what
        // AdminService.payoutCampaign itself gates real payouts on.
        // Confirmed live: without this, a creator's total included
        // rejected/unreviewed deliverables identically to approved ones.
        deliverables: {
          where: { status: FormatDeliverableStatus.proof_approved },
          select: { viewCount: true, paidAmountPaise: true },
        },
      },
    });

    // Each linked profile competes independently, so the same person can
    // appear more than once here (once per profile that joined).
    const entries = participations.map((p) => {
      const totalViews = p.deliverables.reduce((sum, d) => sum + d.viewCount, 0);
      const totalEarnedPaise = p.deliverables.reduce(
        (sum, d) =>
          sum +
          (d.paidAmountPaise ??
            computeEstimatedPaise(d.viewCount, campaign.ratePer1kPaise, campaign.maxPayoutPaise)),
        0,
      );
      return {
        creatorId: p.creator.id,
        creatorProfileId: p.creatorProfile.id,
        // Same real-name-exposure fix as getOverallLeaderboard — see there
        // for why. p.creatorProfile.label is a brand-facing nickname, not
        // relevant to this concern, so it still wins when set.
        displayName:
          p.creatorProfile.label ??
          (p.creator.verifiedCreatorId
            ? `#${p.creator.verifiedCreatorId}`
            : (p.creator.displayName ?? p.creator.username ?? "Creator")),
        handle: p.creatorProfile.handle,
        platform: p.creatorProfile.platform,
        avatarUrl: p.creator.avatarUrl,
        totalViews,
        totalEarnedPaise,
      };
    });

    // Rank reflects what a creator actually earned, not raw reach — the ₹
    // amount shown next to each entry needs to match the order it's shown
    // in. Views is only a tiebreak for two creators earning the same amount.
    entries.sort((a, b) => b.totalEarnedPaise - a.totalEarnedPaise || b.totalViews - a.totalViews);
    const ranked = entries.map((e, i) => ({ ...e, rank: i + 1 }));
    const currentUser = currentCreatorProfileId
      ? ranked.find((e) => e.creatorProfileId === currentCreatorProfileId) ?? null
      : null;

    return {
      campaignId,
      totalParticipants: ranked.length,
      entries: ranked.slice(0, limit),
      currentUser,
    };
  }

  async getOverallLeaderboard(currentUserId: string, limit = 20) {
    // Excludes soft-deleted creators (isActive: false) — their displayName
    // is scrubbed to "deleted_<id>" on deletion (see UsersService.deleteMe),
    // and without this filter that placeholder name shows up ranked
    // alongside real, active creators. Also excludes not-yet-verified
    // creators entirely — this overall leaderboard is public-facing across
    // every campaign, and an unverified creator has no anonymous id to show
    // in place of their real name here.
    const participations = await this.prisma.campaignParticipation.findMany({
      where: { creator: { isActive: true, verifiedCreatorId: { not: null } } },
      include: {
        creator: {
          select: { id: true, displayName: true, username: true, avatarUrl: true, verifiedCreatorId: true },
        },
        campaign: { select: { ratePer1kPaise: true, maxPayoutPaise: true } },
        // Only proof_approved counts toward a rank — see getLeaderboard for
        // why (matches what AdminService.payoutCampaign actually pays out).
        deliverables: {
          where: { status: FormatDeliverableStatus.proof_approved },
          select: { viewCount: true, paidAmountPaise: true },
        },
      },
    });

    const byCreator = new Map<
      string,
      {
        creatorId: string;
        displayName: string;
        avatarUrl: string | null;
        totalViews: number;
        totalEarnedPaise: number;
      }
    >();

    for (const p of participations) {
      const totalViews = p.deliverables.reduce((sum, d) => sum + d.viewCount, 0);
      const totalEarnedPaise = p.deliverables.reduce(
        (sum, d) =>
          sum +
          (d.paidAmountPaise ??
            computeEstimatedPaise(
              d.viewCount,
              p.campaign.ratePer1kPaise,
              p.campaign.maxPayoutPaise,
            )),
        0,
      );

      const existing = byCreator.get(p.creatorId);
      if (existing) {
        existing.totalViews += totalViews;
        existing.totalEarnedPaise += totalEarnedPaise;
      } else {
        byCreator.set(p.creatorId, {
          creatorId: p.creator.id,
          // Every creator reaching this point is verified (see the query's
          // where clause above) and so always has a verifiedCreatorId — the
          // real-name fallback here is defensive, not an expected path.
          displayName: p.creator.verifiedCreatorId
            ? `#${p.creator.verifiedCreatorId}`
            : (p.creator.displayName ?? p.creator.username ?? "Creator"),
          avatarUrl: p.creator.avatarUrl,
          totalViews,
          totalEarnedPaise,
        });
      }
    }

    const entries = [...byCreator.values()];
    // Rank reflects total earnings, not raw reach — see getLeaderboard.
    entries.sort((a, b) => b.totalEarnedPaise - a.totalEarnedPaise || b.totalViews - a.totalViews);
    const ranked = entries.map((e, i) => ({ ...e, rank: i + 1 }));
    const currentUser = ranked.find((e) => e.creatorId === currentUserId) ?? null;

    return {
      totalParticipants: ranked.length,
      entries: ranked.slice(0, limit),
      currentUser,
    };
  }

  async approveProof(userId: string, role: UserRole, deliverableId: string) {
    const deliverable = await this.prisma.formatDeliverable.findUnique({
      where: { id: deliverableId },
      include: { participation: { include: { campaign: true } } },
    });

    if (!deliverable) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
      { requireWrite: true },
    );

    const reviewable: FormatDeliverableStatus[] = [
      FormatDeliverableStatus.proof_under_review,
      FormatDeliverableStatus.live_submitted,
    ];
    if (!reviewable.includes(deliverable.status)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Proof can only be approved when it is under review",
      });
    }

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: {
        status: FormatDeliverableStatus.proof_approved,
        proofReviewedAt: new Date(),
        reviewedByUserId: userId,
      },
    });

    this.realtime.emitDeliverableLiveProof(
      this.deliverableEventPayload(updated, deliverable.participation),
    );
    await this.activityLog.log(userId, "proof.approved", {
      targetType: "FormatDeliverable",
      targetId: updated.id,
      brandProfileId: deliverable.participation.campaign.brandProfileId ?? undefined,
      metadata: { campaignTitle: deliverable.participation.campaign.title, platform: updated.platform },
    });
    await this.notifications.create(deliverable.participation.creatorId, "creator", {
      type: "proof_approved",
      title: "Proof approved — payout on the way",
      body: `Your live ${formatPlatform(updated.platform)} post for ${deliverable.participation.campaign.title} was verified. Payout will be processed shortly.`,
      link: `/participations/${deliverable.participation.id}`,
      sendWhatsapp: true,
    });

    return { id: updated.id, status: updated.status };
  }

  async rejectProof(userId: string, role: UserRole, deliverableId: string, reason: string) {
    const deliverable = await this.prisma.formatDeliverable.findUnique({
      where: { id: deliverableId },
      include: { participation: { include: { campaign: true } } },
    });

    if (!deliverable) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
      { requireWrite: true },
    );

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: {
        status: FormatDeliverableStatus.proof_rejected,
        rejectionReason: reason,
        proofReviewedAt: new Date(),
        reviewedByUserId: userId,
      },
    });

    this.realtime.emitDeliverableLiveProof(
      this.deliverableEventPayload(updated, deliverable.participation),
    );
    await this.activityLog.log(userId, "proof.rejected", {
      targetType: "FormatDeliverable",
      targetId: updated.id,
      brandProfileId: deliverable.participation.campaign.brandProfileId ?? undefined,
      metadata: { campaignTitle: deliverable.participation.campaign.title, platform: updated.platform, reason },
    });
    await this.notifications.create(deliverable.participation.creatorId, "creator", {
      type: "proof_rejected",
      title: "Proof rejected",
      // Full reason stays on rejectionReason, shown once the app is opened.
      body: `Your live ${formatPlatform(updated.platform)} post for ${deliverable.participation.campaign.title} was rejected. Open the app for details.`,
      // No "open the app" — the WhatsApp template already appends that.
      whatsappBody: `Your live ${formatPlatform(updated.platform)} post for ${deliverable.participation.campaign.title} was rejected.`,
      link: `/participations/${deliverable.participation.id}`,
      sendWhatsapp: true,
    });

    return { id: updated.id, status: updated.status };
  }

  async refreshDeliverableViews(creatorId: string, deliverableId: string) {
    const deliverable = await this.prisma.formatDeliverable.findUnique({
      where: { id: deliverableId },
      include: { participation: { include: { campaign: true } } },
    });

    if (!deliverable || deliverable.participation.creatorId !== creatorId) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }

    const proofStatuses: FormatDeliverableStatus[] = [
      FormatDeliverableStatus.proof_under_review,
      FormatDeliverableStatus.proof_approved,
      FormatDeliverableStatus.live_submitted,
    ];
    if (!proofStatuses.includes(deliverable.status) || !deliverable.livePostUrl) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Views can only be refreshed after live proof is submitted",
      });
    }

    return this._refreshDeliverableMetrics(deliverable);
  }

  /** Same manual refresh as refreshDeliverableViews, but for a brand/admin/
   * staff reviewer looking at their own campaign's submissions instead of a
   * creator looking at their own deliverable — a safety-net button next to
   * the automatic 5-minute sweep, for a reviewer who wants current numbers
   * right now rather than waiting for the next sweep pass. */
  async refreshDeliverableViewsForBrand(
    userId: string,
    role: UserRole,
    deliverableId: string,
  ) {
    const deliverable = await this.prisma.formatDeliverable.findUnique({
      where: { id: deliverableId },
      include: { participation: { include: { campaign: true } } },
    });

    if (!deliverable) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      deliverable.participation.campaign,
    );

    const proofStatuses: FormatDeliverableStatus[] = [
      FormatDeliverableStatus.proof_under_review,
      FormatDeliverableStatus.proof_approved,
      FormatDeliverableStatus.live_submitted,
    ];
    if (!proofStatuses.includes(deliverable.status) || !deliverable.livePostUrl) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Views can only be refreshed after live proof is submitted",
      });
    }

    return this._refreshDeliverableMetrics(deliverable);
  }

  /** The shared metrics-fetch-and-persist logic behind both the
   * creator-invoked "Refresh views" call and the background sweep
   * (refreshActiveDeliverableMetrics) — same source-of-truth so a manual
   * tap and an automatic background pass never disagree on how a number
   * was produced.
   *
   * Deliberately does NOT touch the campaign pool / emitCampaignUpdated
   * here — that broadcast goes to *every connected creator app-wide*
   * (see broadcastCampaignEvent), which is fine for one human-initiated
   * manual refresh but would mean the background sweep spams a
   * campaign-wide, app-wide broadcast once per deliverable it silently
   * refreshes — confirmed live: a single 5-minute sweep pass over 29 real
   * deliverables caused 29 such broadcasts, which is what was showing up
   * as the Performance screen (and potentially any other open screen)
   * reloading multiple times in a row. Callers that need the pool-check
   * do it themselves, at whatever granularity is actually appropriate for
   * them (refreshDeliverableViews: every call; the sweep: once per
   * campaign touched, not once per deliverable — see
   * refreshActiveDeliverableMetrics).
   *
   * Still emits deliverable:metrics_updated, but that one is scoped to
   * just the affected creator (and their brand/campaign room) — not
   * broadcast to every connected creator — so it's safe to fire once per
   * deliverable without causing the same storm. */
  private async _persistDeliverableMetrics(
    deliverable: Prisma.FormatDeliverableGetPayload<{
      include: { participation: { include: { campaign: true } } };
    }>,
  ) {
    const deliverableId = deliverable.id;
    const livePostUrl = deliverable.livePostUrl!;

    // Instagram exclusively uses real, first-party Insights — no Apify
    // fallback. This only returns real numbers when the creator connected
    // the exact Instagram account that posted the proof (see
    // getMediaInsightsForPost); otherwise it's "unavailable", not a
    // silently-substituted scrape. YouTube/Twitter have no Insights
    // equivalent in this codebase and stay on Apify exclusively.
    let metrics: PlatformViewResult;
    let metricsSource: "instagram_insights" | "apify" | "unavailable";
    if (deliverable.platform.startsWith("instagram")) {
      const insights = await this.instagramOAuth.getMediaInsightsForPost(
        deliverable.participation.creatorProfileId,
        livePostUrl,
      );
      if (insights) {
        metrics = insights;
        metricsSource = "instagram_insights";
      } else {
        metrics = { viewCount: 0, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform: "instagram" };
        metricsSource = "unavailable";
      }
    } else {
      metrics = await this.apify.getViewCount(livePostUrl);
      metricsSource = "apify";
    }
    this.logger.log(`refreshDeliverableViews: ${deliverableId} metrics source = ${metricsSource}`);

    // A failed refresh must not overwrite the last good numbers with zeros.
    if (metricsSource === "unavailable") {
      return { updated: deliverable, metricsSource };
    }

    const updated = await this.prisma.formatDeliverable.update({
      where: { id: deliverableId },
      data: {
        viewCount:    metrics.viewCount,
        reach:        metrics.reach,
        likeCount:    metrics.likeCount,
        commentCount: metrics.commentCount,
        shareCount:   metrics.shareCount,
      },
    });

    this.realtime.emitDeliverableMetricsUpdated({
      deliverableId,
      participationId: deliverable.participation.id,
      campaignId: deliverable.participation.campaignId,
      creatorId: deliverable.participation.creatorId,
      brandProfileId: deliverable.participation.campaign.brandProfileId,
      platform: deliverable.platform,
      status: deliverable.status,
      viewCount:    updated.viewCount,
      reach:        updated.reach,
      likeCount:    updated.likeCount,
      commentCount: updated.commentCount,
      shareCount:   updated.shareCount,
    });

    return { updated, metricsSource };
  }

  /** Runs the pool-threshold check for one campaign and emits
   * campaign:updated — the app-wide-to-every-creator broadcast — exactly
   * once. Shared by the manual refresh (always emits, matching prior
   * behavior so brand portal pool bars move on every sync) and the sweep
   * (only emits when the intake status actually changed — see
   * refreshActiveDeliverableMetrics — since nothing there is a human
   * waiting to see a bar move in real time). */
  private async _syncCampaignPool(
    campaign: {
      id: string;
      status: CampaignStatus;
      budgetPaise: number;
      brandProfileId: string | null;
      newClipperIntakeStatus: NewClipperIntakeStatus;
      poolThresholdBps: number;
    },
    { onlyIfChanged }: { onlyIfChanged: boolean },
  ): Promise<void> {
    const poolState = await this._evaluateCampaignPoolThresholds(campaign);
    const changed =
      poolState.paused || poolState.newClipperIntakeStatus !== campaign.newClipperIntakeStatus;
    if (onlyIfChanged && !changed) return;
    this.realtime.emitCampaignUpdated({
      id: campaign.id,
      brandProfileId: campaign.brandProfileId,
      ...(poolState.paused ? { status: CampaignStatus.paused } : {}),
      newClipperIntakeStatus: poolState.newClipperIntakeStatus,
      poolUtilizationBps: poolState.utilizationBps,
    });
  }

  private async _refreshDeliverableMetrics(
    deliverable: Prisma.FormatDeliverableGetPayload<{
      include: { participation: { include: { campaign: true } } };
    }>,
  ) {
    const { updated, metricsSource } = await this._persistDeliverableMetrics(deliverable);

    // Re-evaluate the pool: close intake at the 80% threshold, auto-pause at
    // 100%. Emit exactly one campaign:updated either way so brand portal
    // pool bars and intake-status badges refresh live after every view sync.
    await this._syncCampaignPool(deliverable.participation.campaign, { onlyIfChanged: false });

    // Analytics above are always the real, uncapped numbers. payoutCapped
    // tells the client this deliverable's *earnings* have hit its
    // maxPayoutPaise ceiling even though views keep climbing — so the UI
    // can show "earnings capped, views still growing" instead of implying a
    // rising ₹ figure that isn't actually rising anymore.
    const campaign = deliverable.participation.campaign;
    const cappedEstimatePaise = computeEstimatedPaise(
      updated.viewCount,
      campaign.ratePer1kPaise,
      campaign.maxPayoutPaise,
    );
    const payoutCapped = cappedEstimatePaise >= campaign.maxPayoutPaise;

    return {
      id:           updated.id,
      viewCount:    updated.viewCount,
      reach:        updated.reach,
      likeCount:    updated.likeCount,
      commentCount: updated.commentCount,
      shareCount:   updated.shareCount,
      payoutCapped,
      metricsSource,
    };
  }

  /** Background sweep — periodically refreshes every deliverable that's
   * actually live and trackable (a submitted proof URL, not yet in a
   * terminal rejected state), so view/like/comment/share counts and
   * payout estimates update on their own instead of only when a creator
   * happens to open the app and tap "Refresh views". Every-5-minutes
   * cadence balances "feels live" against not hammering Instagram
   * Insights/Apify — there's no job queue in this codebase, so this runs
   * sequentially with a short pause between each deliverable rather than
   * in parallel, and one failure never stops the rest of the sweep. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshActiveDeliverableMetrics(): Promise<void> {
    // The whole body is wrapped — a transient DB blip (a dropped Postgres
    // connection, a pool timeout) hitting the very first query would
    // otherwise throw out of this @Cron method silently: no log line, the
    // sweep just doesn't run for that cycle with nothing to show for it.
    // Confirmed live: five consecutive 5-minute cycles produced no
    // "sweeping N deliverable(s)" log at all during a real connection
    // drop, and the only trace of it was an unrelated request's error log
    // at the same time — this makes that kind of gap visible instead of
    // silent, even though it can't fix the underlying transient outage.
    try {
      const trackableStatuses: FormatDeliverableStatus[] = [
        FormatDeliverableStatus.live_submitted,
        FormatDeliverableStatus.proof_under_review,
        FormatDeliverableStatus.proof_approved,
      ];
      const deliverables = await this.prisma.formatDeliverable.findMany({
        where: {
          status: { in: trackableStatuses },
          livePostUrl: { not: null },
          // A deliverable can sit in proof_approved indefinitely (that
          // status doesn't change on payout — see paidAt), so once its
          // campaign closes there's nothing left keeping this scoped to
          // "actually active" without this — otherwise it's swept forever,
          // still burning Instagram Insights/Apify calls for a campaign
          // nobody's watching anymore.
          participation: { campaign: { status: { not: CampaignStatus.closed } } },
        },
        include: { participation: { include: { campaign: true } } },
      });
      if (deliverables.length === 0) return;

      this.logger.log(`refreshActiveDeliverableMetrics: sweeping ${deliverables.length} deliverable(s)`);
      let succeeded = 0;
      let failed = 0;
      // One campaign per unique id — the pool-threshold check below runs at
      // most once per campaign touched, not once per deliverable (a busy
      // campaign might have a dozen active deliverables in this same sweep).
      const touchedCampaigns = new Map<string, (typeof deliverables)[number]["participation"]["campaign"]>();
      for (const deliverable of deliverables) {
        try {
          await this._persistDeliverableMetrics(deliverable);
          touchedCampaigns.set(deliverable.participation.campaign.id, deliverable.participation.campaign);
          succeeded++;
        } catch (err) {
          failed++;
          this.logger.warn(`refreshActiveDeliverableMetrics: failed for ${deliverable.id}: ${err}`);
        }
        // A small pause between calls — this is a periodic background sweep,
        // not a user waiting on a response, so there's no reason to burst
        // every request at once against Instagram/Apify's rate limits.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Pool check happens after the loop, once per campaign, and only
      // broadcasts (to every connected creator app-wide) when the intake
      // status actually changed — nobody's watching a bar move live during
      // an unattended background sweep, so there's no reason to emit the
      // same wide broadcast unconditionally the way the manual refresh does.
      for (const campaign of touchedCampaigns.values()) {
        try {
          await this._syncCampaignPool(campaign, { onlyIfChanged: true });
        } catch (err) {
          this.logger.warn(`refreshActiveDeliverableMetrics: pool check failed for campaign ${campaign.id}: ${err}`);
        }
      }

      this.logger.log(`refreshActiveDeliverableMetrics: done — ${succeeded} succeeded, ${failed} failed`);
    } catch (err) {
      this.logger.warn(`refreshActiveDeliverableMetrics: sweep aborted — ${err}`);
    }
  }

  /** Re-checks a live campaign's pool usage against its 80% intake threshold
   * and its 100% budget ceiling, applying whichever state changes now apply.
   * Does not emit realtime events itself — callers that already need to emit
   * an update (e.g. after a view refresh) build one payload from the result
   * instead of this firing a second, separate event. */
  private async _evaluateCampaignPoolThresholds(campaign: {
    id: string;
    status: CampaignStatus;
    budgetPaise: number;
    brandProfileId: string | null;
    newClipperIntakeStatus: NewClipperIntakeStatus;
    poolThresholdBps: number;
  }): Promise<{
    paused: boolean;
    newClipperIntakeStatus: NewClipperIntakeStatus;
    utilizationBps: number;
  }> {
    if (campaign.status !== CampaignStatus.live || campaign.budgetPaise <= 0) {
      return { paused: false, newClipperIntakeStatus: campaign.newClipperIntakeStatus, utilizationBps: 0 };
    }

    const budgetUsed = await getCampaignPoolUsage(this.prisma, campaign.id);
    const utilizationBps = Math.min(10000, Math.floor((budgetUsed / campaign.budgetPaise) * 10000));

    let newClipperIntakeStatus = campaign.newClipperIntakeStatus;
    if (
      newClipperIntakeStatus === NewClipperIntakeStatus.open &&
      utilizationBps >= campaign.poolThresholdBps
    ) {
      newClipperIntakeStatus = NewClipperIntakeStatus.closed_at_threshold;
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { newClipperIntakeStatus },
      });
    }

    if (budgetUsed < campaign.budgetPaise) {
      return { paused: false, newClipperIntakeStatus, utilizationBps };
    }

    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.paused },
    });

    return { paused: true, newClipperIntakeStatus, utilizationBps };
  }

  async countPendingReviewsForBrand(
    userId: string,
    role: UserRole,
  ): Promise<number> {
    const brandProfileIds = await this.resolveBrandProfileIds(userId, role);
    if (brandProfileIds && brandProfileIds.length === 0) {
      return 0;
    }

    return this.prisma.formatDeliverable.count({
      where: {
        status: FormatDeliverableStatus.under_review,
        ...(brandProfileIds
          ? {
              participation: {
                campaign: { brandProfileId: { in: brandProfileIds } },
              },
            }
          : {}),
      },
    });
  }
}
