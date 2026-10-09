import { describe, expect, it } from "vitest";

import {
  WITHDRAWAL_DENOMINATIONS_PAISE,
  WITHDRAWAL_LIFETIME_GATE_PAISE,
  checkWithdrawalEligibility,
  computeWithdrawalFeePaise,
  isAllowedWithdrawalAmount,
  isWithdrawalUnlocked,
  startOfIstDay,
  startOfNextIstDay,
} from "./withdrawal-rules";

const base = {
  amountPaise: 500_00,
  availablePaise: 10_000_00,
  lifetimePaise: 10_000_00,
  feeBps: 500,
  hasOpenWithdrawal: false,
  requestedToday: false,
};

describe("denominations", () => {
  it("lists exactly the thirteen allowed amounts, in paise", () => {
    expect(WITHDRAWAL_DENOMINATIONS_PAISE).toEqual(
      [500, 1000, 3000, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000].map((r) => r * 100),
    );
  });

  it("accepts a listed amount and rejects anything else", () => {
    expect(isAllowedWithdrawalAmount(500_00)).toBe(true);
    expect(isAllowedWithdrawalAmount(50_000_00)).toBe(true);
    expect(isAllowedWithdrawalAmount(2_000_00)).toBe(false); // gap between ₹1,000 and ₹3,000
    expect(isAllowedWithdrawalAmount(500_01)).toBe(false);
    expect(isAllowedWithdrawalAmount(0)).toBe(false);
    expect(isAllowedWithdrawalAmount(-500_00)).toBe(false);
  });
});

describe("lifetime gate", () => {
  it("unlocks at exactly ₹1,500 lifetime earnings", () => {
    expect(WITHDRAWAL_LIFETIME_GATE_PAISE).toBe(150_000);
    expect(isWithdrawalUnlocked(149_999)).toBe(false);
    expect(isWithdrawalUnlocked(150_000)).toBe(true);
    expect(isWithdrawalUnlocked(900_000)).toBe(true);
  });
});

describe("fee", () => {
  it("floors the fee in paise", () => {
    expect(computeWithdrawalFeePaise(500_00, 500)).toBe(2_500);
    expect(computeWithdrawalFeePaise(1_001, 500)).toBe(50);
  });
});

describe("IST day boundaries", () => {
  it("treats 18:29 UTC and 18:31 UTC as different IST days", () => {
    // IST midnight = 18:30 UTC the previous day.
    const before = new Date("2026-10-08T18:29:00.000Z");
    const after = new Date("2026-10-08T18:31:00.000Z");
    expect(startOfIstDay(before).toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(startOfIstDay(after).toISOString()).toBe("2026-10-08T18:30:00.000Z");
  });

  it("returns the next IST midnight", () => {
    const now = new Date("2026-10-08T10:00:00.000Z");
    expect(startOfNextIstDay(now).toISOString()).toBe("2026-10-08T18:30:00.000Z");
  });
});

describe("checkWithdrawalEligibility", () => {
  it("allows a valid request", () => {
    expect(checkWithdrawalEligibility(base)).toBeNull();
  });

  it("rejects an amount not on the list before anything else", () => {
    expect(checkWithdrawalEligibility({ ...base, amountPaise: 123_00, lifetimePaise: 0 })?.code).toBe(
      "WITHDRAWAL_AMOUNT_INVALID",
    );
  });

  it("rejects while lifetime earnings are under ₹1,500", () => {
    expect(checkWithdrawalEligibility({ ...base, lifetimePaise: 149_999 })?.code).toBe("WITHDRAWAL_LOCKED");
  });

  it("rejects when another withdrawal is still open", () => {
    expect(checkWithdrawalEligibility({ ...base, hasOpenWithdrawal: true })?.code).toBe(
      "WITHDRAWAL_OPEN_REQUEST",
    );
  });

  it("rejects a second request on the same IST day", () => {
    expect(checkWithdrawalEligibility({ ...base, requestedToday: true })?.code).toBe("WITHDRAWAL_DAILY_LIMIT");
  });

  it("rejects when the available balance is short", () => {
    expect(checkWithdrawalEligibility({ ...base, availablePaise: 499_99 })?.code).toBe(
      "WITHDRAWAL_INSUFFICIENT_BALANCE",
    );
  });

  it("rejects when the fee would consume the whole amount", () => {
    expect(checkWithdrawalEligibility({ ...base, feeBps: 10_000 })?.code).toBe("WITHDRAWAL_TOO_SMALL");
  });

  it("allows the exact available balance", () => {
    expect(checkWithdrawalEligibility({ ...base, availablePaise: 500_00 })).toBeNull();
  });
});
