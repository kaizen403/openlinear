-- FE-04: per-user approval mode for agent permission requests. Additive:
-- a column with a constant default is a catalog-only change in PostgreSQL 11+.

-- AlterTable
ALTER TABLE "settings" ADD COLUMN "approvalMode" TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE "settings" ADD CONSTRAINT "settings_approval_mode_check" CHECK ("approvalMode" IN ('auto', 'ask'));
