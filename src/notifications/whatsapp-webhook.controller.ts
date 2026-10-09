import { Controller, Get, Logger, Post, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";

import { isValidMetaSignature } from "./whatsapp-signature";

/**
 * Meta Cloud API webhook handshake — required to activate a WhatsApp
 * Business number. GET verifies ownership via a shared token; POST is a
 * placeholder that just logs incoming events until real handling is built.
 */
@ApiExcludeController()
@Controller("webhook/whatsapp")
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    // The token must be configured and must match — an unset token never
    // equals a missing one. The challenge is echoed as plain text and only
    // when it is the number Meta sends, so this can't be used to make the
    // API serve attacker-chosen markup.
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === "subscribe" && expected && token === expected && /^[0-9]{1,32}$/.test(challenge ?? "")) {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.status(403).type("text/plain").send("Verification failed");
  }

  @Post()
  receive(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    // Only Meta can sign with the app secret, so anything unsigned (or signed
    // for different bytes) is refused before it is looked at. Refuses
    // everything while WHATSAPP_APP_SECRET is unset.
    if (!isValidMetaSignature(req.rawBody, req.header("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
      res.status(403).type("text/plain").send("Invalid signature");
      return;
    }
    // The body can hold customers' phone numbers and messages — so it is
    // acknowledged and counted, never written to the logs.
    const entries = Array.isArray((req.body as { entry?: unknown[] })?.entry)
      ? (req.body as { entry: unknown[] }).entry.length
      : 0;
    this.logger.log(`WhatsApp webhook event received (${entries} entr${entries === 1 ? "y" : "ies"})`);
    res.status(200).type("text/plain").send("OK");
  }
}
