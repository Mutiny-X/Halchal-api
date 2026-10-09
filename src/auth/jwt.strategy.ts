import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { BRAND_ACCESS_CLOSED, JWT_AUDIENCE, JWT_ISSUER, type AuthJwtPayload } from "./auth.types";

/** What a person who still has to choose a new password may do: look at their own
 * account, change the password, sign out. */
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = new Set([
  "GET /users/me",
  "POST /users/me/change-password",
  "POST /auth/logout",
  "POST /auth/refresh",
]);

export function isAllowedWhilePasswordChangeIsPending(req: { method?: string; originalUrl?: string; url?: string }): boolean {
  const path = (req.originalUrl ?? req.url ?? "").split("?")[0]!.replace(/\/+$/, "");
  return ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.has(`${(req.method ?? "").toUpperCase()} ${path}`);
}

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
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      passReqToCallback: true,
    });
  }

  async validate(req: { method?: string; originalUrl?: string; url?: string }, payload: AuthJwtPayload): Promise<AuthJwtPayload> {
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
    // The token only says who signed in up to 15 minutes ago. Anyone who
    // has since been deactivated, removed or deleted — team member, admin
    // or creator — stops at their next request, not when the token expires.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, role: true, mustChangePassword: true },
    });
    if (!user || !user.isActive || user.role !== payload.role) {
      throw new UnauthorizedException({ code: "UNAUTHORIZED", message: "This account has been deactivated" });
    }
    // A password an admin chose or generated is only good for choosing a new one:
    // until then every route is closed except the few needed to do exactly that.
    if (user.mustChangePassword && !isAllowedWhilePasswordChangeIsPending(req)) {
      throw new ForbiddenException({
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Choose a new password before continuing.",
      });
    }
    return payload;
  }
}
