import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type PlatformViewResult = {
  viewCount: number;
  reach: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  platform: "instagram" | "youtube" | "twitter" | "unknown";
};

export type PostResolution =
  | { status: "resolved" }
  | { status: "not_found" }
  | { status: "unresolved"; reason: string };

export type PostAuthor = {
  handle: string | null;
  platformUserId: string | null;
};

export type SocialProfileStats = {
  platform: "instagram" | "youtube" | "twitter";
  handle: string;
  displayName: string | null;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  profilePicUrl: string | null;
  bio: string | null;
  fetchedAt: string;
};

/** The domains a profile link may be on, per platform. */
const PROFILE_HOSTS: Record<"instagram" | "youtube" | "twitter", string[]> = {
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be"],
  twitter: ["twitter.com", "x.com"],
};
const PROFILE_NAMES: Record<"instagram" | "youtube" | "twitter", string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  twitter: "X",
};

@Injectable()
export class ApifyService {
  private readonly logger = new Logger(ApifyService.name);
  private readonly apiToken: string | null;
  private readonly hikerApiKey: string | null;

  // Apify actor IDs for each platform
  private static readonly ACTORS = {
    instagram: "apify~instagram-scraper",
    youtube: "streamers~youtube-scraper",
    twitter: "apidojo~tweet-scraper",
  };

  constructor(private readonly config: ConfigService) {
    this.apiToken = this.config.get<string>("APIFY_API_TOKEN") ?? null;
    // TEMPORARY: Instagram is being test-driven through HikerAPI instead of
    // the Apify actor above — YouTube/Twitter are untouched. Revert by
    // restoring scrapeInstagram/fetchInstagramProfile to call
    // runActorAndGetDataset(ACTORS.instagram, ...) like the other platforms.
    this.hikerApiKey = this.config.get<string>("HIKERAPI_KEY") ?? null;
  }

  get isConfigured(): boolean {
    return !!this.apiToken;
  }

  async getViewCount(livePostUrl: string): Promise<PlatformViewResult> {
    const platform = this.detectPlatform(livePostUrl);

    const zero: PlatformViewResult = {
      viewCount: 0, reach: 0, likeCount: 0, commentCount: 0, shareCount: 0, platform,
    };

    if (!this.isConfigured) {
      this.logger.warn("APIFY_API_TOKEN not set — returning 0 metrics");
      return zero;
    }

    try {
      switch (platform) {
        case "instagram": return { ...(await this.scrapeInstagram(livePostUrl)), platform };
        case "youtube":   return { ...(await this.scrapeYouTube(livePostUrl)), platform };
        case "twitter":   return { ...(await this.scrapeTwitter(livePostUrl)), platform };
        default:          return zero;
      }
    } catch (err) {
      this.logger.error(`Apify scrape failed for ${livePostUrl}: ${err}`);
      return zero;
    }
  }

  detectPlatform(url: string): PlatformViewResult["platform"] {
    // By host, not by text appearing somewhere in the address: a link like
    // https://evil.example/?instagram.com is not an Instagram link.
    let host: string;
    try {
      const raw = url.trim();
      host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      return "unknown";
    }
    const on = (domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));
    if (on(PROFILE_HOSTS.instagram)) return "instagram";
    if (on(PROFILE_HOSTS.youtube)) return "youtube";
    if (on(PROFILE_HOSTS.twitter)) return "twitter";
    return "unknown";
  }

  /** Checks whether a live post URL actually resolves to real, accessible
   * content — for the auto-review pipeline's "resolves and is public" gate.
   * Deliberately separate from getViewCount, which silently collapses every
   * failure mode (bad config, network error, genuinely-missing post) into a
   * zero-metrics result — a gate deciding auto-reject needs to tell those
   * apart. Only Instagram (via HikerAPI) currently returns a distinguishable
   * "this post doesn't exist" signal (`exc_type: "MediaNotFound"`); Apify
   * actors for YouTube/Twitter just return an empty dataset for almost any
   * failure (bad URL, rate limit, transient block), so those cases are
   * reported as `unresolved` rather than a confident `not_found` — routing
   * to needs_review, not an auto-reject, when we're not actually sure. */
  async checkPostResolves(livePostUrl: string): Promise<PostResolution> {
    const platform = this.detectPlatform(livePostUrl);
    if (!this.isConfigured && !this.hikerApiKey) {
      return { status: "unresolved", reason: "Scraping not configured" };
    }

    try {
      if (platform === "instagram") {
        if (!this.hikerApiKey) {
          return { status: "unresolved", reason: "HIKERAPI_KEY not set" };
        }
        const res = await this.hikerApiRawGet("/v2/media/info/by/url", { url: livePostUrl });
        if (res.status === 404 || res.body?.exc_type === "MediaNotFound") {
          return { status: "not_found" };
        }
        if (!res.ok) {
          return { status: "unresolved", reason: `HikerAPI returned ${res.status}` };
        }
        return { status: "resolved" };
      }

      if (platform === "youtube" || platform === "twitter") {
        const actorId = platform === "youtube" ? ApifyService.ACTORS.youtube : ApifyService.ACTORS.twitter;
        const input = platform === "youtube"
          ? { startUrls: [{ url: livePostUrl }], maxResults: 1 }
          : { startUrls: [livePostUrl], maxItems: 1 };
        const items = await this.runActorAndGetDataset(actorId, input);
        if (items.length === 0) {
          return { status: "unresolved", reason: "Scraper returned no data — can't confirm not_found vs blocked" };
        }
        return { status: "resolved" };
      }

      return { status: "unresolved", reason: `Unrecognized platform for URL: ${livePostUrl}` };
    } catch (err) {
      return { status: "unresolved", reason: `Scrape error: ${err}` };
    }
  }

  /** Best-effort extraction of who actually posted the live content, for the
   * auto-review pipeline's ownership-verification gate. Field paths below
   * follow the conventional Instagram-private-API / Apify-actor response
   * shapes used across this whole ecosystem, but have NOT been empirically
   * verified against a live successful response in this codebase — if the
   * expected field is missing, this returns null (unresolved) rather than
   * guessing, so a wrong assumption fails safe instead of silently. */
  async getPostAuthor(livePostUrl: string): Promise<PostAuthor | null> {
    const platform = this.detectPlatform(livePostUrl);
    try {
      if (platform === "instagram" && this.hikerApiKey) {
        const res = await this.hikerApiRawGet("/v2/media/info/by/url", { url: livePostUrl });
        const user = res.body?.media_or_ad?.user;
        if (!user?.username && !user?.pk) return null;
        return {
          handle: user.username ?? null,
          platformUserId: user.pk != null ? String(user.pk) : null,
        };
      }

      if (platform === "youtube" && this.isConfigured) {
        const items = await this.runActorAndGetDataset(ApifyService.ACTORS.youtube, {
          startUrls: [{ url: livePostUrl }],
          maxResults: 1,
        });
        const v = items[0];
        const handle = v?.channelHandle ?? v?.channelName ?? null;
        const channelId = v?.channelId ?? null;
        if (!handle && !channelId) return null;
        return { handle, platformUserId: channelId };
      }

      if (platform === "twitter" && this.isConfigured) {
        const items = await this.runActorAndGetDataset(ApifyService.ACTORS.twitter, {
          startUrls: [livePostUrl],
          maxItems: 1,
        });
        const t = items[0];
        const handle = t?.author?.userName ?? t?.author?.username ?? null;
        const authorId = t?.author?.id ?? null;
        if (!handle && !authorId) return null;
        return { handle, platformUserId: authorId };
      }

      return null;
    } catch (err) {
      this.logger.warn(`getPostAuthor failed for ${livePostUrl}: ${err}`);
      return null;
    }
  }

  /** Like hikerApiGet, but never throws — returns the status/body so callers
   * can distinguish "not found" from other failures instead of only getting
   * an Error either way. */
  private async hikerApiRawGet(
    path: string,
    params: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    const url = `https://api.hikerapi.com${path}?${new URLSearchParams(params).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      headers: { "x-access-key": this.hikerApiKey ?? "" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  }

  private async runActorAndGetDataset(actorId: string, input: object): Promise<any[]> {
    const baseUrl = "https://api.apify.com/v2";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    const runRes = await fetch(
      `${baseUrl}/acts/${actorId}/run-sync-get-dataset-items?token=${this.apiToken}&timeout=120`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timer));
    if (!runRes.ok) {
      const body = await runRes.text();
      throw new Error(`Apify actor ${actorId} returned ${runRes.status}: ${body}`);
    }
    const items = await runRes.json() as any[];
    this.logger.log(`Apify ${actorId} returned ${items.length} items: ${JSON.stringify(items[0] ?? {})}`);
    return items;
  }

  /** HikerAPI request helper — TEMPORARY, Instagram-only (see constructor note). */
  private async hikerApiGet(path: string, params: Record<string, string>): Promise<any> {
    if (!this.hikerApiKey) {
      throw new Error("HIKERAPI_KEY not set");
    }
    const url = `https://api.hikerapi.com${path}?${new URLSearchParams(params).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      headers: { "x-access-key": this.hikerApiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`HikerAPI ${path} returned ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  private async scrapeInstagram(url: string): Promise<Omit<PlatformViewResult, "platform">> {
    const data = await this.hikerApiGet("/v2/media/info/by/url", { url });
    const m = data.media_or_ad ?? {};
    return {
      viewCount:    m.play_count ?? m.view_count ?? 0,
      reach:        m.play_count ?? m.view_count ?? 0,
      likeCount:    m.like_count ?? 0,
      commentCount: m.comment_count ?? 0,
      shareCount:   m.reshare_count ?? 0,
    };
  }

  private async scrapeYouTube(url: string): Promise<Omit<PlatformViewResult, "platform">> {
    const items = await this.runActorAndGetDataset(ApifyService.ACTORS.youtube, {
      startUrls: [{ url }],
      maxResults: 1,
    });
    const v = items[0] ?? {};
    return {
      viewCount:    v.viewCount ?? v.views ?? 0,
      reach:        v.viewCount ?? v.views ?? 0,
      likeCount:    v.likes ?? v.likeCount ?? 0,
      commentCount: v.commentCount ?? v.comments ?? 0,
      shareCount:   0,
    };
  }

  private async scrapeTwitter(url: string): Promise<Omit<PlatformViewResult, "platform">> {
    const items = await this.runActorAndGetDataset(ApifyService.ACTORS.twitter, {
      startUrls: [url],
      maxItems: 1,
    });
    const t = items[0] ?? {};
    return {
      viewCount:    t.viewCount ?? t.views ?? t.impressions ?? 0,
      reach:        t.impressions ?? t.views ?? 0,
      likeCount:    t.likeCount ?? t.likes ?? t.favoriteCount ?? 0,
      commentCount: t.replyCount ?? t.replies ?? 0,
      shareCount:   t.retweetCount ?? t.retweets ?? 0,
    };
  }

  /**
   * Turns what a creator typed — a username or a profile link — into a
   * full https profile link on that platform. A link is only accepted on
   * the platform's own domain (matched as a host, not as text that merely
   * appears somewhere in the address), and a username only if it looks
   * like one; anything else is refused rather than stored and later shown
   * to admins as a clickable link.
   */
  normalizeProfileUrl(platform: "instagram" | "youtube" | "twitter", input: string): string {
    const s = input.trim().replace(/^@/, "");
    const hosts = PROFILE_HOSTS[platform];
    const refuse = () =>
      new BadRequestException({
        code: "VALIDATION_ERROR",
        message: `Enter your ${PROFILE_NAMES[platform]} username or a link to your ${PROFILE_NAMES[platform]} profile.`,
      });

    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
    if (hasScheme || s.includes("/")) {
      let url: URL;
      try {
        url = new URL(hasScheme ? s : `https://${s}`);
      } catch {
        throw refuse();
      }
      const host = url.hostname.toLowerCase();
      const onPlatform = hosts.some((h) => host === h || host.endsWith(`.${h}`));
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !onPlatform) {
        throw refuse();
      }
      const query = platform === "instagram" ? "" : url.search;
      return `https://${url.host}${url.pathname}${query}`;
    }

    if (!/^[A-Za-z0-9._-]{1,100}$/.test(s)) throw refuse();
    if (platform === "instagram") return `https://www.instagram.com/${s}/`;
    if (platform === "youtube") return `https://www.youtube.com/@${s}`;
    return `https://x.com/${s}`;
  }

  async getSocialProfileStats(
    platform: "instagram" | "youtube" | "twitter",
    handleOrUrl: string,
  ): Promise<SocialProfileStats | null> {
    if (!this.isConfigured) return null;
    const profileUrl = this.normalizeProfileUrl(platform, handleOrUrl);
    try {
      if (platform === "instagram") return await this.fetchInstagramProfile(profileUrl);
      if (platform === "youtube") return await this.fetchYouTubeProfile(profileUrl);
      return await this.fetchTwitterProfile(profileUrl);
    } catch (err) {
      this.logger.error(`Profile stats failed for ${platform}/${handleOrUrl}: ${err}`);
      return null;
    }
  }

  private async fetchInstagramProfile(profileUrl: string): Promise<SocialProfileStats> {
    // Extract username from URL or raw input
    const username = profileUrl
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.split("?")[0] ?? "";

    const data = await this.hikerApiGet("/v2/user/by/username", { username });
    const p = data.user ?? data;
    if (!p?.username) {
      throw new Error(`Instagram: no profile found for "${username}". Account may be private or not exist.`);
    }

    return {
      platform: "instagram",
      handle: p.username ?? username,
      displayName: p.full_name ?? null,
      followersCount: p.follower_count ?? 0,
      followingCount: p.following_count ?? 0,
      postsCount: p.media_count ?? 0,
      profilePicUrl: p.profile_pic_url ?? null,
      bio: p.biography ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchYouTubeProfile(channelUrl: string): Promise<SocialProfileStats> {
    const items = await this.runActorAndGetDataset(ApifyService.ACTORS.youtube, {
      startUrls: [{ url: channelUrl }],
      maxResults: 1,
    });
    const c = items[0] ?? {};
    return {
      platform: "youtube",
      handle: c.channelHandle ?? c.channel ?? channelUrl,
      displayName: c.channelName ?? c.title ?? null,
      followersCount: c.subscriberCount ?? c.subscribers ?? 0,
      followingCount: 0,
      postsCount: c.videoCount ?? c.videos ?? 0,
      profilePicUrl: c.channelThumbnail ?? null,
      bio: c.channelDescription ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchTwitterProfile(profileUrl: string): Promise<SocialProfileStats> {
    const handle = profileUrl.replace(/\/$/, "").split("/").pop() ?? "";
    const items = await this.runActorAndGetDataset("apidojo~twitter-user-scraper", {
      usernames: [handle],
      maxItems: 1,
    });
    const u = items[0] ?? {};
    return {
      platform: "twitter",
      handle: u.userName ?? u.username ?? handle,
      displayName: u.displayName ?? u.name ?? null,
      followersCount: u.followersCount ?? u.followers ?? 0,
      followingCount: u.followingCount ?? u.following ?? 0,
      postsCount: u.tweetCount ?? u.statusesCount ?? 0,
      profilePicUrl: u.profilePicture ?? u.profileImageUrl ?? null,
      bio: u.description ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }
}
