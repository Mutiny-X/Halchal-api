import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { LoginLockout, PrismaLockoutStore } from "./login-lockout";

/** A stand-in for the login_lockouts table, shared by every "server" in a test. */
function fakeTable() {
  const rows = new Map<string, { email: string; failures: number; windowStart: Date; lockedUntil: Date | null }>();
  return {
    rows,
    loginLockout: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => rows.get(where.email) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { email: string }; create: never; update: never }) => {
        rows.set(where.email, { ...(rows.get(where.email) ?? (create as object)), ...(update as object) } as never);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { email: string } }) => {
        rows.delete(where.email);
      }),
    },
  };
}

const EMAIL = "victim@example.com";

describe("login lockout shared through the database", () => {
  it("a lock set by one API instance holds on another", async () => {
    const db = fakeTable();
    const serverA = new LoginLockout(new PrismaLockoutStore(db as never), 3);
    const serverB = new LoginLockout(new PrismaLockoutStore(db as never), 3);
    // Guesses are spread across two servers, so neither sees 3 on its own.
    await serverA.recordFailure(EMAIL);
    await serverB.recordFailure(EMAIL);
    await serverA.recordFailure(EMAIL);
    await expect(serverB.assertNotLocked(EMAIL)).rejects.toBeInstanceOf(HttpException);
    await expect(serverA.assertNotLocked(EMAIL)).rejects.toMatchObject({ status: 429 });
  });

  it("survives a restart — a new process still sees the lock", async () => {
    const db = fakeTable();
    const before = new LoginLockout(new PrismaLockoutStore(db as never), 2);
    await before.recordFailure(EMAIL);
    await before.recordFailure(EMAIL);
    const afterRestart = new LoginLockout(new PrismaLockoutStore(db as never), 2);
    await expect(afterRestart.assertNotLocked(EMAIL)).rejects.toBeInstanceOf(HttpException);
  });

  it("a correct password on any instance clears the count for all", async () => {
    const db = fakeTable();
    const a = new LoginLockout(new PrismaLockoutStore(db as never), 3);
    const b = new LoginLockout(new PrismaLockoutStore(db as never), 3);
    await a.recordFailure(EMAIL);
    await a.recordFailure(EMAIL);
    await b.recordSuccess(EMAIL);
    await a.recordFailure(EMAIL);
    await expect(a.assertNotLocked(EMAIL)).resolves.toBeUndefined();
    expect(db.rows.get(EMAIL)?.failures).toBe(1);
  });

  it("unlocks by itself once the lock period is over", async () => {
    let now = 1_000_000;
    const db = fakeTable();
    const lock = new LoginLockout(new PrismaLockoutStore(db as never), 2, 60_000, 60_000, () => now);
    await lock.recordFailure(EMAIL);
    await lock.recordFailure(EMAIL);
    await expect(lock.assertNotLocked(EMAIL)).rejects.toBeInstanceOf(HttpException);
    now += 61_000;
    await expect(lock.assertNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it("stores only counts and times against the email that was typed — nothing about the account", async () => {
    const db = fakeTable();
    await new LoginLockout(new PrismaLockoutStore(db as never), 3).recordFailure("nobody-has-this@example.com");
    expect([...db.rows.values()][0]).toEqual({
      email: "nobody-has-this@example.com",
      failures: 1,
      windowStart: expect.any(Date),
      lockedUntil: null,
    });
  });
});
