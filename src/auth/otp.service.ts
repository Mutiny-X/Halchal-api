import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import { createHash, randomInt } from "node:crypto";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../notifications/whatsapp.service";
import { FixedOtpService } from "./fixed-otp.service";

// See requestOtp's own comment for why these exist — free resends up to
// this count, then a cooldown between each request after that.
const ATTEMPTS_BEFORE_COOLDOWN = 3;
const ATTEMPT_WINDOW_MS = 30 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly whatsapp: WhatsappService,
    private readonly fixedOtp: FixedOtpService,
  ) {}

  async requestOtp(rawPhone: string): Promise<{ expiresInSeconds: number }> {
    const phone = normalizePhone(rawPhone);

    // The first few resends go through instantly — a creator mistyping
    // their number or not getting the WhatsApp message right away
    // shouldn't be stuck waiting on a cooldown that only matters once this
    // actually looks like spam. Only once ATTEMPTS_BEFORE_COOLDOWN requests
    // have already landed in ATTEMPT_WINDOW_MS does the old 60s
    // between-requests wait kick in. Old sessions are deliberately not
    // deleted here (only their codes go stale, superseded by the newest
    // row — see verifyOtp, which only ever reads the latest one) so this
    // count stays accurate across resends within the window.
    const recentSessions = await this.prisma.otpSession.findMany({
      where: { phone, createdAt: { gte: new Date(Date.now() - ATTEMPT_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      take: ATTEMPTS_BEFORE_COOLDOWN,
    });
    if (recentSessions.length >= ATTEMPTS_BEFORE_COOLDOWN) {
      const msSinceLast = Date.now() - recentSessions[0].createdAt.getTime();
      if (msSinceLast < RESEND_COOLDOWN_MS) {
        throw new HttpException(
          {
            code: "RATE_LIMITED",
            message: "Wait before requesting another OTP",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const fixedCode = await this.fixedOtp.getFixedCodeForPhone(phone);
    const code = fixedCode ?? randomInt(100_000, 999_999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const ttl = this.config.get("OTP_TTL_SECONDS", { infer: true });
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.prisma.otpSession.create({
      data: { phone, codeHash, expiresAt },
    });

    if (fixedCode) {
      this.logger.log(
        `Fixed OTP profile ${phone} — enter ${fixedCode} (no WhatsApp)`,
      );
      return { expiresInSeconds: ttl };
    }

    try {
      await this.whatsapp.sendOtp(phone, code);
    } catch {
      this.logger.error(`Failed to deliver OTP to ${phone}`);
      throw new BadRequestException({
        code: "INTERNAL_ERROR",
        message: "Could not send OTP. Try again later.",
      });
    }

    return { expiresInSeconds: ttl };
  }

  async verifyOtp(rawPhone: string, code: string): Promise<void> {
    const phone = normalizePhone(rawPhone);
    const fixedCode = await this.fixedOtp.getFixedCodeForPhone(phone);
    if (fixedCode && code === fixedCode) {
      this.logger.warn(`Fixed-code OTP verification used for ${phone}`);
      await this.prisma.otpSession.deleteMany({ where: { phone } });
      return;
    }

    const session = await this.prisma.otpSession.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "OTP expired or not found",
      });
    }

    const maxAttempts = this.config.get("OTP_MAX_ATTEMPTS", { infer: true });
    if (session.attempts >= maxAttempts) {
      throw new HttpException(
        {
          code: "RATE_LIMITED",
          message: "Too many OTP attempts",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid = await bcrypt.compare(code, session.codeHash);
    if (!valid) {
      await this.prisma.otpSession.update({
        where: { id: session.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid OTP",
      });
    }

    await this.prisma.otpSession.delete({ where: { id: session.id } });
  }
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Accepts: 10-digit bare number, 91-prefixed 12-digit, or already-formatted +91.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return raw;
}
