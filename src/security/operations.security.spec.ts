/* Security checks for account control, audit trail, clean-up and deletion.
 * Each test asserts the SECURE behaviour. */
import { UserRole } from "@prisma/client";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { AdminAuditInterceptor } from "../activity/admin-audit.interceptor";
import { AdminService } from "../admin/admin.service";
import { AuthCleanupService } from "../auth/auth-cleanup.service";
import { AuthService } from "../auth/auth.service";
import { LoginLockout } from "../auth/login-lockout";
import { passwordProblem } from "../auth/password-policy";
import { maskEmail, maskPhone } from "../common/mask";
import { PushNotificationService } from "../notifications/push-notification.service";
import { ParticipationService } from "../participation/participation.service";
import { UsersService } from "../users/users.service";

async function status(p: Promise<unknown>) {
  try { await p; return 200; } catch (e) { return (e as { getStatus?: () => number }).getStatus?.() ?? 500; }
}

describe("Suspending a creator", () => {
  function admin(creator: unknown) {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue(creator), update: vi.fn().mockResolvedValue({}) },
      refreshToken: { updateMany: vi.fn().mockResolvedValue({}) },
      deviceToken: { deleteMany: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const realtime = { disconnectUser: vi.fn().mockResolvedValue(undefined) };
    const activityLog = { log: vi.fn().mockResolvedValue(undefined) };
    const svc = new AdminService(prisma as never, {} as never, {} as never, {} as never, activityLog as never, {} as never, realtime as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { svc, prisma, realtime, activityLog };
  }
  const creator = { id: "c1", role: UserRole.creator, isActive: true, phone: "+919811122233" };

  it("ends every session and live connection, and is recorded with the admin who did it", async () => {
    const { svc, prisma, realtime, activityLog } = admin(creator);
    await svc.suspendCreator("c1", "admin1", "bought views");
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { isActive: false } });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: "c1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(realtime.disconnectUser).toHaveBeenCalledWith("c1");
    expect(activityLog.log).toHaveBeenCalledWith("admin1", "creator.suspended", expect.objectContaining({ targetId: "c1" }));
  });
  it("only works on creators", async () => {
    const { svc } = admin({ ...creator, role: UserRole.admin });
    expect(await status(svc.suspendCreator("c1", "admin1"))).toBe(404);
  });
  it("can't bring back an account its owner deleted", async () => {
    const { svc } = admin({ ...creator, isActive: false, phone: null });
    expect(await status(svc.reinstateCreator("c1", "admin1"))).toBe(400);
  });
  it("a suspended creator can't sign in, even with a correct code", async () => {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ ...creator, isActive: false, wallet: {} }) } };
    const otp = { verifyOtp: vi.fn().mockResolvedValue(undefined) };
    const auth = new AuthService(prisma as never, { signAsync: vi.fn() } as never, { get: vi.fn() } as never, otp as never, {} as never);
    expect(await status(auth.verifyCreatorOtp({ phone: "+919811122233", code: "123456" } as never))).toBe(403);
  });
});

describe("Audit trail", () => {
  const ctx = (method: string, user: unknown, params = {}) => ({
    switchToHttp: () => ({ getRequest: () => ({ method, user, params, route: { path: "/admin/creators/:id/kyc-review" }, ip: "1.2.3.4", body: { secret: "do-not-log" } }) }),
    getHandler: () => ({ name: "reviewKyc" }),
  }) as never;
  it("every admin change is recorded with who, what and which record", async () => {
    const log = { log: vi.fn().mockResolvedValue(undefined) };
    await firstValueFrom(new AdminAuditInterceptor(log as never).intercept(ctx("POST", { sub: "admin1" }, { id: "c1" }), { handle: () => of({ ok: true }) }));
    expect(log.log).toHaveBeenCalledWith("admin1", "admin.reviewKyc", expect.objectContaining({ targetId: "c1" }));
  });
  it("never stores the request body", async () => {
    const log = { log: vi.fn().mockResolvedValue(undefined) };
    await firstValueFrom(new AdminAuditInterceptor(log as never).intercept(ctx("POST", { sub: "admin1" }, { id: "c1" }), { handle: () => of({}) }));
    expect(JSON.stringify(log.log.mock.calls)).not.toContain("do-not-log");
  });
  it("reads aren't logged", async () => {
    const log = { log: vi.fn() };
    await firstValueFrom(new AdminAuditInterceptor(log as never).intercept(ctx("GET", { sub: "admin1" }), { handle: () => of({}) }));
    expect(log.log).not.toHaveBeenCalled();
  });
});

describe("Lockout, password rules and log masking", () => {
  it("unlocks by itself after the lock period", () => {
    let now = 0;
    const lock = new LoginLockout(3, 60_000, 60_000, () => now);
    for (let i = 0; i < 3; i++) lock.recordFailure("a@x.test");
    expect(() => lock.assertNotLocked("a@x.test")).toThrow();
    now = 61_000;
    expect(() => lock.assertNotLocked("a@x.test")).not.toThrow();
  });
  it("a successful sign-in clears the count", () => {
    const lock = new LoginLockout(3);
    lock.recordFailure("a@x.test"); lock.recordFailure("a@x.test"); lock.recordSuccess("a@x.test"); lock.recordFailure("a@x.test"); lock.recordFailure("a@x.test");
    expect(() => lock.assertNotLocked("a@x.test")).not.toThrow();
  });
  for (const weak of ["short1A", "1234567890", "abcdefghij", "Password123", "aaaaaaaaa1", "halchal@123"]) {
    it(`refuses the password ${weak}`, () => expect(passwordProblem(weak)).not.toBeNull());
  }
  it("accepts a reasonable password", () => expect(passwordProblem("river-Lamp-42-kite")).toBeNull());
  it("logs never carry a full phone number or email", () => {
    expect(maskPhone("+919811122233")).not.toContain("98111222");
    expect(maskPhone("+919811122233")).toMatch(/2233$/);
    expect(maskEmail("narasimha@example.com")).toBe("n•••@example.com");
  });
});

describe("Clean-up, deletion and small access fixes", () => {
  it("the nightly clean-up only removes rows that can no longer be used", async () => {
    const prisma = {
      otpSession: { deleteMany: vi.fn().mockReturnValue("otp") },
      refreshToken: { deleteMany: vi.fn().mockReturnValue("rt") },
      passwordResetToken: { deleteMany: vi.fn().mockReturnValue("prt") },
      $transaction: vi.fn().mockResolvedValue([{ count: 4 }, { count: 2 }, { count: 1 }]),
    };
    const now = Date.UTC(2026, 9, 8);
    await expect(new AuthCleanupService(prisma as never).purge(now)).resolves.toEqual({ otpSessions: 4, refreshTokens: 2, resetTokens: 1 });
    const otpCutoff = prisma.otpSession.deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(now - otpCutoff.getTime()).toBeGreaterThanOrEqual(24 * 3600_000); // the daily cap still sees a full day
    const rt = prisma.refreshToken.deleteMany.mock.calls[0][0].where.OR;
    expect(rt).toEqual([{ expiresAt: { lt: expect.any(Date) } }, { revokedAt: { lt: expect.any(Date) } }]);
  });
  it("deleting an account clears identity details and deletes the stored files", async () => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ avatarUrl: "https://f/avatars/a.jpg", kycDocumentUrl: "https://f/kyc-documents/k.jpg", panDocumentUrl: "https://f/pan-documents/p.jpg", aadhaarDocumentUrl: null }), update: vi.fn().mockReturnValue("u") },
      refreshToken: { updateMany: vi.fn() }, deviceToken: { deleteMany: vi.fn() },
      instagramConnection: { deleteMany: vi.fn() }, youtubeConnection: { deleteMany: vi.fn() }, instagramOAuthTransaction: { deleteMany: vi.fn() },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const storage = { deleteIdentityFile: vi.fn().mockResolvedValue(true) };
    await new UsersService(prisma as never, {} as never, {} as never, storage as never).deleteMe("u1");
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ isActive: false, phone: null, email: null, passwordHash: null, fixedOtpCode: null, panDocumentUrl: null, aadhaarDocumentUrl: null, aadhaarMaskedNumber: null, aadhaarVerifiedName: null });
    expect(prisma.instagramOAuthTransaction.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(storage.deleteIdentityFile.mock.calls.map((c) => c[0])).toEqual(["https://f/avatars/a.jpg", "https://f/kyc-documents/k.jpg", "https://f/pan-documents/p.jpg"]);
  });
  it("a notification token can only be removed by its owner", async () => {
    const prisma = { deviceToken: { deleteMany: vi.fn().mockResolvedValue({}) } };
    await new PushNotificationService({ get: vi.fn() } as never, prisma as never).unregisterToken("u1", "tok");
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { token: "tok", userId: "u1" } });
  });
  it("a draft or unapproved campaign has no leaderboard for creators", async () => {
    const prisma = { campaign: { findUnique: vi.fn().mockResolvedValue({ ratePer1kPaise: 1, maxPayoutPaise: 1, status: "draft" }) } };
    const svc = Object.create(ParticipationService.prototype) as ParticipationService;
    (svc as unknown as { prisma: unknown }).prisma = prisma;
    expect(await status(svc.getLeaderboard("camp1"))).toBe(404);
  });
});
