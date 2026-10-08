import { Module } from "@nestjs/common";

import { CampaignsModule } from "../campaigns/campaigns.module";
import { MarketplaceModule } from "../marketplace/marketplace.module";
import { ParticipationModule } from "../participation/participation.module";
import { StorageModule } from "../storage/storage.module";
import { SubmissionsModule } from "../submissions/submissions.module";
import { CreatorCampaignsController } from "./creator-campaigns.controller";
import { CreatorMarketplaceController } from "./creator-marketplace.controller";
import { CreatorParticipationController } from "./creator-participation.controller";
import { CreatorSubmissionsController } from "./creator-submissions.controller";
import { DeliverableOwnerGuard } from "./deliverable-owner.guard";

@Module({
  imports: [
    CampaignsModule,
    SubmissionsModule,
    ParticipationModule,
    StorageModule,
    MarketplaceModule,
  ],
  providers: [DeliverableOwnerGuard],
  controllers: [
    CreatorCampaignsController,
    CreatorParticipationController,
    CreatorSubmissionsController,
    CreatorMarketplaceController,
  ],
})
export class CreatorModule {}
