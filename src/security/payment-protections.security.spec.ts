import "reflect-metadata";

import { describe, expect, it } from "vitest";

import { AdminController } from "../admin/admin.controller";
import { MONEY_ACCESS_KEY } from "../admin-roles/decorators/money-access.decorator";
import { validateEnv } from "../config/env";
import { AdminWithdrawalsController } from "../payouts/admin-withdrawals.controller";
import { PayoutsController } from "../payouts/payouts.controller";

const moneyGated = (target: object, method: string) =>
  Reflect.getMetadata(MONEY_ACCESS_KEY, (target as Record<string, unknown>)[method] as object) === true;
const limitOf = (target: object, method: string) =>
  Reflect.getMetadata("THROTTLER:LIMITdefault", (target as Record<string, unknown>)[method] as object) as number | undefined;

describe("admin money routes need canSeeMoney, not just the section", () => {
  const withdrawals = AdminWithdrawalsController.prototype;

  it.each(["exportPending", "downloadBatch", "importResults", "markPaid", "markFailed"])(
    "withdrawals: %s is gated",
    (method) => expect(moneyGated(withdrawals, method)).toBe(true),
  );

  it("withdrawals: the masked queue stays viewable without it", () => {
    expect(moneyGated(withdrawals, "list")).toBe(false);
  });

  it.each(["revealPayoutMethodAccountNumber", "payoutAllCreators", "payoutOneCreator"])(
    "admin: %s is gated",
    (method) => expect(moneyGated(AdminController.prototype, method)).toBe(true),
  );
});

describe("payment endpoint behaviour", () => {
  it("the export answers 200 (a download), not the framework's default 201 for POST", () => {
    expect(Reflect.getMetadata("__httpCode__", AdminWithdrawalsController.prototype.exportPending)).toBe(200);
  });

  it("creator withdrawal and bank-detail changes have their own, tighter throttles", () => {
    const payouts = PayoutsController.prototype;
    expect(limitOf(payouts, "withdraw")).toBe(5);
    expect(limitOf(payouts, "createMethod")).toBeLessThanOrEqual(10);
    expect(limitOf(payouts, "updateMethod")).toBeLessThanOrEqual(10);
  });
});

describe("production refuses to start without a proper payout encryption key", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    JWT_SECRET: "j".repeat(40),
    CORS_ORIGINS: "https://app.example.com",
  };

  it("when the key is missing", () => {
    expect(() => validateEnv({ ...base })).toThrow(/PAYOUT_ACCOUNT_ENCRYPTION_KEY is required/);
  });

  it("when the key is too short", () => {
    expect(() => validateEnv({ ...base, PAYOUT_ACCOUNT_ENCRYPTION_KEY: "short" })).toThrow(/at least 32/);
  });

  it("when the key is the same as the login-signing secret", () => {
    expect(() => validateEnv({ ...base, PAYOUT_ACCOUNT_ENCRYPTION_KEY: base.JWT_SECRET })).toThrow(/different from JWT_SECRET/);
  });

  it("but starts with a proper, separate key", () => {
    expect(validateEnv({ ...base, PAYOUT_ACCOUNT_ENCRYPTION_KEY: "k".repeat(40) }).PAYOUT_METHOD_COOLDOWN_HOURS).toBe(24);
  });

  it("and development still works without one", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "development" })).not.toThrow();
  });
});
