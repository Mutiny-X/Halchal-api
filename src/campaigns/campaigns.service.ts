import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CampaignInviteStatus,
  CampaignOwnership,
  CampaignStatus,
  CampaignWizardStep,
  NewClipperIntakeStatus,
  Prisma,
  SourceAssetRequirement,
  StaffAccessLevel,
  UserRole,
} from "@prisma/client";

import { ActivityLogService } from "../activity/activity-log.service";
import { CampaignAccessService } from "../access/campaign-access.service";
import { getCampaignPoolUsageMap } from "../common/campaign-pool";
import { InAppNotificationService } from "../notifications/in-app-notification.service";
import { ParticipationService } from "../participation/participation.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  DEFAULT_CAMPAIGN_PLATFORM,
  normalizeCampaignPlatforms,
} from "./campaign-platforms";
import type { CreateCampaignDto, UpdateCampaignDto } from "./dto/campaign.dto";
import type { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto";

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignAccess: CampaignAccessService,
    private readonly realtime: RealtimeService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: InAppNotificationService,
    private readonly participation: ParticipationService,
  ) {}

  // Fire-and-forget on purpose — a brand/admin publishing a campaign
  // shouldn't wait on N sequential push+WhatsApp sends before getting their
  // response. Failures are logged per-creator so one bad phone/token never
  // stops the rest of the batch.
  private notifyCreatorsOfNewCampaign(campaign: { id: string; title: string }): void {
    this.prisma.user
      .findMany({
        where: { role: UserRole.creator, isActive: true },
        select: { id: true },
      })
      .then(async (creators) => {
        for (const creator of creators) {
          try {
            await this.notifications.create(creator.id, "creator", {
              type: "campaign_live",
              title: "New campaign live 🎉",
              body: `${campaign.title} just went live — check it out and start creating.`,
              link: `/campaigns/${campaign.id}`,
              sendWhatsapp: true,
            });
          } catch (err) {
            this.logger.warn(
              `Failed to notify creator ${creator.id} of new campaign ${campaign.id}: ${err}`,
            );
          }
        }
      })
      .catch((err) => {
        this.logger.warn(`Failed to load creators to notify for campaign ${campaign.id}: ${err}`);
      });
  }

  // Use COALESCE(paid_amount_paise, estimated) so paid takes priority once processed;
  // fall back to view-count-derived estimate for campaigns with no payouts yet.
  private fetchBudgetUsedMap(campaignIds: string[]): Promise<Record<string, number>> {
    return getCampaignPoolUsageMap(this.prisma, campaignIds);
  }

  async listLiveForCreators() {
    const campaigns = await this.prisma.campaign.findMany({
      where: { status: CampaignStatus.live },
      orderBy: { createdAt: "desc" },
      include: {
        brandProfile: { select: { companyName: true, logoUrl: true } },
      },
    });
    const budgetMap = await this.fetchBudgetUsedMap(campaigns.map((c) => c.id));
    return campaigns.map((c) =>
      this.formatCampaignForCreator({ ...c, budgetUsedPaise: budgetMap[c.id] ?? c.budgetUsedPaise }),
    );
  }

  async getLiveForCreator(campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, status: CampaignStatus.live },
      include: {
        brandProfile: { select: { companyName: true, logoUrl: true } },
      },
    });
    if (!campaign) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }
    const budgetMap = await this.fetchBudgetUsedMap([campaign.id]);
    return this.formatCampaignForCreator({
      ...campaign,
      budgetUsedPaise: budgetMap[campaign.id] ?? campaign.budgetUsedPaise,
    });
  }

  async listForUser(
    userId: string,
    role: UserRole,
    query: ListCampaignsQueryDto,
  ) {
    let brandProfileId: string | null = null;
    let staffBrandIds: string[] | null = null;

    if (role === UserRole.brand) {
      brandProfileId = await this.campaignAccess.getBrandProfileIdForUser(userId);
    } else if (role === UserRole.staff) {
      const assignments = await this.prisma.staffBrandAssignment.findMany({
        where: { staffUserId: userId },
        select: { brandProfileId: true },
      });
      staffBrandIds = assignments.map((a) => a.brandProfileId);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 6;
    const skip = (page - 1) * limit;

    const where: Prisma.CampaignWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search?.trim() ? { title: { contains: query.search.trim(), mode: "insensitive" } } : {}),
      ...(role === UserRole.brand && brandProfileId ? { brandProfileId } : {}),
      ...(role === UserRole.staff && staffBrandIds ? { brandProfileId: { in: staffBrandIds } } : {}),
    };

    const [total, campaigns] = await this.prisma.$transaction([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          _count: { select: { submissions: true } },
          brandProfile: { select: { id: true, companyName: true } },
          invites: {
            where: { status: CampaignInviteStatus.pending },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
    ]);

    const budgetMap = await this.fetchBudgetUsedMap(campaigns.map((c) => c.id));
    return {
      items: campaigns.map((c) => ({
        ...this.formatCampaign({ ...c, budgetUsedPaise: budgetMap[c.id] ?? c.budgetUsedPaise }),
        brandCompanyName: c.brandProfile?.companyName ?? null,
        submissionCount: c._count.submissions,
        pendingInviteEmail: c.invites[0]?.email ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  async getForUser(userId: string, role: UserRole, campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        _count: { select: { submissions: true } },
        brandProfile: { select: { id: true, companyName: true } },
        invites: {
          where: { status: CampaignInviteStatus.pending },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!campaign) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }

    await this.campaignAccess.assertCanAccessCampaign(userId, role, campaign);

    const budgetMap = await this.fetchBudgetUsedMap([campaign.id]);
    return {
      ...this.formatCampaign({ ...campaign, budgetUsedPaise: budgetMap[campaign.id] ?? campaign.budgetUsedPaise }),
      brandCompanyName: campaign.brandProfile?.companyName ?? null,
      submissionCount: campaign._count.submissions,
      pendingInviteEmail: campaign.invites[0]?.email ?? null,
    };
  }

  async create(userId: string, role: UserRole, dto: CreateCampaignDto) {
    const status = dto.status ?? CampaignStatus.draft;
    const isLive = status === CampaignStatus.live;

    let brandProfileId: string | null = null;
    let ownership: CampaignOwnership = CampaignOwnership.brand_created;

    if (role === UserRole.admin) {
      ownership = CampaignOwnership.admin_created;
      brandProfileId = dto.brandProfileId ?? null;
    } else if (role === UserRole.staff) {
      brandProfileId = dto.brandProfileId ?? null;
      if (brandProfileId) {
        const assignment = await this.prisma.staffBrandAssignment.findUnique({
          where: { staffUserId_brandProfileId: { staffUserId: userId, brandProfileId } },
        });
        if (!assignment) {
          throw new ForbiddenException({ code: "FORBIDDEN", message: "Not assigned to this brand" });
        }
        if (assignment.accessLevel !== StaffAccessLevel.full) {
          throw new ForbiddenException({
            code: "FORBIDDEN",
            message: "View-only access — cannot create campaigns for this brand",
          });
        }
      }
    } else {
      brandProfileId =
        await this.campaignAccess.resolveBrandProfileIdForBrandCreate(
          userId,
          role,
        );
    }

    if (isLive) {
      this.assertPublishable(dto);
      if (ownership === CampaignOwnership.admin_created) {
        this.assertAdminCanPublish({
          ownership,
          brandProfileId,
          inviteAcceptedAt: null,
        });
      }
    }

    const platforms = normalizeCampaignPlatforms(dto.platforms, dto.platform);
    const brief =
      this.buildBrief(dto) ||
      (isLive ? "" : "Draft campaign — complete before publishing.");

    if (isLive && !brief) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Campaign brief is required to publish",
      });
    }

    const campaign = await this.prisma.campaign.create({
      data: {
        brandProfileId,
        createdByUserId: userId,
        ownership,
        wizardStep: dto.wizardStep ?? CampaignWizardStep.basics,
        title: dto.title,
        category: dto.category,
        platform: platforms[0] ?? DEFAULT_CAMPAIGN_PLATFORM,
        platforms,
        locationType: dto.locationType ?? "pan_india",
        targetStates: dto.locationType === "states" ? (dto.targetStates ?? []) : [],
        status,
        brief,
        briefHook: dto.briefHook,
        doRules: dto.doRules,
        avoidRules: dto.avoidRules,
        sourceAssets: dto.sourceAssets as Prisma.InputJsonValue | undefined,
        sourceVideoRequirement: dto.sourceVideoRequirement,
        sourceAudioRequirement: dto.sourceAudioRequirement,
        autoReviewEnabled: dto.autoReviewEnabled,
        referenceAssets: dto.referenceAssets as Prisma.InputJsonValue | undefined,
        coverImageUrl: dto.coverImageUrl,
        productUrl: dto.productUrl,
        ratePer1kPaise: dto.ratePer1kPaise ?? 5_000,
        maxPayoutPaise: dto.maxPayoutPaise ?? 5_000_000,
        budgetPaise: dto.budgetPaise ?? 10_000_000,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      },
    });

    const formatted = this.formatCampaign(campaign);
    await this.activityLog.log(userId, "campaign.created", {
      targetType: "Campaign",
      targetId: campaign.id,
      brandProfileId: brandProfileId ?? undefined,
      metadata: { title: campaign.title },
    });
    if (isLive) {
      this.realtime.emitCampaignPublished(formatted);
      this.notifyCreatorsOfNewCampaign(formatted);
    } else {
      this.realtime.emitCampaignCreated(formatted);
    }
    return formatted;
  }

  async update(
    userId: string,
    role: UserRole,
    campaignId: string,
    dto: UpdateCampaignDto,
  ) {
    const existing = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!existing) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      existing,
      { requireWrite: true },
    );

    const nextStatus = dto.status ?? existing.status;
    if (dto.status && dto.status !== existing.status) {
      this.assertStatusTransition(existing.status, dto.status);
    }

    if (
      nextStatus === CampaignStatus.live &&
      existing.status !== CampaignStatus.live
    ) {
      this.assertPublishable({
        title: dto.title ?? existing.title,
        briefHook: dto.briefHook ?? existing.briefHook ?? undefined,
        ratePer1kPaise: dto.ratePer1kPaise ?? existing.ratePer1kPaise,
        maxPayoutPaise: dto.maxPayoutPaise ?? existing.maxPayoutPaise,
        budgetPaise: dto.budgetPaise ?? existing.budgetPaise,
        brief: dto.brief ?? existing.brief,
      });
      const effectiveBrandProfileId =
        role === UserRole.admin && dto.brandProfileId !== undefined
          ? dto.brandProfileId
          : existing.brandProfileId;
      this.assertAdminCanPublish({
        ownership: existing.ownership,
        brandProfileId: effectiveBrandProfileId,
        inviteAcceptedAt: existing.inviteAcceptedAt,
      });
    }

    const brief =
      dto.brief !== undefined
        ? dto.brief
        : this.buildBrief({
            briefHook: dto.briefHook ?? existing.briefHook ?? undefined,
            doRules: dto.doRules ?? existing.doRules ?? undefined,
            avoidRules: dto.avoidRules ?? existing.avoidRules ?? undefined,
          }) || existing.brief;

    const platforms = dto.platforms
      ? normalizeCampaignPlatforms(dto.platforms)
      : undefined;

    const targetStates =
      dto.locationType === "pan_india"
        ? []
        : dto.locationType === "states"
          ? (dto.targetStates ?? existing.targetStates)
          : undefined;

    const campaign = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        brandProfileId: role === UserRole.admin ? dto.brandProfileId : undefined,
        status: dto.status,
        wizardStep: this.furthestWizardStep(existing.wizardStep, dto.wizardStep),
        title: dto.title,
        category: dto.category,
        brief,
        briefHook: dto.briefHook,
        doRules: dto.doRules,
        avoidRules: dto.avoidRules,
        sourceAssets: dto.sourceAssets as Prisma.InputJsonValue | undefined,
        sourceVideoRequirement: dto.sourceVideoRequirement,
        sourceAudioRequirement: dto.sourceAudioRequirement,
        autoReviewEnabled: dto.autoReviewEnabled,
        referenceAssets: dto.referenceAssets as Prisma.InputJsonValue | undefined,
        coverImageUrl: dto.coverImageUrl,
        platforms,
        platform: platforms?.[0],
        locationType: dto.locationType,
        targetStates,
        productUrl: dto.productUrl,
        ratePer1kPaise: dto.ratePer1kPaise,
        maxPayoutPaise: dto.maxPayoutPaise,
        budgetPaise: dto.budgetPaise,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      },
    });

    const formatted = this.formatCampaign(campaign);
    if (
      nextStatus === CampaignStatus.live &&
      existing.status !== CampaignStatus.live
    ) {
      this.realtime.emitCampaignPublished(formatted);
      this.notifyCreatorsOfNewCampaign(formatted);
    } else {
      this.realtime.emitCampaignUpdated(formatted);
    }
    // Closed by hand — capture the posts' final metrics now, in the
    // background, same as when the budget pool closes a campaign.
    if (nextStatus === CampaignStatus.closed && existing.status !== CampaignStatus.closed) {
      this.participation.finalizeCampaignMetrics(campaignId).catch((err) => {
        this.logger.warn(`Final metrics fetch could not start for campaign ${campaignId}: ${err}`);
      });
    }
    return formatted;
  }

  async remove(userId: string, role: UserRole, campaignId: string) {
    const existing = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { _count: { select: { submissions: true } } },
    });
    if (!existing) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }

    await this.campaignAccess.assertCanAccessCampaign(
      userId,
      role,
      existing,
      { requireWrite: true },
    );

    if (
      existing.status !== CampaignStatus.draft &&
      existing.status !== CampaignStatus.closed
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "End the campaign before deleting it",
      });
    }

    if (existing._count.submissions > 0) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Cannot delete a campaign that has creator submissions",
      });
    }

    await this.prisma.campaign.delete({ where: { id: campaignId } });
    return { deleted: true, id: campaignId };
  }

  private assertAdminCanPublish(campaign: {
    ownership?: CampaignOwnership;
    brandProfileId: string | null;
    inviteAcceptedAt: Date | null;
  }): void {
    if (!campaign.brandProfileId) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Assign a brand before publishing this campaign",
      });
    }
  }

  /**
   * wizardStep tracks the furthest step a campaign has genuinely reached —
   * it must never regress. Without this, going back to tweak an earlier
   * step (which auto-saves with that step's name) would silently erase
   * progress markers the wizard stepper relies on to gate jumping ahead.
   */
  private furthestWizardStep(
    current: CampaignWizardStep,
    incoming: CampaignWizardStep | undefined,
  ): CampaignWizardStep {
    if (!incoming) return current;
    const order = [
      CampaignWizardStep.basics,
      CampaignWizardStep.brief,
      CampaignWizardStep.payout,
      CampaignWizardStep.review,
    ];
    return order.indexOf(incoming) > order.indexOf(current) ? incoming : current;
  }

  private assertStatusTransition(
    from: CampaignStatus,
    to: CampaignStatus,
  ): void {
    if (from === to) return;

    const allowed: Record<CampaignStatus, CampaignStatus[]> = {
      [CampaignStatus.draft]: [CampaignStatus.live, CampaignStatus.closed],
      [CampaignStatus.live]: [CampaignStatus.paused, CampaignStatus.closed],
      [CampaignStatus.paused]: [CampaignStatus.live, CampaignStatus.closed],
      [CampaignStatus.closed]: [],
    };

    if (!allowed[from].includes(to)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: `Cannot change campaign status from ${from} to ${to}`,
      });
    }
  }

  private assertPublishable(input: {
    title?: string;
    briefHook?: string;
    ratePer1kPaise?: number;
    maxPayoutPaise?: number;
    budgetPaise?: number;
    brief?: string;
  }): void {
    if (!input.ratePer1kPaise || input.ratePer1kPaise < 1) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Rate per 1K views is required to publish",
      });
    }
    if (!input.maxPayoutPaise || input.maxPayoutPaise < 100) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Max payout is required to publish",
      });
    }
    if (!input.budgetPaise || input.budgetPaise < 100) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Campaign budget is required to publish",
      });
    }
  }

  /** Public, unauthenticated read-only view — excludes rate/budget/payout ("commercials"). */
  async getPublicView(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        brandProfile: { select: { companyName: true, logoUrl: true } },
      },
    });

    if (!campaign || campaign.status === CampaignStatus.draft) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not available",
      });
    }

    return {
      id: campaign.id,
      title: campaign.title,
      category: campaign.category,
      platform: campaign.platform,
      platforms: campaign.platforms,
      locationType: campaign.locationType,
      targetStates: campaign.targetStates,
      status: campaign.status,
      brief: campaign.brief,
      briefHook: campaign.briefHook,
      doRules: campaign.doRules,
      avoidRules: campaign.avoidRules,
      sourceAssets: campaign.sourceAssets,
      sourceVideoRequirement: campaign.sourceVideoRequirement,
      sourceAudioRequirement: campaign.sourceAudioRequirement,
      referenceAssets: campaign.referenceAssets,
      coverImageUrl: campaign.coverImageUrl,
      productUrl: campaign.productUrl,
      startDate: campaign.startDate?.toISOString() ?? null,
      brandCompanyName: campaign.brandProfile?.companyName ?? null,
      brandLogoUrl: campaign.brandProfile?.logoUrl ?? null,
    };
  }

  formatCampaignForCreator(
    c: Parameters<CampaignsService["formatCampaign"]>[0] & {
      brandProfile?: { companyName: string; logoUrl: string | null } | null;
    },
  ) {
    return {
      ...this.formatCampaign(c),
      brandCompanyName: c.brandProfile?.companyName ?? null,
      brandLogoUrl: c.brandProfile?.logoUrl ?? null,
    };
  }

  formatCampaign(c: {
    id: string;
    brandProfileId?: string | null;
    ownership?: CampaignOwnership;
    wizardStep?: CampaignWizardStep;
    inviteAcceptedAt?: Date | null;
    createdByUserId?: string | null;
    title: string;
    category: string | null;
    platform: string;
    platforms: string[];
    locationType: string;
    targetStates: string[];
    status: CampaignStatus;
    brief: string;
    briefHook: string | null;
    doRules: string | null;
    avoidRules: string | null;
    sourceAssets: unknown;
    sourceVideoRequirement?: SourceAssetRequirement;
    sourceAudioRequirement?: SourceAssetRequirement;
    autoReviewEnabled?: boolean;
    referenceAssets: unknown;
    coverImageUrl?: string | null;
    productUrl: string | null;
    ratePer1kPaise: number;
    maxPayoutPaise: number;
    budgetPaise: number;
    budgetUsedPaise: number;
    newClipperIntakeStatus?: NewClipperIntakeStatus;
    poolThresholdBps?: number;
    startDate: Date | null;
    createdAt: Date;
    updatedAt?: Date;
  }) {
    const rawPercent =
      c.budgetPaise > 0
        ? Math.min(100, (c.budgetUsedPaise / c.budgetPaise) * 100)
        : 0;
    // Show at least 1% when any budget has been consumed so the bar is visibly non-empty.
    const poolPercent = rawPercent === 0 ? 0 : Math.max(1, Math.round(rawPercent));

    // The stored newClipperIntakeStatus only flips reactively — normally on
    // a deliverable's view refresh or a join attempt (see
    // _evaluateCampaignPoolThresholds) — so it can lag behind the live
    // poolPercent computed just above from the same fresh budgetUsedPaise.
    // Derive what clippers actually see from that same live number so the
    // "Apply" CTA can never show open while the pool bar already reads past
    // threshold; the stored field still catches up for real via the next
    // view refresh or join attempt.
    const utilizationBps = Math.round(rawPercent * 100);
    const poolThresholdBps = c.poolThresholdBps ?? 8000;
    const storedIntakeStatus = c.newClipperIntakeStatus ?? NewClipperIntakeStatus.open;
    const newClipperIntakeStatus =
      storedIntakeStatus === NewClipperIntakeStatus.open && utilizationBps >= poolThresholdBps
        ? NewClipperIntakeStatus.closed_at_threshold
        : storedIntakeStatus;

    return {
      id: c.id,
      brandProfileId: c.brandProfileId ?? null,
      ownership: c.ownership ?? CampaignOwnership.brand_created,
      wizardStep: c.wizardStep ?? CampaignWizardStep.basics,
      inviteAcceptedAt: c.inviteAcceptedAt?.toISOString() ?? null,
      createdByUserId: c.createdByUserId ?? null,
      title: c.title,
      category: c.category,
      platform: c.platform,
      platforms: c.platforms,
      locationType: c.locationType,
      targetStates: c.targetStates,
      status: c.status,
      brief: c.brief,
      briefHook: c.briefHook,
      doRules: c.doRules,
      avoidRules: c.avoidRules,
      sourceAssets: c.sourceAssets,
      sourceVideoRequirement: c.sourceVideoRequirement ?? SourceAssetRequirement.mandatory,
      sourceAudioRequirement: c.sourceAudioRequirement ?? SourceAssetRequirement.not_required,
      autoReviewEnabled: c.autoReviewEnabled ?? true,
      referenceAssets: c.referenceAssets,
      coverImageUrl: c.coverImageUrl,
      productUrl: c.productUrl,
      ratePer1kPaise: c.ratePer1kPaise,
      ratePer1kDisplay: `₹${c.ratePer1kPaise / 100} / 1K views`,
      maxPayoutPaise: c.maxPayoutPaise,
      budgetPaise: c.budgetPaise,
      budgetUsedPaise: c.budgetUsedPaise,
      poolPercent,
      poolRemainingPercent: 100 - poolPercent,
      newClipperIntakeStatus,
      startDate: c.startDate?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt?.toISOString() ?? c.createdAt.toISOString(),
    };
  }

  private buildBrief(dto: {
    brief?: string;
    briefHook?: string;
    doRules?: string;
    avoidRules?: string;
  }): string {
    if (dto.brief && dto.brief.trim().length > 0) {
      return dto.brief.trim();
    }

    const composed = [
      dto.briefHook && `HOOK:\n${dto.briefHook}`,
      dto.doRules && `\n\nDO:\n${dto.doRules}`,
      dto.avoidRules && `\n\nAVOID:\n${dto.avoidRules}`,
    ]
      .filter(Boolean)
      .join("")
      .trim();

    return composed;
  }
}

