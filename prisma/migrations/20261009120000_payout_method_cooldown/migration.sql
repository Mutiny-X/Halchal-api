-- When a payout method's payment details last changed. Withdrawals to a method
-- are held for PAYOUT_METHOD_COOLDOWN_HOURS after this (see PayoutsService).
ALTER TABLE "payout_methods" ADD COLUMN "details_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing methods were set up before the hold existed: date them from when
-- they were created so nobody is suddenly locked out of a long-standing account.
UPDATE "payout_methods" SET "details_changed_at" = "created_at";
