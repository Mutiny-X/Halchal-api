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

/** The key bank numbers are written with, plus — until every row has been
 * re-encrypted — the old JWT_SECRET-derived key they used to be written with.
 * Before PAYOUT_ACCOUNT_ENCRYPTION_KEY was required, an unset key silently
 * fell back to JWT_SECRET, so existing rows may still be encrypted that way:
 * reads try the primary key first and fall back to `legacy`, writes always use
 * `primary`. `scripts/reencrypt-payout-accounts.ts` moves rows to `primary`. */
export type PayoutKeys = { primary: Buffer; legacy: Buffer | null };

export function resolvePayoutKeys(dedicatedKey: string | undefined, jwtSecret: string | undefined): PayoutKeys {
  if (!dedicatedKey?.trim() && !jwtSecret) throw new Error("No encryption key configured");
  const dedicated = dedicatedKey?.trim();
  if (!dedicated) return { primary: derivePayoutKey(jwtSecret as string), legacy: null }; // guarded above
  return {
    primary: derivePayoutKey(dedicated),
    legacy: !jwtSecret || dedicated === jwtSecret ? null : derivePayoutKey(jwtSecret),
  };
}

/** Decrypts with the primary key, falling back to the legacy one. Returns null
 * for a value that isn't in the encrypted format; throws if no key fits. */
export function decryptPayoutAccountWithKeys(keys: PayoutKeys, value: string): string | null {
  try {
    return decryptPayoutAccount(keys.primary, value);
  } catch (primaryError) {
    if (!keys.legacy) throw primaryError;
    try {
      return decryptPayoutAccount(keys.legacy, value);
    } catch {
      throw primaryError;
    }
  }
}

/** True when the value only opens with the legacy key — i.e. it still needs
 * re-encrypting under the dedicated one. */
export function needsPayoutReencrypt(keys: PayoutKeys, value: string): boolean {
  if (!keys.legacy) return false;
  try {
    decryptPayoutAccount(keys.primary, value);
    return false;
  } catch {
    try {
      return decryptPayoutAccount(keys.legacy, value) !== null;
    } catch {
      return false;
    }
  }
}
