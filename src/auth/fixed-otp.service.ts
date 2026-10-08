import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FixedOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // App Store / Play Store reviewer test accounts — work in ALL environments.
  // Reviewers cannot receive real WhatsApp OTPs during the review process.
  // Two accounts (not one) since a reviewer often needs to exercise both a
  // brand and a creator flow, or a fresh-signup vs. already-onboarded path,
  // in the same review pass.
  //
  // These are also the only two phone numbers prisma/seed.ts ever assigns a
  // fixedOtpCode to (Meta app-review demo creators) — same two numbers,
  // same risk, so they're reserved together. See RESERVED_PHONES: no real
  // user may ever sign up with either number, which is what keeps this
  // bypass scoped to these pre-provisioned demo/reviewer accounts instead
  // of becoming a backdoor on an arbitrary real account.
  private static readonly REVIEWER_ACCOUNTS: Record<string, string> = {
    "+919876543211": "000000",
    "+919876543210": "000000",
  };

  /** Phone numbers that may never be claimed by a real signup — see the
   * comment on REVIEWER_ACCOUNTS above for why. */
  static readonly RESERVED_PHONES: ReadonlySet<string> = new Set(
    Object.keys(FixedOtpService.REVIEWER_ACCOUNTS),
  );

  /**
   * Fixed OTP from three mechanisms (checked in order):
   * 1. REVIEWER_ACCOUNTS — hardcoded App Store / Play Store reviewer phones.
   * 2. OTP_DEV_BYPASS_CODE — any valid +91 phone in NODE_ENV=development only.
   * 3. User.fixedOtpCode — per-account static OTP (demo seed users).
   *
   * 1 and 3 are a well-known static code on a real sign-in, so in
   * production they only work while REVIEWER_OTP_ENABLED=true — switch it
   * on for a store review and off again afterwards. Outside production
   * they always work.
   */
  async getFixedCodeForPhone(phone: string): Promise<string | null> {
    const fixedCodesAllowed = this.fixedCodesAllowed();

    const reviewerCode = FixedOtpService.REVIEWER_ACCOUNTS[phone];
    if (reviewerCode) return fixedCodesAllowed ? reviewerCode : null;

    const devBypass = this.getDevBypassCode();
    if (devBypass) return devBypass;

    if (!fixedCodesAllowed) return null;

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { fixedOtpCode: true },
    });
    const code = user?.fixedOtpCode?.trim();
    return code && code.length === 6 ? code : null;
  }

  private fixedCodesAllowed(): boolean {
    if (this.config.get("NODE_ENV", { infer: true }) !== "production") return true;
    return this.config.get("REVIEWER_OTP_ENABLED", { infer: true }) === true;
  }

  private getDevBypassCode(): string | null {
    if (this.config.get("NODE_ENV", { infer: true }) !== "development") {
      return null;
    }
    const code = this.config.get("OTP_DEV_BYPASS_CODE", { infer: true });
    return code?.trim() || null;
  }
}
