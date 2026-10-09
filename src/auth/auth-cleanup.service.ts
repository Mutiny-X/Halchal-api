import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../prisma/prisma.service";

const DAY_MS = 24 * 60 * 60_000;
/** OTP rows are needed for a day (the per-number daily cap counts them). */
const OTP_KEEP_MS = 2 * DAY_MS;
/** Spent sign-in and reset tokens are kept a while for investigations. */
const TOKEN_KEEP_MS = 30 * DAY_MS;

/**
 * Nightly housekeeping for sign-in data that is no longer needed: old OTP
 * rows (each holds a phone number), and refresh / reset tokens that expired
 * or were revoked long ago. Nothing here can sign anyone out — every row it
 * removes is already unusable.
 */
@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron("0 15 3 * * *", { timeZone: "Asia/Kolkata" })
  async purgeNightly(): Promise<void> {
    try {
      const result = await this.purge();
      this.logger.log(
        `Sign-in clean-up: ${result.otpSessions} OTP rows, ${result.refreshTokens} refresh tokens, ${result.resetTokens} reset tokens removed`,
      );
    } catch (error) {
      this.logger.error(`Sign-in clean-up failed: ${String(error)}`);
    }
  }

  async purge(now = Date.now()): Promise<{ otpSessions: number; refreshTokens: number; resetTokens: number }> {
    const otpCutoff = new Date(now - OTP_KEEP_MS);
    const tokenCutoff = new Date(now - TOKEN_KEEP_MS);
    const [otp, refresh, reset] = await this.prisma.$transaction([
      this.prisma.otpSession.deleteMany({ where: { createdAt: { lt: otpCutoff } } }),
      this.prisma.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: tokenCutoff } }, { revokedAt: { lt: tokenCutoff } }] },
      }),
      this.prisma.passwordResetToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: tokenCutoff } }, { usedAt: { lt: tokenCutoff } }] },
      }),
    ]);
    return { otpSessions: otp.count, refreshTokens: refresh.count, resetTokens: reset.count };
  }
}
