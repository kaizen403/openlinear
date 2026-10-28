-- W04a: request-hash idempotency records.
-- See docs/reports/backend-review-2026-10-15/w04a-implementation.md.
--
-- Additive only: one new enum and one new table. No existing table is altered,
-- locked or rewritten; the legacy "idempotency_keys" cache stays in place for
-- the project/team/workspace routes that still use it.
--
-- migration-safety: allow
-- Reason: the two CREATE INDEX statements below index the table created in this
-- same migration. It is empty and invisible to other sessions until the
-- migration commits, so a plain build takes no lock that any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

CREATE TYPE "IdempotencyState" AS ENUM ('in_progress', 'completed');

CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'in_progress',
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
    -- Mirrors the API header contract (apps/api/src/schemas/idempotency.ts).
    CONSTRAINT "idempotency_records_key_check"
        CHECK (char_length("key") BETWEEN 8 AND 128),
    CONSTRAINT "idempotency_records_request_hash_check"
        CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    -- A completed record always carries the response it replays.
    CONSTRAINT "idempotency_records_completed_response_check"
        CHECK ("state" <> 'completed'
               OR ("responseStatus" IS NOT NULL
                   AND "responseBody" IS NOT NULL
                   AND "completedAt" IS NOT NULL)),
    -- Bounded retention: stored responses are at most 2 MiB.
    CONSTRAINT "idempotency_records_response_size_check"
        CHECK ("responseBody" IS NULL OR octet_length("responseBody") <= 2097152)
);

-- Scope: one record per principal, workspace, operation kind and client key.
CREATE UNIQUE INDEX "idempotency_records_principalId_workspaceId_operation_key_key"
    ON "idempotency_records"("principalId", "workspaceId", "operation", "key");

-- Retention sweep (pruneIdempotencyRecords).
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");
