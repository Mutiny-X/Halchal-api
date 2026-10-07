import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  breakdownOf,
  classifyGraphError,
  postedBeforeBusinessAccount,
  contentKind,
  contentMix,
  engagementByReach,
  FALLBACK_MEDIA_METRICS,
  followerSeries,
  mediaMetricsFor,
  postMetricsFrom,
  totalsByName,
  type ContentKind,
  type GraphError,
  type InsightsResponse,
  type KeyValue,
  type MediaItem,
  type PostMetrics,
  type UnavailableSection,
} from "./instagram-account-insights.parse";
import { InstagramOAuthService } from "./instagram-oauth.service";

export const ACCOUNT_INSIGHTS_SOURCE = "instagram_account_insights";
/** A stored report counts as current for a day: the nightly job refreshes
 * every connected account at 12 AM (India), so opening a creator's page
 * shows that run instead of calling Meta again. A couple of spare hours
 * cover a slow or late run. "Sync now" still fetches straight away. */
const FRESH_FOR_MS = 26 * 60 * 60 * 1000;
/** "Sync now" can't hit Meta more often than this per account. */
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000;
const PERIOD_DAYS = 30;
/** How many recent posts get per-post insights (one Meta call each). */
const POSTS_WITH_INSIGHTS = 25;

type Demographics = { age: KeyValue[] | null; gender: KeyValue[] | null; country: KeyValue[] | null; city: KeyValue[] | null };

export type InstagramAccountInsightsReport = {
  connectionId: string;
  syncedAt: string;
  period: { since: string; until: string; days: number };
  profile: {
    username: string;
    name: string | null;
    biography: string | null;
    website: string | null;
    profilePictureUrl: string | null;
    accountType: string | null;
    followerCount: number;
    followsCount: number;
    mediaCount: number;
  };
  overview: {
    totals: {
      views: number | null;
      reach: number | null;
      accountsEngaged: number | null;
      totalInteractions: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
      saves: number | null;
      replies: number | null;
      profileLinksTaps: number | null;
      follows: number | null;
      unfollows: number | null;
    };
    viewsByFormat: KeyValue[] | null;
    reachByFormat: KeyValue[] | null;
    reachByFollowType: KeyValue[] | null;
    profileLinkTaps: KeyValue[] | null;
    followerGrowth: { points: Array<{ date: string; value: number }>; net: number } | null;
  };
  audience: { followers: Demographics; engaged: Demographics };
  content: {
    mix: Array<{ kind: ContentKind; count: number }>;
    analysedPosts: number;
    posts: Array<{
      id: string;
      kind: ContentKind;
      permalink: string | null;
      caption: string | null;
      thumbnailUrl: string | null;
      timestamp: string | null;
      childCount: number | null;
      metrics: PostMetrics;
      engagementByReach: number | null;
    }>;
  };
  unavailable: UnavailableSection[];
};

type GraphResult<T> = { data: T; error?: undefined } | { data?: undefined; error: GraphError };

@Injectable()
export class InstagramAccountInsightsService {
  private readonly logger = new Logger(InstagramAccountInsightsService.name);
  /** In-flight syncs, so two admins opening the page don't double the calls. */
  private readonly inFlight = new Map<string, Promise<InstagramAccountInsightsReport>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: InstagramOAuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Swappable in tests. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  /** Pause between accounts in the nightly run; swappable in tests. */
  nightlyPauseMs = 2000;
  private nightlyRunning = false;

  /**
   * Every night at 12 AM (India): refresh the insights of every creator with
   * Instagram connected, so admins see yesterday's numbers without pressing
   * "Sync now". One account at a time with a short pause (each sync makes
   * dozens of Meta calls), and one account failing never stops the rest.
   */
  @Cron("0 0 0 * * *", { timeZone: "Asia/Kolkata" })
  async syncAllConnectedNightly(): Promise<{ synced: number; failed: number }> {
    if (this.nightlyRunning) {
      this.logger.warn("Nightly Instagram insights sync is still running from before — skipping this start");
      return { synced: 0, failed: 0 };
    }
    this.nightlyRunning = true;
    let synced = 0;
    let failed = 0;
    try {
      const connections = await this.prisma.instagramConnection.findMany({
        where: { isConnected: true },
        select: { id: true, userId: true },
        orderBy: { createdAt: "asc" },
      });
      for (const [i, c] of connections.entries()) {
        try {
          await this.getReport(c.userId, c.id, { refresh: true });
          synced += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(`Nightly Instagram insights sync failed for connection ${c.id}: ${(err as Error).message}`);
        }
        if (i < connections.length - 1 && this.nightlyPauseMs > 0) {
          await new Promise((r) => setTimeout(r, this.nightlyPauseMs));
        }
      }
      this.logger.log(`Nightly Instagram insights sync: ${synced} synced, ${failed} failed`);
      return { synced, failed };
    } finally {
      this.nightlyRunning = false;
    }
  }

  private get graphBase(): string {
    return `https://graph.instagram.com/${this.config.get("INSTAGRAM_GRAPH_API_VERSION", { infer: true }) ?? "v23.0"}`;
  }

  /** The latest report for a creator's Instagram connection: cached if
   * fresh, otherwise (or when `refresh`) pulled from Meta and stored. */
  async getReport(creatorUserId: string, connectionId: string, opts: { refresh?: boolean } = {}) {
    const connection = await this.prisma.instagramConnection.findFirst({
      where: { id: connectionId, userId: creatorUserId },
    });
    if (!connection) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Instagram connection not found for this creator" });
    }

    const latest = await this.prisma.socialAccountInsightSnapshot.findFirst({
      where: { creatorProfileId: connection.creatorProfileId, platform: "instagram", source: ACCOUNT_INSIGHTS_SOURCE },
      orderBy: { collectedAt: "desc" },
    });
    const age = latest ? Date.now() - latest.collectedAt.getTime() : Infinity;
    const usable = latest && age < (opts.refresh ? MIN_REFRESH_GAP_MS : FRESH_FOR_MS);
    if (usable || (!connection.isConnected && latest)) {
      return { report: latest!.rawMetrics as unknown as InstagramAccountInsightsReport, cached: true, connected: connection.isConnected };
    }
    if (!connection.isConnected) {
      throw new ConflictException({
        code: "INSTAGRAM_NOT_CONNECTED",
        message: "This creator has disconnected Instagram, so there are no insights to show.",
      });
    }

    let job = this.inFlight.get(connection.id);
    if (!job) {
      job = this.sync(connection).finally(() => this.inFlight.delete(connection.id));
      this.inFlight.set(connection.id, job);
    }
    return { report: await job, cached: false, connected: true };
  }

  private async sync(connection: { id: string; creatorProfileId: string; platformUserId: string }): Promise<InstagramAccountInsightsReport> {
    const token = encodeURIComponent(await this.oauth.getValidAccessToken(connection.creatorProfileId));
    const unavailable: UnavailableSection[] = [];
    const until = Math.floor(Date.now() / 1000);
    const since = until - PERIOD_DAYS * 86_400 + 60;
    const window = `period=day&since=${since}&until=${until}`;

    const profileRes = await this.graph<{
      user_id?: string; id: string; username?: string; name?: string; biography?: string; website?: string;
      profile_picture_url?: string; account_type?: string; followers_count?: number; follows_count?: number; media_count?: number;
    }>(`/me?fields=id,user_id,username,name,biography,website,profile_picture_url,account_type,followers_count,follows_count,media_count&access_token=${token}`);
    if (profileRes.error) {
      throw new ConflictException({
        code: "INSTAGRAM_GRAPH_FAILED",
        message: profileRes.error.message ?? "Instagram didn't return the profile.",
      });
    }
    const p = profileRes.data;
    const igId = encodeURIComponent(p.user_id ?? p.id ?? connection.platformUserId);
    const followerCount = p.followers_count ?? 0;
    const note = (section: string, error: GraphError) => unavailable.push({ section, ...classifyGraphError(error, followerCount, section) });

    const insights = (query: string) => this.graph<InsightsResponse>(`/${igId}/insights?${query}&access_token=${token}`);

    // ── Account totals (fall back to one metric at a time: a single
    // unsupported metric fails the whole combined call) ──
    const TOTAL_METRICS = ["views", "reach", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "replies", "profile_links_taps"];
    let totals: Record<string, number> = {};
    const combined = await insights(`metric=${TOTAL_METRICS.join(",")}&metric_type=total_value&${window}`);
    if (!combined.error) {
      totals = totalsByName(combined.data);
    } else {
      const firstError = combined.error;
      const each = await this.pool(TOTAL_METRICS, (m) => insights(`metric=${m}&metric_type=total_value&${window}`));
      for (const r of each) if (!r.error) Object.assign(totals, totalsByName(r.data));
      if (Object.keys(totals).length === 0) note("totals", firstError);
    }

    const breakdown = async (section: string, metric: string, dim: string) => {
      const r = await insights(`metric=${metric}&metric_type=total_value&breakdown=${dim}&${window}`);
      if (r.error) {
        note(section, r.error);
        return null;
      }
      return breakdownOf(r.data, metric);
    };
    const demographic = async (audience: "followers" | "engaged", dim: keyof Demographics) => {
      const metric = audience === "followers" ? "follower_demographics" : "engaged_audience_demographics";
      const r = await insights(`metric=${metric}&period=lifetime&timeframe=this_month&metric_type=total_value&breakdown=${dim}`);
      if (r.error) {
        note(`${audience}_${dim}`, r.error);
        return null;
      }
      return breakdownOf(r.data, metric);
    };

    const [viewsByFormat, reachByFormat, reachByFollowType, follows, linkTaps, growthRes] = await Promise.all([
      breakdown("views_by_format", "views", "media_product_type"),
      breakdown("reach_by_format", "reach", "media_product_type"),
      breakdown("reach_by_follow_type", "reach", "follow_type"),
      breakdown("follows", "follows_and_unfollows", "follow_type"),
      breakdown("profile_link_taps", "profile_links_taps", "contact_button_type"),
      insights(`metric=follower_count&${window}`),
    ]);
    if (growthRes.error) note("follower_growth", growthRes.error);

    const dims: Array<keyof Demographics> = ["age", "gender", "country", "city"];
    const followerDemo = await this.pool(dims, (d) => demographic("followers", d));
    const engagedDemo = await this.pool(dims, (d) => demographic("engaged", d));
    const asDemo = (rows: Array<KeyValue[] | null>): Demographics => ({ age: rows[0], gender: rows[1], country: rows[2], city: rows[3] });

    // ── Content ──
    const mediaRes = await this.graph<{ data?: MediaItem[] }>(
      `/${igId}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count,children{id}&limit=100&access_token=${token}`,
    );
    if (mediaRes.error) note("content", mediaRes.error);
    const media = mediaRes.data?.data ?? [];
    const recent = media.filter((m) => contentKind(m) !== "story").slice(0, POSTS_WITH_INSIGHTS);
    const denied: { error: GraphError | null; count: number; beforeBusiness: number } = { error: null, count: 0, beforeBusiness: 0 };
    const posts = await this.pool(recent, async (item) => {
      const kind = contentKind(item);
      let r = await this.graph<InsightsResponse>(`/${encodeURIComponent(item.id)}/insights?metric=${mediaMetricsFor(kind)}&access_token=${token}`);
      if (r.error && r.error.code !== 10 && r.error.code !== 200) {
        r = await this.graph<InsightsResponse>(`/${encodeURIComponent(item.id)}/insights?metric=${FALLBACK_MEDIA_METRICS}&access_token=${token}`);
      }
      if (r.error) {
        denied.error ??= r.error;
        denied.count += 1;
        if (postedBeforeBusinessAccount(r.error)) denied.beforeBusiness += 1;
      }
      const metrics = postMetricsFrom(r.error ? null : r.data, item);
      return {
        id: item.id,
        kind,
        permalink: item.permalink ?? null,
        caption: item.caption ?? null,
        thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null,
        timestamp: item.timestamp ?? null,
        childCount: item.children?.data?.length ?? null,
        metrics,
        engagementByReach: engagementByReach(metrics),
      };
    });
    if (denied.beforeBusiness > 0 && denied.beforeBusiness === denied.count) {
      // Normal, not a failure: Instagram keeps no insights for posts made
      // before the account became a business/creator account.
      unavailable.push({
        section: "post_insights",
        reason: "not_supported",
        message: `${denied.beforeBusiness} of ${recent.length} recent posts were published before this account switched to a business/creator account, so Instagram has no insights for them. Newer posts are shown with their insights.`,
      });
    } else if (denied.error) {
      note("post_insights", denied.error);
    }

    const followsTotals = new Map((follows ?? []).map((f) => [f.key, f.value]));
    const n = (k: string) => (typeof totals[k] === "number" ? totals[k] : null);
    const report: InstagramAccountInsightsReport = {
      connectionId: connection.id,
      syncedAt: new Date().toISOString(),
      period: { since: new Date(since * 1000).toISOString(), until: new Date(until * 1000).toISOString(), days: PERIOD_DAYS },
      profile: {
        username: p.username ?? "",
        name: p.name ?? null,
        biography: p.biography ?? null,
        website: p.website ?? null,
        profilePictureUrl: p.profile_picture_url ?? null,
        accountType: p.account_type ?? null,
        followerCount,
        followsCount: p.follows_count ?? 0,
        mediaCount: p.media_count ?? media.length,
      },
      overview: {
        totals: {
          views: n("views"),
          reach: n("reach"),
          accountsEngaged: n("accounts_engaged"),
          totalInteractions: n("total_interactions"),
          likes: n("likes"),
          comments: n("comments"),
          shares: n("shares"),
          saves: n("saves"),
          replies: n("replies"),
          profileLinksTaps: n("profile_links_taps"),
          // follow_type on follows_and_unfollows: FOLLOWER = new follows, NON_FOLLOWER = unfollows.
          follows: follows ? (followsTotals.get("FOLLOWER") ?? 0) : null,
          unfollows: follows ? (followsTotals.get("NON_FOLLOWER") ?? 0) : null,
        },
        viewsByFormat,
        reachByFormat,
        reachByFollowType,
        profileLinkTaps: linkTaps,
        followerGrowth: growthRes.error ? null : followerSeries(growthRes.data),
      },
      audience: { followers: asDemo(followerDemo), engaged: asDemo(engagedDemo) },
      content: { mix: contentMix(media), analysedPosts: media.length, posts },
      unavailable,
    };

    await this.prisma.$transaction([
      this.prisma.socialAccountInsightSnapshot.create({
        data: {
          creatorProfileId: connection.creatorProfileId,
          platform: "instagram",
          platformUserId: p.user_id ?? p.id ?? connection.platformUserId,
          handle: report.profile.username,
          followerCount,
          followingCount: report.profile.followsCount,
          mediaCount: report.profile.mediaCount,
          totalViewCount: report.overview.totals.views ?? 0,
          engagementRate: report.overview.totals.reach && report.overview.totals.totalInteractions !== null
            ? Math.round((report.overview.totals.totalInteractions / report.overview.totals.reach) * 10000) / 100
            : 0,
          rawMetrics: report as unknown as Prisma.InputJsonValue,
          source: ACCOUNT_INSIGHTS_SOURCE,
        },
      }),
      this.prisma.instagramConnection.update({
        where: { id: connection.id },
        data: {
          followerCount,
          followsCount: report.profile.followsCount,
          mediaCount: report.profile.mediaCount,
          ...(report.profile.profilePictureUrl ? { profilePictureUrl: report.profile.profilePictureUrl } : {}),
          lastSyncedAt: new Date(),
        },
      }),
    ]);
    if (unavailable.length) {
      this.logger.log(`Insights for ${connection.id}: ${unavailable.map((u) => `${u.section}=${u.reason}`).join(", ")}`);
    }
    return report;
  }

  /** One Graph call; never throws for Meta errors — the caller decides. */
  private async graph<T>(path: string): Promise<GraphResult<T>> {
    try {
      const res = await this.fetchImpl(`${this.graphBase}${path}`, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
      if (res.status === 429 || body.error?.code === 4 || body.error?.code === 613 || body.error?.code === 32) {
        throw new ConflictException({
          code: "META_RATE_LIMITED",
          message: "Instagram's rate limit was reached. Try again in a while.",
        });
      }
      if (!res.ok || body.error) return { error: body.error ?? { message: `Instagram returned ${res.status}` } };
      return { data: body };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      return { error: { message: "Couldn't reach Instagram." } };
    }
  }

  /** Runs `fn` over `items` with at most 5 calls to Meta at once. */
  private async pool<I, O>(items: I[], fn: (item: I) => Promise<O>): Promise<O[]> {
    const out: O[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
    return out;
  }
}
