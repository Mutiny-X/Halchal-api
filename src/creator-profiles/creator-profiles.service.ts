import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { ApifyService } from "../common/apify.service";
import { RealtimeService } from "../realtime/realtime.service";
import type { CreateCreatorProfileDto } from "./dto/creator-profile.dto";

@Injectable()
export class CreatorProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apify: ApifyService,
    private readonly realtime: RealtimeService,
  ) {}

  private format(profile: {
    id: string;
    platform: string;
    handle: string;
    label: string | null;
    avatarUrl: string | null;
    isDefault: boolean;
    socialLinks?: Prisma.JsonValue | null;
    socialStats?: Prisma.JsonValue | null;
  }) {
    return {
      id: profile.id,
      platform: profile.platform,
      handle: profile.handle,
      label: profile.label,
      avatarUrl: profile.avatarUrl,
      isDefault: profile.isDefault,
      socialLinks: (profile.socialLinks as Record<string, string> | null) ?? {},
      socialStats: (profile.socialStats as Record<string, unknown> | null) ?? {},
    };
  }

  async list(userId: string) {
    const [profiles, user] = await Promise.all([
      this.prisma.creatorProfile.findMany({
        where: { userId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { socialStats: true },
      }),
    ]);

    const userStats = (user?.socialStats as Record<string, unknown> | null) ?? {};

    // Backfill profiles that have socialLinks but missing socialStats — copy from global user stats
    const backfills: Promise<unknown>[] = [];
    for (const profile of profiles) {
      const links = (profile.socialLinks as Record<string, string> | null) ?? {};
      const stats = (profile.socialStats as Record<string, unknown> | null) ?? {};
      const missing = Object.keys(links).filter((p) => !stats[p] && userStats[p]);
      if (missing.length > 0) {
        const merged = { ...stats };
        for (const p of missing) merged[p] = userStats[p];
        backfills.push(
          this.prisma.creatorProfile
            .update({ where: { id: profile.id }, data: { socialStats: merged as Prisma.InputJsonValue } })
            .then(() => { profile.socialStats = merged as Prisma.JsonValue; }),
        );
      }
    }
    if (backfills.length > 0) await Promise.all(backfills);

    return profiles.map((p) => this.format(p));
  }

  async create(userId: string, dto: CreateCreatorProfileDto) {
    const existing = await this.prisma.creatorProfile.findUnique({
      where: {
        userId_platform_handle: {
          userId,
          platform: dto.platform,
          handle: dto.handle,
        },
      },
    });
    if (existing) {
      throw new ConflictException({
        code: "CONFLICT",
        message: "This handle is already linked to your account",
      });
    }

    const count = await this.prisma.creatorProfile.count({ where: { userId } });
    const profile = await this.prisma.creatorProfile.create({
      data: {
        userId,
        platform: dto.platform,
        handle: dto.handle,
        label: dto.label,
        isDefault: count === 0,
      },
    });
    return this.format(profile);
  }

  async setDefault(userId: string, profileId: string) {
    const profile = await this.prisma.creatorProfile.findFirst({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Profile not found",
      });
    }

    await this.prisma.$transaction([
      this.prisma.creatorProfile.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.creatorProfile.update({
        where: { id: profileId },
        data: { isDefault: true },
      }),
    ]);

    return { ok: true };
  }

  async delete(userId: string, profileId: string) {
    const profile = await this.prisma.creatorProfile.findFirst({
      where: { id: profileId, userId },
      include: { _count: { select: { participations: true } } },
    });
    if (!profile) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Profile not found",
      });
    }
    if (profile._count.participations > 0) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "This profile has campaign history and can't be removed",
      });
    }

    await this.prisma.creatorProfile.delete({ where: { id: profileId } });

    if (profile.isDefault) {
      const next = await this.prisma.creatorProfile.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });
      if (next) {
        await this.prisma.creatorProfile.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }

    return { ok: true };
  }

  async connectSocial(
    userId: string,
    profileId: string,
    platform: "instagram" | "youtube" | "twitter",
    handleOrUrl: string,
  ) {
    // Refuses anything that isn't a username or a link on the platform's
    // own domain, before it is stored and shown to admins as a link.
    this.apify.normalizeProfileUrl(platform, handleOrUrl);

    const [profile, user] = await Promise.all([
      this.assertOwnership(userId, profileId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { socialStats: true },
      }),
    ]);

    const currentLinks = (profile.socialLinks as Record<string, string> | null) ?? {};
    const currentProfileStats = (profile.socialStats as Record<string, unknown> | null) ?? {};
    const userStats = (user?.socialStats as Record<string, unknown> | null) ?? {};
    const existingStats = userStats[platform];

    const updateData: Prisma.CreatorProfileUpdateInput = {
      socialLinks: { ...currentLinks, [platform]: handleOrUrl } as Prisma.InputJsonValue,
    };

    // Copy stats from global user profile if they already exist — avoids waiting for Apify re-scrape
    if (existingStats) {
      updateData.socialStats = { ...currentProfileStats, [platform]: existingStats } as Prisma.InputJsonValue;
    }

    await this.prisma.creatorProfile.update({ where: { id: profileId }, data: updateData });

    if (!existingStats) {
      // No existing stats — kick off Apify scraping in background
      this._scrapeAndStoreStats(userId, profileId, platform, handleOrUrl).catch(() => {});
    }

    return { platform, handle: handleOrUrl, status: existingStats ? "ready" : "fetching" };
  }

  async disconnectSocial(userId: string, profileId: string, platform: string) {
    const profile = await this.assertOwnership(userId, profileId);
    const links = { ...((profile.socialLinks as Record<string, string> | null) ?? {}) };
    const stats = { ...((profile.socialStats as Record<string, unknown> | null) ?? {}) };
    delete links[platform];
    delete stats[platform];

    await this.prisma.creatorProfile.update({
      where: { id: profileId },
      data: {
        socialLinks: Object.keys(links).length ? (links as Prisma.InputJsonValue) : {},
        socialStats: Object.keys(stats).length ? (stats as Prisma.InputJsonValue) : {},
      },
    });
    return { platform, status: "disconnected" };
  }

  private async _scrapeAndStoreStats(
    userId: string,
    profileId: string,
    platform: "instagram" | "youtube" | "twitter",
    handleOrUrl: string,
  ) {
    let stats = await this.apify.getSocialProfileStats(platform, handleOrUrl);

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

    const profile = await this.prisma.creatorProfile.findUnique({
      where: { id: profileId },
      select: { socialStats: true },
    });
    const currentStats = (profile?.socialStats as Record<string, unknown> | null) ?? {};

    await this.prisma.creatorProfile.update({
      where: { id: profileId },
      data: { socialStats: { ...currentStats, [platform]: stats } as Prisma.InputJsonValue },
    });

    this.realtime.emitCreatorProfileStatsUpdated(userId, profileId, platform);
  }

  /** Ensures the profile belongs to the user, throwing NOT_FOUND otherwise. */
  async assertOwnership(userId: string, profileId: string) {
    const profile = await this.prisma.creatorProfile.findFirst({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Creator profile not found",
      });
    }
    return profile;
  }
}
