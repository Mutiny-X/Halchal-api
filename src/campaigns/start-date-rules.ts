/**
 * Campaign start dates are calendar days in India (IST, UTC+5:30) — the
 * brands and creators are there, and "today" must mean their today, not the
 * server's UTC day (which lags IST by 5½ hours every evening).
 */
const IST = "Asia/Kolkata";
/** Catches typos like year 20260 that a date field happily accepts. */
export const MAX_START_DAYS_AHEAD = 365;

const istDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of `date` as a calendar day in India. */
export function toIstDay(date: Date): string {
  return istDay.format(date);
}

/** YYYY-MM-DD (any number of year digits) → YYYYMMDD as a number. */
function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return y * 10_000 + m * 100 + d;
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Parses what the API receives (YYYY-MM-DD or a full ISO timestamp). */
export function parseStartDay(raw: string | Date): string | null {
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return toIstDay(date);
}

/** A user-facing problem with a start date being set, or null if fine. */
export function startDateProblem(raw: string | Date, now: Date = new Date()): string | null {
  const day = parseStartDay(raw);
  if (!day) return "Start date isn't a valid date";
  const today = toIstDay(now);
  // Compared as numbers, not strings: as text, a typo like "20260-01-01"
  // sorts before "2027-…" and would slip past the upper limit.
  if (dayNumber(day) < dayNumber(today)) {
    return "Start date can't be in the past — choose today or a later date";
  }
  if (dayNumber(day) > dayNumber(addDays(today, MAX_START_DAYS_AHEAD))) {
    return "Start date must be within the next 12 months";
  }
  return null;
}
