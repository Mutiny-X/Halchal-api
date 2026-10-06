/* Pure helpers that turn Instagram Insights API responses into the admin
 * report. Kept free of I/O so every response shape can be unit-tested. */

export type GraphError = { code?: number; error_subcode?: number; message?: string; type?: string };

export type InsightResult = { dimension_values?: string[]; value?: number };
export type InsightMetric = {
  name: string;
  period?: string;
  values?: Array<{ value?: number; end_time?: string }>;
  total_value?: {
    value?: number;
    breakdowns?: Array<{ dimension_keys?: string[]; results?: InsightResult[] }>;
  };
};
export type InsightsResponse = { data?: InsightMetric[]; error?: GraphError };

export type KeyValue = { key: string; value: number };

export type UnavailableReason = "permission" | "threshold" | "not_supported" | "error";
export type UnavailableSection = { section: string; reason: UnavailableReason; message: string };

/** Why Meta refused a call, in words an admin can act on. */
export function classifyGraphError(error: GraphError | undefined, followerCount: number): {
  reason: UnavailableReason;
  message: string;
} {
  const raw = error?.message ?? "Instagram didn't return this data.";
  // #10 / #200 / OAuthException on an insights edge = the token lacks
  // instagram_business_manage_insights (creator connected before it was added).
  if (error?.code === 10 || error?.code === 200 || /permission/i.test(raw)) {
    return {
      reason: "permission",
      message: "The creator's Instagram connection doesn't include insights access. Ask them to reconnect Instagram in the app.",
    };
  }
  if (followerCount < 100 || /not enough|minimum|at least 100/i.test(raw)) {
    return {
      reason: "threshold",
      message: "Meta only shares this for accounts with at least 100 followers.",
    };
  }
  if (error?.code === 100 && /metric|breakdown|support/i.test(raw)) {
    return { reason: "not_supported", message: `Instagram doesn't support this for this account: ${raw}` };
  }
  return { reason: "error", message: raw };
}

/** `{ metricName: total }` from a metric_type=total_value response. */
export function totalsByName(res: InsightsResponse | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of res?.data ?? []) {
    if (typeof m.total_value?.value === "number") out[m.name] = m.total_value.value;
  }
  return out;
}

/** A single-dimension breakdown as `[{ key, value }]`, largest first. */
export function breakdownOf(res: InsightsResponse | null, metric: string): KeyValue[] | null {
  const m = res?.data?.find((x) => x.name === metric);
  const results = m?.total_value?.breakdowns?.[0]?.results;
  if (!results) return null;
  const merged = new Map<string, number>();
  for (const r of results) {
    const key = r.dimension_values?.join(" · ") ?? "unknown";
    merged.set(key, (merged.get(key) ?? 0) + (r.value ?? 0));
  }
  return [...merged.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

/** follower_count (period=day) → daily points and the net change. */
export function followerSeries(res: InsightsResponse | null): { points: Array<{ date: string; value: number }>; net: number } | null {
  const m = res?.data?.find((x) => x.name === "follower_count");
  if (!m?.values?.length) return null;
  const points = m.values
    .filter((v) => typeof v.value === "number" && v.end_time)
    .map((v) => ({ date: v.end_time!.slice(0, 10), value: v.value! }));
  return { points, net: points.reduce((s, p) => s + p.value, 0) };
}

export type MediaItem = {
  id: string;
  caption?: string;
  media_type?: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type?: string; // FEED | REELS | STORY | AD
  timestamp?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
  children?: { data?: unknown[] };
};

export type ContentKind = "reel" | "carousel" | "photo" | "video" | "story";

export function contentKind(m: MediaItem): ContentKind {
  if (m.media_product_type === "STORY") return "story";
  if (m.media_product_type === "REELS") return "reel";
  if (m.media_type === "CAROUSEL_ALBUM") return "carousel";
  if (m.media_type === "VIDEO") return "video";
  return "photo";
}

/** The metrics Instagram accepts for each kind of post (asking for one it
 * doesn't support fails the whole call). */
export function mediaMetricsFor(kind: ContentKind): string {
  switch (kind) {
    case "reel":
      return "views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
    case "carousel":
      return "views,reach,likes,comments,shares,saved,total_interactions";
    default:
      return "views,reach,likes,comments,shares,saved,total_interactions,profile_visits,follows";
  }
}
export const FALLBACK_MEDIA_METRICS = "reach,likes,comments,shares,saved";

export type PostMetrics = {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  totalInteractions?: number;
  avgWatchTimeMs?: number;
  totalWatchTimeMs?: number;
  profileVisits?: number;
  follows?: number;
};

export function postMetricsFrom(res: InsightsResponse | null, item: MediaItem): PostMetrics {
  const get = (name: string): number | undefined => {
    const m = res?.data?.find((x) => x.name === name);
    const v = m?.values?.[0]?.value ?? m?.total_value?.value;
    return typeof v === "number" ? v : undefined;
  };
  const metrics: PostMetrics = {
    views: get("views"),
    reach: get("reach"),
    likes: get("likes") ?? item.like_count,
    comments: get("comments") ?? item.comments_count,
    shares: get("shares"),
    saves: get("saved"),
    totalInteractions: get("total_interactions"),
    avgWatchTimeMs: get("ig_reels_avg_watch_time"),
    totalWatchTimeMs: get("ig_reels_video_view_total_time"),
    profileVisits: get("profile_visits"),
    follows: get("follows"),
  };
  if (metrics.totalInteractions === undefined) {
    const parts = [metrics.likes, metrics.comments, metrics.shares, metrics.saves].filter((v): v is number => v !== undefined);
    if (parts.length) metrics.totalInteractions = parts.reduce((a, b) => a + b, 0);
  }
  return Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined)) as PostMetrics;
}

/** Interactions per account reached, as a percentage (Meta's "engagement by reach"). */
export function engagementByReach(m: PostMetrics): number | null {
  if (!m.reach || m.totalInteractions === undefined) return null;
  return Math.round((m.totalInteractions / m.reach) * 10000) / 100;
}

export function contentMix(media: MediaItem[]): Array<{ kind: ContentKind; count: number }> {
  const counts = new Map<ContentKind, number>();
  for (const m of media) counts.set(contentKind(m), (counts.get(contentKind(m)) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}
