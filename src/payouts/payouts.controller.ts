import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";

import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import {
  CreatePayoutMethodDto,
  CreateWithdrawalDto,
  PayoutMethodDto,
  RevealPayoutMethodDto,
  UpdatePayoutMethodDto,
  WithdrawalDto,
} from "./dto/payout.dto";
import { PayoutsService } from "./payouts.service";

@ApiTags("payouts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.creator)
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get("payout-methods")
  listMethods(@CurrentUser() user: AuthJwtPayload) {
    return this.payouts.listPayoutMethods(user.sub);
  }

  @Get("payout-methods/:id/reveal")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOkResponse({ type: RevealPayoutMethodDto })
  revealMethod(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.payouts.revealAccountNumber(user.sub, id);
  }

  // Adding bank details starts the withdrawal hold and sends a notification,
  // so it is limited like the other sensitive account actions.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("payout-methods")
  @ApiOkResponse({ type: PayoutMethodDto })
  createMethod(
    @CurrentUser() user: AuthJwtPayload,
    @Body() dto: CreatePayoutMethodDto,
  ) {
    return this.payouts.createPayoutMethod(user.sub, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch("payout-methods/:id")
  @ApiOkResponse({ type: PayoutMethodDto })
  updateMethod(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdatePayoutMethodDto,
  ) {
    return this.payouts.updatePayoutMethod(user.sub, id, dto);
  }

  @Patch("payout-methods/:id/default")
  setDefault(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.payouts.setDefaultPayoutMethod(user.sub, id);
  }

  @Delete("payout-methods/:id")
  deleteMethod(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
  ) {
    return this.payouts.deletePayoutMethod(user.sub, id);
  }

  // A creator can make one withdrawal a day, so a handful of tries a minute
  // is plenty — this just stops scripted hammering of the money endpoint.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("withdrawals")
  @ApiOkResponse({ type: WithdrawalDto })
  withdraw(
    @CurrentUser() user: AuthJwtPayload,
    @Body() dto: CreateWithdrawalDto,
  ) {
    return this.payouts.createWithdrawal(user.sub, dto);
  }

  @Get("withdrawals")
  listWithdrawals(
    @CurrentUser() user: AuthJwtPayload,
    @Query("limit") limit?: string,
  ) {
    return this.payouts.listWithdrawals(
      user.sub,
      Math.min(Number(limit) || 20, 50),
    );
  }
}
