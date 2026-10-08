import { HttpException, HttpStatus } from "@nestjs/common";

type Entry = { failures: number; windowStart: number; lockedUntil: number };

/**
 * Locks password sign-in for one email after repeated wrong passwords. The
 * route throttle counts per visitor address, so someone spreading guesses
 * over many addresses could keep trying one account — this counts per
 * account instead. Keyed on whatever email was typed (existing or not), so
 * a lock never reveals whether an account exists.
 * In-memory: per API instance, reset on restart.
 */
export class LoginLockout {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 while `email` is locked. */
  assertNotLocked(email: string): void {
    const entry = this.entries.get(email);
    if (!entry) return;
    const t = this.now();
    if (entry.lockedUntil > t) {
      const minutes = Math.max(1, Math.ceil((entry.lockedUntil - t) / 60_000));
      throw new HttpException(
        {
          code: "RATE_LIMITED",
          message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(email: string): void {
    const t = this.now();
    const entry = this.entries.get(email);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.entries.set(email, { failures: 1, windowStart: t, lockedUntil: 0 });
      this.sweep(t);
      return;
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = t + this.lockMs;
      entry.failures = 0;
      entry.windowStart = t;
    }
  }

  recordSuccess(email: string): void {
    this.entries.delete(email);
  }

  /** Drops finished windows so the map can't grow without bound. */
  private sweep(t: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= t && t - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}
