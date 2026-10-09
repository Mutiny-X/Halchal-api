import { describe, expect, it } from "vitest";

import {
  decryptPayoutAccountWithKeys,
  derivePayoutKey,
  encryptPayoutAccount,
  needsPayoutReencrypt,
  resolvePayoutKeys,
} from "./payout-account-crypto";

const JWT = "jwt-secret-that-signs-logins-0123456789";
const DEDICATED = "dedicated-payout-key-0123456789-abcdefgh";

describe("resolvePayoutKeys", () => {
  it("with a dedicated key: writes with it and keeps the JWT-derived key only as a fallback", () => {
    const keys = resolvePayoutKeys(DEDICATED, JWT);
    expect(keys.primary.equals(derivePayoutKey(DEDICATED))).toBe(true);
    expect(keys.legacy?.equals(derivePayoutKey(JWT))).toBe(true);
  });

  it("without one (dev only): falls back to the JWT secret and has no separate legacy key", () => {
    for (const unset of [undefined, "", "   "]) {
      const keys = resolvePayoutKeys(unset, JWT);
      expect(keys.primary.equals(derivePayoutKey(JWT))).toBe(true);
      expect(keys.legacy).toBeNull();
    }
  });

  it("has no legacy key when the dedicated key equals the JWT secret", () => {
    expect(resolvePayoutKeys(JWT, JWT).legacy).toBeNull();
  });
});

describe("decryptPayoutAccountWithKeys / needsPayoutReencrypt", () => {
  const keys = resolvePayoutKeys(DEDICATED, JWT);
  const modern = encryptPayoutAccount(keys.primary, "123456789012");
  const old = encryptPayoutAccount(derivePayoutKey(JWT), "123456789012");

  it("reads rows written with the new key", () => {
    expect(decryptPayoutAccountWithKeys(keys, modern)).toBe("123456789012");
    expect(needsPayoutReencrypt(keys, modern)).toBe(false);
  });

  it("still reads rows written before the dedicated key existed, and flags them for re-encryption", () => {
    expect(decryptPayoutAccountWithKeys(keys, old)).toBe("123456789012");
    expect(needsPayoutReencrypt(keys, old)).toBe(true);
  });

  it("does not flag anything when there is no legacy key", () => {
    expect(needsPayoutReencrypt(resolvePayoutKeys(undefined, JWT), old)).toBe(false);
  });

  it("refuses data neither key opens, instead of returning garbage", () => {
    const stranger = encryptPayoutAccount(derivePayoutKey("some-other-key-entirely-0123456789ab"), "999");
    expect(() => decryptPayoutAccountWithKeys(keys, stranger)).toThrow();
    expect(needsPayoutReencrypt(keys, stranger)).toBe(false);
  });

  it("returns null for a value that is not in the encrypted format", () => {
    expect(decryptPayoutAccountWithKeys(keys, "plain-text-number")).toBeNull();
  });
});
