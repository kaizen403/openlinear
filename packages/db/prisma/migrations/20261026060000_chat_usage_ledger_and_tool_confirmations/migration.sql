-- W15 / W18a (Home Chat): model usage ledger, destructive-tool confirmations
-- and per-turn tool-call journal identity.
-- See docs/reports/revamp-2026-10-26/ai.md.
--
-- Additive only: three nullable columns on "chat_tool_calls" (no default, so
-- Postgres records them in the catalogue without rewriting the table) and two
-- new tables. Nothing is dropped, renamed or narrowed.
--
-- migration-safety: allow
-- Reason: every CREATE INDEX below indexes a table created in this same
-- migration. Those tables are empty and invisible to other sessions until the
-- migration commits, so a plain build takes no lock any running query can wait
-- on, and CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- AlterTable
ALTER TABLE "chat_tool_calls" ADD COLUMN     "effect" TEXT,
ADD COLUMN     "providerToolCallId" TEXT,
ADD COLUMN     "turnId" TEXT;

-- CreateTable
CREATE TABLE "chat_tool_confirmations" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "toolName" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "selection" JSONB NOT NULL,
    "issuedTurnId" TEXT,
    "issuedToolCallId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedTurnId" TEXT,
    "consumedToolCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tool_confirmations_pkey" PRIMARY KEY ("id"),
    -- Only SHA-256 digests are stored, never the code the user types.
    CONSTRAINT "chat_tool_confirmations_code_hash_check"
        CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "chat_tool_confirmations_binding_hash_check"
        CHECK ("bindingHash" ~ '^[0-9a-f]{64}$'),
    -- Short-lived by construction (the API issues 10-minute codes).
    CONSTRAINT "chat_tool_confirmations_expiry_check"
        CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '1 hour')
);

-- CreateTable
CREATE TABLE "model_usage" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "userId" TEXT,
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "turnId" TEXT,
    "round" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "finishReason" TEXT,
    "errorCode" TEXT,
    "usageReported" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "latencyMs" INTEGER,
    "firstTokenMs" INTEGER,
    "costUsd" DECIMAL(12,6),
    "costBasis" TEXT NOT NULL,
    "pricingRevision" TEXT,
    "promptHash" TEXT,
    "toolsHash" TEXT,
    "providerRequestId" TEXT,
    "rawUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_usage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "model_usage_cost_basis_check"
        CHECK ("costBasis" IN ('provider_reported', 'estimated', 'unknown')),
    -- An unknown cost is NULL, never zero; a known cost is always present.
    CONSTRAINT "model_usage_cost_matches_basis_check"
        CHECK (("costBasis" = 'unknown') = ("costUsd" IS NULL)),
    CONSTRAINT "model_usage_cost_nonnegative_check"
        CHECK ("costUsd" IS NULL OR "costUsd" >= 0),
    CONSTRAINT "model_usage_tokens_nonnegative_check"
        CHECK (COALESCE("inputTokens", 0) >= 0 AND COALESCE("outputTokens", 0) >= 0
               AND COALESCE("cacheReadTokens", 0) >= 0 AND COALESCE("cacheWriteTokens", 0) >= 0
               AND COALESCE("reasoningTokens", 0) >= 0),
    CONSTRAINT "model_usage_status_check"
        CHECK ("status" IN ('succeeded', 'failed', 'aborted')),
    -- Bounded raw receipt (the API truncates provider usage objects to 2 KiB).
    CONSTRAINT "model_usage_raw_usage_size_check"
        CHECK ("rawUsage" IS NULL OR octet_length("rawUsage"::text) <= 4096)
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_tool_confirmations_codeHash_key" ON "chat_tool_confirmations"("codeHash");

-- CreateIndex
CREATE INDEX "chat_tool_confirmations_sessionId_createdAt_idx" ON "chat_tool_confirmations"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_tool_confirmations_expiresAt_idx" ON "chat_tool_confirmations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "model_usage_invocationId_key" ON "model_usage"("invocationId");

-- CreateIndex
CREATE INDEX "model_usage_userId_createdAt_idx" ON "model_usage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "model_usage_workspaceId_createdAt_idx" ON "model_usage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "model_usage_sessionId_createdAt_idx" ON "model_usage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_tool_confirmations" ADD CONSTRAINT "chat_tool_confirmations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
