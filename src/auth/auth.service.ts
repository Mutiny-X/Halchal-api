import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Prisma, User, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

import { parseDurationMs } from "../common/parse-duration";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../notifications/email.service";
import { InAppNotificationService } from "../notifications/in-app-notification.service";
import type { AuthJwtPayload, AuthTokens } from "./auth.types";
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
    private readonly notifications: InAppNotificationService,
  ) {}

  async registerBrand(dto: BrandRegisterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw brandEmailConflict(existing);
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    // One nested write = one transaction: the user, brand profile and wallet
    // are created together or not at all. Separately, a failure after the
    // user row left a brand login with no BrandProfile, which campaign
    // scoping then had no brand to filter on.
    let user: User & { brandProfile: { id: string } | null };
    try {
      user = await this.prisma.user.create({
        data: {
          role: UserRole.brand,
          email,
          passwordHash,
          displayName: dto.displayName?.trim() || dto.companyName,
          termsAcceptedAt: new Date(),
          brandProfile: { create: { companyName: dto.companyName.trim() } },
          wallet: { create: {} },
        },
        include: { brandProfile: { select: { id: true } } },
      });
    } catch (error) {
      // Two sign-ups racing on the same email: the unique index catches the
      // second one — report it the same way as the pre-check above.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException({
          code: "CONFLICT",
          message: "This email already has an account. Sign in instead.",
        });
      }
      throw error;
    }
    const brandProfile = user.brandProfile!;

    await this.notifications.notifyAllAdmins({
      type: "brand.registered",
      title: "New brand registered",
      body: dto.companyName.trim(),
      link: `/admin/brands/${brandProfile.id}`,
    });

    return this.issueTokens(user);
  }

  async loginAdmin(dto: AdminLoginDto) {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash || user.role !== UserRole.admin) {
      throw invalidAdminCredentials();
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw invalidAdminCredentials();
    }

    return this.issueTokens(user);
  }

  async loginBrand(dto: BrandLoginDto) {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user?.passwordHash) {
      throw invalidBrandCredentials();
    }

    if (user.role === UserRole.creator) {
      throw new UnauthorizedException({
        code: "WRONG_PORTAL",
        message:
          "This email is registered as a creator. Use the creator app to sign in.",
      });
    }

    if (user.role === UserRole.admin) {
      throw new UnauthorizedException({
        code: "WRONG_PORTAL",
        message: "Use the admin portal to sign in.",
      });
    }

    if (user.role !== UserRole.brand && user.role !== UserRole.staff) {
      throw invalidBrandCredentials();
    }

    if (user.role === UserRole.staff && !user.isActive) {
      throw invalidBrandCredentials();
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw invalidBrandCredentials();
    }

    return this.issueTokens(user);
  }

  async forgotBrandPassword(email: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user || user.role !== UserRole.brand) {
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
      stored.user.role !== UserRole.brand
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
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
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
  }) {
    const payload: AuthJwtPayload = {
      sub: user.id,
      role: user.role,
      email: user.email,
      phone: user.phone,
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
      },
    };
  }
}

function brandEmailConflict(existing: User): ConflictException {
  if (existing.role === UserRole.creator) {
    return new ConflictException({
      code: "WRONG_PORTAL",
      message:
        "This email is registered as a creator account. Use the creator app or a different email.",
    });
  }

  if (existing.role === UserRole.brand) {
    return new ConflictException({
      code: "CONFLICT",
      message: "This email already has a brand account. Sign in instead.",
    });
  }

  if (existing.role === UserRole.admin) {
    return new ConflictException({
      code: "CONFLICT",
      message: "Email already registered",
    });
  }

  return new ConflictException({
    code: "CONFLICT",
    message: "Email already registered",
  });
}

function invalidBrandCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: "UNAUTHORIZED",
    message: "Invalid email or password",
  });
}

function invalidAdminCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: "UNAUTHORIZED",
    message: "Invalid email or password",
  });
}

function parseRefreshDays(ttl: string): number {
  if (ttl.endsWith("d")) {
    return Number.parseInt(ttl.slice(0, -1), 10) || 7;
  }
  return 7;
}
