/* Security checks for creator OTP sign-in, per-request session checks and
 * the role / admin-section / campaign-access guards. Each test asserts the
 * SECURE behaviour; a failing test confirms a weakness. */
import { ForbiddenException } from "@nestjs/common";
import { StaffAccessLevel, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";

import { AdminSectionGuard } from "../admin-roles/guards/admin-section.guard";
import { SuperAdminOnlyGuard } from "../admin-roles/guards/super-admin-only.guard";
import { CampaignAccessService } from "../access/campaign-access.service";
import { FixedOtpService } from "../auth/fixed-otp.service";
import { JwtStrategy } from "../auth/jwt.strategy";
import { OtpService } from "../auth/otp.service";
import { RolesGuard } from "../common/guards/roles.guard";

const PROD = { NODE_ENV: "production", OTP_TTL_SECONDS: 600, OTP_MAX_ATTEMPTS: 5, JWT_SECRET: "s".repeat(32) } as Record<string, unknown>;
const cfg = (env = PROD) => ({ get: vi.fn((k: string) => env[k]) });

function otpService(env = PROD, fixedCodeUser: string | null = null) {
  const prisma: any = {
    otpSession: {
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findFirst: vi.fn(), create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue(fixedCodeUser ? { fixedOtpCode: fixedCodeUser } : null) },
  };
  const whatsapp = { sendOtp: vi.fn().mockResolvedValue(undefined) };
  const fixed = new FixedOtpService(prisma, cfg(env) as never);
  return { svc: new OtpService(prisma, cfg(env) as never, whatsapp as never, fixed), prisma, whatsapp };
}
const session = (code: string, extra: Record<string, unknown> = {}) => ({
  id: "s1", phone: "+919811122233", codeHash: bcrypt.hashSync(code, 4), attempts: 0,
  expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), ...extra,
});
async function status(p: Promise<unknown>) {
  try { await p; return 200; } catch (e: any) { return e.getStatus?.() ?? 500; }
}

describe("Creator OTP", () => {
  it("sends a 6-digit code over WhatsApp and stores only its hash", async () => {
    const { svc, prisma, whatsapp } = otpService();
    await svc.requestOtp("9811122233");
    const code = whatsapp.sendOtp.mock.calls[0][1] as string;
    expect(code).toMatch(/^\d{6}$/);
    const saved = prisma.otpSession.create.mock.calls[0][0].data;
    expect(saved.codeHash).not.toBe(code);
    expect(bcrypt.compareSync(code, saved.codeHash)).toBe(true);
    expect(saved.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000 + 1000);
  });
  it("codes are not predictable (20 requests give 20 different codes)", async () => {
    const { svc, whatsapp } = otpService();
    for (let i = 0; i < 20; i++) await svc.requestOtp("9811122233");
    expect(new Set(whatsapp.sendOtp.mock.calls.map((c) => c[1])).size).toBeGreaterThanOrEqual(19);
  }, 30_000);
  it("blocks rapid repeat requests after 3 in 30 minutes", async () => {
    const { svc, prisma } = otpService();
    prisma.otpSession.findMany.mockResolvedValue([session("1"), session("2"), session("3")]);
    expect(await status(svc.requestOtp("9811122233"))).toBe(429);
  });
  it("accepts the right code once, then it's gone", async () => {
    const { svc, prisma } = otpService();
    prisma.otpSession.findFirst.mockResolvedValue(session("482913"));
    expect(await status(svc.verifyOtp("9811122233", "482913"))).toBe(200);
    expect(prisma.otpSession.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
  });
  it("rejects a wrong code and counts the attempt", async () => {
    const { svc, prisma } = otpService();
    prisma.otpSession.findFirst.mockResolvedValue(session("482913"));
    expect(await status(svc.verifyOtp("9811122233", "111111"))).toBe(400);
    expect(prisma.otpSession.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { attempts: { increment: 1 } } });
  });
  it("rejects an expired code", async () => {
    const { svc, prisma } = otpService();
    prisma.otpSession.findFirst.mockResolvedValue(session("482913", { expiresAt: new Date(Date.now() - 1) }));
    expect(await status(svc.verifyOtp("9811122233", "482913"))).toBe(400);
  });
  it("locks the code after 5 wrong attempts", async () => {
    const { svc, prisma } = otpService();
    prisma.otpSession.findFirst.mockResolvedValue(session("482913", { attempts: 5 }));
    expect(await status(svc.verifyOtp("9811122233", "482913"))).toBe(429);
  });
  it("a fresh code doesn't reset the wrong-guess budget for that phone [T8]", async () => {
    // 10 wrong guesses were used up on two earlier codes; the newest code starts at 0.
    const { svc, prisma } = otpService();
    prisma.otpSession.findMany.mockResolvedValue([{ attempts: 5 }, { attempts: 5 }, { attempts: 0 }]);
    prisma.otpSession.findFirst.mockResolvedValue(session("482913", { attempts: 0 }));
    expect(await status(svc.verifyOtp("9811122233", "482913"))).toBe(429);
  });
  it("one number can't request more than 15 codes a day [N5]", async () => {
    const { svc, prisma, whatsapp } = otpService();
    prisma.otpSession.count.mockResolvedValue(15);
    expect(await status(svc.requestOtp("9811122233"))).toBe(429);
    expect(whatsapp.sendOtp).not.toHaveBeenCalled();
  });
  it("reviewer numbers still work for a store review when REVIEWER_OTP_ENABLED is on", async () => {
    const { svc, prisma } = otpService({ ...PROD, REVIEWER_OTP_ENABLED: true });
    prisma.otpSession.findFirst.mockResolvedValue(null);
    expect(await status(svc.verifyOtp("+919876543210", "000000"))).toBe(200);
  });
  it("the development bypass code is ignored in production", async () => {
    const { svc, prisma } = otpService({ ...PROD, OTP_DEV_BYPASS_CODE: "123456" });
    prisma.otpSession.findFirst.mockResolvedValue(null);
    expect(await status(svc.verifyOtp("9811122233", "123456"))).toBe(400);
  });
  for (const phone of ["+919876543210", "+919876543211"]) {
    it(`reviewer number ${phone} can't sign in with 000000 in production [C5]`, async () => {
      const { svc, prisma } = otpService();
      prisma.otpSession.findFirst.mockResolvedValue(null);
      expect(await status(svc.verifyOtp(phone, "000000"))).not.toBe(200);
    });
  }
  it("a per-account fixed code (fixedOtpCode) is ignored in production [C5]", async () => {
    const { svc, prisma } = otpService(PROD, "424242");
    prisma.otpSession.findFirst.mockResolvedValue(null);
    expect(await status(svc.verifyOtp("9811122233", "424242"))).not.toBe(200);
  });
});

describe("Per-request session check (JWT strategy)", () => {
  const strat = (u: unknown) => new JwtStrategy(cfg() as never, { user: { findUnique: vi.fn().mockResolvedValue(u) } } as never);
  it("rejects a token without a user id or role", async () => {
    expect(await status(strat(null).validate({ method: "GET", url: "/x" }, {} as never))).toBe(401);
  });
  it("rejects brand sessions", async () => {
    expect(await status(strat(null).validate({ method: "GET", url: "/x" }, { sub: "b", role: "brand" } as never))).toBe(401);
  });
  for (const [label, u] of [["deactivated", { isActive: false, role: "staff" }], ["removed", null], ["no longer staff", { isActive: true, role: "creator" }]] as const) {
    it(`rejects a ${label} team member immediately`, async () => {
      expect(await status(strat(u).validate({ method: "GET", url: "/x" }, { sub: "s", role: "staff" } as never))).toBe(401);
    });
  }
  it("accepts an active team member", async () => {
    expect(await status(strat({ isActive: true, role: "staff" }).validate({ method: "GET", url: "/x" }, { sub: "s", role: "staff" } as never))).toBe(200);
  });
  it("rejects a deactivated admin immediately [M13]", async () => {
    expect(await status(strat({ isActive: false, role: "admin" }).validate({ method: "GET", url: "/x" }, { sub: "a", role: "admin" } as never))).toBe(401);
  });
  it("rejects a creator whose account was deleted [new: deleted creator]", async () => {
    expect(await status(strat({ isActive: false, role: "creator" }).validate({ method: "GET", url: "/x" }, { sub: "c", role: "creator" } as never))).toBe(401);
  });
  it("refuses expired tokens (ignoreExpiration is off)", () => {
    const s: any = strat(null);
    expect(s._verifOpts?.ignoreExpiration ?? false).toBe(false);
  });
});

const ctx = (user: unknown, method = "GET") => ({
  getHandler: () => ({}), getClass: () => ({}),
  switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
}) as never;
const reflector = (value: unknown) => ({ getAllAndOverride: vi.fn().mockReturnValue(value) }) as never;

describe("Role guard", () => {
  it("blocks a request with no signed-in user", () => {
    expect(() => new RolesGuard(reflector([UserRole.admin])).canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
  it("blocks the wrong role", () => {
    expect(() => new RolesGuard(reflector([UserRole.admin])).canActivate(ctx({ sub: "c", role: "creator" }))).toThrow(ForbiddenException);
  });
  it("allows the right role", () => {
    expect(new RolesGuard(reflector([UserRole.admin])).canActivate(ctx({ sub: "a", role: "admin" }))).toBe(true);
  });
});

describe("Admin permission guards", () => {
  const roles = (p: unknown) => ({ getEffectivePermissions: vi.fn().mockResolvedValue(p) }) as never;
  const restricted = (level: string | undefined) => ({ isSuperAdmin: false, sections: { campaigns: level } });
  it("a restricted admin with view access can read", async () => {
    await expect(new AdminSectionGuard(reflector("campaigns"), roles(restricted("view"))).canActivate(ctx({ sub: "a" }, "GET"))).resolves.toBe(true);
  });
  it("a restricted admin with view access can't change anything", async () => {
    await expect(new AdminSectionGuard(reflector("campaigns"), roles(restricted("view"))).canActivate(ctx({ sub: "a" }, "POST"))).rejects.toThrow(ForbiddenException);
  });
  it("a restricted admin with no access to the section is blocked", async () => {
    await expect(new AdminSectionGuard(reflector("campaigns"), roles(restricted(undefined))).canActivate(ctx({ sub: "a" }, "GET"))).rejects.toThrow(ForbiddenException);
  });
  it("only super admins may manage roles", async () => {
    await expect(new SuperAdminOnlyGuard(roles(restricted("manage"))).canActivate(ctx({ sub: "a" }))).rejects.toThrow(ForbiddenException);
  });
  it("fails closed when no signed-in user is present [sharp edge]", async () => {
    await expect(new AdminSectionGuard(reflector("campaigns"), roles(restricted(undefined))).canActivate(ctx(undefined))).rejects.toThrow();
  });
});

describe("Campaign access (team members)", () => {
  const camp = { id: "c1", brandProfileId: "b1", ownership: "brand" as never };
  const svc = (assignment: unknown, brandOwner: string | null = null) => new CampaignAccessService({
    staffBrandAssignment: { findUnique: vi.fn().mockResolvedValue(assignment) },
    brandProfile: { findUnique: vi.fn().mockResolvedValue(brandOwner ? { id: brandOwner } : null) },
  } as never);
  it("admins can open any campaign", async () => {
    await expect(svc(null).assertCanAccessCampaign("a", UserRole.admin, camp)).resolves.toBeUndefined();
  });
  it("an assigned team member can open their brand's campaign", async () => {
    await expect(svc({ accessLevel: StaffAccessLevel.full }).assertCanAccessCampaign("s", UserRole.staff, camp)).resolves.toBeUndefined();
  });
  it("an unassigned team member is blocked", async () => {
    await expect(svc(null).assertCanAccessCampaign("s", UserRole.staff, camp)).rejects.toThrow(ForbiddenException);
  });
  it("a view-only team member can't make changes", async () => {
    await expect(svc({ accessLevel: StaffAccessLevel.view_only }).assertCanAccessCampaign("s", UserRole.staff, camp, { requireWrite: true })).rejects.toThrow(ForbiddenException);
  });
  it("a campaign with no brand is closed to team members", async () => {
    await expect(svc({ accessLevel: StaffAccessLevel.full }).assertCanAccessCampaign("s", UserRole.staff, { ...camp, brandProfileId: null })).rejects.toThrow(ForbiddenException);
  });
  it("creators can't use the team campaign routes", async () => {
    await expect(svc(null).assertCanAccessCampaign("c", UserRole.creator, camp)).rejects.toThrow(ForbiddenException);
  });
});
