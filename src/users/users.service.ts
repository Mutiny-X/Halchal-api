import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { KycStatus, Prisma, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { ApifyService } from "../common/apify.service";
import { PrismaService } from "../prisma/prisma.service";
import { CashfreeVerificationService } from "../verification/cashfree-verification.service";

const BADGE_THRESHOLDS_PAISE = [
  { tier: "platinum", minPaise: 10_000_000 },
  { tier: "gold", minPaise: 2_500_000 },
  { tier: "silver", minPaise: 500_000 },
] as const;

export function badgeTierFor(lifetimePaise: number): string {
  for (const { tier, minPaise } of BADGE_THRESHOLDS_PAISE) {
    if (lifetimePaise >= minPaise) return tier;
  }
  return "bronze";
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeStreakDays(liveSubmittedAts: Date[]): number {
  const dates = new Set(liveSubmittedAts.map(dateKey));
  if (dates.size === 0) return 0;

  const cursor = new Date();
  if (!dates.has(dateKey(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let streak = 0;
  while (dates.has(dateKey(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apify: ApifyService,
    private readonly cashfree: CashfreeVerificationService,
  ) {}

  async getMe(userId: string, role: UserRole) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { brandProfile: true },
    });

    if (!user) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    const base = {
      id: user.id,
      role: user.role,
      email: user.email,
      phone: user.phone,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      username: user.username,
      kycStatus: user.kycStatus,
      kycDocumentUrl: user.kycDocumentUrl,
      kycRejectionReason: user.kycRejectionReason,
      companyName: user.brandProfile?.companyName ?? null,
      bio: user.bio,
      socialLinks: (user.socialLinks as Record<string, string> | null) ?? null,
      socialStats: (user.socialStats as Record<string, unknown> | null) ?? null,
      requiresOnboardingGate: user.requiresOnboardingGate,
      // Permanent, assigned once on first Instagram verification — see
      // ensureVerifiedCreatorId. Null until then.
      verifiedCreatorId: user.verifiedCreatorId,
      // Instagram-only for now — PAN/Aadhaar auto-verification (via
      // Cashfree) stays fully built and submittable, just not required to
      // clear the gate, since the Cashfree account's balance is currently
      // blocking real submissions. Re-add the PAN/Aadhaar conditions here
      // once that's sorted and the mobile screen re-exposes those steps.
      onboardingGateCleared:
        !user.requiresOnboardingGate || user.instagramReviewStatus === KycStatus.verified,
      onboarding: {
        panStatus: user.panVerificationStatus,
        panFailureReason: user.panFailureReason,
        aadhaarStatus: user.aadhaarVerificationStatus,
        aadhaarFailureReason: user.aadhaarFailureReason,
        instagramReviewStatus: user.instagramReviewStatus,
        instagramRejectionReason: user.instagramRejectionReason,
      },
    };

    if (role === UserRole.brand && user.brandProfile) {
      return {
        ...base,
        brandProfile: {
          id: user.brandProfile.id,
          companyName: user.brandProfile.companyName,
          logoUrl: user.brandProfile.logoUrl,
        },
      };
    }

    if (role === UserRole.creator) {
      const [wallet, liveDates] = await Promise.all([
        this.prisma.wallet.findUnique({ where: { userId }, select: { lifetimePaise: true } }),
        this.prisma.formatDeliverable.findMany({
          where: { participation: { creatorId: userId }, liveSubmittedAt: { not: null } },
          select: { liveSubmittedAt: true },
        }),
      ]);

      return {
        ...base,
        badgeTier: badgeTierFor(wallet?.lifetimePaise ?? 0),
        currentStreakDays: computeStreakDays(
          liveDates.map((d) => d.liveSubmittedAt!),
        ),
      };
    }

    return base;
  }

  async updateBrandProfile(
    userId: string,
    data: { companyName?: string; displayName?: string; logoUrl?: string },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { brandProfile: true },
    });
    if (!user?.brandProfile) {
      throw new BadRequestException({ code: "FORBIDDEN", message: "No brand profile found" });
    }

    const [updatedProfile, updatedUser] = await this.prisma.$transaction([
      this.prisma.brandProfile.update({
        where: { id: user.brandProfile.id },
        data: {
          ...(data.companyName !== undefined && { companyName: data.companyName }),
          ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(data.displayName !== undefined && { displayName: data.displayName }),
        },
      }),
    ]);

    return {
      companyName: updatedProfile.companyName,
      logoUrl: updatedProfile.logoUrl,
      displayName: updatedUser.displayName,
    };
  }

  async updateProfile(
    userId: string,
    data: {
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      socialLinks?: Record<string, string>;
    },
  ) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.bio !== undefined && { bio: data.bio }),
        ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
        ...(data.socialLinks !== undefined && {
          socialLinks: data.socialLinks as Prisma.InputJsonValue,
        }),
      },
    });

    return {
      displayName: updated.displayName,
      phone: updated.phone,
      bio: updated.bio,
      avatarUrl: updated.avatarUrl,
      socialLinks: (updated.socialLinks as Record<string, string> | null) ?? null,
    };
  }

  async fetchAndStoreSocialStats(
    userId: string,
    platform: "instagram" | "youtube" | "twitter",
    handleOrUrl: string,
  ) {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { socialStats: true, socialLinks: true },
    });

    const currentLinks = (existing?.socialLinks as Record<string, string> | null) ?? {};

    // Save the handle immediately so it persists even if scraping fails
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        socialLinks: { ...currentLinks, [platform]: handleOrUrl } as Prisma.InputJsonValue,
      },
    });

    // Kick off Apify scraping in the background — don't block the response
    this._scrapeAndStoreStats(userId, platform, handleOrUrl).catch(() => {});

    return { platform, handle: handleOrUrl, status: "fetching" };
  }

  async disconnectSocial(userId: string, platform: string) {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { socialLinks: true, socialStats: true },
    });
    const links = { ...((existing?.socialLinks as Record<string, string> | null) ?? {}) };
    const stats = { ...((existing?.socialStats as Record<string, unknown> | null) ?? {}) };
    delete links[platform];
    delete stats[platform];
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        socialLinks: Object.keys(links).length ? (links as Prisma.InputJsonValue) : Prisma.DbNull,
        socialStats: Object.keys(stats).length ? (stats as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    return { platform, status: "disconnected" };
  }

  private async _scrapeAndStoreStats(
    userId: string,
    platform: "instagram" | "youtube" | "twitter",
    handleOrUrl: string,
  ) {
    let stats = await this.apify.getSocialProfileStats(platform, handleOrUrl);

    // If Apify fails entirely, save a minimal fallback so the user isn't stuck
    // in "pending" state indefinitely — shows as connected with 0 stats.
    if (!stats) {
      const handle = handleOrUrl.trim().replace(/^@/, "").split("/").filter(Boolean).pop()?.split("?")[0] ?? handleOrUrl;
      stats = {
        platform,
        handle,
        displayName: null,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        profilePicUrl: null,
        bio: null,
        fetchedAt: new Date().toISOString(),
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { socialStats: true },
    });
    const currentStats = (user?.socialStats as Record<string, unknown> | null) ?? {};

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        socialStats: { ...currentStats, [platform]: stats } as Prisma.InputJsonValue,
      },
    });
  }

  async submitKyc(userId: string, documentUrl: string, documentType: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "User not found" });
    }
    if (user.kycStatus === KycStatus.verified) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "KYC is already verified",
      });
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        kycDocumentUrl: documentUrl,
        kycDocumentType: documentType,
        kycStatus: KycStatus.pending,
        kycSubmittedAt: new Date(),
        kycRejectionReason: null,
      },
    });

    return {
      kycStatus: updated.kycStatus,
      kycDocumentUrl: updated.kycDocumentUrl,
      kycSubmittedAt: updated.kycSubmittedAt?.toISOString() ?? null,
    };
  }

  /** Real-time PAN verification for the signup gate, via Cashfree — a
   * single synchronous call, so this goes straight from not_started to
   * verified/rejected (no separate pending write in between). Accepting
   * every "valid: true" PAN unconditionally would miss the actual fraud
   * case that matters here: a real, active PAN number that just isn't
   * this person's own (someone else's, found/stolen) — Cashfree's
   * name_match_result is what actually tells the two apart, so this
   * gates on that too, not just PAN validity alone. */
  /** Real-time PAN verification for the signup gate, via Cashfree's Smart
   * OCR against an uploaded photo (do_verification requests the real-time
   * ITD lookup in the same call). Note: name_match here confirms the
   * card's printed name matches its own ITD-registered name — proving the
   * card is genuine — not that it belongs to this specific app user; there
   * is no independent binding to the account holder's identity the way a
   * typed-PAN + claimed-name comparison would give. */
  async submitPan(userId: string, documentUrl: string, imageBuffer: Buffer, mimeType: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "User not found" });
    }

    const verificationId = `pan-${userId}-${randomUUID()}`.slice(0, 50);
    const result = await this.cashfree.verifyPanByOcr(imageBuffer, mimeType, verificationId);
    if (!result) {
      throw new ServiceUnavailableException({
        code: "VERIFICATION_UNAVAILABLE",
        message: "Couldn't reach the verification service — please try again shortly.",
      });
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        panDocumentUrl: documentUrl,
        panNumber: result.valid ? result.panNumber : null,
        panVerificationStatus: result.valid ? KycStatus.verified : KycStatus.rejected,
        panVerifiedName: result.valid ? result.name : null,
        panVerifiedAt: result.valid ? new Date() : null,
        panFailureReason: result.valid ? null : result.reason,
      },
    });

    return {
      panVerificationStatus: updated.panVerificationStatus,
      panFailureReason: updated.panFailureReason,
    };
  }

  /** Real-time Aadhaar verification for the signup gate, via Cashfree's
   * Smart OCR + QR check. Requires the QR to have actually verified
   * (qrVerified) on top of the document itself being valid — a QR-less
   * OCR-only read is a much weaker claim (just "this looks like a real
   * card"), and the whole point of building this over the cheaper
   * plausibility-check alternative was getting real, UIDAI-backed
   * assurance, not settling for OCR alone. */
  async submitAadhaar(userId: string, documentUrl: string, imageBuffer: Buffer, mimeType: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "User not found" });
    }

    const verificationId = `aadhaar-${userId}-${randomUUID()}`.slice(0, 50);
    const result = await this.cashfree.verifyAadhaar(imageBuffer, mimeType, verificationId);
    if (!result) {
      throw new ServiceUnavailableException({
        code: "VERIFICATION_UNAVAILABLE",
        message: "Couldn't reach the verification service — please try again shortly.",
      });
    }

    const verified = result.valid && result.qrVerified;
    const failureReason = !result.valid
      ? result.reason
      : !verified
        ? "Couldn't cryptographically verify this document's QR code — try a clearer, well-lit photo of the front"
        : null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        aadhaarDocumentUrl: documentUrl,
        aadhaarVerificationStatus: verified ? KycStatus.verified : KycStatus.rejected,
        aadhaarVerifiedName: result.valid ? result.name : null,
        aadhaarMaskedNumber: result.valid ? result.maskedNumber : null,
        aadhaarVerifiedAt: verified ? new Date() : null,
        aadhaarFailureReason: failureReason,
      },
    });

    return {
      aadhaarVerificationStatus: updated.aadhaarVerificationStatus,
      aadhaarFailureReason: updated.aadhaarFailureReason,
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Password login is not enabled for this account",
      });
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Current password is incorrect",
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { changed: true };
  }

  async deleteMe(userId: string) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      // This is a soft delete (the User row survives with isActive:false
      // below), so the schema's onDelete:Cascade on these two relations
      // never fires — without this, a deleted user's platformUserId claim
      // on their Instagram/YouTube account stays isConnected:true forever,
      // permanently blocking that same platform account from reconnecting
      // under a new signup (confirmed live: deleting and re-signing up
      // didn't resolve an Instagram "already linked to another account"
      // error, because the stale row was never actually anyone's problem
      // to begin with — it belonged to this now-deleted account).
      this.prisma.instagramConnection.deleteMany({ where: { userId } }),
      this.prisma.youtubeConnection.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          isActive: false,
          email: null,
          phone: null,
          username: null,
          displayName: `deleted_${userId.slice(0, 8)}`,
          avatarUrl: null,
          bio: null,
          socialLinks: Prisma.JsonNull,
          socialStats: Prisma.JsonNull,
          kycDocumentUrl: null,
        },
      }),
    ]);
    return { deleted: true };
  }
}
