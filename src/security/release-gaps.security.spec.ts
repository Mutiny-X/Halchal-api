/* Differential-review gap tests: changed security code that had no test in the repo. */
import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_SETUP_TTL_MS, issuePasswordSetupToken } from "../auth/password-setup";
import { AuthController } from "../auth/auth.controller";

describe("Account setup links (new in this release)", () => {
  it("are 32 random bytes, stored only as a hash, cancel older links and last 72 hours", async () => {
    const prisma = { passwordResetToken: { updateMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) } };
    const token = await issuePasswordSetupToken(prisma, "u1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const data = prisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(data)).not.toContain(token);
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", usedAt: null }, data: { usedAt: expect.any(Date) } });
    expect(Math.abs(data.expiresAt.getTime() - Date.now() - ACCOUNT_SETUP_TTL_MS)).toBeLessThan(2000);
  });
  it("two links are never the same", async () => {
    const prisma = { passwordResetToken: { updateMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) } };
    const a = await issuePasswordSetupToken(prisma, "u1");
    const b = await issuePasswordSetupToken(prisma, "u1");
    expect(a).not.toBe(b);
  });
});

describe("Sign-in rate limits (new in this release)", () => {
  const limit = (handler: string) => {
    const fn = (AuthController.prototype as any)[handler];
    const keys = Reflect.getMetadataKeys(fn).filter((k: string) => String(k).includes("LIMIT"));
    return keys.length ? Reflect.getMetadata(keys[0], fn) : undefined;
  };
  for (const [h, max] of [["loginAdmin", 10], ["loginBrand", 10], ["forgotPassword", 5], ["resetPassword", 10], ["requestCreatorOtp", 5], ["sendOtp", 5], ["verifyCreatorOtp", 10], ["verifyOtp", 10]] as const) {
    it(`${h} is limited to ${max} a minute or fewer`, () => {
      const v = limit(h);
      expect(v, `no per-route limit found on ${h}`).toBeDefined();
      expect(v).toBeLessThanOrEqual(max);
    });
  }
  it("refresh and logout are rate-limited (refresh at the general limit: shared mobile addresses) [T23]", () => {
    expect(limit("refresh")).toBeLessThanOrEqual(100);
    expect(limit("logout")).toBeLessThanOrEqual(30);
  });
});
