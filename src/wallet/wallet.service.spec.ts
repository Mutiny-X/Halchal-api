import { describe, expect, it, vi } from "vitest";

import { WalletService } from "./wallet.service";

function build(opts: { open?: number; today?: number } = {}) {
  const count = vi
    .fn()
    .mockResolvedValueOnce(opts.open ?? 0) // open withdrawals
    .mockResolvedValueOnce(opts.today ?? 0); // requested today
  const prisma = { withdrawal: { count } };
  const config = { get: vi.fn(() => 500) };
  return new WalletService(prisma as never, config as never);
}

describe("WalletService.getWithdrawalRules", () => {
  it("is locked below ₹1,500 and says how much is left to unlock", async () => {
    const rules = await build().getWithdrawalRules("u-1", 1_000_00);
    expect(rules.unlocked).toBe(false);
    expect(rules.lifetimeGatePaise).toBe(150_000);
    expect(rules.remainingToUnlockPaise).toBe(50_000);
  });

  it("unlocks at exactly ₹1,500", async () => {
    const rules = await build().getWithdrawalRules("u-1", 1_500_00);
    expect(rules.unlocked).toBe(true);
    expect(rules.remainingToUnlockPaise).toBe(0);
  });

  it("publishes the fixed denominations and the server's fee", async () => {
    const rules = await build().getWithdrawalRules("u-1", 5_000_00);
    expect(rules.denominationsPaise[0]).toBe(500_00);
    expect(rules.denominationsPaise.at(-1)).toBe(50_000_00);
    expect(rules.denominationsPaise).toHaveLength(13);
    expect(rules.feeBps).toBe(500);
    expect(rules.expectedDays).toBe(7);
  });

  it("reports an open withdrawal and a request made today", async () => {
    const rules = await build({ open: 1, today: 1 }).getWithdrawalRules("u-1", 5_000_00);
    expect(rules.hasOpenWithdrawal).toBe(true);
    expect(rules.requestedToday).toBe(true);
    expect(rules.nextRequestAt).not.toBeNull();
  });

  it("has no next-request time when nothing was requested today", async () => {
    const rules = await build().getWithdrawalRules("u-1", 5_000_00);
    expect(rules.requestedToday).toBe(false);
    expect(rules.nextRequestAt).toBeNull();
  });
});
