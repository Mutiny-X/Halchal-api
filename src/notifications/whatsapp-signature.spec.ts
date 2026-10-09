import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { isValidMetaSignature } from "./whatsapp-signature";

const SECRET = "app-secret-0123456789";
const BODY = Buffer.from(JSON.stringify({ entry: [{ id: "1" }] }));
const sign = (body: Buffer, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("isValidMetaSignature", () => {
  it("accepts the right signature over the exact bytes", () => {
    expect(isValidMetaSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a body that was changed after signing", () => {
    expect(isValidMetaSignature(Buffer.from('{"entry":[]}'), sign(BODY), SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(isValidMetaSignature(BODY, sign(BODY, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects missing or malformed pieces — and never passes just because nothing is configured", () => {
    expect(isValidMetaSignature(BODY, undefined, SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, sign(BODY), undefined)).toBe(false);
    expect(isValidMetaSignature(BODY, sign(BODY), "")).toBe(false);
    expect(isValidMetaSignature(undefined, sign(BODY), SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, "sha256=zz", SECRET)).toBe(false);
    expect(isValidMetaSignature(BODY, sign(BODY).replace("sha256=", "sha1="), SECRET)).toBe(false);
  });
});
