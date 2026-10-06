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

const PLAIN_DAY = /^(\d{4,})-(\d{2})-(\d{2})$/;

function isUtcMidnight(date: Date): boolean {
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

/**
 * The calendar day a start date means.
 * - "YYYY-MM-DD" (what the website sends) is that day, literally — never
 *   shifted by any time zone.
 * - A stored value at UTC midnight (how every start date is saved) is that
 *   UTC date.
 * - Any other timestamp is read as the day it falls on in India.
 */
export function parseStartDay(raw: string | Date): string | null {
  if (typeof raw === "string") {
    const m = PLAIN_DAY.exec(raw.trim());
    if (m) {
      const [, y, mo, d] = m;
      const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      // Rejects 2026-02-31 and the like (Date would roll it into March).
      const valid =
        Number(y) >= 1000 && check.getUTCFullYear() === Number(y) && check.getUTCMonth() === Number(mo) - 1 && check.getUTCDate() === Number(d);
      return valid ? `${y}-${mo}-${d}` : null;
    }
  }
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return isUtcMidnight(date) ? date.toISOString().slice(0, 10) : toIstDay(date);
}

/** Every day a stored start date could reasonably be shown as (its UTC date
 * and its date in India) — so re-sending the value a client displayed never
 * counts as "changing" it. */
export function storedStartDays(stored: Date | null | undefined): Set<string> {
  if (!stored || Number.isNaN(stored.getTime())) return new Set();
  return new Set([stored.toISOString().slice(0, 10), toIstDay(stored), parseStartDay(stored)!]);
}

/** What to save: the start day at UTC midnight, like all existing rows. */
export function startDateForStorage(raw: string | Date): Date | undefined {
  const day = parseStartDay(raw);
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
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
