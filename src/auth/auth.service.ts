import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Prisma, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

import { parseDurationMs } from "../common/parse-duration";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../notifications/email.service";
import { BRAND_ACCESS_CLOSED, type AuthJwtPayload, type AuthTokens } from "./auth.types";
import { FixedOtpService } from "./fixed-otp.service";
import { LoginLockout, PrismaLockoutStore } from "./login-lockout";
import { hashRefreshToken, normalizePhone, OtpService } from "./otp.service";
import type { AdminLoginDto } from "./dto/admin-auth.dto";
import type { BrandLoginDto, BrandRegisterDto } from "./dto/brand-auth.dto";
import type { CreatorOtpVerifyDto } from "./dto/creator-auth.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly otp: OtpService,
    private readonly email: EmailService,
  ) {
    this.lockout = new LoginLockout(new PrismaLockoutStore(prisma));
  }

  /** Wrong-password lockout per email, shared by both password sign-ins and,
   * because it lives in the database, by every API instance. */
  private readonly lockout: LoginLockout;

  /** Brand self sign-up is closed (see BRAND_ACCESS_CLOSED) — admins add
   * brands from the admin panel instead. The route stays so an old sign-up
   * page or a direct call gets a clear answer rather than a 404. */
  registerBrand(_dto: BrandRegisterDto): never {
    throw new ForbiddenException({
      code: "BRAND_ACCESS_CLOSED",
      message: "Brand sign-up is closed. The Halchal team sets up campaigns for brands — contact us to get started.",
    });
  }

  async loginAdmin(dto: AdminLoginDto) {
    return this.passwordLogin(dto.email, dto.password, [UserRole.admin]);
  }

  /** The team sign-in page. Admins may sign in here too — the website sends
   * them to the admin portal by their role — so no answer ever has to say
   * "wrong portal" and reveal what kind of account an email belongs to. */
  async loginBrand(dto: BrandLoginDto) {
    return this.passwordLogin(dto.email, dto.password, [UserRole.staff, UserRole.admin]);
  }

  /**
   * One path for every password sign-in. Every failure — unknown email,
   * wrong role, deactivated account, wrong password — gets the same answer
   * after the same amount of work (a bcrypt compare always runs), so
   * neither the message nor the response time says whether an account
   * exists or what it is.
   */
  private async passwordLogin(rawEmail: string, password: string, roles: UserRole[]) {
    return this.issueTokens(await this.authenticatePassword(rawEmail, password, roles));
  }

  /**
   * Proves someone knows an account's password — same lockout, same timing,
   * same single answer for every failure as a normal sign-in — without
   * starting a session. For flows that must re-check ownership before doing
   * something sensitive (e.g. accepting a campaign invite on an existing account).
   */
  async authenticatePassword(rawEmail: string, password: string, roles: UserRole[]) {
    const email = rawEmail.toLowerCase();
    await this.lockout.assertNotLocked(email);

    const user = await this.prisma.user.findUnique({ where: { email } });
    const eligible = Boolean(
      user?.passwordHash && roles.includes(user.role) && user.isActive !== false,
    );
    const ok = await bcrypt.compare(password, eligible ? user!.passwordHash! : TIMING_DUMMY_HASH);

    if (!eligible || !ok) {
      await this.lockout.recordFailure(email);
      throw invalidCredentials();
    }

    await this.lockout.recordSuccess(email);
    return user!;
  }

  async forgotBrandPassword(email: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    // Only team members sign in with a password here now. Same answer
    // either way, so this can't be used to find out who has an account.
    if (!user || user.role !== UserRole.staff || !user.isActive) {
      return { sent: true };
    }

    const resetToken = randomBytes(32).toString("hex");
    const tokenHash = hashRefreshToken(resetToken);
    const resetTtlMs = this.passwordResetTtlMs();

    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + resetTtlMs),
      },
    });

    await this.email.sendPasswordReset(user.email!, resetToken);
    return { sent: true };
  }

  async resetBrandPassword(
    token: string,
    password: string,
  ): Promise<{ reset: boolean }> {
    const tokenHash = hashRefreshToken(token);
    const stored = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (
      !stored ||
      stored.usedAt ||
      stored.expiresAt < new Date() ||
      // Team members reset here; admins only use it through the one-time
      // setup link in their welcome email (forgot-password never issues
      // admin links).
      (stored.user.role !== UserRole.staff && stored.user.role !== UserRole.admin) ||
      !stored.user.isActive
    ) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid or expired reset link",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: stored.userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.activityLog.create({
        data: { actorUserId: stored.userId, action: "auth.password_reset", targetType: "User", targetId: stored.userId },
      }),
    ]);

    return { reset: true };
  }

  async verifyCreatorOtp(dto: CreatorOtpVerifyDto) {
    const phone = normalizePhone(dto.phone);
    await this.otp.verifyOtp(phone, dto.code);

    let user = await this.prisma.user.findUnique({
      where: { phone },
      include: { wallet: true },
    });

    if (!user) {
      if (!dto.displayName) {
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          message: "No account with this phone. Sign up to create one.",
        });
      }
      if (!dto.email?.trim()) {
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          message: "Email is required to create an account.",
        });
      }
      await this.assertCreatorSignupFieldsAvailable({ ...dto, phone });
      try {
        user = await this.prisma.user.create({
          data: {
            role: UserRole.creator,
            phone,
            displayName: dto.displayName,
            username: dto.username,
            email: dto.email?.toLowerCase(),
            requiresOnboardingGate: true,
            wallet: { create: {} },
            // A placeholder profile so the signup-verification gate's
            // Instagram OAuth step has something to attach to immediately —
            // complete() overwrites handle/socialLinks with the real
            // connected account the moment OAuth finishes.
            creatorProfiles: {
              create: { platform: "instagram", handle: phone, isDefault: true },
            },
          },
          include: { wallet: true },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new ConflictException({
            code: "CONFLICT",
            message:
              "Phone, email, or username is already registered. Try logging in or use different details.",
          });
        }
        throw error;
      }
    } else if (user.role === UserRole.creator && !user.isActive) {
      // Suspended by an admin. (A self-deleted account has no phone number
      // left, so it never reaches here.)
      throw new ForbiddenException({
        code: "ACCOUNT_SUSPENDED",
        message: "This account has been suspended. Contact Halchal support if you think this is a mistake.",
      });
    } else if (user.role !== UserRole.creator) {
      throw new ConflictException({
        code: "WRONG_PORTAL",
        message:
          "This phone number is registered as a brand account. Use the brand portal.",
      });
    } else if (!user.wallet) {
      await this.prisma.wallet.create({ data: { userId: user.id } });
      user = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { wallet: true },
      });
    }

    return this.issueTokens(user);
  }

  private async assertCreatorSignupFieldsAvailable(
    dto: CreatorOtpVerifyDto,
  ): Promise<void> {
    // These numbers are reserved for the hardcoded App Store/Meta reviewer
    // + demo-seed accounts (see FixedOtpService) — a real signup must never
    // land on one, since that phone number's OTP is a well-known static
    // code in every environment.
    if (FixedOtpService.RESERVED_PHONES.has(dto.phone)) {
      throw new ConflictException({
        code: "CONFLICT",
        message: "This phone number can't be used to sign up.",
      });
    }

    if (dto.email) {
      const email = dto.email.toLowerCase();
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new ConflictException({
          code: "CONFLICT",
          message:
            "This email is already registered. Use a different email or log in.",
        });
      }
    }

    if (dto.username) {
      const existing = await this.prisma.user.findUnique({
        where: { username: dto.username },
      });
      if (existing) {
        throw new ConflictException({
          code: "CONFLICT",
          message: "This username is already taken.",
        });
      }
    }
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    // A refresh token is single-use, so one that was already used turning
    // up again means someone else holds a copy. Sign that account out
    // everywhere. A short grace period covers the honest case of two
    // requests racing with the same token (two tabs, a retried request).
    if (stored?.revokedAt && stored.user) {
      const sinceRevoked = Date.now() - stored.revokedAt.getTime();
      if (sinceRevoked > REFRESH_REUSE_GRACE_MS && stored.expiresAt >= new Date()) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: stored.user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt < new Date() ||
      !stored.user
    ) {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "Invalid refresh token",
      });
    }

    // A session can't outlive the account's access: brands are closed out,
    // and anyone deactivated or removed stops at their next refresh instead
    // of staying signed in for as long as they keep the tab open.
    if (stored.user.role === UserRole.brand || !stored.user.isActive) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException(
        stored.user.role === UserRole.brand
          ? BRAND_ACCESS_CLOSED
          : { code: "UNAUTHORIZED", message: "This account has been deactivated" },
      );
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private passwordResetTtlMs(): number {
    return parseDurationMs(
      this.config.get("PASSWORD_RESET_TTL", { infer: true }),
    );
  }

  async createSessionForUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }
    return this.issueTokens(user);
  }

  private async issueTokens(user: {
    id: string;
    role: UserRole;
    email: string | null;
    phone: string | null;
    displayName: string | null;
    mustChangePassword?: boolean;
  }) {
    // Only what the guards need. Tokens are readable by anyone holding
    // one, so the email and phone number stay out of them.
    const payload: AuthJwtPayload = {
      sub: user.id,
      role: user.role,
    };

    const accessTtl = this.config.get("JWT_ACCESS_TTL", { infer: true });
    const refreshTtl = this.config.get("JWT_REFRESH_TTL", { infer: true });

    const accessToken = await this.jwt.signAsync(
      { ...payload },
      { expiresIn: accessTtl as `${number}${"s" | "m" | "h" | "d"}` },
    );

    const refreshToken = randomBytes(48).toString("base64url");
    const refreshDays = parseRefreshDays(refreshTtl);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
      },
    });

    const tokens: AuthTokens = {
      accessToken,
      refreshToken,
      expiresIn: accessTtl,
    };

    return {
      tokens,
      user: {
        id: user.id,
        role: user.role,
        email: user.email,
        phone: user.phone,
        displayName: user.displayName,
        // The client should send this person straight to "choose a new password".
        mustChangePassword: user.mustChangePassword === true,
      },
    };
  }
}


function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: "UNAUTHORIZED",
    message: "Invalid email or password",
  });
}

/** A used refresh token presented again within this window is treated as
 * two honest requests racing, not as a stolen copy. */
const REFRESH_REUSE_GRACE_MS = 30_000;

/** A real bcrypt hash (cost 12) of a random throwaway value, made once at
 * startup — compared against when there is no account hash to check, so a
 * failed sign-in costs the same time whether or not the account exists. */
const TIMING_DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 12);

function parseRefreshDays(ttl: string): number {
  if (ttl.endsWith("d")) {
    return Number.parseInt(ttl.slice(0, -1), 10) || 7;
  }
  return 7;
}
