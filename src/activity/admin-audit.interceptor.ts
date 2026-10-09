import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";

import type { AuthJwtPayload } from "../auth/auth.types";
import { ActivityLogService } from "./activity-log.service";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ID_PARAMS = ["id", "staffId", "userId", "campaignId", "brandId", "inviteId", "creatorId"];

/**
 * Records every change an admin makes: after any non-read request on the
 * controller it is attached to succeeds, one activity-log row says who did
 * what to which record. Covers routes added later without anyone having to
 * remember to log them. Only the route and its ids are stored — never the
 * request body, which can hold personal data or passwords.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly activityLog: ActivityLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      user?: AuthJwtPayload;
      params?: Record<string, string>;
      route?: { path?: string };
      ip?: string;
    }>();
    if (READ_METHODS.has(req.method?.toUpperCase()) || !req.user?.sub) {
      return next.handle();
    }
    const action = `admin.${context.getHandler().name}`;
    const params = req.params ?? {};
    const targetKey = ID_PARAMS.find((key) => params[key]);
    return next.handle().pipe(
      tap(() => {
        void this.activityLog.log(req.user!.sub, action, {
          targetType: "admin_action",
          targetId: targetKey ? params[targetKey] : "-",
          metadata: { method: req.method, route: req.route?.path ?? null, params, ip: req.ip ?? null },
        });
      }),
    );
  }
}
