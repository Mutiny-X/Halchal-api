import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { CampaignStatus, StaffAccessLevel, UserRole } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { CampaignsService } from "../campaigns/campaigns.service";
import type { CreateCampaignDto } from "../campaigns/dto/campaign.dto";

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  async getAssignedBrands(staffUserId: string) {
    const assignments = await this.prisma.staffBrandAssignment.findMany({
      where: { staffUserId },
      include: {
        brandProfile: {
          select: {
            id: true,
            companyName: true,
            logoUrl: true,
            companyEmail: true,
            _count: { select: { campaigns: true } },
          },
        },
      },
      orderBy: { assignedAt: "desc" },
    });
    return assignments.map((a) => ({
      id: a.brandProfile.id,
      companyName: a.brandProfile.companyName,
      logoUrl: a.brandProfile.logoUrl,
      companyEmail: a.brandProfile.companyEmail,
      campaignCount: a.brandProfile._count.campaigns,
      assignedAt: a.assignedAt.toISOString(),
      accessLevel: a.accessLevel,
    }));
  }

  async getBrand(staffUserId: string, brandProfileId: string) {
    const accessLevel = await this.assertAssigned(staffUserId, brandProfileId);

    const b = await this.prisma.brandProfile.findUnique({
      where: { id: brandProfileId },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        campaigns: {
          orderBy: { createdAt: "desc" },
          include: { _count: { select: { submissions: true } } },
        },
      },
    });
    if (!b) throw new NotFoundException({ code: "NOT_FOUND", message: "Brand not found" });

    return {
      id: b.id,
      accessLevel,
      companyName: b.companyName,
      companyEmail: b.companyEmail,
      logoUrl: b.logoUrl,
      email: b.user.email,
      displayName: b.user.displayName,
      pocName: b.pocName,
      pocPhone: b.pocPhone,
      pocEmail: b.pocEmail,
      createdAt: b.createdAt.toISOString(),
      campaigns: b.campaigns.map((c) => ({
        ...this.campaigns.formatCampaign(c),
        submissionCount: c._count.submissions,
      })),
    };
  }

  async createCampaignForBrand(staffUserId: string, brandProfileId: string, dto: CreateCampaignDto) {
    await this.assertAssigned(staffUserId, brandProfileId, { requireWrite: true });
    // This calls create() with the admin role (for admin-created ownership),
    // so it must not become a way around approval: staff start drafts only.
    if (dto.status && dto.status !== CampaignStatus.draft) {
      throw new ForbiddenException({
        code: "CAMPAIGN_NEEDS_APPROVAL",
        message: "Only an admin can put a campaign live. Submit it for approval instead.",
      });
    }
    return this.campaigns.create(staffUserId, UserRole.admin, {
      ...dto,
      brandProfileId,
      status: dto.status ?? CampaignStatus.draft,
    });
  }

  async assertAssigned(
    staffUserId: string,
    brandProfileId: string,
    opts?: { requireWrite?: boolean },
  ) {
    const assignment = await this.prisma.staffBrandAssignment.findUnique({
      where: { staffUserId_brandProfileId: { staffUserId, brandProfileId } },
    });
    if (!assignment) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Not assigned to this brand" });
    }
    if (opts?.requireWrite && assignment.accessLevel !== StaffAccessLevel.full) {
      throw new ForbiddenException({
        code: "FORBIDDEN",
        message: "View-only access — cannot create campaigns for this brand",
      });
    }
    return assignment.accessLevel;
  }
}
