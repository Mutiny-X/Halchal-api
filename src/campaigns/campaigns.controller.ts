import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Get,
  UploadedFile,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { UserRole } from "@prisma/client";

import { imageOnlyFileFilter, imageOrVideoFileFilter } from "./campaign-upload.util";
import { ObjectStorageService } from "../storage/object-storage.service";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { CampaignsService } from "./campaigns.service";
import {
  CheckSourceAssetUrlDto,
  CreateCampaignDto,
  UpdateCampaignDto,
  UpdateCampaignStepDto,
} from "./dto/campaign.dto";
import { checkMediaUrlFetchable } from "../auto-review/media-fetch";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto";
import { assertVideoIsPlayable, UnsupportedVideoFormatError } from "./video-compatibility";

@ApiTags("campaigns")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.brand, UserRole.admin, UserRole.staff)
@Controller("campaigns")
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Post("cover/upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 200 * 1024 * 1024 },
      fileFilter: imageOnlyFileFilter,
    }),
  )
  async uploadCoverImage(
    @UploadedFile()
    file:
      | { buffer: Buffer; originalname: string; mimetype: string }
      | undefined,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException("File is required");
    }
    return this.storage.saveUploadedFile("cover-images", file);
  }

  @Post("reference-assets/upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      // 2GB, not the 5-10GB actually asked for — memoryStorage() buffers
      // the entire file into process memory before it ever reaches R2
      // (object-storage.service.ts sends it as one Buffer via a single
      // PutObjectCommand), and S3/R2 hard-caps a single PutObject at 5GB
      // regardless of this setting. Genuinely supporting multi-GB files
      // needs a streaming/multipart-upload rework (ideally direct-to-R2
      // via a presigned URL, bypassing this server for the actual
      // bytes) — this is a stopgap that raises headroom without that
      // rework, chosen deliberately over the larger sizes to keep the
      // in-memory-buffer risk on this shared server bounded.
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
      fileFilter: imageOrVideoFileFilter,
    }),
  )
  async uploadReferenceAsset(
    @UploadedFile()
    file:
      | { buffer: Buffer; mimetype: string; originalname: string }
      | undefined,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException("File is required");
    }
    const type = file.mimetype.startsWith("image/") ? "image" : "video";

    if (type === "video") {
      try {
        await assertVideoIsPlayable(file.buffer);
      } catch (e) {
        if (e instanceof UnsupportedVideoFormatError) {
          throw new BadRequestException(e.message);
        }
        throw e;
      }
    }

    return {
      ...(await this.storage.saveUploadedFile("reference-assets", file)),
      type,
    };
  }

  @Post("source-assets/check-url")
  @HttpCode(HttpStatus.OK)
  checkSourceAssetUrl(@Body() dto: CheckSourceAssetUrlDto) {
    return checkMediaUrlFetchable(dto.url);
  }

  @Get()
  list(@CurrentUser() user: AuthJwtPayload, @Query() query: ListCampaignsQueryDto) {
    return this.campaigns.listForUser(user.sub, user.role, query);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.campaigns.getForUser(user.sub, user.role, id);
  }

  @Post()
  create(@CurrentUser() user: AuthJwtPayload, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(user.sub, user.role, dto);
  }

  @Patch(":id/step")
  updateStep(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdateCampaignStepDto,
  ) {
    return this.campaigns.update(user.sub, user.role, id, dto);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaigns.update(user.sub, user.role, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.campaigns.remove(user.sub, user.role, id);
  }
}
