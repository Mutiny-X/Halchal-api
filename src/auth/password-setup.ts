import { randomBytes } from "node:crypto";

import { hashRefreshToken } from "./otp.service";

type TokenStore = {
  passwordResetToken: {
    updateMany(args: { where: { userId: string; usedAt: null }; data: { usedAt: Date } }): Promise<unknown>;
    create(args: { data: { userId: string; tokenHash: string; expiresAt: Date } }): Promise<unknown>;
  };
};

/** How long a new team member's "set your password" link stays valid. */
export const ACCOUNT_SETUP_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * A one-time link token for choosing a password, so a new account's
 * password never travels by email. It's an ordinary password-reset token
 * (same table, same /reset-password page), just valid for longer.
 */
export async function issuePasswordSetupToken(prisma: TokenStore, userId: string, ttlMs = ACCOUNT_SETUP_TTL_MS): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashRefreshToken(token), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}
