-- New campaigns start with auto-verification off. Existing campaigns keep
-- whatever they are set to now.
ALTER TABLE "campaigns" ALTER COLUMN "auto_review_enabled" SET DEFAULT false;
