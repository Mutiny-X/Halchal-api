import { Injectable, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";

import { CampaignAccessService } from "../access/campaign-access.service";
import {
  computeParticipationSummary,
  isParticipationCompleted,
} from "../participation/participation-summary";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CreatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignAccess: CampaignAccessService,
  ) {}

  async getCreatorProfile(creatorId: string, userId: string, role: UserRole) {
    const creator = await this.prisma.user.findUnique({ where: { id: creatorId } });
    if (!creator || creator.role !== UserRole.creator) {
      throw this.notFound();
    }

    const brandProfileIds = await this.resolveBrandProfileIds(userId, role);
    if (brandProfileIds) {
      const hasWorkedTogether = await this.prisma.campaignParticipation.findFirst({
        where: {
          creatorId,
          campaign: { brandProfileId: { in: brandProfileIds } },
        },
        select: { id: true },
      });
      if (!hasWorkedTogether) {
        throw this.notFound();
      }
    }

    const [participations, linkedProfiles] = await Promise.all([
      this.prisma.campaignParticipation.findMany({
        // Only campaigns of brands this viewer can see — not the creator's
        // work for every other brand.
        where: {
          creatorId,
          ...(brandProfileIds ? { campaign: { brandProfileId: { in: brandProfileIds } } } : {}),
        },
        include: {
          campaign: { select: { id: true, title: true, status: true } },
          deliverables: {
            select: { status: true, draftDriveUrl: true, livePostUrl: true },
          },
        },
        orderBy: { joinedAt: "desc" },
      }),
      this.prisma.creatorProfile.findMany({
        where: { userId: creatorId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      }),
    ]);

    const runningCampaigns: Array<{ campaignId: string; title: string; status: string }> = [];
    const pastCampaigns: Array<{ campaignId: string; title: string; status: string }> = [];

    for (const p of participations) {
      const summary = computeParticipationSummary(p.deliverables, p.campaign.status);
      const entry = { campaignId: p.campaign.id, title: p.campaign.title, status: summary };
      if (isParticipationCompleted(summary)) {
        pastCampaigns.push(entry);
      } else {
        runningCampaigns.push(entry);
      }
    }

    return {
      id: creator.id,
      displayName: creator.displayName,
      username: creator.username,
      email: creator.email,
      phone: creator.phone,
      avatarUrl: creator.avatarUrl,
      bio: creator.bio,
      socialLinks: (creator.socialLinks as Record<string, string> | null) ?? null,
      createdAt: creator.createdAt.toISOString(),
      linkedProfiles: linkedProfiles.map((p) => ({
        id: p.id,
        platform: p.platform,
        handle: p.handle,
        label: p.label,
        avatarUrl: p.avatarUrl,
        isDefault: p.isDefault,
        socialLinks: (p.socialLinks as Record<string, string> | null) ?? {},
      })),
      runningCampaigns,
      pastCampaigns,
    };
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
    const brandProfileId = await this.campaignAccess.getBrandProfileIdForUser(userId);
    return brandProfileId ? [brandProfileId] : [];
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: "NOT_FOUND", message: "Creator not found" });
  }
}
