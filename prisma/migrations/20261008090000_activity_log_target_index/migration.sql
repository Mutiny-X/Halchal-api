-- Looking up "who reviewed this clip" reads the activity log by its target.
CREATE INDEX "activity_logs_target_type_target_id_idx" ON "activity_logs"("target_type", "target_id");
