import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminSection } from "@prisma/client";

import type { AuthJwtPayload } from "../../auth/auth.types";
import { AdminRolesService } from "../admin-roles.service";
import { ADMIN_SECTION_KEY } from "../decorators/admin-section.decorator";

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Enforces per-section View/Manage access for restricted admin roles.
 * Routes with no @AdminSectionRoute stay open to any admin (unchanged
 * behavior) — this only tightens routes that have been explicitly
 * annotated. Super Admins (adminRoleId null) always pass. */
@Injectable()
export class AdminSectionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly adminRoles: AdminRolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const section = this.reflector.getAllAndOverride<AdminSection | undefined>(ADMIN_SECTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!section) return true;

    const request = context.switchToHttp().getRequest<{ user: AuthJwtPayload; method: string }>();
    const { user, method } = request;
    // JwtAuthGuard runs first and attaches the user. If this guard is ever
    // used without it, refuse rather than wave the request through.
    if (!user) {
      throw new UnauthorizedException({ code: "UNAUTHORIZED", message: "Sign in required" });
    }

    const permissions = await this.adminRoles.getEffectivePermissions(user.sub);
    if (permissions.isSuperAdmin) return true;

    const level = permissions.sections[section];
    const required = READ_METHODS.has(method.toUpperCase()) ? "view" : "manage";
    const allowed = level === required || (required === "view" && level === "manage");

    if (!allowed) {
      throw new ForbiddenException({
        code: "FORBIDDEN",
        message: `Your role does not have ${required} access to ${section}`,
      });
    }
    return true;
  }
}
