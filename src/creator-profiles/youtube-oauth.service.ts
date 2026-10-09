import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { Env } from "../config/env";
import { resolvePayoutKeys, type PayoutKeys } from "../payouts/payout-account-crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CreatorProfilesService } from "./creator-profiles.service";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_DATA_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";
const YOUTUBE_CALLBACK_SCHEME = "halchal://youtube-callback";
const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type YoutubeChannelResponse = {
  items?: Array<{
    id: string;
    snippet: {
      title?: string;
      customUrl?: string;
      description?: string;
      thumbnails?: {
        default?: { url?: string };
        high?: { url?: string };
      };
    };
    statistics: {
      subscriberCount?: string;
      videoCount?: string;
      viewCount?: string;
      hiddenSubscriberCount?: boolean;
    };
  }>;
  error?: { message?: string };
};

type YoutubeSearchResponse = {
  items?: Array<{
    id: { videoId: string };
    snippet: {
      title?: string;
      publishedAt?: string;
      thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
    };
  }>;
  error?: { message?: string };
};

type YoutubeVideosResponse = {
  items?: Array<{
    id: string;
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
  }>;
  error?: { message?: string };
};

type YoutubeProfile = {
  channelId: string;
  handle: string;
  displayName: string;
  subscriberCount: number;
  videoCount: number;
  totalViewCount: number;
  profilePictureUrl: string | null;
  biography: string | null;
  engagementRate: number;
  avgViews: number;
  avgLikes: number;
  avgComments: number;
  topVideos: Array<{
    videoId: string;
    title: string;
    thumbnail: string | null;
    publishedAt: string | null;
    viewCount: number;
    likeCount: number;
    commentCount: number;
    permalink: string;
  }>;
  fetchedAt: string;
};

/** How long a started connect attempt stays redeemable. */
const YOUTUBE_OAUTH_TTL_MS = 10 * 60 * 1000;

/** Only the hash of the state is stored, like the Instagram flow. */
function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function oauthId(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function toInt(value: string | number | undefined | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

@Injectable()
export class YoutubeOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: CreatorProfilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Starts a connect attempt. The `state` is always minted here (anything the
   * app sends is ignored) and remembered against this account and profile,
   * together with a PKCE verifier that never leaves the server. The code that
   * comes back can only be redeemed by the same account, once, within 10 minutes.
   */
  async authUrl(userId: string, creatorProfileId: string) {
    this.requireConfig();
    await this.profiles.assertOwnership(userId, creatorProfileId);

    const oauthState = oauthId(24);
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    // Old, unspent attempts are just clutter.
    await this.prisma.youtubeOAuthTransaction.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { userId, creatorProfileId }] },
    });
    await this.prisma.youtubeOAuthTransaction.create({
      data: {
        stateHash: hashOAuthState(oauthState),
        codeVerifier,
        userId,
        creatorProfileId,
        expiresAt: new Date(Date.now() + YOUTUBE_OAUTH_TTL_MS),
      },
    });

    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: this.youtubeRedirectUri,
      scope: this.youtubeScopes,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: oauthState,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      state: oauthState,
    };
  }

  callback(query: { code?: string; state?: string; error?: string }) {
    const params = new URLSearchParams();
    if (query.error || !query.code) {
      params.set("error", query.error || "access_denied");
    } else {
      params.set("code", query.code);
      if (query.state) params.set("state", query.state);
    }
    const deepLink = `${YOUTUBE_CALLBACK_SCHEME}?${params.toString()}`;
    return this.callbackHtml(deepLink, Boolean(query.error || !query.code));
  }

  async connect(userId: string, creatorProfileId: string, code: string, state: string) {
    this.requireConfig();
    if (!code?.trim()) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "YouTube authorization code is required.",
      });
    }
    await this.profiles.assertOwnership(userId, creatorProfileId);
    const codeVerifier = await this.spendTransaction(userId, creatorProfileId, state);

    const token = await this.exchangeCode(code.trim(), codeVerifier);
    const profile = await this.fetchProfile(token.accessToken);
    const lastSyncedAt = new Date();
    const stats = this.toSocialStats(profile);

    await this.prisma.$transaction(async (tx) => {
      const creatorProfile = await tx.creatorProfile.findFirst({
        where: { id: creatorProfileId, userId },
        select: { socialLinks: true, socialStats: true },
      });
      if (!creatorProfile) {
        throw new BadRequestException({
          code: "NOT_FOUND",
          message: "Creator profile not found.",
        });
      }

      const links =
        (creatorProfile.socialLinks as Record<string, string> | null) ?? {};
      const currentStats =
        (creatorProfile.socialStats as Record<string, unknown> | null) ?? {};

      await tx.youtubeConnection.upsert({
        where: { creatorProfileId },
        create: {
          userId,
          creatorProfileId,
          platformUserId: profile.channelId,
          platformHandle: profile.handle,
          encryptedAccessToken: this.encrypt(token.accessToken),
          encryptedRefreshToken: token.refreshToken
            ? this.encrypt(token.refreshToken)
            : null,
          tokenExpiresAt: token.expiresAt,
          subscriberCount: profile.subscriberCount,
          videoCount: profile.videoCount,
          totalViewCount: profile.totalViewCount,
          engagementRate: profile.engagementRate,
          profilePictureUrl: profile.profilePictureUrl,
          metadata: this.toConnectionMetadata(profile, token.scopes) as Prisma.InputJsonValue,
          isConnected: true,
          lastSyncedAt,
        },
        update: {
          platformUserId: profile.channelId,
          platformHandle: profile.handle,
          encryptedAccessToken: this.encrypt(token.accessToken),
          encryptedRefreshToken: token.refreshToken
            ? this.encrypt(token.refreshToken)
            : undefined,
          tokenExpiresAt: token.expiresAt,
          subscriberCount: profile.subscriberCount,
          videoCount: profile.videoCount,
          totalViewCount: profile.totalViewCount,
          engagementRate: profile.engagementRate,
          profilePictureUrl: profile.profilePictureUrl,
          metadata: this.toConnectionMetadata(profile, token.scopes) as Prisma.InputJsonValue,
          isConnected: true,
          lastSyncedAt,
        },
      });

      await tx.creatorProfile.update({
        where: { id: creatorProfileId },
        data: {
          socialLinks: {
            ...links,
            youtube: `https://www.youtube.com/channel/${profile.channelId}`,
          } as Prisma.InputJsonValue,
          socialStats: {
            ...currentStats,
            youtube: stats,
          } as Prisma.InputJsonValue,
        },
      });
    });

    return {
      connected: true as const,
      handle: profile.handle,
      lastSyncedAt: lastSyncedAt.toISOString(),
    };
  }

  async disconnect(userId: string, creatorProfileId: string) {
    const profile = await this.profiles.assertOwnership(userId, creatorProfileId);
    await this.revokeAtGoogle(userId, creatorProfileId);
    const links = { ...((profile.socialLinks as Record<string, string> | null) ?? {}) };
    const stats = { ...((profile.socialStats as Record<string, unknown> | null) ?? {}) };
    delete links.youtube;
    delete stats.youtube;

    await this.prisma.$transaction([
      // Disconnecting also destroys both stored tokens — a disconnected
      // account has no business leaving a usable credential in the database.
      this.prisma.youtubeConnection.updateMany({
        where: { userId, creatorProfileId },
        data: { isConnected: false, encryptedAccessToken: "", encryptedRefreshToken: null },
      }),
      this.prisma.creatorProfile.update({
        where: { id: creatorProfileId },
        data: {
          socialLinks: links as Prisma.InputJsonValue,
          socialStats: stats as Prisma.InputJsonValue,
        },
      }),
    ]);

    return { platform: "youtube", status: "disconnected" };
  }

  /** Finds the attempt this `state` belongs to and spends it. It must have been
   * started by this account for this profile, be unspent and unexpired. Marked
   * spent before anything is exchanged, so a replay never gets a second go. */
  private async spendTransaction(userId: string, creatorProfileId: string, state: string): Promise<string> {
    const invalid = new BadRequestException({
      code: "YOUTUBE_STATE_INVALID",
      message: "This YouTube connection attempt has expired or is not valid. Start again.",
    });
    if (!state?.trim()) throw invalid;
    const tx = await this.prisma.youtubeOAuthTransaction.findUnique({
      where: { stateHash: hashOAuthState(state.trim()) },
    });
    if (
      !tx ||
      tx.userId !== userId ||
      tx.creatorProfileId !== creatorProfileId ||
      tx.consumedAt ||
      tx.expiresAt < new Date()
    ) {
      throw invalid;
    }
    const spent = await this.prisma.youtubeOAuthTransaction.updateMany({
      where: { id: tx.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count !== 1) throw invalid;
    return tx.codeVerifier;
  }

  private async exchangeCode(code: string, codeVerifier: string) {
    const form = new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      client_id: this.googleClientId,
      client_secret: this.googleClientSecret,
      redirect_uri: this.youtubeRedirectUri,
      grant_type: "authorization_code",
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
    if (!res.ok || !data.access_token || !data.expires_in) {
      throw new BadRequestException({
        code: "YOUTUBE_TOKEN_EXCHANGE_FAILED",
        message:
          data.error_description ??
          data.error ??
          "YouTube authorization code exchange failed.",
      });
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: (data.scope ?? "").split(/\s+/).filter(Boolean),
    };
  }

  private async fetchProfile(accessToken: string): Promise<YoutubeProfile> {
    const channel = await this.youtubeGet<YoutubeChannelResponse>(
      "/channels?part=snippet,statistics&mine=true",
      accessToken,
    );
    const item = channel.items?.[0];
    if (!item) {
      throw new BadRequestException({
        code: "YOUTUBE_CHANNEL_NOT_FOUND",
        message: "No YouTube channel was found for this Google account.",
      });
    }

    const channelId = item.id;
    const displayName = item.snippet.title?.trim() || "YouTube";
    const handle = (item.snippet.customUrl ?? displayName)
      .replace(/^@/, "")
      .trim();
    const subscriberCount = item.statistics.hiddenSubscriberCount
      ? 0
      : toInt(item.statistics.subscriberCount);
    const videoCount = toInt(item.statistics.videoCount);
    const totalViewCount = toInt(item.statistics.viewCount);
    const profilePictureUrl =
      item.snippet.thumbnails?.high?.url ??
      item.snippet.thumbnails?.default?.url ??
      null;
    const biography = item.snippet.description?.trim() || null;

    let topVideos: YoutubeProfile["topVideos"] = [];
    let engagementRate = 0;
    let avgViews = 0;
    let avgLikes = 0;
    let avgComments = 0;

    try {
      const search = await this.youtubeGet<YoutubeSearchResponse>(
        `/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&maxResults=12&type=video`,
        accessToken,
      );
      const videos = search.items ?? [];
      const videoIds = videos.map((video) => video.id.videoId).filter(Boolean);
      if (videoIds.length > 0) {
        const stats = await this.youtubeGet<YoutubeVideosResponse>(
          `/videos?part=statistics&id=${encodeURIComponent(videoIds.join(","))}`,
          accessToken,
        );
        const statsMap = new Map(
          (stats.items ?? []).map((video) => [video.id, video.statistics ?? {}]),
        );
        const enriched = videos.map((video) => {
          const s = statsMap.get(video.id.videoId) ?? {};
          return {
            videoId: video.id.videoId,
            title: video.snippet.title ?? "",
            thumbnail:
              video.snippet.thumbnails?.medium?.url ??
              video.snippet.thumbnails?.default?.url ??
              null,
            publishedAt: video.snippet.publishedAt ?? null,
            viewCount: toInt(s.viewCount),
            likeCount: toInt(s.likeCount),
            commentCount: toInt(s.commentCount),
            permalink: `https://youtube.com/watch?v=${video.id.videoId}`,
          };
        });
        const count = enriched.length;
        const totalViews = enriched.reduce((sum, video) => sum + video.viewCount, 0);
        const totalLikes = enriched.reduce((sum, video) => sum + video.likeCount, 0);
        const totalComments = enriched.reduce(
          (sum, video) => sum + video.commentCount,
          0,
        );
        avgViews = count > 0 ? Math.round(totalViews / count) : 0;
        avgLikes = count > 0 ? Math.round(totalLikes / count) : 0;
        avgComments = count > 0 ? Math.round(totalComments / count) : 0;
        engagementRate =
          totalViews > 0
            ? Math.round(((totalLikes + totalComments) / totalViews) * 10000) / 100
            : 0;
        topVideos = [...enriched]
          .sort((a, b) => b.viewCount - a.viewCount)
          .slice(0, 3);
      }
    } catch {
      // Recent video metrics are optional; channel-level connection still succeeds.
    }

    return {
      channelId,
      handle,
      displayName,
      subscriberCount,
      videoCount,
      totalViewCount,
      profilePictureUrl,
      biography,
      engagementRate,
      avgViews,
      avgLikes,
      avgComments,
      topVideos,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async youtubeGet<T extends { error?: { message?: string } }>(
    path: string,
    accessToken: string,
  ): Promise<T> {
    const res = await fetch(`${YOUTUBE_DATA_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok || data.error) {
      throw new BadGatewayException({
        code: "YOUTUBE_API_FAILED",
        message: data.error?.message ?? "YouTube API request failed.",
      });
    }
    return data;
  }

  /** Returns a currently-valid access token for this profile's connected
   * YouTube channel, refreshing it via the stored refresh token when it's
   * close to expiring. Also verifies the connection was granted upload
   * permission — connections made before youtube.upload was added to
   * YOUTUBE_OAUTH_SCOPES predate it and need to reconnect. */
  async getValidAccessToken(creatorProfileId: string): Promise<string> {
    const connection = await this.prisma.youtubeConnection.findUnique({
      where: { creatorProfileId },
    });
    if (!connection || !connection.isConnected) {
      throw new ConflictException({
        code: "YOUTUBE_NOT_CONNECTED",
        message: "Connect a YouTube account before posting to it.",
      });
    }

    const scopes =
      ((connection.metadata as Record<string, unknown> | null)?.scopes as
        | string[]
        | undefined) ?? [];
    if (!scopes.includes(YOUTUBE_UPLOAD_SCOPE)) {
      throw new ConflictException({
        code: "YOUTUBE_UPLOAD_SCOPE_MISSING",
        message: "Reconnect your YouTube account to grant upload permission.",
      });
    }

    const expiresAt = connection.tokenExpiresAt;
    const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;
    if (!needsRefresh) {
      return this.decrypt(connection.encryptedAccessToken);
    }

    if (!connection.encryptedRefreshToken) {
      throw new ConflictException({
        code: "YOUTUBE_REAUTH_REQUIRED",
        message: "Reconnect your YouTube account to keep posting on your behalf.",
      });
    }

    const refreshed = await this.refreshAccessToken(
      this.decrypt(connection.encryptedRefreshToken),
    );
    await this.prisma.youtubeConnection.update({
      where: { creatorProfileId },
      data: {
        encryptedAccessToken: this.encrypt(refreshed.accessToken),
        tokenExpiresAt: refreshed.expiresAt,
      },
    });
    return refreshed.accessToken;
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const form = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.googleClientId,
      client_secret: this.googleClientSecret,
      grant_type: "refresh_token",
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
    if (!res.ok || !data.access_token || !data.expires_in) {
      throw new ConflictException({
        code: "YOUTUBE_REAUTH_REQUIRED",
        message:
          data.error_description ??
          data.error ??
          "Reconnect your YouTube account to keep posting on your behalf.",
      });
    }
    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  /** Uploads a video already hosted at a public `videoUrl` as a YouTube
   * Short on this profile's connected channel via a single multipart
   * request (metadata + video bytes in one call) — simpler than the full
   * resumable-upload protocol, fine for short-form clips. Fetches the
   * source video server-side first since `videoUrl` is our own R2-hosted
   * file, not something YouTube can be pointed at directly the way
   * Instagram's container API can. */
  async uploadShort(
    creatorProfileId: string,
    videoUrl: string,
    title: string,
  ): Promise<{ permalink: string }> {
    const accessToken = await this.getValidAccessToken(creatorProfileId);

    const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
    if (!videoRes.ok || !videoRes.body) {
      throw new BadGatewayException({
        code: "YOUTUBE_SOURCE_MEDIA_UNAVAILABLE",
        message: "Could not fetch the source video for upload.",
      });
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const metadata = {
      snippet: { title: title.slice(0, 100), description: title },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    };
    const boundary = `halchal-${randomBytes(16).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`,
        "utf8",
      ),
      videoBuffer,
      Buffer.from(`\r\n--${boundary}--`, "utf8"),
    ]);

    const uploadRes = await fetch(`${YOUTUBE_UPLOAD_API}?uploadType=multipart&part=snippet,status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await uploadRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!uploadRes.ok || !data.id) {
      throw new BadGatewayException({
        code: "YOUTUBE_PUBLISH_FAILED",
        message: data.error?.message ?? "YouTube upload failed.",
      });
    }

    return { permalink: `https://www.youtube.com/shorts/${data.id}` };
  }

  private toSocialStats(profile: YoutubeProfile) {
    return {
      platform: "youtube",
      handle: profile.handle,
      displayName: profile.displayName,
      followersCount: profile.subscriberCount,
      followingCount: 0,
      postsCount: profile.videoCount,
      profilePicUrl: profile.profilePictureUrl,
      bio: profile.biography,
      engagementRate: profile.engagementRate,
      avgLikes: profile.avgLikes,
      avgComments: profile.avgComments,
      avgViews: profile.avgViews,
      totalViewCount: profile.totalViewCount,
      fetchedAt: profile.fetchedAt,
      source: "youtube_official",
      connectMethod: "youtube_oauth",
    };
  }

  private toConnectionMetadata(profile: YoutubeProfile, scopes: string[]) {
    return {
      connectMethod: "youtube_oauth",
      source: "youtube_official",
      scopes,
      displayName: profile.displayName,
      profilePictureUrl: profile.profilePictureUrl,
      biography: profile.biography,
      avgViews: profile.avgViews,
      avgLikes: profile.avgLikes,
      avgComments: profile.avgComments,
      topVideos: profile.topVideos,
      lastSyncedAt: profile.fetchedAt,
    };
  }

  private callbackHtml(deepLink: string, hasError: boolean): string {
    const title = hasError ? "YouTube connection failed" : "YouTube authorized";
    const body = hasError
      ? "Return to Halchal and try connecting YouTube again."
      : "Return to Halchal to finish saving your YouTube channel.";
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

  private requireConfig() {
    if (!this.googleClientId || !this.googleClientSecret || !this.youtubeRedirectUri) {
      throw new ConflictException({
        code: "YOUTUBE_OAUTH_NOT_CONFIGURED",
        message: "YouTube OAuth is not configured on the API.",
      });
    }
  }

  /** Tells Google to cancel the grant, so the token we are about to forget is
   * also dead on their side. Best effort: failing to reach Google must not stop
   * the creator disconnecting. */
  private async revokeAtGoogle(userId: string, creatorProfileId: string): Promise<void> {
    try {
      const conn = await this.prisma.youtubeConnection.findFirst({
        where: { userId, creatorProfileId },
        select: { encryptedRefreshToken: true, encryptedAccessToken: true },
      });
      const stored = conn?.encryptedRefreshToken || conn?.encryptedAccessToken;
      if (!stored) return;
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: this.decrypt(stored) }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // ignored on purpose, see above
    }
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.tokenKeys.primary, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  /** Reads with the dedicated key; falls back to the old login-secret-derived
   * key only for tokens saved before the dedicated key was required. */
  private decrypt(value: string): string {
    const keys = this.tokenKeys;
    try {
      return this.decryptWithKey(keys.primary, value);
    } catch (primaryError) {
      if (!keys.legacy) throw primaryError;
      try {
        return this.decryptWithKey(keys.legacy, value);
      } catch {
        throw primaryError;
      }
    }
  }

  private decryptWithKey(key: Buffer, value: string): string {
    const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
    if (!ivRaw || !tagRaw || !encryptedRaw) {
      throw new BadRequestException({
        code: "YOUTUBE_TOKEN_INVALID",
        message: "Stored YouTube token is invalid.",
      });
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivRaw, "base64url"),
      // Only the full 16-byte tag is accepted; a shorter one is easier to forge.
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private get googleClientId(): string {
    return this.config.get("GOOGLE_CLIENT_ID", { infer: true }) ?? "";
  }

  private get googleClientSecret(): string {
    return this.config.get("GOOGLE_CLIENT_SECRET", { infer: true }) ?? "";
  }

  private get youtubeRedirectUri(): string {
    return this.config.get("YOUTUBE_REDIRECT_URI", { infer: true }) ?? "";
  }

  private get youtubeScopes(): string {
    return this.config.get("YOUTUBE_OAUTH_SCOPES", { infer: true });
  }

  private get tokenKeys(): PayoutKeys {
    return resolvePayoutKeys(
      this.config.get("YOUTUBE_TOKEN_ENCRYPTION_KEY", { infer: true }),
      this.config.get("JWT_SECRET", { infer: true }),
    );
  }
}
