-- FE-14 / W20: outbound webhooks. A project or workspace admin registers an
-- HTTPS endpoint and picks event types; a fan-out job turns committed domain
-- events (stream order, `webhook_fanout_cursor`) into deliveries, unique per
-- (endpoint, event), and a worker POSTs them signed, with retries. See
-- docs/reports/revamp-2026-10-26/webhooks.md.
--
-- Additive only: three new tables (the cursor starts at the current stream
-- head, so events from before this migration are never delivered).
--
-- migration-safety: allow
-- Reason: the CREATE [UNIQUE] INDEX statements below index tables created in
-- this same migration. They are empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secretEncrypted" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "previousSecretEncrypted" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    -- Exactly one owner scope.
    CONSTRAINT "webhook_endpoints_scope_check" CHECK (
        ("scope" = 'project' AND "projectId" IS NOT NULL AND "workspaceId" IS NULL)
        OR ("scope" = 'workspace' AND "workspaceId" IS NOT NULL AND "projectId" IS NULL)
    ),
    -- HTTPS only outside tests; the full SSRF rules are enforced in the API.
    CONSTRAINT "webhook_endpoints_url_check" CHECK (char_length("url") BETWEEN 9 AND 2048 AND "url" ~ '^https?://'),
    CONSTRAINT "webhook_endpoints_description_check" CHECK ("description" IS NULL OR char_length("description") <= 200),
    CONSTRAINT "webhook_endpoints_event_types_check" CHECK (cardinality("eventTypes") BETWEEN 1 AND 20),
    -- The secret is never stored in clear: AES-256-GCM `enc:v1:` envelopes only.
    CONSTRAINT "webhook_endpoints_secret_check" CHECK ("secretEncrypted" LIKE 'enc:v1:%' AND char_length("secretPrefix") BETWEEN 1 AND 32),
    CONSTRAINT "webhook_endpoints_previous_secret_check" CHECK (
        ("previousSecretEncrypted" IS NULL) = ("previousSecretExpiresAt" IS NULL)
        AND ("previousSecretEncrypted" IS NULL OR "previousSecretEncrypted" LIKE 'enc:v1:%')
    ),
    -- Active exactly when not disabled; a disabled endpoint says why.
    CONSTRAINT "webhook_endpoints_disabled_check" CHECK (
        "active" = ("disabledAt" IS NULL)
        AND ("disabledAt" IS NULL) = ("disabledReason" IS NULL)
        AND ("disabledReason" IS NULL OR "disabledReason" IN ('manual', 'consecutive_failures', 'owner_lost_access'))
    ),
    CONSTRAINT "webhook_endpoints_failures_check" CHECK ("consecutiveFailures" >= 0)
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastResponseExcerpt" TEXT,
    "lastError" TEXT,
    "lastDurationMs" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "redeliveries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'abandoned')),
    -- Due exactly while pending; a success records when.
    CONSTRAINT "webhook_deliveries_schedule_check" CHECK (
        ("status" = 'pending') = ("nextAttemptAt" IS NOT NULL)
        AND ("status" <> 'succeeded' OR "deliveredAt" IS NOT NULL)
    ),
    CONSTRAINT "webhook_deliveries_lease_check" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
    CONSTRAINT "webhook_deliveries_counts_check" CHECK ("attempts" BETWEEN 0 AND 1000 AND "redeliveries" >= 0),
    CONSTRAINT "webhook_deliveries_event_check" CHECK (char_length("eventId") BETWEEN 1 AND 200 AND char_length("eventType") BETWEEN 1 AND 64),
    -- Bounded snapshot and response details.
    CONSTRAINT "webhook_deliveries_payload_check" CHECK (octet_length("payload") <= 65536),
    CONSTRAINT "webhook_deliveries_response_check" CHECK (
        ("lastResponseExcerpt" IS NULL OR char_length("lastResponseExcerpt") <= 1024)
        AND ("lastError" IS NULL OR char_length("lastError") <= 500)
        AND ("lastStatusCode" IS NULL OR "lastStatusCode" BETWEEN 100 AND 599)
    )
);

-- CreateTable
CREATE TABLE "webhook_fanout_cursor" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "last_event_id" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_fanout_cursor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_fanout_cursor_single_row_check" CHECK ("id" = 1)
);

-- Start at the current stream head: nothing that happened before webhooks
-- existed is delivered.
INSERT INTO "webhook_fanout_cursor" ("id", "last_event_id", "updated_at")
SELECT 1, COALESCE(MAX("id"), 0), (now() AT TIME ZONE 'UTC') FROM "domain_events";

-- CreateIndex
CREATE INDEX "webhook_endpoints_projectId_createdAt_idx" ON "webhook_endpoints"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_endpoints_workspaceId_createdAt_idx" ON "webhook_endpoints"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_createdAt_id_idx" ON "webhook_deliveries"("endpointId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpointId_eventId_key" ON "webhook_deliveries"("endpointId", "eventId");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
