import { describe, expect, it, vi } from "vitest";

import { breakdownOf, classifyGraphError, contentKind, engagementByReach, followerSeries, postMetricsFrom, totalsByName } from "./instagram-account-insights.parse";
import { ACCOUNT_INSIGHTS_SOURCE, InstagramAccountInsightsService } from "./instagram-account-insights.service";

const tv = (name: string, value: number) => ({ name, period: "day", total_value: { value } });
const bd = (name: string, key: string, rows: Array<[string, number]>) => ({
  name,
  period: "lifetime",
  total_value: { breakdowns: [{ dimension_keys: [key], results: rows.map(([k, v]) => ({ dimension_values: [k], value: v })) }] },
});

/** Answers Graph URLs like Meta does for a 327-follower creator account. */
function metaFake(opts: { denyInsights?: boolean; followers?: number; rateLimited?: boolean; badMetric?: string } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const q = url.searchParams;
    if (opts.rateLimited) return json({ error: { code: 4, message: "Application request limit reached" } }, 400);
    if (url.pathname.endsWith("/me")) {
      return json({ id: "17841", user_id: "17841", username: "simba_the_spy7", name: "Narasimha", followers_count: opts.followers ?? 327, follows_count: 210, media_count: 100, account_type: "MEDIA_CREATOR" });
    }
    if (url.pathname.endsWith("/media")) {
      return json({ data: [
        { id: "m1", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/A/", caption: "Orewa", like_count: 65, comments_count: 7, timestamp: "2025-09-26T10:00:00+0000" },
        { id: "m2", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", permalink: "https://www.instagram.com/p/B/", like_count: 124, comments_count: 6, children: { data: [{}, {}, {}, {}, {}] } },
        { id: "m3", media_type: "IMAGE", media_product_type: "FEED", like_count: 10, comments_count: 1 },
        { id: "s1", media_type: "IMAGE", media_product_type: "STORY" },
      ] });
    }
    const metric = q.get("metric") ?? "";
    if (opts.denyInsights) return json({ error: { code: 10, type: "OAuthException", message: "(#10) Application does not have permission for this action" } }, 403);
    if (opts.badMetric && metric.split(",").length > 1 && metric.includes(opts.badMetric)) {
      return json({ error: { code: 100, message: `(#100) metric[${opts.badMetric}] must be one of the following values` } }, 400);
    }
    if (url.pathname.includes("/m1/")) return json({ data: [{ name: "views", values: [{ value: 1200 }] }, { name: "reach", values: [{ value: 759 }] }, { name: "total_interactions", values: [{ value: 78 }] }, { name: "saved", values: [{ value: 1 }] }, { name: "shares", values: [{ value: 5 }] }, { name: "ig_reels_avg_watch_time", values: [{ value: 4200 }] }] });
    if (url.pathname.includes("/m2/") || url.pathname.includes("/m3/")) return json({ data: [{ name: "reach", values: [{ value: 898 }] }, { name: "total_interactions", values: [{ value: 131 }] }] });
    if (metric === "follower_demographics" || metric === "engaged_audience_demographics") {
      if ((opts.followers ?? 327) < 100) return json({ error: { code: 100, message: "(#100) Not enough users to show demographics" } }, 400);
      const b = q.get("breakdown")!;
      const rows: Record<string, Array<[string, number]>> = {
        age: [["18-24", 190], ["25-34", 95], ["13-17", 13]],
        gender: [["M", 193], ["U", 86], ["F", 47]],
        country: [["IN", 312], ["US", 3]],
        city: [["Nellore, Andhra Pradesh", 118], ["Bangalore, Karnataka", 38]],
      };
      return json({ data: [bd(metric, b, rows[b])] });
    }
    if (metric === "follower_count") return json({ data: [{ name: "follower_count", period: "day", values: [{ value: 2, end_time: "2026-10-01T07:00:00+0000" }, { value: -1, end_time: "2026-10-02T07:00:00+0000" }] }] });
    if (q.get("breakdown") === "media_product_type") return json({ data: [bd(metric, "media_product_type", [["STORY", 2660], ["POST", 930], ["CAROUSEL_CONTAINER", 190], ["REEL", 19]])] });
    if (q.get("breakdown") === "follow_type") return json({ data: [bd(metric, "follow_type", [["FOLLOWER", 9], ["NON_FOLLOWER", 8]])] });
    if (q.get("breakdown") === "contact_button_type") return json({ data: [bd(metric, "contact_button_type", [["BOOK_NOW", 1]])] });
    const values: Record<string, number> = { views: 3800, reach: 326, accounts_engaged: 83, total_interactions: 149, likes: 130, comments: 5, shares: 2, saves: 0, replies: 10, profile_links_taps: 1 };
    return json({ data: metric.split(",").map((m) => tv(m, values[m])) });
  });
  return { fn, calls };
}

function setup(fake = metaFake(), snapshot: { collectedAt: Date; rawMetrics: unknown } | null = null, isConnected = true) {
  const prisma = {
    instagramConnection: {
      findFirst: vi.fn().mockResolvedValue({ id: "conn-1", userId: "creator-1", creatorProfileId: "prof-1", platformUserId: "17841", isConnected }),
      update: vi.fn().mockReturnValue("conn-update"),
    },
    socialAccountInsightSnapshot: {
      findFirst: vi.fn().mockResolvedValue(snapshot),
      create: vi.fn().mockReturnValue("snap-create"),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  const oauth = { getValidAccessToken: vi.fn().mockResolvedValue("tok en") };
  const config = { get: () => "v23.0" };
  const service = new InstagramAccountInsightsService(prisma as never, oauth as never, config as never);
  service.fetchImpl = fake.fn as unknown as typeof fetch;
  return { service, prisma, oauth, fake };
}

describe("parsing Meta's responses", () => {
  it("totals, breakdowns (largest first), follower series", () => {
    expect(totalsByName({ data: [tv("reach", 326), tv("views", 3800)] })).toEqual({ reach: 326, views: 3800 });
    expect(breakdownOf({ data: [bd("views", "media_product_type", [["POST", 1], ["STORY", 9]])] }, "views")).toEqual([
      { key: "STORY", value: 9 },
      { key: "POST", value: 1 },
    ]);
    expect(breakdownOf({ data: [] }, "views")).toBeNull();
    expect(followerSeries({ data: [{ name: "follower_count", values: [{ value: 3, end_time: "2026-10-01T00:00:00Z" }, { value: -1, end_time: "2026-10-02T00:00:00Z" }] }] })).toEqual({
      points: [{ date: "2026-10-01", value: 3 }, { date: "2026-10-02", value: -1 }],
      net: 2,
    });
  });

  it("post metrics: Meta's numbers win, the media fields fill gaps, interactions derived if missing", () => {
    const m = postMetricsFrom({ data: [{ name: "reach", values: [{ value: 100 }] }, { name: "saved", values: [{ value: 2 }] }] }, { id: "x", like_count: 10, comments_count: 3 });
    expect(m).toEqual({ reach: 100, likes: 10, comments: 3, saves: 2, totalInteractions: 15 });
    expect(engagementByReach(m)).toBe(15);
    expect(engagementByReach({ totalInteractions: 5 })).toBeNull();
  });

  it("content kinds", () => {
    expect(contentKind({ id: "1", media_product_type: "REELS", media_type: "VIDEO" })).toBe("reel");
    expect(contentKind({ id: "1", media_product_type: "FEED", media_type: "CAROUSEL_ALBUM" })).toBe("carousel");
    expect(contentKind({ id: "1", media_product_type: "STORY", media_type: "IMAGE" })).toBe("story");
    expect(contentKind({ id: "1", media_type: "IMAGE" })).toBe("photo");
  });

  it("explains why data is missing", () => {
    expect(classifyGraphError({ code: 10, message: "(#10) Application does not have permission" }, 500).reason).toBe("permission");
    expect(classifyGraphError({ code: 100, message: "(#100) Not enough users" }, 500).reason).toBe("threshold");
    expect(classifyGraphError({ code: 100, message: "anything" }, 50).reason).toBe("threshold");
  });
});

describe("InstagramAccountInsightsService", () => {
  it("builds the full report from a creator account and stores it", async () => {
    const { service, prisma } = setup();
    const { report, cached } = await service.getReport("creator-1", "conn-1");
    expect(cached).toBe(false);
    expect(report.profile).toMatchObject({ username: "simba_the_spy7", followerCount: 327 });
    expect(report.overview.totals).toEqual({
      views: 3800, reach: 326, accountsEngaged: 83, totalInteractions: 149, likes: 130, comments: 5,
      shares: 2, saves: 0, replies: 10, profileLinksTaps: 1, follows: 9, unfollows: 8,
    });
    expect(report.overview.viewsByFormat?.[0]).toEqual({ key: "STORY", value: 2660 });
    expect(report.overview.followerGrowth?.net).toBe(1);
    expect(report.audience.followers.age?.[0]).toEqual({ key: "18-24", value: 190 });
    expect(report.audience.engaged.city?.[0].key).toBe("Nellore, Andhra Pradesh");
    // Stories aren't analysed as posts (their insights expire after 24h).
    expect(report.content.posts.map((p) => p.id)).toEqual(["m1", "m2", "m3"]);
    expect(report.content.posts[0]).toMatchObject({ kind: "reel", engagementByReach: 10.28, metrics: { views: 1200, reach: 759, likes: 65, avgWatchTimeMs: 4200 } });
    expect(report.content.posts[1]).toMatchObject({ kind: "carousel", childCount: 5 });
    expect(report.content.mix).toEqual(expect.arrayContaining([{ kind: "reel", count: 1 }, { kind: "story", count: 1 }]));
    expect(report.unavailable).toEqual([]);
    expect(prisma.socialAccountInsightSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: ACCOUNT_INSIGHTS_SOURCE, followerCount: 327, totalViewCount: 3800, engagementRate: 45.71 }),
    });
  });

  it("never puts the access token anywhere but the query string sent to Meta (and encodes it)", async () => {
    const { service, fake, prisma } = setup();
    const { report } = await service.getReport("creator-1", "conn-1");
    expect(fake.calls.every((c) => c.includes("access_token=tok+en") || c.includes("access_token=tok%20en"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("tok");
    expect(JSON.stringify(prisma.socialAccountInsightSnapshot.create.mock.calls)).not.toContain("tok en");
  });

  it("a connection without insights permission still returns the profile, with a clear reason", async () => {
    const { service } = setup(metaFake({ denyInsights: true }));
    const { report } = await service.getReport("creator-1", "conn-1");
    expect(report.profile.username).toBe("simba_the_spy7");
    expect(report.overview.totals.reach).toBeNull();
    expect(report.unavailable.find((u) => u.section === "totals")?.reason).toBe("permission");
    expect(report.unavailable.find((u) => u.section === "post_insights")?.reason).toBe("permission");
    expect(report.content.posts[0].metrics.likes).toBe(65); // from the media list
  });

  it("small accounts: demographics marked as below Meta's 100-follower threshold", async () => {
    const { service } = setup(metaFake({ followers: 60 }));
    const { report } = await service.getReport("creator-1", "conn-1");
    expect(report.audience.followers.age).toBeNull();
    expect(report.unavailable.find((u) => u.section === "followers_age")?.reason).toBe("threshold");
  });

  it("one unsupported metric doesn't lose the other totals", async () => {
    const { service } = setup(metaFake({ badMetric: "replies" }));
    const { report } = await service.getReport("creator-1", "conn-1");
    expect(report.overview.totals.reach).toBe(326);
    expect(report.overview.totals.views).toBe(3800);
  });

  it("rate limited by Meta → 409 META_RATE_LIMITED, nothing stored", async () => {
    const { service, prisma } = setup(metaFake({ rateLimited: true }));
    const err = await service.getReport("creator-1", "conn-1").catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "META_RATE_LIMITED" });
    expect(prisma.socialAccountInsightSnapshot.create).not.toHaveBeenCalled();
  });

  it("serves a fresh cached report without calling Meta; refresh re-syncs unless it was just synced", async () => {
    const fresh = { collectedAt: new Date(Date.now() - 60 * 60 * 1000), rawMetrics: { connectionId: "conn-1" } };
    const a = setup(metaFake(), fresh);
    expect(await a.service.getReport("creator-1", "conn-1")).toMatchObject({ cached: true });
    expect(a.fake.fn).not.toHaveBeenCalled();
    const b = setup(metaFake(), fresh);
    expect(await b.service.getReport("creator-1", "conn-1", { refresh: true })).toMatchObject({ cached: false });
    const justNow = { collectedAt: new Date(Date.now() - 60 * 1000), rawMetrics: { connectionId: "conn-1" } };
    const c = setup(metaFake(), justNow);
    expect(await c.service.getReport("creator-1", "conn-1", { refresh: true })).toMatchObject({ cached: true });
    expect(c.fake.fn).not.toHaveBeenCalled();
  });

  it("a connection belonging to another creator is a 404; a disconnected one shows its last report", async () => {
    const { service, prisma } = setup();
    prisma.instagramConnection.findFirst.mockResolvedValue(null);
    await expect(service.getReport("someone-else", "conn-1")).rejects.toThrow(/not found/);
    const old = { collectedAt: new Date("2026-01-01"), rawMetrics: { connectionId: "conn-1" } };
    const d = setup(metaFake(), old, false);
    expect(await d.service.getReport("creator-1", "conn-1", { refresh: true })).toMatchObject({ cached: true, connected: false });
    const e = setup(metaFake(), null, false);
    await expect(e.service.getReport("creator-1", "conn-1")).rejects.toThrow(/disconnected/);
  });

  it("two admins opening it at once share one sync", async () => {
    const { service, fake } = setup();
    await Promise.all([service.getReport("creator-1", "conn-1"), service.getReport("creator-1", "conn-1")]);
    expect(fake.calls.filter((c) => c.endsWith("/me") || c.includes("/me?")).length).toBe(1);
  });
});
