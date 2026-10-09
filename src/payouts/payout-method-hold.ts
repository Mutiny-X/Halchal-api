/** Withdrawals to a payout method are held for a while after its payment
 * details are added or changed. Returns when the hold ends, or null when
 * there's no hold (hold turned off, or the method has no change date). */
export function payoutMethodHoldUntil(detailsChangedAt: Date | null | undefined, holdHours: number): Date | null {
  if (!detailsChangedAt || !Number.isFinite(holdHours) || holdHours <= 0) return null;
  return new Date(detailsChangedAt.getTime() + holdHours * 60 * 60 * 1000);
}

/** "9 Oct, 6:05 pm" in India time — what a creator reads in the error. */
export function formatHoldEnd(date: Date): string {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
