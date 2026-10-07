import { describe, expect, it } from "vitest";

import {
  aggregateAgeBreakdown,
  aggregateDemographicBreakdown,
  buildDailyCumulativeSeries,
  type InsightSnapshotRow,
} from "./campaign-report.util";

function snapshot(
  deliverableId: string,
  day: string,
  values: Partial<Omit<InsightSnapshotRow, "deliverableId" | "collectedAt">> = {},
): InsightSnapshotRow {
  return {
    deliverableId,
    collectedAt: new Date(`${day}T12:00:00Z`),
    viewCount: 0,
    reach: 0,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    saveCount: 0,
    ...values,
  };
}

describe("buildDailyCumulativeSeries", () => {
  it("returns an empty series when there are no snapshots", () => {
    expect(buildDailyCumulativeSeries([])).toEqual([]);
  });

  it("sums across deliverables per day, carrying each forward from its own last snapshot", () => {
    const rows = [
      snapshot("d1", "2026-01-01", { viewCount: 100, reach: 80, likeCount: 10 }),
      snapshot("d2", "2026-01-02", { viewCount: 50, reach: 40, likeCount: 5 }),
      snapshot("d1", "2026-01-03", { viewCount: 200, reach: 150, likeCount: 20 }),
    ];

    const series = buildDailyCumulativeSeries(rows);

    expect(series.map((p) => p.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    // Day 1: only d1 has reported (100 views). d2 hasn't started yet -> 0.
    expect(series[0]).toMatchObject({ views: 100, reach: 80, engagement: 10 });
    // Day 2: d1 carries forward its day-1 value (100); d2 reports 50 -> 150 total.
    expect(series[1]).toMatchObject({ views: 150, reach: 120, engagement: 15 });
    // Day 3: d1 updates to 200; d2 carries forward 50 -> 250 total.
    expect(series[2]).toMatchObject({ views: 250, reach: 190, engagement: 25 });
  });

  it("collapses same-day duplicate snapshots for one deliverable, keeping the later one", () => {
    const rows = [
      snapshot("d1", "2026-02-01", { viewCount: 10 }),
      { ...snapshot("d1", "2026-02-01", { viewCount: 40 }), collectedAt: new Date("2026-02-01T18:00:00Z") },
    ];

    const series = buildDailyCumulativeSeries(rows);

    expect(series).toHaveLength(1);
    expect(series[0].views).toBe(40);
  });

  it("fills gap days by carrying the last known value forward", () => {
    const rows = [
      snapshot("d1", "2026-03-01", { viewCount: 100 }),
      snapshot("d1", "2026-03-05", { viewCount: 500 }),
    ];

    const series = buildDailyCumulativeSeries(rows);

    expect(series.map((p) => p.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
    expect(series.map((p) => p.views)).toEqual([100, 100, 100, 100, 500]);
  });
});

describe("aggregateDemographicBreakdown", () => {
  it("returns an empty list when there's no data at all", () => {
    expect(aggregateDemographicBreakdown([])).toEqual([]);
    expect(aggregateDemographicBreakdown([{}, {}])).toEqual([]);
  });

  it("sums counts for the same key across creators, ranked by magnitude", () => {
    const perCreator: Record<string, number>[] = [
      { Hyderabad: 400, Chennai: 100 },
      { Hyderabad: 600, Bengaluru: 200 },
    ];

    const buckets = aggregateDemographicBreakdown(perCreator, 8);

    expect(buckets[0]).toMatchObject({ label: "Hyderabad", value: 1000 });
    expect(buckets.map((b) => b.label)).toEqual(["Hyderabad", "Bengaluru", "Chennai"]);
    const totalPct = buckets.reduce((sum, b) => sum + b.pct, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });

  it("folds everything past topN into a single Other bucket", () => {
    const perCreator = [
      { A: 50, B: 40, C: 30, D: 20, E: 10 },
    ];

    const buckets = aggregateDemographicBreakdown(perCreator, 2);

    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ label: "A", value: 50 });
    expect(buckets[1]).toMatchObject({ label: "B", value: 40 });
    expect(buckets[2].label).toBe("Other (3)");
    expect(buckets[2].value).toBe(30 + 20 + 10);
  });
});

describe("aggregateAgeBreakdown", () => {
  it("returns an empty list when there's no data", () => {
    expect(aggregateAgeBreakdown([])).toEqual([]);
  });

  it("orders known age bands by band, not by magnitude, and never buckets into Other", () => {
    const perCreator: Record<string, number>[] = [
      { "35-44": 10, "18-24": 500, "65+": 5 },
      { "25-34": 200 },
    ];

    const buckets = aggregateAgeBreakdown(perCreator);

    expect(buckets.map((b) => b.label)).toEqual(["18-24", "25-34", "35-44", "65+"]);
    expect(buckets.find((b) => b.label === "18-24")).toMatchObject({ value: 500 });
  });

  it("appends an unrecognized band after the known ones instead of dropping it", () => {
    const buckets = aggregateAgeBreakdown([{ "18-24": 10, "unknown-band": 5 }]);
    expect(buckets.map((b) => b.label)).toEqual(["18-24", "unknown-band"]);
  });
});
