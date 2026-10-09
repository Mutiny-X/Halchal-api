-- CreateTable
CREATE TABLE "youtube_oauth_transactions" (
    "id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "creator_profile_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_oauth_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "youtube_oauth_transactions_state_hash_key" ON "youtube_oauth_transactions"("state_hash");

-- CreateIndex
CREATE INDEX "youtube_oauth_transactions_user_id_idx" ON "youtube_oauth_transactions"("user_id");

-- CreateIndex
CREATE INDEX "youtube_oauth_transactions_creator_profile_id_idx" ON "youtube_oauth_transactions"("creator_profile_id");

-- CreateIndex
CREATE INDEX "youtube_oauth_transactions_expires_at_idx" ON "youtube_oauth_transactions"("expires_at");

-- AddForeignKey
ALTER TABLE "youtube_oauth_transactions" ADD CONSTRAINT "youtube_oauth_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_oauth_transactions" ADD CONSTRAINT "youtube_oauth_transactions_creator_profile_id_fkey" FOREIGN KEY ("creator_profile_id") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
