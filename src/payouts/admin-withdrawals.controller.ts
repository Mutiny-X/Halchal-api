import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole, WithdrawalStatus } from "@prisma/client";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { Response } from "express";
import { memoryStorage } from "multer";

import { AdminSectionRoute } from "../admin-roles/decorators/admin-section.decorator";
import { RequireMoneyAccess } from "../admin-roles/decorators/money-access.decorator";
import { AdminSectionGuard } from "../admin-roles/guards/admin-section.guard";
import { MoneyAccessGuard } from "../admin-roles/guards/money-access.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { WithdrawalFulfilmentService } from "./withdrawal-fulfilment.service";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

class MarkPaidDto {
  @IsString()
  @MinLength(3, { message: "Enter the UTR / bank reference" })
  @MaxLength(64)
  utr!: string;
}

class MarkFailedDto {
  @IsString()
  @MinLength(3, { message: "Say why the payment failed" })
  @MaxLength(300)
  reason!: string;
}

class ListWithdrawalsQuery {
  @IsOptional()
  @IsString()
  status?: string;
}

/** Admin tooling for the manual payout process. Every route here needs the
 * "payouts" section: View to see the queue (masked account numbers only),
 * Manage to download sheets (which contain full bank details) and record
 * results. The routes that expose full bank details or record a payment also
 * need the role's canSeeMoney flag — Manage on the section alone isn't enough. */
@ApiTags("admin-withdrawals")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminSectionGuard, MoneyAccessGuard)
@Roles(UserRole.admin)
@AdminSectionRoute("payouts")
@Controller("admin/withdrawals")
export class AdminWithdrawalsController {
  constructor(private readonly fulfilment: WithdrawalFulfilmentService) {}

  @Get()
  list(
    @Query() query: ListWithdrawalsQuery,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    let status: WithdrawalStatus | undefined;
    if (query.status) {
      if (!Object.values(WithdrawalStatus).includes(query.status as WithdrawalStatus)) {
        throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Unknown status" });
      }
      status = query.status as WithdrawalStatus;
    }
    return this.fulfilment.list({ status, limit: Number(limit) || undefined, cursor: cursor || undefined });
  }

  // A POST because exporting changes state: the rows move to "processing".
  // The download is a one-time hand-off; use the batch route to fetch it again.
  @Post("export")
  @HttpCode(200)
  @RequireMoneyAccess()
  async exportPending(@CurrentUser() user: AuthJwtPayload, @Res() res: Response) {
    const file = await this.fulfilment.exportPending(user.sub);
    res.set({
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "X-Batch-Id": file.batchId,
      "X-Row-Count": String(file.rowCount),
      "Access-Control-Expose-Headers": "Content-Disposition, X-Batch-Id, X-Row-Count",
      "Cache-Control": "no-store",
    });
    res.send(file.buffer);
  }

  @Get("batches/:id/download")
  @RequireMoneyAccess()
  async downloadBatch(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") batchId: string,
    @Res() res: Response,
  ) {
    const file = await this.fulfilment.downloadBatch(batchId, user.sub);
    res.set({
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      "Cache-Control": "no-store",
    });
    res.send(file.buffer);
  }

  @Post("import")
  @RequireMoneyAccess()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  importResults(@CurrentUser() user: AuthJwtPayload, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Attach the returned .xlsx file." });
    }
    return this.fulfilment.importResults(file.buffer, user.sub);
  }

  @Post(":id/paid")
  @RequireMoneyAccess()
  markPaid(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string, @Body() dto: MarkPaidDto) {
    return this.fulfilment.markPaid(id, dto.utr, user.sub);
  }

  @Post(":id/failed")
  @RequireMoneyAccess()
  markFailed(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string, @Body() dto: MarkFailedDto) {
    return this.fulfilment.markFailed(id, dto.reason, user.sub);
  }
}
