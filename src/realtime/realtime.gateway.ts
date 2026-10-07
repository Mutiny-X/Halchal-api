import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { UserRole } from "@prisma/client";
import type { Server, Socket } from "socket.io";

import type { Env } from "../config/env";
import type { AuthJwtPayload } from "../auth/auth.types";
import { CampaignAccessService } from "../access/campaign-access.service";

@WebSocketGateway({
  namespace: "/realtime",
  cors: {
    origin: process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) ?? true,
    credentials: true,
  },
})
@Injectable()
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly campaignAccess: CampaignAccessService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.headers.authorization?.replace(/^Bearer\s+/i, "") ??
          undefined);

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = await this.jwt.verifyAsync<AuthJwtPayload>(token, {
        secret: this.config.get("JWT_SECRET", { infer: true }),
      });

      // Brands don't sign in any more — no live updates for an old session.
      if (payload.role === UserRole.brand) {
        client.disconnect();
        return;
      }

      client.data.userId = payload.sub;
      client.data.role = payload.role;

      if (payload.role === UserRole.admin) {
        await client.join("admin");
      }

      if (payload.role === UserRole.creator) {
        await client.join(`creator:${payload.sub}`);
        await client.join("creators");
      }

      if (payload.role === UserRole.staff) {
        await client.join(`staff:${payload.sub}`);
      }

      this.logger.debug(`Client connected: ${client.id} (${payload.role})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * App-level liveness check — clients can't always trust their own
   * `connected` flag (observed on iOS: the socket reports connected while
   * silently no longer receiving pushes). Round-tripping this ack lets the
   * client detect and force-reconnect a stale-but-"connected" socket.
   */
  @SubscribeMessage("ping")
  handlePing(@ConnectedSocket() client: Socket): { ok: true } {
    this.logger.debug(`Heartbeat ping from ${client.id}`);
    return { ok: true };
  }

  @SubscribeMessage("campaign:join")
  async handleJoinCampaign(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { campaignId?: unknown },
  ): Promise<{ joined: boolean }> {
    const campaignId = body?.campaignId;
    const userId = client.data.userId as string | undefined;
    const role = client.data.role as UserRole | undefined;
    if (typeof campaignId !== "string" || campaignId.length === 0 || campaignId.length > 64 || !userId || !role) {
      return { joined: false };
    }

    // A room carries that campaign's submission/review/join events, so
    // subscribing needs the same access as reading the campaign itself.
    const allowed = await this.campaignAccess
      .canJoinCampaignRoom(userId, role, campaignId)
      .catch(() => false);
    if (!allowed) {
      this.logger.debug(`Refused campaign:join ${campaignId} for ${userId} (${role})`);
      return { joined: false };
    }
    await client.join(`campaign:${campaignId}`);
    return { joined: true };
  }

  @SubscribeMessage("campaign:leave")
  async handleLeaveCampaign(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { campaignId?: string },
  ): Promise<void> {
    if (body.campaignId) {
      await client.leave(`campaign:${body.campaignId}`);
    }
  }

  emitToAdmin(event: string, payload: unknown): void {
    this.server?.to("admin").emit(event, payload);
  }

  emitToBrand(brandProfileId: string, event: string, payload: unknown): void {
    this.server?.to(`brand:${brandProfileId}`).emit(event, payload);
  }

  emitToCampaign(campaignId: string, event: string, payload: unknown): void {
    this.server?.to(`campaign:${campaignId}`).emit(event, payload);
  }

  emitToCreator(creatorId: string, event: string, payload: unknown): void {
    this.server?.to(`creator:${creatorId}`).emit(event, payload);
  }

  emitToCreators(event: string, payload: unknown): void {
    this.server?.to("creators").emit(event, payload);
  }

  emitToStaff(staffUserId: string, event: string, payload: unknown): void {
    this.server?.to(`staff:${staffUserId}`).emit(event, payload);
  }
}
