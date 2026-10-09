import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Req,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { diskStorage } from "multer";

import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { SubmitDraftDto } from "../participation/dto/submit-draft.dto";
import { SubmitLiveProofDto } from "../participation/dto/submit-live-proof.dto";
import { ParticipationService } from "../participation/participation.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { DeliverableOwnerGuard } from "./deliverable-owner.guard";

@ApiTags("creator")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.creator)
@Controller("creator")
export class CreatorParticipationController {
  constructor(
    private readonly participation: ParticipationService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get("leaderboard")
  getOverallLeaderboard(@CurrentUser() user: AuthJwtPayload) {
    return this.participation.getOverallLeaderboard(user.sub);
  }

  @Get("participations")
  list(
    @CurrentUser() user: AuthJwtPayload,
    @Query("tab") tab?: "active" | "completed",
    @Query("creatorProfileId") creatorProfileId?: string,
  ) {
    return this.participation.listForCreator(user.sub, tab ?? "active", creatorProfileId);
  }

  @Get("participations/:id")
  get(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.participation.getForCreator(user.sub, id);
  }

  @Patch("deliverables/:id/draft")
  submitDraft(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: SubmitDraftDto,
  ) {
    return this.participation.submitDraft(user.sub, id, dto);
  }

  @Patch("deliverables/:id/live-proof")
  submitLiveProof(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: SubmitLiveProofDto,
  ) {
    return this.participation.submitLiveProof(user.sub, id, dto);
  }

  @Post("deliverables/:id/upload-draft")
  // Ownership is checked before the file is received, and the file goes to
  // a temp file on disk, not into memory — a 500 MB video per request in
  // RAM would let a handful of uploads take the API down.
  @UseGuards(DeliverableOwnerGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, _file, cb) => cb(null, `halchal-draft-${Date.now()}-${randomBytes(8).toString("hex")}`),
      }),
      limits: { fileSize: 500 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadDraftFile(
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.path) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "File is required" });
    }
    const result = await this.storage.saveUploadedFileFromPath("creator-drafts", {
      path: file.path,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
    // If the URL is a relative path (local disk, no R2), make it absolute
    const url = result.url.startsWith("http")
      ? result.url
      : `${req.protocol}://${req.get("host")}${result.url}`;
    return { url };
  }

  @Post("deliverables/:id/refresh-views")
  refreshViews(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.participation.refreshDeliverableViews(user.sub, id);
  }
}
