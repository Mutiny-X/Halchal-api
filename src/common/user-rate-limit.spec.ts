import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { UserRateLimiter } from "./user-rate-limit";

describe("UserRateLimiter", () => {
  it("allows up to the limit, then answers 429 RATE_LIMITED", () => {
    const limiter = new UserRateLimiter(3, 60_000, () => 0);
    limiter.consume("u1");
    limiter.consume("u1");
    limiter.consume("u1");
    try {
      limiter.consume("u1");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
      expect((e as HttpException).getResponse()).toMatchObject({ code: "RATE_LIMITED" });
    }
  });

  it("counts each user separately", () => {
    const limiter = new UserRateLimiter(1, 60_000, () => 0);
    limiter.consume("u1");
    expect(() => limiter.consume("u2")).not.toThrow();
  });

  it("starts a fresh window once the old one has passed", () => {
    let t = 0;
    const limiter = new UserRateLimiter(1, 60_000, () => t);
    limiter.consume("u1");
    t = 60_000;
    expect(() => limiter.consume("u1")).not.toThrow();
  });
});
