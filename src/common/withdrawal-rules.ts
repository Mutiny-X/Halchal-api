/** Withdrawal business rules, kept pure so they're trivially testable and so
 * the API is the single source of truth — clients read these values from the
 * wallet response instead of hard-coding them. */

/** A creator can withdraw only once their lifetime earnings have first
 * reached this. One-time unlock: lifetimePaise never decreases (withdrawals
 * and refunds don't touch it), so a plain >= check is stable. */
export const WITHDRAWAL_LIFETIME_GATE_PAISE = 150_000;

/** The only amounts a creator may withdraw, in paise (₹500 … ₹50,000). */
export const WITHDRAWAL_DENOMINATIONS_PAISE: readonly number[] = [
  500, 1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000,
  40_000, 45_000, 50_000,
].map((rupees) => rupees * 100);

/** What the creator is told about turnaround — payments are made manually. */
export const WITHDRAWAL_EXPECTED_DAYS = 7;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function isAllowedWithdrawalAmount(amountPaise: number): boolean {
  return WITHDRAWAL_DENOMINATIONS_PAISE.includes(amountPaise);
}

export function computeWithdrawalFeePaise(amountPaise: number, feeBps: number): number {
  return Math.floor((amountPaise * feeBps) / 10000);
}

export function isWithdrawalUnlocked(lifetimePaise: number): boolean {
  return lifetimePaise >= WITHDRAWAL_LIFETIME_GATE_PAISE;
}

/** Start (00:00 IST) of the calendar day containing `now`, as a UTC Date.
 * "One withdrawal per day" is measured on the IST calendar. */
export function startOfIstDay(now: Date): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  const dayStartIstMs = istMs - (((istMs % 86_400_000) + 86_400_000) % 86_400_000);
  return new Date(dayStartIstMs - IST_OFFSET_MS);
}

/** Start of the next IST calendar day — when a daily limit frees up. */
export function startOfNextIstDay(now: Date): Date {
  return new Date(startOfIstDay(now).getTime() + 86_400_000);
}

export type WithdrawalRejection =
  | { code: "WITHDRAWAL_LOCKED"; message: string }
  | { code: "WITHDRAWAL_AMOUNT_INVALID"; message: string }
  | { code: "WITHDRAWAL_OPEN_REQUEST"; message: string }
  | { code: "WITHDRAWAL_DAILY_LIMIT"; message: string }
  | { code: "WITHDRAWAL_INSUFFICIENT_BALANCE"; message: string }
  | { code: "WITHDRAWAL_TOO_SMALL"; message: string };

/** Pure eligibility check. Returns the first rule that blocks the request, or
 * null when the creator may withdraw `amountPaise`. */
export function checkWithdrawalEligibility(input: {
  amountPaise: number;
  availablePaise: number;
  lifetimePaise: number;
  feeBps: number;
  hasOpenWithdrawal: boolean;
  requestedToday: boolean;
}): WithdrawalRejection | null {
  if (!isAllowedWithdrawalAmount(input.amountPaise)) {
    return {
      code: "WITHDRAWAL_AMOUNT_INVALID",
      message: "Choose one of the available withdrawal amounts.",
    };
  }
  if (!isWithdrawalUnlocked(input.lifetimePaise)) {
    return {
      code: "WITHDRAWAL_LOCKED",
      message: "Withdrawals unlock once your total earnings reach ₹1,500.",
    };
  }
  if (input.hasOpenWithdrawal) {
    return {
      code: "WITHDRAWAL_OPEN_REQUEST",
      message: "You already have a withdrawal in progress. You can request another once it's paid.",
    };
  }
  if (input.requestedToday) {
    return {
      code: "WITHDRAWAL_DAILY_LIMIT",
      message: "You've already requested a withdrawal today. Come back tomorrow.",
    };
  }
  if (input.availablePaise < input.amountPaise) {
    return {
      code: "WITHDRAWAL_INSUFFICIENT_BALANCE",
      message: "Insufficient available balance.",
    };
  }
  const feePaise = computeWithdrawalFeePaise(input.amountPaise, input.feeBps);
  if (input.amountPaise - feePaise <= 0) {
    return {
      code: "WITHDRAWAL_TOO_SMALL",
      message: "Withdrawal amount too small after fee.",
    };
  }
  return null;
}
