import { describe, expect, it } from "vitest";

import { formatHoldEnd, payoutMethodHoldUntil } from "./payout-method-hold";

const CHANGED = new Date("2026-10-09T10:00:00Z");

describe("payoutMethodHoldUntil", () => {
  it("ends the hold the configured number of hours after the change", () => {
    expect(payoutMethodHoldUntil(CHANGED, 24)?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
    expect(payoutMethodHoldUntil(CHANGED, 0.5)?.toISOString()).toBe("2026-10-09T10:30:00.000Z");
  });

  it("means no hold when it is turned off or the change date is unknown", () => {
    expect(payoutMethodHoldUntil(CHANGED, 0)).toBeNull();
    expect(payoutMethodHoldUntil(CHANGED, Number.NaN)).toBeNull();
    expect(payoutMethodHoldUntil(CHANGED, -5)).toBeNull();
    expect(payoutMethodHoldUntil(null, 24)).toBeNull();
    expect(payoutMethodHoldUntil(undefined, 24)).toBeNull();
  });
});

describe("formatHoldEnd", () => {
  it("prints India time, not the server's", () => {
    // 10:00 UTC is 3:30 pm IST.
    expect(formatHoldEnd(CHANGED)).toMatch(/9 Oct.*3:30\s?pm/i);
  });
});
