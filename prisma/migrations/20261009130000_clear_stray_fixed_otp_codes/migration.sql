-- A per-account fixed OTP is a permanent login that bypasses WhatsApp. It is
-- only meant for the two reserved App Store / Play Store reviewer accounts
-- (see FixedOtpService.RESERVED_PHONES). Clear it from every other account so a
-- demo/seed value that ever reached real data can't be used to take it over.
UPDATE "users"
SET "fixed_otp_code" = NULL
WHERE "fixed_otp_code" IS NOT NULL
  AND ("phone" IS NULL OR "phone" NOT IN ('+919876543210', '+919876543211'));
