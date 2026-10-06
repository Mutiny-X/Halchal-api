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
  PresignUploadDto,
  UpdateCampaignDto,
  UpdateCampaignStepDto,
} from "./dto/campaign.dto";
import { checkMediaUrlFetchable } from "../auto-review/media-fetch";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto";
import { assertVideoIsPlayable, UnsupportedVideoFormatError } from "./video-compatibility";
import { detectFileType } from "../common/file-signature";
import { UserRateLimiter } from "../common/user-rate-limit";

/** Covers are display images — 10 MB is generous for a JPEG/PNG/WebP. */
const MAX_COVER_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Above this the website uploads straight to R2 via presign-upload. */
const MAX_BUFFERED_ASSET_UPLOAD_BYTES = 100 * 1024 * 1024;
const COVER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const checkUrlLimiter = new UserRateLimiter(10, 60_000);
const presignLimiter = new UserRateLimiter(20, 60_000);

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
      limits: { fileSize: MAX_COVER_UPLOAD_BYTES, files: 1 },
      fileFilter: imageOnlyFileFilter,
    }),
  )
  async uploadCoverImage(
    @UploadedFile()
    file:
      | { buffer: Buffer; originalname: string; mimetype: string }
      | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "File is required" });
    }
    const detected = detectFileType(file.buffer);
    if (!detected || !COVER_IMAGE_TYPES.has(detected.mimeType)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Cover must be a JPEG, PNG or WebP image",
      });
    }
    return this.storage.saveVerifiedFile("cover-images", file.buffer, detected, file.originalname);
  }

  @Post("reference-assets/upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor("file", {
      // memoryStorage() holds the whole file in this process's RAM until it
      // is forwarded to R2, so this route is for small files only — one
      // oversized upload (or a few in parallel) would otherwise take the API
      // down for every user, mobile included. Larger files go through
      // presign-upload below, straight from the browser to R2.
      storage: memoryStorage(),
      limits: { fileSize: MAX_BUFFERED_ASSET_UPLOAD_BYTES, files: 1 },
      fileFilter: imageOrVideoFileFilter,
    }),
  )
  async uploadReferenceAsset(
    @UploadedFile()
    file:
      | { buffer: Buffer; mimetype: string; originalname: string }
      | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "File is required" });
    }
    // The real type comes from the bytes, not the claimed MIME type — that
    // is what decides the stored extension and the Content-Type it's served
    // with, so a renamed HTML/SVG file can't be planted on our domain.
    const detected = detectFileType(file.buffer);
    if (!detected) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Only JPEG, PNG, WebP, GIF, MP4, MOV and WebM files can be uploaded",
      });
    }

    if (detected.kind === "video") {
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
      ...(await this.storage.saveVerifiedFile(
        "reference-assets",
        file.buffer,
        detected,
        file.originalname,
      )),
      type: detected.kind,
    };
  }

  // Direct-to-R2 alternative to reference-assets/upload above, for files
  // too large to safely buffer through this server (that route's own
  // memoryStorage() holds the whole file in process memory — fine up to
  // its 2GB limit, but multi-GB files risk crashing the backend for every
  // user, not just this upload). The client PUTs the bytes straight to R2
  // using the returned uploadUrl; this server never touches them, so size
  // is bounded only by R2's own 5GB single-PUT ceiling. Trade-off: unlike
  // uploadReferenceAsset above, this can't run assertVideoIsPlayable()
  // against the file first, since the bytes never pass through here —
  // an invalid/corrupt video won't be caught at upload time this way.
  // R2-only — no equivalent exists for the local-disk fallback used when
  // R2 isn't configured, so callers should fall back to the multipart
  // upload route above in that case.
  @Post("reference-assets/presign-upload")
  @HttpCode(HttpStatus.OK)
  async presignReferenceAssetUpload(
    @CurrentUser() user: AuthJwtPayload,
    @Body() dto: PresignUploadDto,
  ) {
    presignLimiter.consume(user.sub);
    if (!dto.contentType.startsWith("image/") && !dto.contentType.startsWith("video/")) {
      throw new BadRequestException("Only image and video files are allowed");
    }
    if (!this.storage.isR2Configured()) {
      throw new BadRequestException(
        "Direct upload isn't available — object storage isn't configured on this server",
      );
    }
    return this.storage.presignUpload("reference-assets", dto.fileName, dto.contentType);
  }

  @Post("source-assets/check-url")
  @HttpCode(HttpStatus.OK)
  checkSourceAssetUrl(
    @CurrentUser() user: AuthJwtPayload,
    @Body() dto: CheckSourceAssetUrlDto,
  ) {
    // Each call makes this server fetch a URL — keep it to what a person
    // pasting links into the wizard actually needs.
    checkUrlLimiter.consume(user.sub);
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
