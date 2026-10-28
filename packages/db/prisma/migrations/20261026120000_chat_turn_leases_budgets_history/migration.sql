-- W18a / W15 (Home Chat, round 7 `chat2`): durable single-writer turn
-- leases, monthly chat budgets with reservations, turn completion state and
-- usage on stored messages, revocable confirmation codes, summarizing
-- compaction records.
-- See docs/reports/revamp-2026-10-26/chat2.md.
--
-- Expand-only and backward compatible:
--   * five columns on "chat_messages" and two on "chat_tool_confirmations",
--     all nullable or with a constant default (catalogue-only in PostgreSQL
--     11+, no table rewrite); the previous API version never reads them;
--   * six new tables;
--   * one CHECK on "chat_tool_confirmations" added NOT VALID, then validated
--     (the validation scan holds SHARE UPDATE EXCLUSIVE; writes continue).
-- Nothing is dropped, renamed or narrowed.
--
-- migration-safety: allow
-- Reason: every CREATE INDEX below indexes a table created in this same
-- migration. Those tables are empty and invisible to other sessions until the
-- migration commits, so a plain build takes no lock any running query can wait
-- on, and CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- Fail fast instead of queueing behind a long transaction on chat_messages.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "finishReason" TEXT,
ADD COLUMN     "incomplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "turnId" TEXT,
ADD COLUMN     "usage" JSONB;

-- AlterTable
ALTER TABLE "chat_tool_confirmations" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT;

-- A code is either redeemed or revoked, never both (both writes are also
-- conditional on the other column being NULL).
ALTER TABLE "chat_tool_confirmations"
    ADD CONSTRAINT "chat_tool_confirmations_consumed_or_revoked_check"
    CHECK ("consumedAt" IS NULL OR "revokedAt" IS NULL) NOT VALID;
ALTER TABLE "chat_tool_confirmations" VALIDATE CONSTRAINT "chat_tool_confirmations_consumed_or_revoked_check";

-- CreateTable
CREATE TABLE "chat_turn_leases" (
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "fence" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "chat_turn_leases_pkey" PRIMARY KEY ("sessionId"),
    -- Fencing token: starts at 1, bumped by every takeover.
    CONSTRAINT "chat_turn_leases_fence_check" CHECK ("fence" >= 1),
    CONSTRAINT "chat_turn_leases_expiry_check" CHECK ("expiresAt" > "renewedAt")
);

-- CreateTable
CREATE TABLE "chat_session_summaries" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "coveredMessages" INTEGER NOT NULL,
    "previousSummaryId" TEXT,
    "fromMessageId" TEXT,
    "throughMessageId" TEXT,
    "throughCreatedAt" TIMESTAMP(3),
    "sourceMessages" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "content" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "turnId" TEXT,
    "invocationId" TEXT,
    "inputChars" INTEGER NOT NULL,
    "outputChars" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_session_summaries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_session_summaries_status_check"
        CHECK ("status" IN ('succeeded', 'failed')),
    -- A stored summary exists exactly when the attempt succeeded.
    CONSTRAINT "chat_session_summaries_content_matches_status_check"
        CHECK (("status" = 'succeeded') = ("content" IS NOT NULL)),
    CONSTRAINT "chat_session_summaries_counts_check"
        CHECK ("coveredMessages" > 0 AND "sourceMessages" >= 0 AND "inputChars" >= 0 AND "outputChars" >= 0),
    CONSTRAINT "chat_session_summaries_source_hash_check"
        CHECK ("sourceHash" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "chat_workspace_budgets" (
    "workspaceId" TEXT NOT NULL,
    "monthlyUsdLimit" DECIMAL(12,6),
    "monthlyTokenLimit" INTEGER,
    "perUserMonthlyUsdLimit" DECIMAL(12,6),
    "perUserMonthlyTokenLimit" INTEGER,
    "unknownCostPolicy" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_workspace_budgets_pkey" PRIMARY KEY ("workspaceId"),
    CONSTRAINT "chat_workspace_budgets_limits_check"
        CHECK (COALESCE("monthlyUsdLimit", 0) >= 0 AND COALESCE("monthlyTokenLimit", 0) >= 0
               AND COALESCE("perUserMonthlyUsdLimit", 0) >= 0 AND COALESCE("perUserMonthlyTokenLimit", 0) >= 0),
    CONSTRAINT "chat_workspace_budgets_unknown_cost_policy_check"
        CHECK ("unknownCostPolicy" IS NULL OR "unknownCostPolicy" IN ('block', 'allow'))
);

-- CreateTable
CREATE TABLE "chat_member_budgets" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monthlyUsdLimit" DECIMAL(12,6),
    "monthlyTokenLimit" INTEGER,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_member_budgets_pkey" PRIMARY KEY ("workspaceId","userId"),
    CONSTRAINT "chat_member_budgets_limits_check"
        CHECK (COALESCE("monthlyUsdLimit", 0) >= 0 AND COALESCE("monthlyTokenLimit", 0) >= 0)
);

-- CreateTable
CREATE TABLE "chat_budget_reservations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "turnId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "reservedUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "consumedUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "consumedTokens" INTEGER NOT NULL DEFAULT 0,
    "unknownCostCalls" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stopCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "chat_budget_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_budget_reservations_status_check"
        CHECK ("status" IN ('active', 'settled', 'released')),
    CONSTRAINT "chat_budget_reservations_amounts_check"
        CHECK ("reservedUsd" >= 0 AND "reservedTokens" >= 0 AND "consumedUsd" >= 0
               AND "consumedTokens" >= 0 AND "unknownCostCalls" >= 0)
);

-- CreateIndex
CREATE INDEX "chat_session_summaries_sessionId_coveredMessages_idx" ON "chat_session_summaries"("sessionId", "coveredMessages");

-- CreateIndex
CREATE UNIQUE INDEX "chat_budget_reservations_turnId_key" ON "chat_budget_reservations"("turnId");

-- CreateIndex
CREATE INDEX "chat_budget_reservations_workspaceId_status_expiresAt_idx" ON "chat_budget_reservations"("workspaceId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "chat_turn_leases" ADD CONSTRAINT "chat_turn_leases_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_session_summaries" ADD CONSTRAINT "chat_session_summaries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_workspace_budgets" ADD CONSTRAINT "chat_workspace_budgets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_member_budgets" ADD CONSTRAINT "chat_member_budgets_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "workspace_members"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
