import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CampaignInviteStatus,
  CampaignOwnership,
  CampaignStatus,
  UserRole,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

import { parseDurationMs } from "../common/parse-duration";
import type { Env } from "../config/env";
import { EmailService } from "../notifications/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { AuthService } from "./auth.service";
import { BRAND_INVITES_OPEN } from "./auth.types";
import { hashRefreshToken } from "./otp.service";
import type { CampaignInviteAcceptDto } from "./dto/campaign-invite.dto";

/** Inviting a brand to a campaign gave them a portal login — brands don't
 * sign in any more (see BRAND_ACCESS_CLOSED), so no new invites go out and
 * old links stop working. Listing and revoking old invites still work. */
function assertInvitesOpen() {
  if (!BRAND_INVITES_OPEN) {
    throw new GoneException({
      code: "BRAND_ACCESS_CLOSED",
      message: "Brand invites are no longer used. The Halchal team manages campaigns for brands.",
    });
  }
}

@Injectable()
export class CampaignInviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly email: EmailService,
    private readonly auth: AuthService,
    private readonly realtime: RealtimeService,
  ) {}

  async preview(token: string) {
    assertInvitesOpen();
    const invite = await this.findInviteByToken(token);
    if (!invite) {
      return {
        valid: false,
        expired: true,
        alreadyAccepted: false,
        campaignId: null,
        campaignTitle: null,
        email: null,
        needsSignup: false,
        hasBrandAccount: false,
      };
    }

    const expired =
      invite.expiresAt < new Date() ||
      invite.status === CampaignInviteStatus.expired;
    const alreadyAccepted =
      invite.status === CampaignInviteStatus.accepted;
    const valid =
      !expired && invite.status === CampaignInviteStatus.pending;

    const existingUser = await this.prisma.user.findUnique({
      where: { email: invite.email.toLowerCase() },
      select: { id: true, role: true },
    });

    return {
      valid,
      expired,
      alreadyAccepted,
      campaignId: invite.campaignId,
      campaignTitle: invite.campaign.title,
      email: invite.email,
      needsSignup: !existingUser,
      hasBrandAccount: existingUser?.role === UserRole.brand,
    };
  }

  async accept(dto: CampaignInviteAcceptDto) {
    assertInvitesOpen();
    const invite = await this.findInviteByToken(dto.token);
    if (!invite) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid or expired invite link",
      });
    }

    if (invite.expiresAt < new Date()) {
      await this.prisma.campaignInvite.update({
        where: { id: invite.id },
        data: { status: CampaignInviteStatus.expired },
      });
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invite has expired",
      });
    }

    if (invite.status !== CampaignInviteStatus.pending) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invite is no longer valid",
      });
    }

    if (
      invite.campaign.status !== CampaignStatus.draft ||
      invite.campaign.ownership !== CampaignOwnership.admin_created
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Campaign is no longer available for invite acceptance",
      });
    }

    const email = invite.email.toLowerCase();
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { brandProfile: true },
    });

    if (!user) {
      if (!dto.password) {
        return { needsSignup: true as const };
      }

      const companyName =
        dto.companyName?.trim() || dto.displayName?.trim() || email.split("@")[0]!;

      const passwordHash = await bcrypt.hash(dto.password, 12);
      const created = await this.prisma.user.create({
        data: {
          role: UserRole.brand,
          email,
          passwordHash,
          displayName: dto.displayName?.trim() || companyName,
          termsAcceptedAt: new Date(),
        },
      });

      await this.prisma.$transaction([
        this.prisma.brandProfile.create({
          data: { userId: created.id, companyName },
        }),
        this.prisma.wallet.create({ data: { userId: created.id } }),
      ]);

      user = await this.prisma.user.findUniqueOrThrow({
        where: { id: created.id },
        include: { brandProfile: true },
      });
    } else if (user.role !== UserRole.brand) {
      throw new ConflictException({
        code: "WRONG_PORTAL",
        message: "This email is not registered as a brand account",
      });
    } else if (!user.brandProfile) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Brand profile not found for this account",
      });
    }

    const brandProfileId = user.brandProfile!.id;
    const now = new Date();

    const [updatedCampaign] = await this.prisma.$transaction([
      this.prisma.campaign.update({
        where: { id: invite.campaignId },
        data: {
          brandProfileId,
          inviteAcceptedAt: now,
        },
        include: {
          brandProfile: { select: { id: true, companyName: true } },
        },
      }),
      this.prisma.campaignInvite.update({
        where: { id: invite.id },
        data: {
          status: CampaignInviteStatus.accepted,
          acceptedAt: now,
          acceptedByUserId: user.id,
        },
      }),
    ]);

    const session = await this.auth.createSessionForUser(user.id);

    const formattedCampaign = {
      id: updatedCampaign.id,
      title: updatedCampaign.title,
      status: updatedCampaign.status,
      ownership: updatedCampaign.ownership,
      brandProfileId: updatedCampaign.brandProfileId,
      brandCompanyName: updatedCampaign.brandProfile?.companyName ?? null,
      inviteAcceptedAt: updatedCampaign.inviteAcceptedAt?.toISOString() ?? null,
    };

    this.realtime.emitCampaignInviteAccepted(
      {
        id: invite.id,
        email: invite.email,
        status: CampaignInviteStatus.accepted,
        campaignId: invite.campaignId,
      },
      formattedCampaign,
    );

    return { ...session, campaign: formattedCampaign };
  }

  async sendInvite(
    adminUserId: string,
    campaignId: string,
    email: string,
  ) {
    assertInvitesOpen();
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }

    if (
      campaign.ownership !== CampaignOwnership.admin_created ||
      campaign.status !== CampaignStatus.draft
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invites can only be sent for admin-created draft campaigns",
      });
    }

    if (campaign.inviteAcceptedAt) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Campaign already has an accepted brand invite",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const ttlMs = parseDurationMs(
      this.config.get("BRAND_INVITE_TTL", { infer: true }),
    );
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashRefreshToken(rawToken);

    await this.prisma.campaignInvite.updateMany({
      where: {
        campaignId,
        status: CampaignInviteStatus.pending,
      },
      data: { status: CampaignInviteStatus.revoked },
    });

    const invite = await this.prisma.campaignInvite.create({
      data: {
        campaignId,
        email: normalizedEmail,
        tokenHash,
        expiresAt: new Date(Date.now() + ttlMs),
        invitedByUserId: adminUserId,
      },
    });

    await this.email.sendCampaignInvite(
      normalizedEmail,
      rawToken,
      campaign.title,
    );

    const payload = {
      id: invite.id,
      campaignId: invite.campaignId,
      email: invite.email,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
    };

    this.realtime.emitCampaignInviteSent(payload);

    return payload;
  }

  async listInvites(campaignId: string) {
    const invites = await this.prisma.campaignInvite.findMany({
      where: { campaignId },
      orderBy: { createdAt: "desc" },
    });
    return invites.map((i) => ({
      id: i.id,
      campaignId: i.campaignId,
      email: i.email,
      status: i.status,
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async revokeInvite(campaignId: string, inviteId: string) {
    const invite = await this.prisma.campaignInvite.findFirst({
      where: { id: inviteId, campaignId },
    });
    if (!invite) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Invite not found",
      });
    }
    if (invite.status !== CampaignInviteStatus.pending) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Only pending invites can be revoked",
      });
    }

    await this.prisma.campaignInvite.update({
      where: { id: inviteId },
      data: { status: CampaignInviteStatus.revoked },
    });

    return { revoked: true, id: inviteId };
  }

  private async findInviteByToken(token: string) {
    if (!token?.trim()) return null;
    const tokenHash = hashRefreshToken(token);
    return this.prisma.campaignInvite.findUnique({
      where: { tokenHash },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            status: true,
            ownership: true,
            brandProfileId: true,
          },
        },
      },
    });
  }
}
