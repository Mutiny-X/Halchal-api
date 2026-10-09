-- CreateTable
CREATE TABLE "login_lockouts" (
    "email" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL,
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "login_lockouts_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE INDEX "login_lockouts_window_start_idx" ON "login_lockouts"("window_start");
