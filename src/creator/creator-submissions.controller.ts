import {
  Controller,
  Get,
  GoneException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";

import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { SubmissionsService } from "../submissions/submissions.service";

@ApiTags("creator")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.creator)
@Controller("creator")
export class CreatorSubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get("dashboard")
  dashboard(
    @CurrentUser() user: AuthJwtPayload,
    @Query("creatorProfileId") creatorProfileId?: string,
  ) {
    return this.submissions.creatorDashboard(user.sub, creatorProfileId);
  }

  @Get("submissions")
  list(
    @CurrentUser() user: AuthJwtPayload,
    @Query("tab") tab?: "active" | "completed",
  ) {
    return this.submissions.listForCreator(user.sub, tab ?? "active");
  }

  @Get("submissions/:id")
  get(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.submissions.getForCreator(user.sub, id);
  }

  @Post("submissions")
  create() {
    throw new GoneException({
      code: "DEPRECATED",
      message:
        "Use POST /creator/campaigns/:campaignId/join and PATCH /creator/deliverables/:id/draft",
    });
  }

  @Patch("submissions/:id/live-link")
  submitLiveLink() {
    throw new GoneException({
      code: "DEPRECATED",
      message: "Use PATCH /creator/deliverables/:id/live-proof",
    });
  }

  // Retired: this let a creator report their own view count. Views come
  // from the platform through the creator's connected account instead.
  @Patch("submissions/:id/sync-performance")
  syncPerformance() {
    throw new GoneException({
      code: "DEPRECATED",
      message: "View counts are synced automatically from your connected account.",
    });
  }
}
