import { describe, expect, it } from "vitest";

import { parseStartDay, startDateProblem, toIstDay } from "./start-date-rules";

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
});
