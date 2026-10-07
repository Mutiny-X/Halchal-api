import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../config/env";
import { BRAND_ACCESS_CLOSED, type AuthJwtPayload } from "./auth.types";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get("JWT_SECRET", { infer: true }),
    });
  }

  validate(payload: AuthJwtPayload): AuthJwtPayload {
    if (!payload?.sub || !payload?.role) {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "Invalid token",
      });
    }
    // Ends any brand session issued before brand sign-in was closed.
    if (payload.role === "brand") {
      throw new UnauthorizedException(BRAND_ACCESS_CLOSED);
    }
    return payload;
  }
}
