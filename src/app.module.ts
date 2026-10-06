import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { validateEnv } from "./config/env";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { AccessModule } from "./access/access.module";
import { ActivityModule } from "./activity/activity.module";
import { AdminModule } from "./admin/admin.module";
import { AppVersionModule } from "./app-version/app-version.module";
import { StaffModule } from "./staff/staff.module";
import { AuthModule } from "./auth/auth.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { HealthModule } from "./health/health.module";
import { PayoutsModule } from "./payouts/payouts.module";
import { CreatorModule } from "./creator/creator.module";
import { CreatorProfilesModule } from "./creator-profiles/creator-profiles.module";
import { CreatorsModule } from "./creators/creators.module";
import { FaqsModule } from "./faqs/faqs.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SubmissionsModule } from "./submissions/submissions.module";
import { SupportModule } from "./support/support.module";
import { TasksModule } from "./tasks/tasks.module";
import { PrismaModule } from "./prisma/prisma.module";
import { UsersModule } from "./users/users.module";
import { DirectUploadModule } from "./direct-upload/direct-upload.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== "production"
            ? { target: "pino-pretty", options: { colorize: true } }
            : undefined,
        redact: [
          "req.headers.authorization",
          "req.body.password",
          "req.body.passwordHash",
        ],
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    PrismaModule,
    AccessModule,
    ActivityModule,
    RealtimeModule,
    AuthModule,
    AdminModule,
    StaffModule,
    UsersModule,
    DirectUploadModule,
    WalletModule,
    PayoutsModule,
    CampaignsModule,
    SubmissionsModule,
    CreatorModule,
    CreatorProfilesModule,
    CreatorsModule,
    TasksModule,
    SupportModule,
    FaqsModule,
    HealthModule,
    AppVersionModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
