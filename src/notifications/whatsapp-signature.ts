import { createHmac, timingSafeEqual } from "node:crypto";

/** Checks Meta's X-Hub-Signature-256 header ("sha256=<hex>") against an HMAC of
 * the exact bytes Meta sent, keyed with the app secret. Constant-time compare.
 * False for a missing header, a missing secret or a missing body — never
 * "true because nothing was configured". */
export function isValidMetaSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(match[1]!, "hex"), expected);
}
