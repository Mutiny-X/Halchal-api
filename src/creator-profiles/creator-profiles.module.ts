import { Module } from "@nestjs/common";

import { CreatorProfilesController } from "./creator-profiles.controller";
import { CreatorProfilesService } from "./creator-profiles.service";
import { InstagramOAuthCallbackController } from "./instagram-oauth-callback.controller";
import { InstagramAccountInsightsService } from "./instagram-account-insights.service";
import { InstagramOAuthService } from "./instagram-oauth.service";
import { YoutubeOAuthCallbackController } from "./youtube-oauth-callback.controller";
import { YoutubeOAuthService } from "./youtube-oauth.service";
import { ApifyService } from "../common/apify.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [
    CreatorProfilesController,
    InstagramOAuthCallbackController,
    YoutubeOAuthCallbackController,
  ],
  providers: [
    CreatorProfilesService,
    InstagramOAuthService,
    InstagramAccountInsightsService,
    YoutubeOAuthService,
    ApifyService,
  ],
  exports: [CreatorProfilesService, InstagramOAuthService, InstagramAccountInsightsService, YoutubeOAuthService],
})
export class CreatorProfilesModule {}
