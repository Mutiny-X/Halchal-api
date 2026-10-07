import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KycStatus, Prisma } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { PlatformViewResult } from "../common/apify.service";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { CreatorProfilesService } from "./creator-profiles.service";

const OAUTH_TTL_MS = 10 * 60 * 1000;
const INSTAGRAM_CALLBACK_SCHEME = "halchal://instagram-callback";

type InstagramTokenResponse = {
  access_token?: string;
  user_id?: string;
  permissions?: string[];
  error?: InstagramGraphError;
};

type InstagramLongTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: InstagramGraphError;
};

type InstagramGraphError = {
  message?: string;
  code?: number;
  type?: string;
};

type InstagramProfileResponse = {
  id: string;
  user_id?: string;
  username?: string;
  name?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  account_type?: string;
  biography?: string;
  website?: string;
  error?: InstagramGraphError;
};

type InstagramMediaItem = {
  id: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  timestamp?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
};

type InstagramMediaResponse = {
  data?: InstagramMediaItem[];
  paging?: { next?: string };
  error?: InstagramGraphError;
};

/** One value per distinct dimension value (e.g. age band, city name) within
 * a single breakdown dimension — counts, not percentages; see
 * aggregateDemographicBreakdown for how these get normalized for display. */
export type FollowerDemographicsBreakdown = {
  age: Record<string, number>;
  gender: Record<string, number>;
  city: Record<string, number>;
  country: Record<string, number>;
};

type FollowerDemographicsResponse = {
  data?: Array<{
    total_value?: {
      breakdowns?: Array<{
        dimension_keys?: string[];
        results?: Array<{ dimension_values?: string[]; value?: number }>;
      }>;
    };
  }>;
  error?: InstagramGraphError;
};

type InstagramInsights = {
  igUserId: string;
  username: string;
  displayName: string | null;
  followerCount: number;
  followsCount: number;
  mediaCount: number;
  profilePictureUrl: string | null;
  accountType: string | null;
  biography: string | null;
  website: string | null;
  engagementRate: number;
  avgLikes: number;
  avgComments: number;
  topPosts: Array<{
    permalink: string;
    mediaType: string;
    likeCount: number;
    commentsCount: number;
    timestamp: string | null;
    thumbnail: string | null;
  }>;
  fetchedAt: string;
};

/** Per-post metrics Instagram actually reported — a field is left out, not
 * zeroed, when Instagram didn't return it, so a partial response never
 * overwrites a previously-known value with a fake 0. */
export type InstagramPostInsights = Partial<Omit<PlatformViewResult, "platform">> & {
  platform: "instagram";
  /** Saves aren't stored on the deliverable itself — only in its history
   * snapshot rows, which is what the campaign report reads. */
  saveCount?: number;
  /** Instagram's own id for the matched media item. */
  platformMediaId?: string;
  /** Every metric Instagram returned, by its own name, for the audit trail. */
  rawMetrics?: Record<string, number>;
};

function oauthId(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenExpiry(expiresIn?: number): Date | null {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

/** Extracts the shortcode from an Instagram post/reel URL (the part that
 * uniquely identifies it — e.g. "Cxyz123" from ".../reel/Cxyz123/?utm=..."),
 * so a creator-submitted live post URL can be matched against the
 * account's own media permalinks regardless of trailing slash, query
 * params, or www./non-www. differences. Returns null for a URL that isn't
 * a recognizable Instagram post/reel link. */
function extractInstagramShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

@Injectable()
export class InstagramOAuthService {
  private readonly logger = new Logger(InstagramOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: CreatorProfilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async start(userId: string, creatorProfileId: string) {
    this.requireConfig();
    await this.profiles.assertOwnership(userId, creatorProfileId);

    const transactionId = oauthId();
    const state = oauthId(32);
    const stateHash = sha256(state);
    const expiresAt = new Date(Date.now() + OAUTH_TTL_MS);

    await this.prisma.instagramOAuthTransaction.create({
      data: {
        transactionId,
        stateHash,
        userId,
        creatorProfileId,
        expiresAt,
      },
    });

    const authorizationUrl = this.buildAuthorizationUrl(state);
    this.logger.log(
      `Instagram OAuth started for profile ${creatorProfileId}; transaction=${transactionId}`,
    );

    return {
      authorizationUrl,
      transactionId,
      expiresAt: expiresAt.toISOString(),
      graphApiVersion: this.graphVersion,
    };
  }

  async callback(query: {
    state?: string;
    code?: string;
    error?: string;
    error_reason?: string;
  }) {
    const transaction = query.state
      ? await this.prisma.instagramOAuthTransaction.findUnique({
          where: { stateHash: sha256(query.state) },
        })
      : null;

    if (!transaction) {
      return this.callbackHtml("error", undefined, "OAUTH_STATE_INVALID");
    }

    if (transaction.expiresAt.getTime() < Date.now()) {
      await this.markTransactionError(transaction.id, "OAUTH_TRANSACTION_EXPIRED");
      return this.callbackHtml(
        "error",
        transaction.transactionId,
        "OAUTH_TRANSACTION_EXPIRED",
      );
    }

    if (query.error || query.error_reason || !query.code) {
      const code =
        query.error === "access_denied" || query.error_reason === "user_denied"
          ? "OAUTH_CANCELLED"
          : "META_PERMISSION_DENIED";
      await this.markTransactionError(transaction.id, code);
      return this.callbackHtml("error", transaction.transactionId, code);
    }

    try {
      const token = await this.exchangeCode(query.code);
      await this.prisma.instagramOAuthTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "ready",
          encryptedAccessToken: this.encrypt(token.accessToken),
          tokenExpiresAt: token.expiresAt,
          dataAccessExpiresAt: token.expiresAt,
          errorCode: null,
        },
      });
      return this.callbackHtml("ready", transaction.transactionId);
    } catch (error) {
      this.logger.warn(
        `Instagram OAuth callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.markTransactionError(
        transaction.id,
        error instanceof ConflictException ? "META_RATE_LIMITED" : "INSTAGRAM_ACCOUNT_UNAVAILABLE",
      );
      return this.callbackHtml(
        "error",
        transaction.transactionId,
        error instanceof ConflictException
          ? "META_RATE_LIMITED"
          : "INSTAGRAM_ACCOUNT_UNAVAILABLE",
      );
    }
  }

  async complete(userId: string, creatorProfileId: string, transactionId: string) {
    this.requireConfig();
    await this.profiles.assertOwnership(userId, creatorProfileId);

    const transaction = await this.prisma.instagramOAuthTransaction.findUnique({
      where: { transactionId },
    });
    if (!transaction) {
      throw new GoneException({
        code: "OAUTH_TRANSACTION_EXPIRED",
        message: "Instagram connection session expired. Please connect again.",
      });
    }
    if (
      transaction.userId !== userId ||
      transaction.creatorProfileId !== creatorProfileId
    ) {
      throw new BadRequestException({
        code: "OAUTH_STATE_INVALID",
        message: "Instagram connection session is invalid.",
      });
    }
    if (transaction.status === "completed") {
      const connection = await this.prisma.instagramConnection.findUnique({
        where: { creatorProfileId },
      });
      return {
        connected: true as const,
        handle: connection?.platformHandle ?? "",
        lastSyncedAt:
          connection?.lastSyncedAt.toISOString() ?? transaction.completedAt?.toISOString() ?? "",
      };
    }
    if (transaction.expiresAt.getTime() < Date.now()) {
      throw new GoneException({
        code: "OAUTH_TRANSACTION_EXPIRED",
        message: "Instagram connection session expired. Please connect again.",
      });
    }
    if (transaction.status !== "ready" || !transaction.encryptedAccessToken) {
      throw new ConflictException({
        code: "OAUTH_NOT_READY",
        message: "Instagram authorization is not ready yet.",
      });
    }

    const accessToken = this.decrypt(transaction.encryptedAccessToken);
    const insights = await this.fetchProfileAndMedia(accessToken);
    const lastSyncedAt = new Date();
    const stats = this.toSocialStats(insights);

    await this.prisma.$transaction(async (tx) => {
      const profile = await tx.creatorProfile.findFirst({
        where: { id: creatorProfileId, userId },
        select: { socialLinks: true, socialStats: true },
      });
      if (!profile) {
        throw new NotFoundException({
          code: "NOT_FOUND",
          message: "Creator profile not found",
        });
      }

      const links = (profile.socialLinks as Record<string, string> | null) ?? {};
      const currentStats =
        (profile.socialStats as Record<string, unknown> | null) ?? {};

      // platformUserId is Instagram's stable numeric account ID (not the
      // @handle, which the Instagram user can rename) — the only thing
      // safe to compare across users. Without this, nothing (app code or
      // the DB schema — creatorProfileId is @unique on this table, but
      // platformUserId isn't) stops the same Instagram account from being
      // connected to two different Halchal users at once.
      //
      // Must also exclude the current userId, not just creatorProfileId —
      // CreatorProfile is unique per (userId, platform, handle), not per
      // user, so one Halchal account can hold several profiles. A stale
      // isConnected:true row left on this same user's OTHER profile (e.g.
      // disconnected via one profile/screen but never cleared on another)
      // would otherwise look identical to a genuine different-user
      // conflict and wrongly block reconnecting your own account.
      const conflicting = await tx.instagramConnection.findFirst({
        where: {
          platformUserId: insights.igUserId,
          isConnected: true,
          NOT: { creatorProfileId },
          userId: { not: userId },
        },
        select: { id: true },
      });
      if (conflicting) {
        throw new ConflictException({
          code: "INSTAGRAM_ACCOUNT_ALREADY_LINKED",
          message:
            "This Instagram account is already connected to another Halchal account.",
        });
      }

      await tx.instagramConnection.upsert({
        where: { creatorProfileId },
        create: {
          userId,
          creatorProfileId,
          platformUserId: insights.igUserId,
          platformHandle: insights.username,
          encryptedAccessToken: transaction.encryptedAccessToken!,
          tokenExpiresAt: transaction.tokenExpiresAt,
          dataAccessExpiresAt: transaction.dataAccessExpiresAt,
          followerCount: insights.followerCount,
          followsCount: insights.followsCount,
          mediaCount: insights.mediaCount,
          engagementRate: insights.engagementRate,
          profilePictureUrl: insights.profilePictureUrl,
          metadata: this.toConnectionMetadata(insights) as Prisma.InputJsonValue,
          isConnected: true,
          lastSyncedAt,
        },
        update: {
          platformUserId: insights.igUserId,
          platformHandle: insights.username,
          encryptedAccessToken: transaction.encryptedAccessToken!,
          tokenExpiresAt: transaction.tokenExpiresAt,
          dataAccessExpiresAt: transaction.dataAccessExpiresAt,
          followerCount: insights.followerCount,
          followsCount: insights.followsCount,
          mediaCount: insights.mediaCount,
          engagementRate: insights.engagementRate,
          profilePictureUrl: insights.profilePictureUrl,
          metadata: this.toConnectionMetadata(insights) as Prisma.InputJsonValue,
          isConnected: true,
          lastSyncedAt,
        },
      });

      await tx.creatorProfile.update({
        where: { id: creatorProfileId },
        data: {
          handle: insights.username,
          socialLinks: {
            ...links,
            instagram: `https://www.instagram.com/${insights.username}/`,
          } as Prisma.InputJsonValue,
          socialStats: {
            ...currentStats,
            instagram: stats,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.instagramOAuthTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "completed",
          completedAt: lastSyncedAt,
        },
      });

      // A previously-rejected clipper reconnecting (same or a different
      // account — the upsert above already replaced whatever was there)
      // is a fresh submission and needs a human to look at it again. Only
      // touches the rejected case — an already-verified creator updating
      // their linked account elsewhere in the app (connected_accounts_screen)
      // shouldn't get bounced back into review just for that.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { instagramReviewStatus: true },
      });
      if (user?.instagramReviewStatus === KycStatus.rejected) {
        await tx.user.update({
          where: { id: userId },
          data: {
            instagramReviewStatus: KycStatus.pending,
            instagramRejectionReason: null,
            instagramReviewedAt: null,
            instagramReviewedByUserId: null,
          },
        });
      }
    });

    return {
      connected: true as const,
      handle: insights.username,
      lastSyncedAt: lastSyncedAt.toISOString(),
    };
  }

  async disconnect(userId: string, creatorProfileId: string) {
    const profile = await this.profiles.assertOwnership(userId, creatorProfileId);
    const links = { ...((profile.socialLinks as Record<string, string> | null) ?? {}) };
    const stats = { ...((profile.socialStats as Record<string, unknown> | null) ?? {}) };
    delete links.instagram;
    delete stats.instagram;

    await this.prisma.$transaction([
      this.prisma.instagramConnection.updateMany({
        where: { userId, creatorProfileId },
        data: { isConnected: false },
      }),
      this.prisma.creatorProfile.update({
        where: { id: creatorProfileId },
        data: {
          socialLinks: links as Prisma.InputJsonValue,
          socialStats: stats as Prisma.InputJsonValue,
        },
      }),
    ]);

    return { platform: "instagram", status: "disconnected" };
  }

  private requireConfig() {
    if (!this.instagramAppId || !this.instagramAppSecret || !this.instagramRedirectUri) {
      throw new ConflictException({
        code: "INSTAGRAM_OAUTH_NOT_CONFIGURED",
        message: "Instagram OAuth is not configured on the API.",
      });
    }
  }

  private buildAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.instagramAppId,
      redirect_uri: this.instagramRedirectUri,
      response_type: "code",
      scope: this.instagramScopes,
      state,
      enable_fb_login: "0",
      force_authentication: "1",
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  private async exchangeCode(code: string): Promise<{
    accessToken: string;
    expiresAt: Date | null;
  }> {
    const form = new URLSearchParams({
      client_id: this.instagramAppId,
      client_secret: this.instagramAppSecret,
      grant_type: "authorization_code",
      redirect_uri: this.instagramRedirectUri,
      code,
    });
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const shortData = (await shortRes.json()) as InstagramTokenResponse;
    if (!shortRes.ok || shortData.error || !shortData.access_token) {
      throw new BadRequestException({
        code: "INSTAGRAM_TOKEN_EXCHANGE_FAILED",
        message:
          shortData.error?.message ?? "Instagram authorization code exchange failed.",
      });
    }

    const longParams = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.instagramAppSecret,
      access_token: shortData.access_token,
    });
    const longRes = await fetch(
      `https://graph.instagram.com/access_token?${longParams.toString()}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const longData = (await longRes.json()) as InstagramLongTokenResponse;
    if (longRes.status === 429 || longData.error?.code === 4 || longData.error?.code === 613) {
      throw new ConflictException({
        code: "META_RATE_LIMITED",
        message: "Instagram API rate limit reached. Please try again later.",
      });
    }
    if (!longRes.ok || longData.error || !longData.access_token) {
      throw new BadRequestException({
        code: "INSTAGRAM_TOKEN_EXCHANGE_FAILED",
        message: longData.error?.message ?? "Instagram long-lived token exchange failed.",
      });
    }

    return {
      accessToken: longData.access_token,
      expiresAt: tokenExpiry(longData.expires_in),
    };
  }

  private async fetchProfileAndMedia(accessToken: string): Promise<InstagramInsights> {
    const token = encodeURIComponent(accessToken);
    const profileFields =
      "id,user_id,username,name,followers_count,follows_count,media_count,profile_picture_url,account_type,biography,website";
    const mediaFields =
      "id,like_count,comments_count,media_type,timestamp,permalink,thumbnail_url,media_url";
    const profile = await this.instagramGraphFetch<InstagramProfileResponse>(
      `${this.graphBase}/me?fields=${profileFields}&access_token=${token}`,
    );

    const igUserId = profile.user_id ?? profile.id;
    if (!igUserId || !profile.username) {
      throw new BadGatewayException({
        code: "INSTAGRAM_ACCOUNT_UNAVAILABLE",
        message: "Instagram profile data is incomplete.",
      });
    }

    const mediaRes = await this.instagramGraphFetch<InstagramMediaResponse>(
      `${this.graphBase}/${encodeURIComponent(igUserId)}/media?fields=${mediaFields}&limit=25&access_token=${token}`,
    );
    const media = mediaRes.data ?? [];
    const followerCount = profile.followers_count ?? 0;
    const totalLikes = media.reduce((sum, item) => sum + (item.like_count ?? 0), 0);
    const totalComments = media.reduce(
      (sum, item) => sum + (item.comments_count ?? 0),
      0,
    );
    const postCount = media.length;
    const engagementRate =
      postCount > 0 && followerCount > 0
        ? Math.round(((totalLikes + totalComments) / postCount / followerCount) * 10000) / 100
        : 0;

    return {
      igUserId,
      username: profile.username,
      displayName: profile.name ?? null,
      followerCount,
      followsCount: profile.follows_count ?? 0,
      mediaCount: profile.media_count ?? postCount,
      profilePictureUrl: profile.profile_picture_url ?? null,
      accountType: profile.account_type ?? null,
      biography: profile.biography ?? null,
      website: profile.website ?? null,
      engagementRate,
      avgLikes: postCount > 0 ? Math.round(totalLikes / postCount) : 0,
      avgComments: postCount > 0 ? Math.round(totalComments / postCount) : 0,
      topPosts: [...media]
        .sort(
          (a, b) =>
            (b.like_count ?? 0) +
            (b.comments_count ?? 0) -
            ((a.like_count ?? 0) + (a.comments_count ?? 0)),
        )
        .slice(0, 3)
        .map((item) => ({
          permalink: item.permalink ?? "",
          mediaType: item.media_type ?? "UNKNOWN",
          likeCount: item.like_count ?? 0,
          commentsCount: item.comments_count ?? 0,
          timestamp: item.timestamp ?? null,
          thumbnail: item.thumbnail_url ?? item.media_url ?? null,
        })),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async instagramGraphFetch<T extends { error?: InstagramGraphError }>(
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
    const data = (await res.json().catch(() => ({}))) as T;
    if (res.status === 429 || data.error?.code === 4 || data.error?.code === 613) {
      throw new ConflictException({
        code: "META_RATE_LIMITED",
        message: "Instagram API rate limit reached. Please try again later.",
      });
    }
    if (!res.ok || data.error) {
      throw new BadGatewayException({
        code: "INSTAGRAM_GRAPH_FAILED",
        message: data.error?.message ?? "Instagram API request failed.",
      });
    }
    return data;
  }

  /** Returns a currently-valid access token for this profile's connected
   * Instagram account, transparently refreshing it via ig_refresh_token
   * when it's within a week of expiring (Instagram long-lived tokens last
   * ~60 days and don't use OAuth refresh tokens — they're refreshed by
   * re-exchanging the current token itself). */
  async getValidAccessToken(creatorProfileId: string): Promise<string> {
    const connection = await this.prisma.instagramConnection.findUnique({
      where: { creatorProfileId },
    });
    if (!connection || !connection.isConnected) {
      throw new ConflictException({
        code: "INSTAGRAM_NOT_CONNECTED",
        message: "Connect an Instagram account before posting to it.",
      });
    }

    const expiresAt = connection.tokenExpiresAt;
    const needsRefresh =
      !expiresAt || expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
    if (!needsRefresh) {
      return this.decrypt(connection.encryptedAccessToken);
    }

    const refreshed = await this.refreshAccessToken(
      this.decrypt(connection.encryptedAccessToken),
    );
    await this.prisma.instagramConnection.update({
      where: { creatorProfileId },
      data: {
        encryptedAccessToken: this.encrypt(refreshed.accessToken),
        tokenExpiresAt: refreshed.expiresAt,
        dataAccessExpiresAt: refreshed.expiresAt,
      },
    });
    return refreshed.accessToken;
  }

  /** The connected account's current follower count, fetched fresh —
   * deliberately not read off InstagramConnection.followerCount, which only
   * holds whatever was last synced and can be weeks stale. Used to snapshot
   * "followers at time of posting" the moment a creator submits a live-proof
   * link (see ParticipationService.submitLiveProof), so the campaign
   * report's per-reel ledger reflects their reach at that specific moment,
   * not today's number. Returns null on any failure — this must never block
   * a live-proof submission. */
  async getFollowerCount(creatorProfileId: string): Promise<number | null> {
    try {
      const connection = await this.prisma.instagramConnection.findUnique({
        where: { creatorProfileId },
      });
      if (!connection || !connection.isConnected) return null;

      const accessToken = await this.getValidAccessToken(creatorProfileId);
      const token = encodeURIComponent(accessToken);
      const profile = await this.instagramGraphFetch<{
        followers_count?: number;
        error?: InstagramGraphError;
      }>(`${this.graphBase}/me?fields=followers_count&access_token=${token}`);
      return typeof profile.followers_count === "number" ? profile.followers_count : null;
    } catch (err) {
      this.logger.warn(`getFollowerCount failed for profile ${creatorProfileId}: ${err}`);
      return null;
    }
  }

  /** Account-level follower demographics (age, gender, city, country) via
   * Instagram's follower_demographics insights metric — requires the
   * connection's token to carry instagram_business_manage_insights (same
   * scope getMediaInsightsForPost needs) and, per Meta's own documentation,
   * a minimum follower count before the account qualifies for this metric
   * at all. This describes the account's FOLLOWER base, not viewers of any
   * specific post — Instagram has no per-post viewer-demographics API, for
   * anyone, at any permission level. Used by the campaign report's
   * demographics section, aggregated across every participating creator.
   *
   * One call per breakdown dimension (age/gender/city/country) rather than
   * a combined request — the safer choice against an unconfirmed API
   * surface. The exact request/response shape here is built from Meta's
   * documented total_value/breakdown pattern used elsewhere in their
   * Insights API, but has not been exercised against a live account yet;
   * treat the first real call in production as the actual validation, and
   * expect this to need adjustment if Instagram's response shape differs. */
  async getFollowerDemographics(
    creatorProfileId: string,
  ): Promise<FollowerDemographicsBreakdown | null> {
    try {
      const connection = await this.prisma.instagramConnection.findUnique({
        where: { creatorProfileId },
      });
      if (!connection || !connection.isConnected) return null;

      const accessToken = await this.getValidAccessToken(creatorProfileId);
      const token = encodeURIComponent(accessToken);
      const result: FollowerDemographicsBreakdown = { age: {}, gender: {}, city: {}, country: {} };

      for (const dimension of ["age", "gender", "city", "country"] as const) {
        const res = await this.instagramGraphFetch<FollowerDemographicsResponse>(
          `${this.graphBase}/${encodeURIComponent(connection.platformUserId)}/insights` +
            `?metric=follower_demographics&period=lifetime&metric_type=total_value` +
            `&breakdown=${dimension}&access_token=${token}`,
        );
        const buckets = res.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
        for (const bucket of buckets) {
          const key = bucket.dimension_values?.[0];
          if (key && typeof bucket.value === "number") {
            result[dimension][key] = (result[dimension][key] ?? 0) + bucket.value;
          }
        }
      }

      return result;
    } catch (err) {
      this.logger.warn(`getFollowerDemographics failed for profile ${creatorProfileId}: ${err}`);
      return null;
    }
  }

  /** Real, first-party metrics for one specific live post via Instagram's
   * official Insights API — used as a preferred alternative to the Apify
   * scrape when the creator has connected their own Instagram account.
   * Requires the connection's token to actually carry the
   * instagram_business_manage_insights scope, which only creators who
   * *reconnected* after that scope was added to INSTAGRAM_OAUTH_SCOPES will
   * have — an existing connection from before that change doesn't
   * retroactively gain it. Returns null on any failure (no connection,
   * insufficient permission, the post isn't among the account's recent
   * media, network error) so callers can fall back to the existing Apify
   * path rather than break the view-refresh flow. */
  /** Searches a connected account's own media for the item matching a live
   * post's shortcode — shared by getMediaInsightsForPost (metrics) and
   * getOwnLivePostMedia (the actual media file, for auto-review's
   * draft-vs-live comparison). Instagram-only by design — no Apify fallback
   * — so a post simply not being on the first page isn't good enough reason
   * to give up: page further back (100/page, the max this edge allows)
   * until we find it or hit a hard cap on how far we'll look. `fields`
   * lets each caller request only what it actually needs from the match. */
  private async findOwnMediaItem(
    creatorProfileId: string,
    livePostUrl: string,
    fields: string,
  ): Promise<{ item: InstagramMediaItem; accessToken: string } | null> {
    const targetShortcode = extractInstagramShortcode(livePostUrl);
    if (!targetShortcode) return null;

    const connection = await this.prisma.instagramConnection.findUnique({
      where: { creatorProfileId },
    });
    if (!connection || !connection.isConnected) return null;

    const accessToken = await this.getValidAccessToken(creatorProfileId);
    const token = encodeURIComponent(accessToken);

    const maxPages = 5; // up to ~500 most recent posts
    let nextUrl: string | undefined =
      `${this.graphBase}/${encodeURIComponent(connection.platformUserId)}/media?fields=${fields}&limit=100&access_token=${token}`;
    for (let page = 0; page < maxPages && nextUrl; page++) {
      const mediaRes: InstagramMediaResponse =
        await this.instagramGraphFetch<InstagramMediaResponse>(nextUrl);
      const match = (mediaRes.data ?? []).find(
        (m) => m.permalink && extractInstagramShortcode(m.permalink) === targetShortcode,
      );
      if (match) return { item: match, accessToken };
      nextUrl = mediaRes.paging?.next;
    }
    return null;
  }

  async getMediaInsightsForPost(
    creatorProfileId: string,
    livePostUrl: string,
  ): Promise<InstagramPostInsights | null> {
    try {
      const found = await this.findOwnMediaItem(creatorProfileId, livePostUrl, "id,permalink");
      if (!found) {
        this.logger.warn(`No Instagram media match for ${livePostUrl} in profile ${creatorProfileId}'s recent posts`);
        return null;
      }
      const { item: match, accessToken } = found;
      const token = encodeURIComponent(accessToken);

      const metricsRes = await this.instagramGraphFetch<{
        data?: Array<{
          name: string;
          values?: Array<{ value: number }>;
          total_value?: { value: number };
        }>;
        error?: InstagramGraphError;
      }>(
        `${this.graphBase}/${encodeURIComponent(match.id)}/insights?metric=reach,likes,comments,shares,saved,views&access_token=${token}`,
      );
      if (!metricsRes.data) return null;

      // undefined (not 0) when Instagram didn't report a metric — a metric
      // that's absent from the response isn't known to be zero, so callers
      // must be able to tell the two apart and keep whatever they last had.
      const metricValue = (name: string): number | undefined => {
        const entry = metricsRes.data!.find((m) => m.name === name);
        return entry?.total_value?.value ?? entry?.values?.[0]?.value;
      };

      const insights: InstagramPostInsights = { platform: "instagram", platformMediaId: match.id };
      const fields = [
        ["viewCount", "views"],
        ["reach", "reach"],
        ["likeCount", "likes"],
        ["commentCount", "comments"],
        ["shareCount", "shares"],
        ["saveCount", "saved"],
      ] as const;
      let reportedAny = false;
      for (const [key, metric] of fields) {
        const value = metricValue(metric);
        if (value !== undefined) {
          insights[key] = value;
          reportedAny = true;
        }
      }
      // Nothing usable came back at all — same as no data, not a post with
      // zero of everything.
      if (!reportedAny) return null;

      const rawMetrics: Record<string, number> = {};
      for (const entry of metricsRes.data) {
        const value = entry.total_value?.value ?? entry.values?.[0]?.value;
        if (value !== undefined) rawMetrics[entry.name] = value;
      }
      insights.rawMetrics = rawMetrics;
      return insights;
    } catch (err) {
      this.logger.warn(`Instagram Insights fetch failed for ${livePostUrl}: ${err}`);
      return null;
    }
  }

  /** The actual media file for a live post, fetched directly from the
   * connected account's own Graph API data — real, first-party media_url,
   * not a third-party scrape (there is no scrape fallback for this anymore
   * — Apify/HikerAPI's live-media lookup was removed once this replaced
   * it). Only works when the post is the connected account's own (same
   * match this account's Insights use), which is exactly the case
   * auto-review's draft-vs-live comparison needs: by the time it's called,
   * ownership is already independently verified via this same
   * connection. */
  async getOwnLivePostMedia(
    creatorProfileId: string,
    livePostUrl: string,
  ): Promise<{ kind: "video" | "image"; url: string } | null> {
    try {
      const found = await this.findOwnMediaItem(
        creatorProfileId,
        livePostUrl,
        "id,permalink,media_type,media_url,thumbnail_url",
      );
      if (!found) return null;
      const { item } = found;
      if (item.media_type === "VIDEO" && item.media_url) {
        return { kind: "video", url: item.media_url };
      }
      if (item.media_url) return { kind: "image", url: item.media_url };
      if (item.thumbnail_url) return { kind: "image", url: item.thumbnail_url };
      return null;
    } catch (err) {
      this.logger.warn(`getOwnLivePostMedia failed for ${livePostUrl}: ${err}`);
      return null;
    }
  }

  private async refreshAccessToken(
    currentAccessToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const params = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: currentAccessToken,
    });
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?${params.toString()}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const data = (await res.json().catch(() => ({}))) as InstagramLongTokenResponse;
    if (!res.ok || data.error || !data.access_token) {
      throw new ConflictException({
        code: "INSTAGRAM_REAUTH_REQUIRED",
        message:
          data.error?.message ?? "Reconnect your Instagram account to keep posting on your behalf.",
      });
    }
    return { accessToken: data.access_token, expiresAt: tokenExpiry(data.expires_in) };
  }

  /** Publishes a video already hosted at a public `videoUrl` as an Instagram
   * Reel on this profile's connected account: create a media container,
   * poll until Instagram finishes processing it, publish, then read back
   * the permalink. Bounded to ~100s of polling — there's no job queue in
   * this codebase to hand a longer wait off to. */
  async publishReel(
    creatorProfileId: string,
    videoUrl: string,
    caption: string,
  ): Promise<{ permalink: string }> {
    const connection = await this.prisma.instagramConnection.findUnique({
      where: { creatorProfileId },
      select: { platformUserId: true },
    });
    if (!connection) {
      throw new ConflictException({
        code: "INSTAGRAM_NOT_CONNECTED",
        message: "Connect an Instagram account before posting to it.",
      });
    }
    const accessToken = await this.getValidAccessToken(creatorProfileId);
    const igUserId = connection.platformUserId;

    const containerParams = new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: "true",
      access_token: accessToken,
    });
    const container = await this.instagramGraphFetch<{ id?: string; error?: InstagramGraphError }>(
      `${this.graphBase}/${encodeURIComponent(igUserId)}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: containerParams.toString(),
      },
    );
    if (!container.id) {
      throw new BadGatewayException({
        code: "INSTAGRAM_PUBLISH_FAILED",
        message: "Instagram did not return a media container id.",
      });
    }

    await this.pollContainerReady(container.id, accessToken);

    const publishParams = new URLSearchParams({
      creation_id: container.id,
      access_token: accessToken,
    });
    const published = await this.instagramGraphFetch<{ id?: string; error?: InstagramGraphError }>(
      `${this.graphBase}/${encodeURIComponent(igUserId)}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: publishParams.toString(),
      },
    );
    if (!published.id) {
      throw new BadGatewayException({
        code: "INSTAGRAM_PUBLISH_FAILED",
        message: "Instagram did not return a published media id.",
      });
    }

    const permalinkRes = await this.instagramGraphFetch<{
      permalink?: string;
      error?: InstagramGraphError;
    }>(
      `${this.graphBase}/${encodeURIComponent(published.id)}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!permalinkRes.permalink) {
      throw new BadGatewayException({
        code: "INSTAGRAM_PUBLISH_FAILED",
        message: "Instagram did not return a permalink for the published media.",
      });
    }
    return { permalink: permalinkRes.permalink };
  }

  private async pollContainerReady(containerId: string, accessToken: string): Promise<void> {
    const maxAttempts = 20;
    const intervalMs = 5_000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.instagramGraphFetch<{
        status_code?: string;
        error?: InstagramGraphError;
      }>(
        `${this.graphBase}/${encodeURIComponent(containerId)}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      );
      if (status.status_code === "FINISHED") return;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw new BadGatewayException({
          code: "INSTAGRAM_PUBLISH_FAILED",
          message: `Instagram media processing failed (${status.status_code}).`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new BadGatewayException({
      code: "INSTAGRAM_PUBLISH_TIMEOUT",
      message: "Instagram media processing took too long. Try again shortly.",
    });
  }

  private toSocialStats(insights: InstagramInsights) {
    return {
      platform: "instagram",
      handle: insights.username,
      displayName: insights.displayName,
      followersCount: insights.followerCount,
      followingCount: insights.followsCount,
      postsCount: insights.mediaCount,
      profilePicUrl: insights.profilePictureUrl,
      bio: insights.biography,
      engagementRate: insights.engagementRate,
      avgLikes: insights.avgLikes,
      avgComments: insights.avgComments,
      accountType: insights.accountType,
      fetchedAt: insights.fetchedAt,
      source: "meta_graph",
      connectMethod: "instagram_login",
    };
  }

  private toConnectionMetadata(insights: InstagramInsights) {
    return {
      connectMethod: "instagram_login",
      source: "meta_graph",
      graphApiVersion: this.graphVersion,
      scopes: this.instagramScopes.split(",").map((scope) => scope.trim()).filter(Boolean),
      displayName: insights.displayName,
      profilePictureUrl: insights.profilePictureUrl,
      accountType: insights.accountType,
      biography: insights.biography,
      website: insights.website,
      avgLikes: insights.avgLikes,
      avgComments: insights.avgComments,
      topPosts: insights.topPosts,
      lastSyncedAt: insights.fetchedAt,
    };
  }

  private callbackHtml(
    status: "ready" | "error",
    transactionId?: string,
    errorCode?: string,
  ): string {
    const params = new URLSearchParams({ status });
    if (transactionId) params.set("transactionId", transactionId);
    if (errorCode) params.set("error", errorCode);
    const deepLink = `${INSTAGRAM_CALLBACK_SCHEME}?${params.toString()}`;
    const title =
      status === "ready" ? "Instagram connected" : "Instagram connection failed";
    const body =
      status === "ready"
        ? "Return to Halchal to finish saving your Instagram account."
        : "Return to Halchal and try connecting Instagram again.";
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${escapeHtml(deepLink)}" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 24px;">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <p><a href="${escapeHtml(deepLink)}">Open Halchal</a></p>
    <script>window.location.href = ${JSON.stringify(deepLink)};</script>
  </body>
</html>`;
  }

  private async markTransactionError(id: string, errorCode: string) {
    await this.prisma.instagramOAuthTransaction.update({
      where: { id },
      data: { status: "error", errorCode },
    });
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  private decrypt(value: string): string {
    const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
    if (!ivRaw || !tagRaw || !encryptedRaw) {
      throw new BadRequestException({
        code: "INSTAGRAM_TOKEN_INVALID",
        message: "Stored Instagram token is invalid.",
      });
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private get instagramAppId(): string {
    return this.config.get("INSTAGRAM_APP_ID", { infer: true }) ?? "";
  }

  private get instagramAppSecret(): string {
    return this.config.get("INSTAGRAM_APP_SECRET", { infer: true }) ?? "";
  }

  private get instagramRedirectUri(): string {
    return this.config.get("INSTAGRAM_REDIRECT_URI", { infer: true }) ?? "";
  }

  private get instagramScopes(): string {
    return this.config.get("INSTAGRAM_OAUTH_SCOPES", { infer: true });
  }

  private get graphVersion(): string {
    return this.config.get("INSTAGRAM_GRAPH_API_VERSION", { infer: true });
  }

  private get graphBase(): string {
    return `https://graph.instagram.com/${this.graphVersion}`;
  }

  private get encryptionKey(): Buffer {
    return createHash("sha256")
      .update(
        this.config.get("INSTAGRAM_TOKEN_ENCRYPTION_KEY", { infer: true }) ??
          this.config.get("JWT_SECRET", { infer: true }),
      )
      .digest();
  }
}
