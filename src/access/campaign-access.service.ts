import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CampaignOwnership, StaffAccessLevel, UserRole } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { isUnpublished } from "../campaigns/campaign-status";

@Injectable()
export class CampaignAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getBrandProfileIdForUser(userId: string): Promise<string | null> {
    const profile = await this.prisma.brandProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    return profile?.id ?? null;
  }

  async assertCanAccessCampaign(
    userId: string,
    role: UserRole,
    campaign: {
      id: string;
      brandProfileId: string | null;
      ownership: CampaignOwnership;
    },
    opts?: { requireWrite?: boolean },
  ): Promise<void> {
    if (role === UserRole.admin) {
      return;
    }

    if (role === UserRole.brand) {
      const brandProfileId = await this.getBrandProfileIdForUser(userId);
      if (brandProfileId && campaign.brandProfileId === brandProfileId) {
        return;
      }
    }

    if (role === UserRole.staff && campaign.brandProfileId) {
      const assignment = await this.prisma.staffBrandAssignment.findUnique({
        where: {
          staffUserId_brandProfileId: {
            staffUserId: userId,
            brandProfileId: campaign.brandProfileId,
          },
        },
      });
      if (assignment) {
        if (opts?.requireWrite && assignment.accessLevel !== StaffAccessLevel.full) {
          throw new ForbiddenException({
            code: "FORBIDDEN",
            message: "View-only access — cannot make changes to this brand",
          });
        }
        return;
      }
    }

    throw new ForbiddenException({
      code: "FORBIDDEN",
      message: "No access to this campaign",
    });
  }

  /** Whether a socket may subscribe to a campaign's realtime room. Brand,
   * staff and admin use the same rule as reading the campaign over HTTP;
   * creators (the mobile app) may follow any campaign that has been
   * published — never a draft. */
  async canJoinCampaignRoom(
    userId: string,
    role: UserRole,
    campaignId: string,
  ): Promise<boolean> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, brandProfileId: true, ownership: true, status: true },
    });
    if (!campaign) return false;

    if (role === UserRole.creator) {
      return !isUnpublished(campaign.status);
    }

    try {
      await this.assertCanAccessCampaign(userId, role, campaign);
      return true;
    } catch {
      return false;
    }
  }

  async resolveBrandProfileIdForBrandCreate(
    userId: string,
    role: UserRole,
  ): Promise<string> {
    if (role !== UserRole.brand) {
      throw new ForbiddenException({
        code: "FORBIDDEN",
        message: "Brand profile required",
      });
    }

    const brandProfileId = await this.getBrandProfileIdForUser(userId);
    if (!brandProfileId) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Brand profile not found",
      });
    }
    return brandProfileId;
  }

  buildCampaignWhereForRole(
    role: UserRole,
    brandProfileId: string | null,
  ): Record<string, unknown> {
    if (role === UserRole.admin) {
      return {};
    }

    if (role === UserRole.brand && brandProfileId) {
      return { brandProfileId };
    }

    return { id: "__none__" };
  }
}
