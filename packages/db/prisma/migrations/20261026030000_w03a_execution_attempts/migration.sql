-- W03a: execution attempts and run-scoped capabilities for the API-only sidecar.
-- See docs/reports/revamp-2026-10-26/sidecar.md.
--
-- Additive only: one new enum and two new tables. No existing table is altered,
-- locked or rewritten. The back-relations added to Task/User/AgentRun in
-- schema.prisma are virtual (no column on those tables).
--
-- migration-safety: allow
-- Reason: every CREATE INDEX below indexes a table created in this same
-- migration. The tables are empty and invisible to other sessions until the
-- migration commits, so a plain build takes no lock any running query can wait
-- on. CREATE INDEX CONCURRENTLY cannot run inside the migration transaction.
-- This file contains no destructive DDL.

-- CreateEnum
CREATE TYPE "execution_attempt_statuses" AS ENUM ('preparing', 'running', 'finishing', 'closed', 'released');

-- CreateTable
CREATE TABLE "execution_attempts" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "execution_attempt_statuses" NOT NULL DEFAULT 'preparing',
    "authSource" TEXT NOT NULL,
    "credentialId" TEXT,
    "workspaceRestriction" TEXT,
    "projectId" TEXT,
    "teamId" TEXT,
    "creatorId" TEXT,
    "workspaceId" TEXT,
    "repositoryId" TEXT,
    "repositoryFullName" TEXT,
    "runner" TEXT,
    "model" TEXT,
    "snapshot" JSONB NOT NULL,
    "sessionId" TEXT,
    "agentRunId" TEXT,
    "terminalStatus" "Status",
    "lastEventSeq" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelAcknowledgedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "execution_attempts_auth_source_check"
        CHECK ("authSource" IN ('session', 'pat')),
    CONSTRAINT "execution_attempts_last_event_seq_check"
        CHECK ("lastEventSeq" >= 0),
    -- Only the two legacy terminal projections can be recorded.
    CONSTRAINT "execution_attempts_terminal_status_check"
        CHECK ("terminalStatus" IS NULL OR "terminalStatus" IN ('done', 'cancelled')),
    -- A preparing attempt has not touched the task row.
    CONSTRAINT "execution_attempts_preparing_unclaimed_check"
        CHECK ("status" <> 'preparing' OR ("claimedAt" IS NULL AND "sessionId" IS NULL AND "agentRunId" IS NULL))
);

-- CreateTable
CREATE TABLE "execution_capabilities" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_capabilities_pkey" PRIMARY KEY ("id"),
    -- Only a SHA-256 digest of the token is ever stored.
    CONSTRAINT "execution_capabilities_token_hash_check"
        CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "execution_attempts_agentRunId_key" ON "execution_attempts"("agentRunId");

-- CreateIndex
CREATE INDEX "execution_attempts_taskId_createdAt_idx" ON "execution_attempts"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "execution_attempts_userId_createdAt_idx" ON "execution_attempts"("userId", "createdAt");

-- CreateIndex (lease/heartbeat sweep for lost sidecars; see the ledger)
CREATE INDEX "execution_attempts_status_heartbeatAt_idx" ON "execution_attempts"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "execution_capabilities_tokenHash_key" ON "execution_capabilities"("tokenHash");

-- CreateIndex
CREATE INDEX "execution_capabilities_attemptId_idx" ON "execution_capabilities"("attemptId");

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_capabilities" ADD CONSTRAINT "execution_capabilities_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "execution_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
