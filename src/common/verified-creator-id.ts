import { randomInt } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";

/** A random (never sequential — a sequential number would leak total signup
 * count to anyone looking at the leaderboard) 9-digit string, always in
 * [100000000, 999999999] so every id is genuinely 9 digits, never
 * zero-padded. */
function randomNineDigitId(): string {
  return String(randomInt(100_000_000, 1_000_000_000));
}

/** Assigns userId a permanent verifiedCreatorId if it doesn't already have
 * one — called once, the first time a creator's Instagram gets verified.
 * Retries on the rare collision (~1 in 900M) rather than trusting
 * randomness alone to never repeat. Idempotent: a user who already has one
 * keeps it, since this is meant to be permanent. */
export async function ensureVerifiedCreatorId(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { verifiedCreatorId: true },
  });
  if (existing?.verifiedCreatorId) return;

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { verifiedCreatorId: randomNineDigitId() },
      });
      return;
    } catch (err) {
      const isUniqueConflict =
        typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
      if (isUniqueConflict && attempt < maxAttempts) continue;
      throw err;
    }
  }
}
