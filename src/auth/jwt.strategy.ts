import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { BRAND_ACCESS_CLOSED, type AuthJwtPayload } from "./auth.types";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get("JWT_SECRET", { infer: true }),
    });
  }

  async validate(payload: AuthJwtPayload): Promise<AuthJwtPayload> {
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
    // A team member who is deactivated or removed stops at their next
    // request, not when their access token happens to expire.
    if (payload.role === "staff") {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { isActive: true, role: true },
      });
      if (!user || !user.isActive || user.role !== "staff") {
        throw new UnauthorizedException({ code: "UNAUTHORIZED", message: "This account has been deactivated" });
      }
    }
    return payload;
  }
}
