import { Body, Controller, Get, Logger, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { ActivityLogService } from "../activity/activity-log.service";
import { maskEmail } from "../common/mask";
import { CampaignInviteService } from "./campaign-invite.service";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { AdminLoginDto } from "./dto/admin-auth.dto";
import { CampaignInviteAcceptDto } from "./dto/campaign-invite.dto";
import {
  BrandForgotPasswordDto,
  BrandLoginDto,
  BrandRegisterDto,
  BrandResetPasswordDto,
  RefreshTokenDto,
} from "./dto/brand-auth.dto";
import { CreatorOtpRequestDto, CreatorOtpVerifyDto, SendOtpDto, VerifyOtpDto } from "./dto/creator-auth.dto";
import { normalizePhone } from "./otp.service";
import { AuthResponseDto } from "./dto/auth-response.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly campaignInvites: CampaignInviteService,
    private readonly otp: OtpService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /** Sign-in history: every successful password sign-in is recorded with
   * where it came from; every failed one is written to the server log
   * (there is no account to attach it to) with the email masked. */
  private async recordedSignIn<T extends { user: { id: string; role: string } }>(
    req: Request,
    email: string,
    portal: "team" | "admin",
    signIn: () => Promise<T>,
  ): Promise<T> {
    const from = { ip: req.ip ?? null, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200) };
    try {
      const result = await signIn();
      await this.activityLog.log(result.user.id, "auth.signed_in", {
        targetType: "User",
        targetId: result.user.id,
        metadata: { portal, role: result.user.role, ...from },
      });
      return result;
    } catch (error) {
      this.logger.warn(`Sign-in failed (${portal}) for ${maskEmail(email)} from ${from.ip ?? "unknown"}`);
      throw error;
    }
  }

  @Post("brand/register")
  @ApiOkResponse({ type: AuthResponseDto })
  registerBrand(@Body() dto: BrandRegisterDto) {
    return this.auth.registerBrand(dto);
  }

  // Team sign-in. Tight limit per client to slow password guessing.
  @Post("brand/login")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  loginBrand(@Req() req: Request, @Body() dto: BrandLoginDto) {
    return this.recordedSignIn(req, dto.email, "team", () => this.auth.loginBrand(dto));
  }

  @Post("admin/login")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  loginAdmin(@Req() req: Request, @Body() dto: AdminLoginDto) {
    return this.recordedSignIn(req, dto.email, "admin", () => this.auth.loginAdmin(dto));
  }

  @Post("brand/forgot-password")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Body() dto: BrandForgotPasswordDto) {
    return this.auth.forgotBrandPassword(dto.email);
  }

  @Post("brand/reset-password")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: BrandResetPasswordDto) {
    return this.auth.resetBrandPassword(dto.token, dto.password);
  }

  @Get("campaign-invite/preview")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  previewCampaignInvite(@Query("token") token: string) {
    return this.campaignInvites.preview(token ?? "");
  }

  @Post("campaign-invite/accept")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptCampaignInvite(@Body() dto: CampaignInviteAcceptDto) {
    return this.campaignInvites.accept(dto);
  }

  @Post("creator/otp/request")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestCreatorOtp(@Body() dto: CreatorOtpRequestDto) {
    return this.otp.requestOtp(dto.phone);
  }

  @Post("creator/otp/verify")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  verifyCreatorOtp(@Body() dto: CreatorOtpVerifyDto) {
    return this.auth.verifyCreatorOtp(dto);
  }

  @Post("send-otp")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.otp.requestOtp(dto.phone);
  }

  @Post("verify-otp")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyCreatorOtp({
      ...dto,
      phone: normalizePhone(dto.phone),
    });
  }

  // Kept at the general limit on purpose. A refresh token is 48 random
  // bytes, so guessing isn't the risk — and many creators on one mobile
  // network share a single address, so a tight per-address limit here would
  // block real people rather than attackers.
  @Post("refresh")
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post("logout")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  logout(@Body() dto: RefreshTokenDto) {
    return this.auth.logout(dto.refreshToken);
  }
}
