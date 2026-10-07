import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";
import { ParticipationModule } from "../participation/participation.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { StorageModule } from "../storage/storage.module";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";

@Module({
  imports: [StorageModule, RealtimeModule, ParticipationModule, NotificationsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
