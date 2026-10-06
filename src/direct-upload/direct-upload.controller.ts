import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import type { AuthJwtPayload } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { DIRECT_UPLOAD_PURPOSES, type DirectUploadPurpose } from "./direct-upload.purposes";
import { DirectUploadService } from "./direct-upload.service";

class PresignDirectUploadDto {
  @IsIn(DIRECT_UPLOAD_PURPOSES)
  purpose!: DirectUploadPurpose;

  @IsString()
  @MaxLength(100)
  contentType!: string;

  /** Exact byte size — signed into the upload URL. */
  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024 * 1024)
  size!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deliverableId?: string;
}

class CompleteDirectUploadDto {
  @IsString()
  @MaxLength(4096)
  uploadId!: string;
}

@ApiTags("uploads")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.brand, UserRole.staff, UserRole.admin)
@Controller("uploads/direct")
export class DirectUploadController {
  constructor(private readonly uploads: DirectUploadService) {}

  /** Step 1: get a signed URL; the browser PUTs the file straight to R2. */
  @Post("presign")
  @HttpCode(HttpStatus.OK)
  presign(@CurrentUser() user: AuthJwtPayload, @Body() dto: PresignDirectUploadDto) {
    return this.uploads.presign(user.sub, user.role, dto);
  }

  /** Step 2: after the PUT, verify the file and get its permanent URL. */
  @Post("complete")
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthJwtPayload, @Body() dto: CompleteDirectUploadDto) {
    return this.uploads.complete(user.sub, user.role, dto.uploadId);
  }
}
