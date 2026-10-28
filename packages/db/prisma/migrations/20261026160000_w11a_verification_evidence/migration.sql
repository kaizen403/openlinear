-- W11a: "done means verified". Project verification settings and the
-- verification evidence each execution attempt records for the commit it
-- checked. See docs/reports/revamp-2026-10-26/verify.md.
--
-- Additive only: one nullable column without a default (a catalog-only change
-- in PostgreSQL, no table rewrite) and one new table.
--
-- migration-safety: allow
-- Reason: the CREATE [UNIQUE] INDEX statements below index the table created
-- in this same migration. It is empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- AlterTable
ALTER TABLE "linear_projects" ADD COLUMN "executionSettings" JSONB;

-- CreateTable
CREATE TABLE "execution_verifications" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "runId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "baseSha" TEXT,
    "checksHash" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "publication" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "runner" TEXT NOT NULL,
    "environment" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "detail" TEXT,
    "bodyHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_verifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "execution_verifications_commit_sha_check" CHECK ("commitSha" ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT "execution_verifications_base_sha_check" CHECK ("baseSha" IS NULL OR "baseSha" ~ '^[0-9a-f]{40,64}$'),
    CONSTRAINT "execution_verifications_checks_hash_check" CHECK ("checksHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "execution_verifications_body_hash_check" CHECK ("bodyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "execution_verifications_policy_check" CHECK ("policy" IN ('require-pass', 'warn', 'off')),
    CONSTRAINT "execution_verifications_status_check" CHECK ("status" IN ('passed', 'failed', 'error', 'skipped')),
    CONSTRAINT "execution_verifications_publication_check" CHECK ("publication" IN ('allowed', 'blocked')),
    CONSTRAINT "execution_verifications_source_check" CHECK ("source" IN ('project', 'repository', 'auto-detect', 'none')),
    -- Publication may only be blocked by require-pass, and require-pass only
    -- allows it after a pass (execution-core verificationPublicationDecision).
    CONSTRAINT "execution_verifications_publication_policy_check" CHECK (
        ("policy" = 'require-pass' AND ("publication" = 'allowed') = ("status" = 'passed'))
        OR ("policy" <> 'require-pass' AND "publication" = 'allowed')
    ),
    CONSTRAINT "execution_verifications_time_check" CHECK ("finishedAt" >= "startedAt")
);

-- CreateIndex
CREATE UNIQUE INDEX "execution_verifications_attemptId_commitSha_checksHash_key" ON "execution_verifications"("attemptId", "commitSha", "checksHash");

-- CreateIndex
CREATE INDEX "execution_verifications_taskId_createdAt_idx" ON "execution_verifications"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "execution_verifications" ADD CONSTRAINT "execution_verifications_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "execution_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
