import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { MONEY_ACCESS_KEY } from "../decorators/money-access.decorator";
import { MoneyAccessGuard } from "./money-access.guard";

function makeGuard(
  marked: boolean,
  permissions: { isSuperAdmin: boolean; canSeeMoney: boolean; sections?: Record<string, string> },
) {
  const reflector = new Reflector();
  vi.spyOn(reflector, "getAllAndOverride").mockImplementation((key) => (key === MONEY_ACCESS_KEY ? marked : undefined));
  const adminRoles = { getEffectivePermissions: vi.fn().mockResolvedValue({ sections: {}, ...permissions }) };
  const guard = new MoneyAccessGuard(reflector, adminRoles as never);
  const context = (user?: { sub: string }) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
  return { guard, adminRoles, context };
}

describe("MoneyAccessGuard", () => {
  it("leaves unmarked routes alone, without even loading permissions", async () => {
    const { guard, adminRoles, context } = makeGuard(false, { isSuperAdmin: false, canSeeMoney: false });
    await expect(guard.canActivate(context({ sub: "a1" }))).resolves.toBe(true);
    expect(adminRoles.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it("refuses a restricted role without canSeeMoney", async () => {
    const { guard, context } = makeGuard(true, { isSuperAdmin: false, canSeeMoney: false });
    await expect(guard.canActivate(context({ sub: "a1" }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a restricted role that has canSeeMoney", async () => {
    const { guard, context } = makeGuard(true, { isSuperAdmin: false, canSeeMoney: true });
    await expect(guard.canActivate(context({ sub: "a1" }))).resolves.toBe(true);
  });

  it("always allows a Super Admin", async () => {
    const { guard, context } = makeGuard(true, { isSuperAdmin: true, canSeeMoney: false });
    await expect(guard.canActivate(context({ sub: "a1" }))).resolves.toBe(true);
  });

  it("fails closed when no user is attached", async () => {
    const { guard, context } = makeGuard(true, { isSuperAdmin: true, canSeeMoney: true });
    await expect(guard.canActivate(context(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
