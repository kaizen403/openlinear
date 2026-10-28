-- W05a/W06a: attempt leases for the durable run engine.
-- See docs/reports/revamp-2026-10-26/runengine.md.
--
-- Expand-only and backward compatible:
--   * four nullable / constant-default columns on `execution_attempts`
--     (metadata-only in PostgreSQL 11+, no table rewrite);
--   * two CHECK constraints added NOT VALID and then validated, so the
--     validation scan holds only SHARE UPDATE EXCLUSIVE (writes continue).
-- The control-plane sweeper reads the existing (status, heartbeatAt) index.
-- No CREATE INDEX, no destructive DDL. The previous API version never reads
-- or writes these columns.

-- Fail fast instead of queueing behind a long transaction on execution_attempts.
SET LOCAL lock_timeout = '5s';

-- recoveryState: set by the lease sweeper when a sidecar stopped heartbeating.
--   recovery_required — the attempt had claimed the task (work may exist on
--                       the device); the task was released for a retry.
--   abandoned         — nothing to recover (unclaimed, or the task already
--                       belonged to a replacement attempt).
-- sweptAt: when the sweeper fenced the attempt.
-- renewedAt / renewals: capability rotation for long runs.
ALTER TABLE "execution_attempts"
    ADD COLUMN "recoveryState" TEXT,
    ADD COLUMN "sweptAt" TIMESTAMP(3),
    ADD COLUMN "renewedAt" TIMESTAMP(3),
    ADD COLUMN "renewals" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "execution_attempts"
    ADD CONSTRAINT "execution_attempts_recovery_state_check"
    CHECK ("recoveryState" IS NULL OR "recoveryState" IN ('recovery_required', 'abandoned')) NOT VALID;
ALTER TABLE "execution_attempts" VALIDATE CONSTRAINT "execution_attempts_recovery_state_check";

ALTER TABLE "execution_attempts"
    ADD CONSTRAINT "execution_attempts_renewals_check"
    CHECK ("renewals" >= 0) NOT VALID;
ALTER TABLE "execution_attempts" VALIDATE CONSTRAINT "execution_attempts_renewals_check";
