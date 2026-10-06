import { describe, expect, it } from "vitest";

import { computePostEngagementRate } from "./engagement-rate";

describe("computePostEngagementRate", () => {
  it("is (likes + comments + shares + saves) / reach, as a percentage", () => {
    // 100 + 20 + 30 + 50 = 200 interactions over 4,000 reach = 5%
    expect(
      computePostEngagementRate({ reach: 4_000, likeCount: 100, commentCount: 20, shareCount: 30, saveCount: 50 }),
    ).toBe(5);
  });

  it("rounds to 2 decimals", () => {
    // 1 / 3 = 33.333…%
    expect(
      computePostEngagementRate({ reach: 3, likeCount: 1, commentCount: 0, shareCount: 0, saveCount: 0 }),
    ).toBe(33.33);
  });

  it("includes saves and shares, not just likes and comments", () => {
    expect(
      computePostEngagementRate({ reach: 100, likeCount: 0, commentCount: 0, shareCount: 10, saveCount: 15 }),
    ).toBe(25);
  });

  it("is a real 0 — not null — when there's reach but no interactions", () => {
    expect(
      computePostEngagementRate({ reach: 500, likeCount: 0, commentCount: 0, shareCount: 0, saveCount: 0 }),
    ).toBe(0);
  });

  it("returns null when reach is 0, negative or not a number — there's nothing to divide by", () => {
    const base = { likeCount: 10, commentCount: 1, shareCount: 1, saveCount: 1 };
    expect(computePostEngagementRate({ ...base, reach: 0 })).toBeNull();
    expect(computePostEngagementRate({ ...base, reach: -5 })).toBeNull();
    expect(computePostEngagementRate({ ...base, reach: Number.NaN })).toBeNull();
  });

  it("is not capped at 100%", () => {
    expect(
      computePostEngagementRate({ reach: 100, likeCount: 90, commentCount: 10, shareCount: 10, saveCount: 10 }),
    ).toBe(120);
  });
});
