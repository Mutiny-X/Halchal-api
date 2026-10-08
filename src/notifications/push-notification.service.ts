import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { cert, deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type MulticastMessage } from "firebase-admin/messaging";

import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

type PushPayload = {
  title: string;
  body?: string;
  data?: Record<string, string>;
};

/** FCM error codes that mean the token is permanently dead and should be
 * dropped rather than retried — anything else (rate limits, transient
 * server errors) is left alone so a future send can retry it. */
const DEAD_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

@Injectable()
export class PushNotificationService implements OnModuleDestroy {
  private readonly logger = new Logger(PushNotificationService.name);
  private app: App | null | undefined; // undefined = not attempted yet, null = attempted and failed/unconfigured

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return this.getApp() !== null;
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });
    if (tokens.length === 0) return;
    await this.sendToTokens(tokens, payload);
  }

  /** Like sendToUser, but reports whether delivery actually happened —
   * used by bulk sends that need accurate sent/failed counts rather than
   * the fire-and-forget behavior sendToUser's callers rely on elsewhere. */
  async sendToUserWithResult(
    userId: string,
    payload: PushPayload,
  ): Promise<{ delivered: boolean; reason?: string }> {
    if (!this.isConfigured()) {
      return { delivered: false, reason: "Push not configured" };
    }
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });
    if (tokens.length === 0) {
      return { delivered: false, reason: "No registered device" };
    }
    const { successCount } = await this.sendToTokens(tokens, payload);
    if (successCount === 0) {
      return { delivered: false, reason: "Delivery failed for all devices" };
    }
    return { delivered: true };
  }

  private async sendToTokens(
    tokens: { token: string; platform: string }[],
    payload: PushPayload,
  ): Promise<{ successCount: number }> {
    const app = this.getApp();
    if (!app) {
      this.logger.log(
        `[push:stub] Would send "${payload.title}" to ${tokens.length} device(s): ${tokens
          .map((t) => `${t.platform}:${t.token.slice(0, 8)}…`)
          .join(", ")}`,
      );
      return { successCount: 0 };
    }

    const message: MulticastMessage = {
      tokens: tokens.map((t) => t.token),
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
    };

    const response = await getMessaging(app).sendEachForMulticast(message);

    const deadTokens: string[] = [];
    response.responses.forEach((result, i) => {
      if (result.success) return;
      const code = result.error?.code;
      this.logger.warn(`[push] delivery failed for ${tokens[i].platform} token: ${code} — ${result.error?.message}`);
      if (code && DEAD_TOKEN_ERROR_CODES.has(code)) {
        deadTokens.push(tokens[i].token);
      }
    });
    if (deadTokens.length > 0) {
      await this.prisma.deviceToken.deleteMany({ where: { token: { in: deadTokens } } });
    }

    return { successCount: response.successCount };
  }

  async registerToken(userId: string, token: string, platform: string): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  /** Removes a device token — only if it is registered to this user, so
   * knowing someone else's token can't be used to silence their phone. */
  async unregisterToken(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  /** Lazily initializes the Firebase Admin app from
   * FIREBASE_SERVICE_ACCOUNT_BASE64. Returns null (and stays null — no
   * retry per request) if unset or invalid, so every call site can treat
   * "no app" as "push isn't configured" without its own try/catch. */
  private getApp(): App | null {
    if (this.app !== undefined) return this.app;

    const encoded = this.config.get("FIREBASE_SERVICE_ACCOUNT_BASE64");
    if (!encoded) {
      this.app = null;
      return this.app;
    }

    try {
      const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      this.app = initializeApp(
        { credential: cert(serviceAccount) },
        "push-notifications",
      );
    } catch (e) {
      this.logger.error(`Failed to initialize Firebase Admin from FIREBASE_SERVICE_ACCOUNT_BASE64: ${e}`);
      this.app = null;
    }
    return this.app;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) {
      await deleteApp(this.app);
    }
  }
}
