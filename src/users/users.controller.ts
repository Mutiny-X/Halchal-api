import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsIn, IsString } from "class-validator";
import { memoryStorage } from "multer";

import { ActivityLogService } from "../activity/activity-log.service";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { PushNotificationService } from "../notifications/push-notification.service";
import { BufferedUploadGuard } from "../direct-upload/buffered-upload.guard";
import { isPrivateDocumentRef, ObjectStorageService } from "../storage/object-storage.service";
import { UsersService } from "./users.service";
import { UserMeDto } from "./dto/user-me.dto";
import { UpdateBrandProfileDto } from "./dto/update-brand-profile.dto";
import { ChangePasswordDto, UpdateProfileDto } from "./dto/update-profile.dto";

class RegisterDeviceTokenDto {
  @IsString()
  token!: string;

  @IsIn(["ios", "android"])
  platform!: "ios" | "android";
}

class UnregisterDeviceTokenDto {
  @IsString()
  token!: string;
}

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly storage: ObjectStorageService,
    private readonly push: PushNotificationService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @Get("me")
  @ApiOkResponse({ type: UserMeDto })
  getMe(@CurrentUser() user: AuthJwtPayload) {
    return this.users.getMe(user.sub, user.role);
  }

  @Patch("me")
  updateProfile(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: UpdateProfileDto,
  ) {
    return this.users.updateProfile(user.sub, body);
  }

  @Delete("me")
  async deleteMe(@CurrentUser() user: AuthJwtPayload) {
    const result = await this.users.deleteMe(user.sub);
    await this.activityLog.log(user.sub, "account.deleted", { targetType: "User", targetId: user.sub });
    return result;
  }

  @Delete("me/social-stats/:platform")
  async disconnectSocial(
    @CurrentUser() user: AuthJwtPayload,
    @Param("platform") platform: string,
  ) {
    const allowed = ["instagram", "youtube", "twitter"] as const;
    if (!allowed.includes(platform as never)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Invalid platform" });
    }
    if (platform === "instagram" || platform === "youtube") {
      throw new BadRequestException({
        code: "OFFICIAL_OAUTH_REQUIRED",
        message: `${platform} must be managed from creator profile official OAuth.`,
      });
    }
    return this.users.disconnectSocial(user.sub, platform);
  }

  @Post("me/social-stats/:platform")
  async fetchSocialStats(
    @CurrentUser() user: AuthJwtPayload,
    @Param("platform") platform: string,
    @Body("handle") handle: string,
  ) {
    const allowed = ["instagram", "youtube", "twitter"] as const;
    if (!allowed.includes(platform as never)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Invalid platform" });
    }
    if (platform === "instagram" || platform === "youtube") {
      throw new BadRequestException({
        code: "OFFICIAL_OAUTH_REQUIRED",
        message: `${platform} must be connected with official OAuth.`,
      });
    }
    if (!handle?.trim()) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "handle is required" });
    }
    return this.users.fetchAndStoreSocialStats(
      user.sub,
      platform as "instagram" | "youtube" | "twitter",
      handle.trim(),
    );
  }

  @Post("me/change-password")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: ChangePasswordDto,
  ) {
    const result = await this.users.changePassword(user.sub, body.currentPassword, body.newPassword);
    await this.activityLog.log(user.sub, "auth.password_changed", { targetType: "User", targetId: user.sub });
    return result;
  }

  @Patch("me/brand-profile")
  updateBrandProfile(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: UpdateBrandProfileDto,
  ) {
    return this.users.updateBrandProfile(user.sub, body);
  }

  @Post("me/brand-logo")
  @UseGuards(BufferedUploadGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadBrandLogo(
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.storage.saveUploadedFile("brand-logos", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url =
      result.url.startsWith("http") || isPrivateDocumentRef(result.url)
        ? result.url
        : `${req.protocol}://${req.get("host")}${result.url}`;
    return { url };
  }

  @Post("me/avatar")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadAvatar(
    @CurrentUser() user: AuthJwtPayload,
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.storage.saveUploadedFile("avatars", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url =
      result.url.startsWith("http") || isPrivateDocumentRef(result.url)
        ? result.url
        : `${req.protocol}://${req.get("host")}${result.url}`;
    await this.users.updateProfile(user.sub, { avatarUrl: url });
    return { url };
  }

  @Post("me/kyc")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async submitKyc(
    @CurrentUser() user: AuthJwtPayload,
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
    @Body("documentType") documentType?: string,
  ) {
    const result = await this.storage.saveIdentityDocument("kyc-documents", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url =
      result.url.startsWith("http") || isPrivateDocumentRef(result.url)
        ? result.url
        : `${req.protocol}://${req.get("host")}${result.url}`;
    return this.users.submitKyc(user.sub, url, documentType ?? "id_proof");
  }

  @Post("me/pan")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async submitPan(
    @CurrentUser() user: AuthJwtPayload,
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "File is required" });
    }
    const result = await this.storage.saveIdentityDocument("pan-documents", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url =
      result.url.startsWith("http") || isPrivateDocumentRef(result.url)
        ? result.url
        : `${req.protocol}://${req.get("host")}${result.url}`;
    return this.users.submitPan(user.sub, url, file.buffer, file.mimetype);
  }

  @Post("me/aadhaar")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async submitAadhaar(
    @CurrentUser() user: AuthJwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "File is required" });
    }
    // The Aadhaar image is checked straight from the upload and never
    // stored: only the verified name and the masked last four digits are
    // kept (see User.aadhaarMaskedNumber).
    return this.users.submitAadhaar(user.sub, null, file.buffer, file.mimetype);
  }

  @Post("me/device-token")
  async registerDeviceToken(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: RegisterDeviceTokenDto,
  ) {
    await this.push.registerToken(user.sub, body.token, body.platform);
    return { registered: true };
  }

  @Delete("me/device-token")
  async unregisterDeviceToken(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: UnregisterDeviceTokenDto,
  ) {
    await this.push.unregisterToken(user.sub, body.token);
    return { unregistered: true };
  }
}
