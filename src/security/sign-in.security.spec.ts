/* Security checks for password sign-in, reset links and sessions.
 * Each test asserts the SECURE behaviour; a failing test confirms a weakness. */
import { createHash } from "node:crypto";

import { UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";

import { AuthService } from "../auth/auth.service";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

function make(overrides: Record<string, unknown> = {}) {
  const prisma: any = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passwordResetToken: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue("access-token") };
  const config = {
    get: vi.fn((k: string) => ({ JWT_ACCESS_TTL: "15m", JWT_REFRESH_TTL: "7d", PASSWORD_RESET_TTL: "1h" } as Record<string, string>)[k]),
  };
  const email = { sendPasswordReset: vi.fn().mockResolvedValue(undefined) };
  const service = new AuthService(prisma, jwt as never, config as never, {} as never, email as never);
  return { service, prisma, jwt, email };
}

const hash = bcrypt.hashSync("Correct-Horse-9", 4);
const user = (role: UserRole, extra: Record<string, unknown> = {}) => ({
  id: `u-${role}`, role, email: `${role}@x.test`, phone: "+919000000000", displayName: role,
  passwordHash: hash, isActive: true, ...extra,
});

async function errorOf(p: Promise<unknown>) {
  try { await p; return null; } catch (e: any) { return { status: e.getStatus?.(), body: e.getResponse?.() }; }
}

describe("Admin sign-in", () => {
  it("accepts the right password for an admin", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    await expect(service.loginAdmin({ email: "admin@x.test", password: "Correct-Horse-9" })).resolves.toBeTruthy();
  });
  it("rejects a wrong password", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    expect((await errorOf(service.loginAdmin({ email: "admin@x.test", password: "wrong-pass" })))?.status).toBe(401);
  });
  for (const role of [UserRole.creator, UserRole.staff, UserRole.brand]) {
    it(`rejects a ${role} account on the admin sign-in`, async () => {
      const { service, prisma } = make();
      prisma.user.findUnique.mockResolvedValue(user(role));
      expect((await errorOf(service.loginAdmin({ email: "x@x.test", password: "Correct-Horse-9" })))?.status).toBe(401);
    });
  }
  it("rejects an account with no password set", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin, { passwordHash: null }));
    expect((await errorOf(service.loginAdmin({ email: "a@x.test", password: "Correct-Horse-9" })))?.status).toBe(401);
  });
  it("rejects a deactivated admin [M13]", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin, { isActive: false }));
    expect(await errorOf(service.loginAdmin({ email: "a@x.test", password: "Correct-Horse-9" }))).not.toBeNull();
  });
  it("gives the same answer for an unknown email and a wrong password", async () => {
    const a = make(); a.prisma.user.findUnique.mockResolvedValue(null);
    const b = make(); b.prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    const e1 = await errorOf(a.service.loginAdmin({ email: "none@x.test", password: "whatever-1" }));
    const e2 = await errorOf(b.service.loginAdmin({ email: "admin@x.test", password: "whatever-1" }));
    expect(e1).toEqual(e2);
  });
});

describe("Team sign-in", () => {
  it("accepts an active team member with the right password", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.staff));
    await expect(service.loginBrand({ email: "s@x.test", password: "Correct-Horse-9" })).resolves.toBeTruthy();
  });
  it("lets an admin sign in on the same page (no \"wrong portal\" answer needed)", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    await expect(service.loginBrand({ email: "a@x.test", password: "Correct-Horse-9" })).resolves.toBeTruthy();
  });
  it("locks an email after 10 wrong passwords, whether or not the account exists [M2]", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) expect((await errorOf(service.loginBrand({ email: "x@x.test", password: "wrong-pass-1" })))?.status).toBe(401);
    expect((await errorOf(service.loginBrand({ email: "x@x.test", password: "wrong-pass-1" })))?.status).toBe(429);
    // another email is unaffected
    expect((await errorOf(service.loginBrand({ email: "y@x.test", password: "wrong-pass-1" })))?.status).toBe(401);
  });
  it("rejects a deactivated team member", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.staff, { isActive: false }));
    expect((await errorOf(service.loginBrand({ email: "s@x.test", password: "Correct-Horse-9" })))?.status).toBe(401);
  });
  it("rejects brand accounts (brand access closed)", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.brand));
    expect((await errorOf(service.loginBrand({ email: "b@x.test", password: "Correct-Horse-9" })))?.status).toBe(401);
  });
  for (const role of [UserRole.creator, UserRole.admin, UserRole.brand]) {
    it(`doesn't reveal that the email belongs to a ${role} account [M11]`, async () => {
      const unknown = make(); unknown.prisma.user.findUnique.mockResolvedValue(null);
      const known = make(); known.prisma.user.findUnique.mockResolvedValue(user(role));
      const e1 = await errorOf(unknown.service.loginBrand({ email: "none@x.test", password: "whatever-1" }));
      const e2 = await errorOf(known.service.loginBrand({ email: "k@x.test", password: "whatever-1" }));
      expect(e2).toEqual(e1);
    });
  }
});

describe("Forgot password", () => {
  for (const [label, u] of [["unknown email", null], ["creator", user(UserRole.creator)], ["admin", user(UserRole.admin)], ["inactive team member", user(UserRole.staff, { isActive: false })]] as const) {
    it(`answers the same and sends nothing for: ${label}`, async () => {
      const { service, prisma, email } = make();
      prisma.user.findUnique.mockResolvedValue(u);
      await expect(service.forgotBrandPassword("x@x.test")).resolves.toEqual({ sent: true });
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });
  }
  it("for an active team member: stores only a hash of the link token and cancels older links", async () => {
    const { service, prisma, email } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.staff));
    await service.forgotBrandPassword("s@x.test");
    const raw = email.sendPasswordReset.mock.calls[0][1] as string;
    expect(raw).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes
    const stored = prisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(sha256(raw));
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-staff", usedAt: null } }));
    const ttl = stored.expiresAt.getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });
});

describe("Reset link", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 1000);
  const cases: Array<[string, unknown]> = [
    ["an unknown token", null],
    ["a used token", { id: "t", userId: "u", usedAt: new Date(), expiresAt: future, user: user(UserRole.staff) }],
    ["an expired token", { id: "t", userId: "u", usedAt: null, expiresAt: past, user: user(UserRole.staff) }],
    ["a creator's token", { id: "t", userId: "u", usedAt: null, expiresAt: future, user: user(UserRole.creator) }],
    ["a brand's token", { id: "t", userId: "u", usedAt: null, expiresAt: future, user: user(UserRole.brand) }],
    ["a deactivated member's token", { id: "t", userId: "u", usedAt: null, expiresAt: future, user: user(UserRole.staff, { isActive: false }) }],
  ];
  for (const [label, stored] of cases) {
    it(`refuses ${label}`, async () => {
      const { service, prisma } = make();
      prisma.passwordResetToken.findUnique.mockResolvedValue(stored);
      expect((await errorOf(service.resetBrandPassword("t".repeat(64), "New-Password-1")))?.status).toBe(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  }
  it("a valid reset hashes the new password, burns the link and signs out every session", async () => {
    const { service, prisma } = make();
    prisma.passwordResetToken.findUnique.mockResolvedValue({ id: "t1", userId: "u1", usedAt: null, expiresAt: future, user: user(UserRole.staff) });
    await service.resetBrandPassword("t".repeat(64), "New-Password-1");
    const [upd, burn, revoke] = prisma.$transaction.mock.calls[0][0];
    expect(prisma.user.update).toHaveBeenCalled();
    const newHash = prisma.user.update.mock.calls[0][0].data.passwordHash as string;
    expect(newHash).toMatch(/^\$2[aby]\$12\$/);
    expect(prisma.passwordResetToken.update.mock.calls[0][0].data.usedAt).toBeInstanceOf(Date);
    expect(prisma.refreshToken.updateMany.mock.calls[0][0].where).toEqual({ userId: "u1", revokedAt: null });
    expect([upd, burn, revoke].length).toBe(3);
    // …and the reset is recorded against the account.
    expect(prisma.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorUserId: "u1", action: "auth.password_reset" }) });
  });
});

describe("Sessions and refresh tokens", () => {
  const future = new Date(Date.now() + 86_400_000);
  it("refresh tokens are long random values and only their hash is stored", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    const out: any = await service.loginAdmin({ email: "a@x.test", password: "Correct-Horse-9" });
    const raw = out.refreshToken ?? out.tokens?.refreshToken;
    expect(Buffer.from(raw, "base64url").length).toBeGreaterThanOrEqual(48);
    const data = prisma.refreshToken.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(sha256(raw));
    expect(JSON.stringify(data)).not.toContain(raw);
  });
  it("the access token carries no email or phone number [N3]", async () => {
    const { service, prisma, jwt } = make();
    prisma.user.findUnique.mockResolvedValue(user(UserRole.admin));
    await service.loginAdmin({ email: "a@x.test", password: "Correct-Horse-9" });
    const payload = jwt.signAsync.mock.calls[0][0];
    expect(payload.email ?? null).toBeNull();
    expect(payload.phone ?? null).toBeNull();
  });
  for (const [label, stored] of [
    ["an unknown token", null],
    ["a revoked token", { id: "r", revokedAt: new Date(), expiresAt: future, user: user(UserRole.admin) }],
    ["an expired token", { id: "r", revokedAt: null, expiresAt: new Date(Date.now() - 1), user: user(UserRole.admin) }],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const { service, prisma } = make();
      prisma.refreshToken.findUnique.mockResolvedValue(stored);
      expect((await errorOf(service.refresh("x")))?.status).toBe(401);
    });
  }
  it("rotates: a used refresh token is revoked when a new one is issued", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", revokedAt: null, expiresAt: future, user: user(UserRole.admin) });
    await service.refresh("x");
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1" } }));
    expect(prisma.refreshToken.create).toHaveBeenCalled();
  });
  it("a deactivated team member's refresh ends all their sessions", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", revokedAt: null, expiresAt: future, user: user(UserRole.staff, { isActive: false }) });
    expect((await errorOf(service.refresh("x")))?.status).toBe(401);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-staff", revokedAt: null } }));
  });
  it("a brand account's refresh is refused", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", revokedAt: null, expiresAt: future, user: user(UserRole.brand) });
    expect((await errorOf(service.refresh("x")))?.status).toBe(401);
  });
  it("a deactivated admin's refresh is refused [M13]", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", revokedAt: null, expiresAt: future, user: user(UserRole.admin, { isActive: false }) });
    expect(await errorOf(service.refresh("x"))).not.toBeNull();
  });
  it("re-using an already-used refresh token signs that user out everywhere [M10]", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", userId: "u-admin", revokedAt: new Date(Date.now() - 5 * 60_000), expiresAt: future, user: user(UserRole.admin) });
    expect((await errorOf(service.refresh("x")))?.status).toBe(401);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "u-admin" }) }));
  });
  it("two honest requests racing with the same token don't sign the user out everywhere", async () => {
    const { service, prisma } = make();
    prisma.refreshToken.findUnique.mockResolvedValue({ id: "r1", userId: "u-admin", revokedAt: new Date(Date.now() - 2000), expiresAt: future, user: user(UserRole.admin) });
    expect((await errorOf(service.refresh("x")))?.status).toBe(401);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it("logout revokes the presented refresh token", async () => {
    const { service, prisma } = make();
    await service.logout("abc");
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { tokenHash: sha256("abc"), revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
  it("brand sign-up is closed", () => {
    const { service } = make();
    expect(() => service.registerBrand({} as never)).toThrow();
  });
});
