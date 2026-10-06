import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  FormatDeliverableStatus,
  SubmissionStatus,
  UserRole,
} from "@prisma/client";
import { IsString, MaxLength } from "class-validator";
import { memoryStorage } from "multer";

import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { ReviewDeliverableDto } from "../participation/dto/review-deliverable.dto";
import { ParticipationService } from "../participation/participation.service";
import { BufferedUploadGuard } from "../direct-upload/buffered-upload.guard";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ReviewSubmissionDto } from "./dto/review-submission.dto";
import { SubmissionsService } from "./submissions.service";

class RejectProofDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

@ApiTags("submissions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.brand, UserRole.admin, UserRole.staff)
@Controller("submissions")
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly participation: ParticipationService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get("stats")
  stats(@CurrentUser() user: AuthJwtPayload) {
    return this.submissions.brandStats(user.sub, user.role);
  }

  /** Must be registered before the `:id` routes below. */
  @Get("analytics")
  analyticsOverview(@CurrentUser() user: AuthJwtPayload) {
    return this.submissions.getAnalyticsOverview(user.sub, user.role);
  }

  @Get()
  list(
    @CurrentUser() user: AuthJwtPayload,
    @Query("status") status?: SubmissionStatus,
    @Query("campaignId") campaignId?: string,
  ) {
    return this.submissions.listForBrand(user.sub, user.role, {
      status,
      campaignId,
    });
  }

  /** Per-format deliverables — must be registered before `:id` routes. */
  @Get("deliverables")
  listDeliverables(
    @CurrentUser() user: AuthJwtPayload,
    @Query("status") status?: FormatDeliverableStatus,
    @Query("campaignId") campaignId?: string,
  ) {
    return this.participation.listDeliverablesForBrand(user.sub, user.role, {
      status,
      campaignId,
    });
  }

  @Get("deliverables/:id")
  getDeliverable(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.participation.getDeliverableForBrand(user.sub, user.role, id);
  }

  @Post("deliverables/:id/refresh-views")
  refreshDeliverableViews(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.participation.refreshDeliverableViewsForBrand(user.sub, user.role, id);
  }

  @Patch("deliverables/:id/review")
  reviewDeliverable(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: ReviewDeliverableDto,
  ) {
    return this.participation.reviewDeliverable(
      user.sub,
      user.role,
      id,
      dto.action,
      dto.rejectionReason,
    );
  }

  /** Lets a brand/admin/staff reviewer upload their own copy of a
   * Drive-linked draft — the auto-review pipeline can't fetch Drive links
   * itself, so it stays needs_review until someone with view access on the
   * Drive file downloads it and re-uploads it here. Re-triggers the
   * pipeline immediately if the deliverable is still awaiting review. */
  @Post("deliverables/:id/admin-draft-copy")
  @UseGuards(BufferedUploadGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 500 * 1024 * 1024 },
    }),
  )
  async uploadAdminDraftCopy(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.storage.saveUploadedFile("admin-draft-copies", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url = result.url.startsWith("http")
      ? result.url
      : `${req.protocol}://${req.get("host")}${result.url}`;
    return this.participation.setAdminDraftCopy(user.sub, user.role, id, url);
  }

  @Patch("deliverables/:id/approve-proof")
  approveProof(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.participation.approveProof(user.sub, user.role, id);
  }

  @Patch("deliverables/:id/reject-proof")
  rejectProof(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: RejectProofDto,
  ) {
    return this.participation.rejectProof(user.sub, user.role, id, dto.reason);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.submissions.getForBrand(user.sub, user.role, id);
  }

  @Patch(":id/review")
  review(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: ReviewSubmissionDto,
  ) {
    return this.submissions.review(user.sub, user.role, id, dto);
  }
}
