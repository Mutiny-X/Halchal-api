import { describe, expect, it, vi } from "vitest";

import { FixedOtpService } from "./fixed-otp.service";

function makeService(
  prisma: { user: { findUnique: ReturnType<typeof vi.fn> } },
  env: { NODE_ENV?: string; OTP_DEV_BYPASS_CODE?: string; REVIEWER_OTP_ENABLED?: boolean } = {},
) {
  const config = {
    get: vi.fn((key: string) => {
      if (key === "NODE_ENV") return env.NODE_ENV ?? "development";
      if (key === "OTP_DEV_BYPASS_CODE") return env.OTP_DEV_BYPASS_CODE;
      if (key === "REVIEWER_OTP_ENABLED") return env.REVIEWER_OTP_ENABLED;
      return undefined;
    }),
  };
  return new FixedOtpService(prisma as never, config as never);
}

describe("FixedOtpService", () => {
  it.each(["+919876543211", "+919876543210"])(
    "returns the reviewer bypass code for %s in production only while REVIEWER_OTP_ENABLED is on",
    async (phone) => {
      const prisma = { user: { findUnique: vi.fn() } };

      const enabled = makeService(prisma, { NODE_ENV: "production", REVIEWER_OTP_ENABLED: true });
      await expect(enabled.getFixedCodeForPhone(phone)).resolves.toBe("000000");

      // Off by default: a static, publicly known code must not open a
      // production account outside a store review.
      const off = makeService(prisma, { NODE_ENV: "production" });
      await expect(off.getFixedCodeForPhone(phone)).resolves.toBeNull();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it("ignores a per-account fixed code in production unless REVIEWER_OTP_ENABLED is on", async () => {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ fixedOtpCode: "424242" }) } };
    await expect(makeService(prisma, { NODE_ENV: "production" }).getFixedCodeForPhone("+916281068402")).resolves.toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    await expect(
      makeService(prisma, { NODE_ENV: "production", REVIEWER_OTP_ENABLED: true }).getFixedCodeForPhone("+916281068402"),
    ).resolves.toBe("424242");
  });

  it("returns dev bypass code for any phone in development", async () => {
    const prisma = {
      user: { findUnique: vi.fn() },
    };
    const service = makeService(prisma, { OTP_DEV_BYPASS_CODE: "000000" });
    await expect(service.getFixedCodeForPhone("+919999999999")).resolves.toBe(
      "000000",
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns fixed code when user has fixedOtpCode in DB", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ fixedOtpCode: "000000" }),
      },
    };
    const service = makeService(prisma, {});
    await expect(service.getFixedCodeForPhone("+916281068402")).resolves.toBe(
      "000000",
    );
  });

  it("returns null when user has no fixed OTP and no dev bypass", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ fixedOtpCode: null }),
      },
    };
    const service = makeService(prisma, { NODE_ENV: "production" });
    await expect(service.getFixedCodeForPhone("+919999999999")).resolves.toBeNull();
  });
});
