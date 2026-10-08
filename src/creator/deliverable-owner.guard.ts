import { CanActivate, ExecutionContext, Injectable, NotFoundException } from "@nestjs/common";

import type { AuthJwtPayload } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Lets a creator act on a deliverable (`:id` in the route) only if it is
 * their own. A guard rather than a check in the handler, so it runs before
 * the upload interceptor: someone else's deliverable id is refused before
 * any file is received.
 */
@Injectable()
export class DeliverableOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthJwtPayload; params: { id?: string } }>();
    const deliverableId = req.params.id;
    const deliverable = deliverableId && req.user
      ? await this.prisma.formatDeliverable.findUnique({
          where: { id: deliverableId },
          select: { participation: { select: { creatorId: true } } },
        })
      : null;
    if (!deliverable || deliverable.participation.creatorId !== req.user?.sub) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
    }
    return true;
  }
}
