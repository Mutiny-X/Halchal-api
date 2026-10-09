-- Manual withdrawal fulfilment: creators request a withdrawal, an admin exports
-- a payment sheet for the accounts team, and results are recorded back here.

-- AlterEnum
ALTER TYPE "AdminSection" ADD VALUE IF NOT EXISTS 'payouts';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'withdrawal_refund';

-- CreateTable
CREATE TABLE "withdrawal_batches" (
    "id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "total_net_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_batches_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "withdrawals"
    ADD COLUMN "payout_snapshot" JSONB,
    ADD COLUMN "batch_id" TEXT,
    ADD COLUMN "exported_at" TIMESTAMP(3),
    ADD COLUMN "utr" TEXT,
    ADD COLUMN "failure_reason" TEXT,
    ADD COLUMN "resolved_by_user_id" TEXT;

-- CreateIndex
CREATE INDEX "withdrawals_status_created_at_idx" ON "withdrawals"("status", "created_at");

-- CreateIndex
CREATE INDEX "withdrawals_batch_id_idx" ON "withdrawals"("batch_id");

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "withdrawal_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
