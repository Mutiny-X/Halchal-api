import { describe, expect, it } from "vitest";

import { parseStartDay, startDateForStorage, startDateProblem, storedStartDays, toIstDay } from "./start-date-rules";

describe("start-date-rules (India calendar days)", () => {
  // 2026-10-06 20:00 UTC = 2026-10-07 01:30 in India — already "tomorrow" there.
  const lateEveningUtc = new Date("2026-10-06T20:00:00Z");

  it("'today' is India's date, not the server's UTC date", () => {
    expect(toIstDay(lateEveningUtc)).toBe("2026-10-07");
    expect(startDateProblem("2026-10-06", lateEveningUtc)).toMatch(/past/);
    expect(startDateProblem("2026-10-07", lateEveningUtc)).toBeNull();
  });

  it("YYYY-MM-DD and full timestamps parse to the same India day", () => {
    expect(parseStartDay("2026-10-07")).toBe("2026-10-07");
    expect(parseStartDay("2026-10-07T00:00:00+05:30")).toBe("2026-10-07");
    expect(parseStartDay("not a date")).toBeNull();
  });

  it("caps at 12 months ahead", () => {
    const now = new Date("2026-10-06T06:00:00Z");
    expect(startDateProblem("2027-10-06", now)).toBeNull();
    expect(startDateProblem("2027-10-08", now)).toMatch(/12 months/);
    expect(startDateProblem("20260-01-01", now)).not.toBeNull();
  });

  it("a plain YYYY-MM-DD is that exact day, whatever the server's time zone", () => {
    expect(parseStartDay("2026-10-07")).toBe("2026-10-07");
    expect(parseStartDay("2026-02-31")).toBeNull();
    expect(parseStartDay("2026-13-01")).toBeNull();
  });

  it("stored values: UTC midnight is that date; other timestamps are India's day", () => {
    expect(parseStartDay(new Date("2026-10-07T00:00:00.000Z"))).toBe("2026-10-07");
    // IST midnight of 8 Oct, as some clients send it:
    expect(parseStartDay(new Date("2026-10-07T18:30:00.000Z"))).toBe("2026-10-08");
  });

  it("re-sending what a client displayed never counts as a change", () => {
    const odd = new Date("2026-10-07T18:30:00.000Z"); // shown as 7 Oct (UTC) or 8 Oct (India)
    expect(storedStartDays(odd)).toEqual(new Set(["2026-10-07", "2026-10-08"]));
    expect(storedStartDays(new Date("2026-10-07T00:00:00.000Z"))).toEqual(new Set(["2026-10-07"]));
    expect(storedStartDays(null).size).toBe(0);
  });

  it("always stores the day at UTC midnight", () => {
    expect(startDateForStorage("2026-10-07")?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(startDateForStorage("2026-10-08T00:00:00+05:30")?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(startDateForStorage("nope")).toBeUndefined();
  });
});
