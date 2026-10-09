import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM helpers for payout account numbers. Format: iv.tag.ciphertext,
 * each base64url, dot-joined. Shared by PayoutsService (encrypt on save,
 * decrypt on reveal) and the withdrawal fulfilment service (decrypt for the
 * payment sheet). */

export function derivePayoutKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptPayoutAccount(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

/** Returns null when the stored value isn't in the expected format. Throws if
 * the format is right but authentication fails (wrong key / tampered data). */
export function decryptPayoutAccount(key: Buffer, value: string): string | null {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) return null;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
