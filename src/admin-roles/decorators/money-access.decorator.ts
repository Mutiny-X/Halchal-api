import { SetMetadata } from "@nestjs/common";

export const MONEY_ACCESS_KEY = "requireMoneyAccess";

/** Marks a route that shows full bank details or moves money, so
 * MoneyAccessGuard requires the admin's role to have canSeeMoney. Super
 * Admins always pass. Stacks with @AdminSectionRoute: the section decides
 * whether the admin may use the screen at all, this decides whether they
 * may see or handle money on it. */
export const RequireMoneyAccess = () => SetMetadata(MONEY_ACCESS_KEY, true);
