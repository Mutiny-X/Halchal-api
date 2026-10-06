import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * A small per-user fixed-window limiter for expensive authenticated actions
 * (outbound fetches, presigned uploads). The global ThrottlerGuard counts
 * per client IP and runs before authentication, so behind a shared proxy IP
 * it can't tell users apart — this keys on the logged-in user instead.
 * In-memory: per API instance, reset on restart, which is fine for abuse
 * damping (not billing-grade accounting).
 */
export class UserRateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 RATE_LIMITED once `userId` exceeds the limit in the window. */
  consume(userId: string): void {
    const t = this.now();
    const entry = this.hits.get(userId);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(userId, { windowStart: t, count: 1 });
      this.sweep(t);
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      throw new HttpException(
        {
          code: "RATE_LIMITED",
          message: "Too many requests — please wait a minute and try again",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Drops expired windows so the map can't grow without bound. */
  private sweep(t: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (t - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
