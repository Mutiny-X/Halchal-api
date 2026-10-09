import { z } from "zod";

export const UserRoleSchema = z.enum(["creator", "brand", "admin"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const KycStatusSchema = z.enum([
  "not_started",
  "pending",
  "verified",
  "rejected",
]);
export type KycStatus = z.infer<typeof KycStatusSchema>;

export const CampaignStatusSchema = z.enum([
  "draft",
  "live",
  "paused",
  "closed",
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignWizardStepSchema = z.enum([
  "basics",
  "brief",
  "payout",
  "review",
]);
export type CampaignWizardStep = z.infer<typeof CampaignWizardStepSchema>;

export const CampaignOwnershipSchema = z.enum([
  "brand_created",
  "admin_created",
]);
export type CampaignOwnership = z.infer<typeof CampaignOwnershipSchema>;

export const CampaignInviteStatusSchema = z.enum([
  "pending",
  "accepted",
  "expired",
  "revoked",
]);
export type CampaignInviteStatus = z.infer<typeof CampaignInviteStatusSchema>;

/** Server-owned submission state machine */
export const SubmissionStatusSchema = z.enum([
  "draft_submitted",
  "under_review",
  "approved",
  "awaiting_live_link",
  "live_tracking",
  "payout_pending",
  "paid",
  "rejected",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

export const TransactionTypeSchema = z.enum([
  "earning_credit",
  "withdrawal_debit",
  "fee_debit",
  "adjustment",
  "withdrawal_refund",
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const WithdrawalStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type WithdrawalStatus = z.infer<typeof WithdrawalStatusSchema>;

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "PUBLISH_BLOCKED_PENDING_INVITE",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.nullable(),
    error: ApiErrorSchema.nullable(),
  });

/** Money amounts are always integer paise (1 INR = 100 paise) */
export const MoneyPaiseSchema = z.number().int().nonnegative();

/** CPV rate: rupees per 1,000 eligible views (display as "₹50 / 1K views") */
export const CpvRateSchema = z.object({
  ratePer1kPaise: MoneyPaiseSchema,
  maxPayoutPaise: MoneyPaiseSchema,
});

export function computeEarningsPaise(
  eligibleViews: number,
  ratePer1kPaise: number,
): number {
  return Math.floor((eligibleViews / 1000) * ratePer1kPaise);
}

export function computeWithdrawalFeePaise(
  amountPaise: number,
  feeBps: number = 500,
): number {
  return Math.floor((amountPaise * feeBps) / 10000);
}
