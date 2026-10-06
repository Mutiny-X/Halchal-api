-- Admin approval before brand/staff campaigns go live.
-- Additive only: a new enum value and four nullable columns. Existing rows
-- are untouched (no campaign is pending_review until someone submits one).
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'pending_review' BEFORE 'live';

ALTER TABLE "campaigns"
  ADD COLUMN "submitted_for_review_at" TIMESTAMP(3),
  ADD COLUMN "review_rejection_reason" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_by_user_id" TEXT;
