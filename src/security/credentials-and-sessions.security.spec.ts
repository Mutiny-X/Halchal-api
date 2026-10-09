import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../auth/auth.service";
import { hashRefreshToken } from "../auth/otp.service";
import { isAllowedWhilePasswordChangeIsPending, JwtStrategy } from "../auth/jwt.strategy";
import { UsersService } from "../users/users.service";

// ── changePassword ────────────────────────────────────────────────────────

describe("changing your password", () => {
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    refreshToken: { updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: UsersService;

  beforeEach(async () => {
    const hash = await bcrypt.hash("current-Password-1", 4);
    prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", passwordHash: hash }), update: vi.fn().mockReturnValue("user-update") },
      refreshToken: { updateMany: vi.fn().mockReturnValue("revoke-all") },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    service = new UsersService(prisma as never, {} as never, {} as never, {} as never);
  });

  it("refuses a wrong current password and changes nothing", async () => {
    await expect(service.changePassword("u1", "not-the-password", "new-Password-2")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an account that has no password login at all", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "u1", passwordHash: null });
    await expect(service.changePassword("u1", "anything", "new-Password-2")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores a fresh bcrypt hash (never the plain password) and clears the must-change flag", async () => {
    await service.changePassword("u1", "current-Password-1", "new-Password-2");
    const data = prisma.user.update.mock.calls[0][0].data as { passwordHash: string; mustChangePassword: boolean };
    expect(data.passwordHash).not.toContain("new-Password-2");
    expect(await bcrypt.compare("new-Password-2", data.passwordHash)).toBe(true);
    expect(data.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(data.mustChangePassword).toBe(false);
  });

  it("signs the person out everywhere, in the same transaction as the change", async () => {
    await service.changePassword("u1", "current-Password-1", "new-Password-2");
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(["user-update", "revoke-all"]);
  });
});

// ── refresh tokens ────────────────────────────────────────────────────────

describe("refresh tokens", () => {
  const USER = { id: "u1", role: "staff", isActive: true, email: "s@x.test", phone: null, displayName: "S" };
  const NOW = Date.now();

  function build(stored: Record<string, unknown> | null) {
    const prisma = {
      refreshToken: {
        findUnique: vi.fn().mockResolvedValue(stored),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const jwt = { signAsync: vi.fn().mockResolvedValue("access.jwt") };
    const config = { get: vi.fn((k: string) => (k === "JWT_ACCESS_TTL" ? "15m" : k === "JWT_REFRESH_TTL" ? "7d" : "x")) };
    const service = new AuthService(prisma as never, jwt as never, config as never, {} as never, {} as never);
    return { service, prisma };
  }
  const row = (over: Record<string, unknown> = {}) => ({
    id: "rt-1",
    user: USER,
    revokedAt: null,
    expiresAt: new Date(NOW + 86_400_000),
    ...over,
  });

  it("a valid one is spent and replaced (rotation)", async () => {
    const { service, prisma } = build(row());
    const out = await service.refresh("the-token");
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: "rt-1" }, data: { revokedAt: expect.any(Date) } });
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(out.tokens.refreshToken).not.toBe("the-token");
  });

  it("looks the token up by its hash, never by the raw value", async () => {
    const { service, prisma } = build(row());
    await service.refresh("the-token");
    expect(prisma.refreshToken.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: hashRefreshToken("the-token") });
  });

  it("an unknown token is refused", async () => {
    const { service, prisma } = build(null);
    await expect(service.refresh("nope")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("an expired token is refused", async () => {
    const { service } = build(row({ expiresAt: new Date(NOW - 1000) }));
    await expect(service.refresh("old")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("a token used again long after it was spent means a stolen copy: everything is signed out", async () => {
    const { service, prisma } = build(row({ revokedAt: new Date(NOW - 10 * 60_000) }));
    await expect(service.refresh("replayed")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("a double-submit within seconds (two tabs, a retry) is refused but does not sign everyone out", async () => {
    const { service, prisma } = build(row({ revokedAt: new Date(NOW - 2_000) }));
    await expect(service.refresh("raced")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("a deactivated account's token is refused and its other sessions are ended", async () => {
    const { service, prisma } = build(row({ user: { ...USER, isActive: false } }));
    await expect(service.refresh("t")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });
});

// ── must change password ──────────────────────────────────────────────────

describe("an account still on an admin-set password", () => {
  const strategy = (user: Record<string, unknown>) =>
    new JwtStrategy({ get: () => "s".repeat(40) } as never, { user: { findUnique: vi.fn().mockResolvedValue(user) } } as never);
  const pending = { isActive: true, role: "staff", mustChangePassword: true };
  const payload = { sub: "s1", role: "staff" } as never;

  it("is shut out of ordinary routes with a clear reason", async () => {
    for (const [method, url] of [["GET", "/admin/withdrawals"], ["POST", "/campaigns"], ["GET", "/wallet"], ["DELETE", "/users/me"]]) {
      await expect(strategy(pending).validate({ method, url }, payload)).rejects.toBeInstanceOf(ForbiddenException);
    }
    try {
      await strategy(pending).validate({ method: "GET", url: "/wallet" }, payload);
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    }
  });

  it("can still look at their account, change the password, refresh and sign out", async () => {
    for (const [method, url] of [["GET", "/users/me"], ["GET", "/users/me?x=1"], ["POST", "/users/me/change-password"], ["POST", "/auth/logout"], ["POST", "/auth/refresh"]]) {
      await expect(strategy(pending).validate({ method, url }, payload)).resolves.toBe(payload);
    }
  });

  it("is not let through by a look-alike path or the wrong method", () => {
    expect(isAllowedWhilePasswordChangeIsPending({ method: "GET", url: "/users/me/change-password" })).toBe(false);
    expect(isAllowedWhilePasswordChangeIsPending({ method: "PATCH", url: "/users/me" })).toBe(false);
    expect(isAllowedWhilePasswordChangeIsPending({ method: "GET", url: "/users/me/../admin/withdrawals" })).toBe(false);
    expect(isAllowedWhilePasswordChangeIsPending({ method: "GET", url: "/auth/logout" })).toBe(false);
  });

  it("is unaffected once the password has been changed", async () => {
    await expect(strategy({ ...pending, mustChangePassword: false }).validate({ method: "GET", url: "/wallet" }, payload)).resolves.toBe(payload);
  });
});
