import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";
import { PayoutsController } from "./payouts.controller";
import { PayoutsService } from "./payouts.service";
import { WithdrawalFulfilmentService } from "./withdrawal-fulfilment.service";

@Module({
  imports: [NotificationsModule],
  controllers: [PayoutsController],
  providers: [PayoutsService, WithdrawalFulfilmentService],
  exports: [PayoutsService, WithdrawalFulfilmentService],
})
export class PayoutsModule {}
