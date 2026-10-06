import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { DirectUploadPurpose } from "./direct-upload.purposes";

/**
 * What the API promised at presign time, handed to the browser as an opaque
 * signed string and checked again at completion. Signed, so the browser
 * can't swap the key, purpose, size, type or owner; no database row needed.
 */
export type UploadTicket = {
  v: 1;
  /** Where the browser PUTs the bytes (pending area, never shown to anyone). */
  pendingKey: string;
  /** Where the file lives once verified. */
  finalKey: string;
  purpose: DirectUploadPurpose;
  userId: string;
  contentType: string;
  size: number;
  name: string;
  deliverableId?: string;
  /** Unix ms after which the ticket is void. */
  expiresAt: number;
};

function keyFrom(secret: string): Buffer {
  // A key used only for upload tickets — never the JWT signing key itself.
  return createHash("sha256").update(`direct-upload-ticket:v1:${secret}`).digest();
}

export function signTicket(ticket: UploadTicket, secret: string): string {
  const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  const mac = createHmac("sha256", keyFrom(secret)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Returns the ticket, or null if it was tampered with, malformed or expired. */
export function verifyTicket(token: string, secret: string, now = Date.now()): UploadTicket | null {
  const [body, mac, ...rest] = token.split(".");
  if (!body || !mac || rest.length) return null;
  const expected = createHmac("sha256", keyFrom(secret)).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadTicket;
    if (ticket.v !== 1 || typeof ticket.expiresAt !== "number" || ticket.expiresAt < now) return null;
    return ticket;
  } catch {
    return null;
  }
}
