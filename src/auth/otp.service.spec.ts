import { describe, expect, it, vi } from "vitest";

import { OtpService } from "./otp.service";

function makeService() {
  const prisma = {
    otpSession: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "OTP_TTL_SECONDS") return 600;
      if (key === "OTP_MAX_ATTEMPTS") return 5;
      return undefined;
    }),
  };
  const whatsapp = { sendOtp: vi.fn().mockResolvedValue(undefined) };
  const fixedOtp = { getFixedCodeForPhone: vi.fn().mockResolvedValue(null) };
  const service = new OtpService(prisma as never, config as never, whatsapp as never, fixedOtp as never);
  return { service, prisma, whatsapp, fixedOtp };
}

const PHONE = "+919876543210";

function sessionAt(msAgo: number) {
  return { createdAt: new Date(Date.now() - msAgo) };
}

describe("OtpService.requestOtp", () => {
  it("allows the first request with no prior sessions at all", async () => {
    const { service, prisma } = makeService();
    prisma.otpSession.findMany.mockResolvedValue([]);

    await expect(service.requestOtp(PHONE)).resolves.toEqual({ expiresInSeconds: 600 });
    expect(prisma.otpSession.create).toHaveBeenCalled();
  });

  it.each([0, 1, 2])(
    "allows a resend instantly when only %i prior request(s) exist in the window — no cooldown yet",
    async (priorCount) => {
      const { service, prisma } = makeService();
      // All requested "just now" — if a cooldown were being checked, this would fail it.
      prisma.otpSession.findMany.mockResolvedValue(
        Array.from({ length: priorCount }, () => sessionAt(500)),
      );

      await expect(service.requestOtp(PHONE)).resolves.toEqual({ expiresInSeconds: 600 });
      expect(prisma.otpSession.create).toHaveBeenCalled();
    },
  );

  it("rejects the 4th request within the window if the last one was under a minute ago", async () => {
    const { service, prisma } = makeService();
    prisma.otpSession.findMany.mockResolvedValue([
      sessionAt(5_000), // most recent — 5s ago, well under the 60s cooldown
      sessionAt(120_000),
      sessionAt(180_000),
    ]);

    await expect(service.requestOtp(PHONE)).rejects.toMatchObject({
      response: { code: "RATE_LIMITED" },
    });
    expect(prisma.otpSession.create).not.toHaveBeenCalled();
  });

  it("allows the 4th request once 60s have passed since the last one", async () => {
    const { service, prisma } = makeService();
    prisma.otpSession.findMany.mockResolvedValue([
      sessionAt(61_000), // just over the 60s cooldown
      sessionAt(180_000),
      sessionAt(240_000),
    ]);

    await expect(service.requestOtp(PHONE)).resolves.toEqual({ expiresInSeconds: 600 });
    expect(prisma.otpSession.create).toHaveBeenCalled();
  });

  it("queries only sessions within the 30-minute attempt window — old ones don't count toward the free 3", async () => {
    const { service, prisma } = makeService();
    prisma.otpSession.findMany.mockResolvedValue([]);

    await service.requestOtp(PHONE);

    expect(prisma.otpSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: "+919876543210",
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
    const call = prisma.otpSession.findMany.mock.calls[0][0];
    const gte: Date = call.where.createdAt.gte;
    const minutesAgo = (Date.now() - gte.getTime()) / 60_000;
    expect(minutesAgo).toBeGreaterThan(29);
    expect(minutesAgo).toBeLessThan(31);
  });

  it("does not delete prior sessions on request — verifyOtp relies on the latest row, and the attempt count relies on history", async () => {
    const { service, prisma } = makeService();
    prisma.otpSession.findMany.mockResolvedValue([]);

    await service.requestOtp(PHONE);

    expect(prisma.otpSession.deleteMany).not.toHaveBeenCalled();
  });
});
