import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";

import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { CreatorProfilesService } from "./creator-profiles.service";
import { CreateCreatorProfileDto } from "./dto/creator-profile.dto";
import { InstagramOAuthService } from "./instagram-oauth.service";
import { YoutubeOAuthService } from "./youtube-oauth.service";

@ApiTags("creator")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.creator)
@Controller("creator/profiles")
export class CreatorProfilesController {
  constructor(
    private readonly profiles: CreatorProfilesService,
    private readonly instagramOAuth: InstagramOAuthService,
    private readonly youtubeOAuth: YoutubeOAuthService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthJwtPayload) {
    return this.profiles.list(user.sub);
  }

  @Post()
  create(
    @CurrentUser() user: AuthJwtPayload,
    @Body() dto: CreateCreatorProfileDto,
  ) {
    return this.profiles.create(user.sub, dto);
  }

  @Patch(":id/default")
  setDefault(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.profiles.setDefault(user.sub, id);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.profiles.delete(user.sub, id);
  }

  @Post(":id/social/instagram/oauth/start")
  startInstagramOAuth(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.instagramOAuth.start(user.sub, id);
  }

  @Post(":id/social/instagram/oauth/:transactionId/complete")
  completeInstagramOAuth(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Param("transactionId") transactionId: string,
  ) {
    return this.instagramOAuth.complete(user.sub, id, transactionId);
  }

  @Get(":id/social/youtube/auth-url")
  getYoutubeAuthUrl(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.youtubeOAuth.authUrl(user.sub, id);
  }

  @Post(":id/social/youtube/connect")
  connectYoutube(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body("code") code: string,
    @Body("state") state: string,
  ) {
    return this.youtubeOAuth.connect(user.sub, id, code, state);
  }

  @Post(":id/social/:platform")
  connectSocial(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Param("platform") platform: string,
    @Body("handle") handle: string,
  ) {
    const allowed = ["instagram", "youtube", "twitter"] as const;
    if (!allowed.includes(platform as never)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Invalid platform" });
    }
    if (!handle?.trim()) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "handle is required" });
    }
    return this.profiles.connectSocial(user.sub, id, platform as "instagram" | "youtube" | "twitter", handle.trim());
  }

  @Delete(":id/social/:platform")
  disconnectSocial(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Param("platform") platform: string,
  ) {
    const allowed = ["instagram", "youtube", "twitter"] as const;
    if (!allowed.includes(platform as never)) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Invalid platform" });
    }
    return this.profiles.disconnectSocial(user.sub, id, platform);
  }
}
