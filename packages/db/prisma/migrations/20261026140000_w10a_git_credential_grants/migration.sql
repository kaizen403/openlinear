-- W10a: brokered git credentials per execution attempt (GitHub App
-- installation tokens, or the user-OAuth fallback). Audit record and
-- revocation ledger; see docs/reports/revamp-2026-10-26/creds.md.
--
-- Additive only: one new table. No existing table is altered, locked or
-- rewritten (the back-relation on execution_attempts in schema.prisma is
-- virtual; the foreign key below lives on the new table).
--
-- migration-safety: allow
-- Reason: the CREATE INDEX below indexes the table created in this same
-- migration. It is empty and invisible to other sessions until the migration
-- commits, so a plain build takes no lock any running query can wait on.
-- CREATE INDEX CONCURRENTLY cannot run inside the migration transaction.
-- This file contains no destructive DDL.

-- CreateTable
CREATE TABLE "execution_git_credentials" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repositoryFullName" TEXT,
    "installationId" TEXT,
    "permissions" JSONB,
    "fallbackReason" TEXT,
    "tokenHash" TEXT,
    "encryptedToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_git_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "execution_git_credentials_effect_check"
        CHECK ("effect" IN ('fetch', 'push', 'pull_request')),
    CONSTRAINT "execution_git_credentials_kind_check"
        CHECK ("kind" IN ('installation', 'user_oauth', 'none')),
    CONSTRAINT "execution_git_credentials_revocation_status_check"
        CHECK ("revocationStatus" IS NULL OR "revocationStatus" IN ('revoked', 'already_invalid', 'expired', 'failed')),
    -- Only a SHA-256 digest of an installation token is kept for correlation.
    CONSTRAINT "execution_git_credentials_token_hash_check"
        CHECK ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$'),
    -- Token material (encrypted) only ever exists for installation tokens: the
    -- user's OAuth token is never copied into this table.
    CONSTRAINT "execution_git_credentials_token_kind_check"
        CHECK ("kind" = 'installation' OR ("encryptedToken" IS NULL AND "tokenHash" IS NULL)),
    CONSTRAINT "execution_git_credentials_encrypted_token_format_check"
        CHECK ("encryptedToken" IS NULL OR "encryptedToken" LIKE 'enc:v1:%'),
    -- A revoked (or expired) grant keeps no token material.
    CONSTRAINT "execution_git_credentials_revoked_cleared_check"
        CHECK ("revokedAt" IS NULL OR "encryptedToken" IS NULL)
);

-- CreateIndex
CREATE INDEX "execution_git_credentials_attemptId_effect_idx" ON "execution_git_credentials"("attemptId", "effect");

-- AddForeignKey
ALTER TABLE "execution_git_credentials" ADD CONSTRAINT "execution_git_credentials_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "execution_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
