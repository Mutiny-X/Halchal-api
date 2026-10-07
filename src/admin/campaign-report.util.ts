/** Pure day-bucketing math for the campaign report — split out from
 * CampaignReportService so it's unit-testable without mocking Prisma. */

export interface InsightSnapshotRow {
  deliverableId: string;
  collectedAt: Date;
  viewCount: number;
  reach: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  saveCount: number;
}

export interface DailyCumulativePoint {
  date: string; // YYYY-MM-DD (UTC)
  views: number;
  reach: number;
  engagement: number;
}

function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function enumerateDays(startDay: string, endDay: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${startDay}T00:00:00Z`);
  const last = new Date(`${endDay}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Each snapshot row already carries a deliverable's *cumulative* value as of
 * that refresh (see participation.service.ts's _recordInsightSnapshot) —
 * never a delta. For each day in the campaign's tracked range, this takes
 * the latest snapshot at-or-before that day per deliverable (carrying the
 * last known value forward across gaps) and sums across every deliverable,
 * producing one campaign-wide cumulative point per day for views, reach,
 * and engagement (likes + comments + shares + saves).
 *
 * Returns an empty array if there's no tracked data yet.
 */
export function buildDailyCumulativeSeries(
  snapshots: InsightSnapshotRow[],
): DailyCumulativePoint[] {
  if (snapshots.length === 0) return [];

  const byDeliverable = new Map<
    string,
    { date: string; views: number; reach: number; engagement: number }[]
  >();
  for (const s of snapshots) {
    const date = toDayKey(s.collectedAt);
    const list = byDeliverable.get(s.deliverableId) ?? [];
    list.push({
      date,
      views: s.viewCount,
      reach: s.reach,
      engagement: s.likeCount + s.commentCount + s.shareCount + s.saveCount,
    });
    byDeliverable.set(s.deliverableId, list);
  }

  // Collapse same-day duplicates per deliverable (later refresh wins) and sort ascending.
  for (const [id, list] of byDeliverable) {
    const byDay = new Map<string, { date: string; views: number; reach: number; engagement: number }>();
    for (const point of list) byDay.set(point.date, point);
    byDeliverable.set(
      id,
      Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    );
  }

  const allDays = Array.from(new Set(snapshots.map((s) => toDayKey(s.collectedAt)))).sort();
  const dayRange = enumerateDays(allDays[0], allDays[allDays.length - 1]);

  const cursors = new Map<string, number>();
  for (const id of byDeliverable.keys()) cursors.set(id, -1);

  const result: DailyCumulativePoint[] = [];
  for (const day of dayRange) {
    let views = 0;
    let reach = 0;
    let engagement = 0;
    for (const [id, list] of byDeliverable) {
      let idx = cursors.get(id)!;
      while (idx + 1 < list.length && list[idx + 1].date <= day) idx++;
      cursors.set(id, idx);
      if (idx >= 0) {
        views += list[idx].views;
        reach += list[idx].reach;
        engagement += list[idx].engagement;
      }
    }
    result.push({ date: day, views, reach, engagement });
  }
  return result;
}

export interface DemographicBucket {
  label: string;
  value: number;
  pct: number;
}

/** Sums a dimension's counts (e.g. city -> follower count) across every
 * participating creator who returned demographics, ranks by magnitude, and
 * folds anything past topN into a single "Other" bucket — the same
 * read-at-a-glance cap used elsewhere in this report, just applied to a bar
 * chart instead of a pie. Counts are summed (not percentages averaged), so
 * a creator with more followers naturally carries proportionally more
 * weight in the result. Returns [] if nobody has any data for this
 * dimension (e.g. no connected creator had the required Instagram scope). */
export function aggregateDemographicBreakdown(
  perCreator: Record<string, number>[],
  topN = 8,
): DemographicBucket[] {
  const totals = new Map<string, number>();
  for (const breakdown of perCreator) {
    for (const [key, count] of Object.entries(breakdown)) {
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }

  const grandTotal = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
  if (grandTotal <= 0) return [];

  const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const otherTotal = rest.reduce((sum, [, v]) => sum + v, 0);

  const buckets: DemographicBucket[] = top.map(([label, value]) => ({
    label,
    value,
    pct: (value / grandTotal) * 100,
  }));
  if (otherTotal > 0) {
    buckets.push({ label: `Other (${rest.length})`, value: otherTotal, pct: (otherTotal / grandTotal) * 100 });
  }
  return buckets;
}

/** Instagram's standard age-band labels, in their natural order — age is an
 * ordered category, so (unlike city/country) this is sorted by band, not by
 * magnitude, and nothing gets folded into "Other" regardless of how many
 * bands are present (there are only ever a handful). Any band Instagram
 * returns that isn't in this known list is appended at the end rather than
 * dropped. */
const AGE_BAND_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

export function aggregateAgeBreakdown(perCreator: Record<string, number>[]): DemographicBucket[] {
  const totals = new Map<string, number>();
  for (const breakdown of perCreator) {
    for (const [key, count] of Object.entries(breakdown)) {
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }

  const grandTotal = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
  if (grandTotal <= 0) return [];

  const known = AGE_BAND_ORDER.filter((band) => totals.has(band));
  const unknown = Array.from(totals.keys()).filter((band) => !AGE_BAND_ORDER.includes(band));
  return [...known, ...unknown].map((label) => {
    const value = totals.get(label) ?? 0;
    return { label, value, pct: (value / grandTotal) * 100 };
  });
}
