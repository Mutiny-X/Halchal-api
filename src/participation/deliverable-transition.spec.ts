import { BadRequestException } from "@nestjs/common";
import { FormatDeliverableStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { liveLinkProblem, liveLinkVariants, transitionDeliverable } from "./deliverable-transition";

describe("transitionDeliverable", () => {
  function client(count: number) {
    return {
      formatDeliverable: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "d1", status: "draft_approved" }),
      },
    };
  }

  it("writes only while the deliverable is still in an allowed state", async () => {
    const c = client(1);
    const updated = await transitionDeliverable(
      c as never,
      "d1",
      [FormatDeliverableStatus.under_review],
      { status: FormatDeliverableStatus.draft_approved },
      "already reviewed",
    );
    expect(c.formatDeliverable.updateMany).toHaveBeenCalledWith({
      where: { id: "d1", status: { in: [FormatDeliverableStatus.under_review] } },
      data: { status: FormatDeliverableStatus.draft_approved },
    });
    expect(updated).toEqual({ id: "d1", status: "draft_approved" });
  });

  it("refuses when someone else moved it first", async () => {
    const c = client(0);
    await expect(
      transitionDeliverable(c as never, "d1", [FormatDeliverableStatus.under_review], {}, "already reviewed"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(c.formatDeliverable.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("liveLinkProblem", () => {
  it.each([
    ["instagram_reel", "https://www.instagram.com/reel/abc/"],
    ["instagram_post", "https://instagram.com/p/abc"],
    ["youtube_shorts", "https://youtube.com/shorts/abc"],
    ["youtube_shorts", "https://m.youtube.com/watch?v=abc"],
    ["youtube_shorts", "https://youtu.be/abc"],
    ["twitter_tweet", "https://x.com/a/status/1"],
    ["twitter_tweet", "https://twitter.com/a/status/1"],
    ["some_new_platform", "https://example.com/anything"],
  ])("accepts %s → %s", (platform, url) => {
    expect(liveLinkProblem(platform, url)).toBeNull();
  });

  it.each([
    ["instagram_reel", "https://youtube.com/shorts/abc"],
    ["instagram_reel", "https://evilinstagram.com/reel/abc"],
    ["instagram_reel", "https://instagram.com.evil.io/reel/abc"],
    ["youtube_shorts", "https://www.instagram.com/reel/abc"],
    ["instagram_reel", "javascript:alert(1)"],
    ["instagram_reel", "not a url"],
  ])("rejects %s → %s", (platform, url) => {
    expect(liveLinkProblem(platform, url)).toMatch(/link/);
  });
});

describe("liveLinkVariants", () => {
  it("matches the same post with or without a trailing slash", () => {
    expect(liveLinkVariants(" https://instagram.com/reel/abc/ ")).toEqual(
      expect.arrayContaining(["https://instagram.com/reel/abc", "https://instagram.com/reel/abc/"]),
    );
  });
});
