import { Module } from "@nestjs/common";

import { AdminRolesModule } from "../admin-roles/admin-roles.module";
import { AuthModule } from "../auth/auth.module";
import { CampaignsModule } from "../campaigns/campaigns.module";
import { CreatorProfilesModule } from "../creator-profiles/creator-profiles.module";
import { FaqsModule } from "../faqs/faqs.module";
import { MarketplaceModule } from "../marketplace/marketplace.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AdminWithdrawalsController } from "../payouts/admin-withdrawals.controller";
import { PayoutsModule } from "../payouts/payouts.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { StorageModule } from "../storage/storage.module";
import { SupportModule } from "../support/support.module";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { CampaignReportService } from "./campaign-report.service";

@Module({
  imports: [
    AdminRolesModule,
    AuthModule,
    CampaignsModule,
    CreatorProfilesModule,
    FaqsModule,
    MarketplaceModule,
    NotificationsModule,
    PayoutsModule,
    RealtimeModule,
    StorageModule,
    SupportModule,
    WalletModule,
  ],
  controllers: [AdminController, AdminWithdrawalsController],
  providers: [AdminService, CampaignReportService],
})
export class AdminModule {}
