import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import type { Env } from "../config/env";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { AuthCleanupService } from "./auth-cleanup.service";
import { CampaignInviteService } from "./campaign-invite.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { FixedOtpService } from "./fixed-otp.service";
import { JWT_AUDIENCE, JWT_ISSUER } from "./auth.types";
import { JwtStrategy } from "./jwt.strategy";
import { OtpService } from "./otp.service";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
        signOptions: { algorithm: "HS256", issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        verifyOptions: { algorithms: ["HS256"], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      }),
    }),
    NotificationsModule,
    forwardRef(() => RealtimeModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    CampaignInviteService,
    OtpService,
    FixedOtpService,
    JwtStrategy,
    AuthCleanupService,
  ],
  exports: [AuthService, CampaignInviteService, JwtModule],
})
export class AuthModule {}
