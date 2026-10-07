import { BadRequestException, ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";

function makeAuthService() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    wallet: { create: vi.fn() },
    refreshToken: { create: vi.fn() },
  };
  const otp = { verifyOtp: vi.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: vi.fn().mockResolvedValue("access-token") };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "JWT_ACCESS_TTL") return "15m";
      if (key === "JWT_REFRESH_TTL") return "7d";
      return undefined;
    }),
  };
  const email = {};
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    otp as never,
    email as never,
  );
  return { service, prisma, otp, jwt };
}

describe("AuthService.verifyCreatorOtp", () => {
  it("throws VALIDATION_ERROR when logging in with unknown phone", async () => {
    const { service, prisma } = makeAuthService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.verifyCreatorOtp({
        phone: "+919876543210",
        code: "000000",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "No account with this phone. Sign up to create one.",
      });
      return true;
    });
  });

  it("throws VALIDATION_ERROR when signup omits email", async () => {
    const { service, prisma } = makeAuthService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.verifyCreatorOtp({
        phone: "+919876543299",
        code: "000000",
        displayName: "New Creator",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Email is required to create an account.",
      });
      return true;
    });
  });

  it("creates creator and wallet on signup", async () => {
    const { service, prisma } = makeAuthService();
    prisma.user.findUnique.mockResolvedValue(null);
    const created = {
      id: "user-1",
      role: UserRole.creator,
      email: "new@viralcut.test",
      phone: "+919876543299",
      displayName: "New Creator",
      wallet: { id: "wallet-1" },
    };
    prisma.user.create.mockResolvedValue(created);

    const result = await service.verifyCreatorOtp({
      phone: "+919876543299",
      code: "000000",
      displayName: "New Creator",
      email: "new@viralcut.test",
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: UserRole.creator,
          phone: "+919876543299",
          wallet: { create: {} },
        }),
      }),
    );
    expect(result.tokens.accessToken).toBe("access-token");
    expect(result.user.id).toBe("user-1");
  });

  it("throws WRONG_PORTAL when phone belongs to a brand user", async () => {
    const { service, prisma } = makeAuthService();
    prisma.user.findUnique.mockResolvedValue({
      id: "brand-1",
      role: UserRole.brand,
      phone: "+919876543210",
      wallet: null,
    });

    await expect(
      service.verifyCreatorOtp({
        phone: "+919876543210",
        code: "000000",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: "WRONG_PORTAL",
      });
      return true;
    });
  });
});
