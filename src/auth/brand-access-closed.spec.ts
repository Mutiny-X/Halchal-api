import { ForbiddenException, GoneException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";
import { CampaignInviteService } from "./campaign-invite.service";
import { JwtStrategy } from "./jwt.strategy";

function makeService() {
  const prisma = {
    user: { findUnique: vi.fn() },
    refreshToken: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    passwordResetToken: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue("access-token") };
  const config = { get: vi.fn((k: string) => (k === "JWT_ACCESS_TTL" ? "15m" : k === "JWT_REFRESH_TTL" ? "7d" : k === "PASSWORD_RESET_TTL" ? "1h" : undefined)) };
  const email = { sendPasswordReset: vi.fn().mockResolvedValue(undefined) };
  const service = new AuthService(prisma as never, jwt as never, config as never, {} as never, email as never);
  return { service, prisma, email };
}

const code = (e: unknown) => ((e as { getResponse(): { code: string } }).getResponse()).code;

describe("brand access is closed", () => {
  it("refuses brand sign-up", () => {
    const { service } = makeService();
    expect(() => service.registerBrand({} as never)).toThrow(ForbiddenException);
  });

  it("refuses a brand signing in, even with the right password", async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: "b", role: UserRole.brand, passwordHash: await bcrypt.hash("pw", 4) });
    await expect(service.loginBrand({ email: "b@x.com", password: "pw" })).rejects.toSatisfy(
      (e) => e instanceof UnauthorizedException && code(e) === "BRAND_ACCESS_CLOSED",
    );
  });

  it("still lets an active team member sign in", async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: "s", role: UserRole.staff, isActive: true, passwordHash: await bcrypt.hash("pw", 4) });
    const res = await service.loginBrand({ email: "s@x.com", password: "pw" });
    expect(res.tokens.accessToken).toBe("access-token");
  });

  it("ends a brand's existing session at refresh", async () => {
    const { service, prisma } = makeService();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: "rt", revokedAt: null, expiresAt: new Date(Date.now() + 60_000), user: { id: "b", role: UserRole.brand },
    });
    await expect(service.refresh("token")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: "b", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it("ends a deactivated team member's session at refresh", async () => {
    const { service, prisma } = makeService();
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: "rt", revokedAt: null, expiresAt: new Date(Date.now() + 60_000), user: { id: "s", role: UserRole.staff, isActive: false },
    });
    await expect(service.refresh("token")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("sends password resets to team members, not brands", async () => {
    const { service, prisma, email } = makeService();
    prisma.user.findUnique.mockResolvedValueOnce({ id: "b", role: UserRole.brand, email: "b@x.com" });
    await expect(service.forgotBrandPassword("b@x.com")).resolves.toEqual({ sent: true });
    expect(email.sendPasswordReset).not.toHaveBeenCalled();

    prisma.user.findUnique.mockResolvedValueOnce({ id: "s", role: UserRole.staff, isActive: true, email: "s@x.com" });
    await service.forgotBrandPassword("s@x.com");
    expect(email.sendPasswordReset).toHaveBeenCalledWith("s@x.com", expect.any(String));
  });

  it("rejects a brand access token on every request", () => {
    const strategy = new JwtStrategy({ get: () => "secret" } as never);
    expect(() => strategy.validate({ sub: "b", role: "brand" } as never)).toThrow(UnauthorizedException);
    expect(strategy.validate({ sub: "s", role: "staff" } as never)).toMatchObject({ sub: "s" });
  });

  it("stops brand campaign invites", async () => {
    const invites = new CampaignInviteService({} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(invites.sendInvite("admin", "c", "brand@x.com")).rejects.toBeInstanceOf(GoneException);
    await expect(invites.preview("t")).rejects.toBeInstanceOf(GoneException);
    await expect(invites.accept({ token: "t" } as never)).rejects.toBeInstanceOf(GoneException);
  });
});
