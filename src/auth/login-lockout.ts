import { HttpException, HttpStatus } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

export type LockoutEntry = { failures: number; windowStart: number; lockedUntil: number };

/** Where failure counts live. The app uses the database, so a lock holds across
 * every API instance and survives a restart; tests use memory. */
export interface LockoutStore {
  get(key: string): Promise<LockoutEntry | null>;
  set(key: string, entry: LockoutEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryLockoutStore implements LockoutStore {
  private readonly entries = new Map<string, LockoutEntry>();

  async get(key: string) {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, entry: LockoutEntry) {
    this.entries.set(key, entry);
    // Drop finished windows so the map can't grow without bound.
    if (this.entries.size < 1000) return;
    const t = Date.now();
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= t && t - e.windowStart >= 60 * 60_000) this.entries.delete(k);
    }
  }

  async delete(key: string) {
    this.entries.delete(key);
  }
}

/** Database-backed store (table `login_lockouts`). */
export class PrismaLockoutStore implements LockoutStore {
  // A client without the table (a test double) falls back to memory; a real
  // PrismaClient always has it.
  private readonly fallback = new MemoryLockoutStore();

  constructor(private readonly prisma: Pick<PrismaClient, "loginLockout">) {}

  private get table() {
    return this.prisma.loginLockout ?? null;
  }

  async get(key: string): Promise<LockoutEntry | null> {
    if (!this.table) return this.fallback.get(key);
    const row = await this.table.findUnique({ where: { email: key } });
    return row
      ? { failures: row.failures, windowStart: row.windowStart.getTime(), lockedUntil: row.lockedUntil?.getTime() ?? 0 }
      : null;
  }

  async set(key: string, entry: LockoutEntry): Promise<void> {
    if (!this.table) return this.fallback.set(key, entry);
    const data = {
      failures: entry.failures,
      windowStart: new Date(entry.windowStart),
      lockedUntil: entry.lockedUntil ? new Date(entry.lockedUntil) : null,
    };
    await this.table.upsert({ where: { email: key }, create: { email: key, ...data }, update: data });
  }

  async delete(key: string): Promise<void> {
    if (!this.table) return this.fallback.delete(key);
    await this.table.deleteMany({ where: { email: key } });
  }
}

/**
 * Locks password sign-in for one email after repeated wrong passwords. The
 * route throttle counts per visitor address, so someone spreading guesses
 * over many addresses could keep trying one account — this counts per
 * account instead. Keyed on whatever email was typed (existing or not), so
 * a lock never reveals whether an account exists.
 */
export class LoginLockout {
  constructor(
    private readonly store: LockoutStore = new MemoryLockoutStore(),
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 while `email` is locked. */
  async assertNotLocked(email: string): Promise<void> {
    const entry = await this.store.get(email);
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

  async recordFailure(email: string): Promise<void> {
    const t = this.now();
    const entry = await this.store.get(email);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      await this.store.set(email, { failures: 1, windowStart: t, lockedUntil: 0 });
      return;
    }
    const failures = entry.failures + 1;
    if (failures >= this.maxFailures) {
      await this.store.set(email, { failures: 0, windowStart: t, lockedUntil: t + this.lockMs });
      return;
    }
    await this.store.set(email, { ...entry, failures });
  }

  async recordSuccess(email: string): Promise<void> {
    await this.store.delete(email);
  }
}
