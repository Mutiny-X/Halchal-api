import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { AuthJwtPayload } from "../../auth/auth.types";
import { AdminRolesService } from "../admin-roles.service";
import { MONEY_ACCESS_KEY } from "../decorators/money-access.decorator";

/** Enforces the canSeeMoney flag on routes marked @RequireMoneyAccess.
 * Routes without the marker are untouched. Super Admins always pass, and so
 * does any role with canSeeMoney. Refuses (never waves through) when no user
 * is attached, so it fails closed if it is ever used without JwtAuthGuard. */
@Injectable()
export class MoneyAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly adminRoles: AdminRolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(MONEY_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthJwtPayload }>();
    if (!user) {
      throw new UnauthorizedException({ code: "UNAUTHORIZED", message: "Sign in required" });
    }

    const permissions = await this.adminRoles.getEffectivePermissions(user.sub);
    if (permissions.isSuperAdmin || permissions.canSeeMoney) return true;

    throw new ForbiddenException({
      code: "FORBIDDEN",
      message: "Your role is not allowed to see bank details or handle payments",
    });
  }
}
