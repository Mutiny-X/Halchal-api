"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CpvRateSchema = exports.MoneyPaiseSchema = exports.ApiEnvelopeSchema = exports.ApiErrorSchema = exports.ApiErrorCodeSchema = exports.WithdrawalStatusSchema = exports.TransactionTypeSchema = exports.SubmissionStatusSchema = exports.CampaignStatusSchema = exports.KycStatusSchema = exports.UserRoleSchema = void 0;
exports.computeEarningsPaise = computeEarningsPaise;
exports.computeWithdrawalFeePaise = computeWithdrawalFeePaise;
const zod_1 = require("zod");
exports.UserRoleSchema = zod_1.z.enum(["creator", "brand", "admin"]);
exports.KycStatusSchema = zod_1.z.enum([
    "not_started",
    "pending",
    "verified",
    "rejected",
]);
exports.CampaignStatusSchema = zod_1.z.enum([
    "draft",
    "live",
    "paused",
    "closed",
]);
/** Server-owned submission state machine */
exports.SubmissionStatusSchema = zod_1.z.enum([
    "draft_submitted",
    "under_review",
    "approved",
    "awaiting_live_link",
    "live_tracking",
    "payout_pending",
    "paid",
    "rejected",
]);
exports.TransactionTypeSchema = zod_1.z.enum([
    "earning_credit",
    "withdrawal_debit",
    "fee_debit",
    "adjustment",
    "withdrawal_refund",
]);
exports.WithdrawalStatusSchema = zod_1.z.enum([
    "pending",
    "processing",
    "completed",
    "failed",
]);
exports.ApiErrorCodeSchema = zod_1.z.enum([
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
]);
exports.ApiErrorSchema = zod_1.z.object({
    code: exports.ApiErrorCodeSchema,
    message: zod_1.z.string(),
    details: zod_1.z.record(zod_1.z.unknown()).optional(),
});
const ApiEnvelopeSchema = (dataSchema) => zod_1.z.object({
    success: zod_1.z.boolean(),
    data: dataSchema.nullable(),
    error: exports.ApiErrorSchema.nullable(),
});
exports.ApiEnvelopeSchema = ApiEnvelopeSchema;
/** Money amounts are always integer paise (1 INR = 100 paise) */
exports.MoneyPaiseSchema = zod_1.z.number().int().nonnegative();
/** CPV rate: rupees per 1,000 eligible views (display as "₹50 / 1K views") */
exports.CpvRateSchema = zod_1.z.object({
    ratePer1kPaise: exports.MoneyPaiseSchema,
    maxPayoutPaise: exports.MoneyPaiseSchema,
});
function computeEarningsPaise(eligibleViews, ratePer1kPaise) {
    return Math.floor((eligibleViews / 1000) * ratePer1kPaise);
}
function computeWithdrawalFeePaise(amountPaise, feeBps = 500) {
    return Math.floor((amountPaise * feeBps) / 10000);
}
//# sourceMappingURL=index.js.map