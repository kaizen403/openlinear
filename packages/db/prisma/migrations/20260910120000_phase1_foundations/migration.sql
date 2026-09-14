-- Phase 1 foundations: drop unused Role, identity/tickets/idempotency,
-- PAT workspace binding, SSE tickets, session refresh, attachment scan fields,
-- denormalised Task.workspaceId, and the global Repository.userId IS NULL namespace.
-- migration-safety: allow
-- Intentional destructive DDL: unused Role/Permission tables and roleId columns,
-- plus deletion of orphan Repository rows with userId IS NULL.

-- Role / Permission (unused after CASL removal)
ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_roleId_fkey";
ALTER TABLE "team_members" DROP CONSTRAINT IF EXISTS "team_members_roleId_fkey";
ALTER TABLE "project_access" DROP CONSTRAINT IF EXISTS "project_access_roleId_fkey";
DROP INDEX IF EXISTS "workspace_members_roleId_idx";
DROP INDEX IF EXISTS "team_members_roleId_idx";
DROP INDEX IF EXISTS "project_access_roleId_idx";
ALTER TABLE "workspace_members" DROP COLUMN IF EXISTS "roleId";
ALTER TABLE "team_members" DROP COLUMN IF EXISTS "roleId";
ALTER TABLE "project_access" DROP COLUMN IF EXISTS "roleId";
DROP TABLE IF EXISTS "roles";
DROP TYPE IF EXISTS "permissions";

-- Task.workspaceId (denormalised; backfill from project)
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;
UPDATE "tasks" AS t
SET "workspaceId" = p."workspaceId"
FROM "linear_projects" AS p
WHERE t."projectId" = p."id" AND t."workspaceId" IS NULL;
UPDATE "tasks" AS t
SET "projectId" = tm.project_id
FROM "teams" AS tm
WHERE t."teamId" = tm."id"
  AND t."projectId" IS NULL
  AND tm.project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "tasks_workspaceId_idx" ON "tasks"("workspaceId");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_workspaceId_fkey'
  ) THEN
    ALTER TABLE "tasks"
      ADD CONSTRAINT "tasks_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- PAT workspace binding
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personal_access_tokens_workspaceId_fkey'
  ) THEN
    ALTER TABLE "personal_access_tokens"
      ADD CONSTRAINT "personal_access_tokens_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "personal_access_tokens_workspaceId_idx" ON "personal_access_tokens"("workspaceId");

-- SSO domain verification
ALTER TABLE "sso_configs" ADD COLUMN IF NOT EXISTS "domainVerifiedAt" TIMESTAMP(3);
ALTER TABLE "sso_configs" ADD COLUMN IF NOT EXISTS "verificationToken" TEXT;

-- Session refresh
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "refreshTokenHash" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "familyId" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- Chat attachments (Blob-ready metadata)
ALTER TABLE "chat_attachments" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "chat_attachments" ADD COLUMN IF NOT EXISTS "checksumSha256" TEXT;
ALTER TABLE "chat_attachments" ADD COLUMN IF NOT EXISTS "scanStatus" TEXT NOT NULL DEFAULT 'pending';

-- Per-row encryption key version
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1;

-- Remove the global repository namespace (F-011 / F-018)
UPDATE "linear_projects" SET "repositoryId" = NULL
WHERE "repositoryId" IN (SELECT "id" FROM "repositories" WHERE "userId" IS NULL);
DELETE FROM "repositories" WHERE "userId" IS NULL;
ALTER TABLE "repositories" ALTER COLUMN "userId" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "identities_issuer_subject_key" ON "identities"("issuer", "subject");
CREATE INDEX IF NOT EXISTS "identities_userId_idx" ON "identities"("userId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identities_userId_fkey') THEN
    ALTER TABLE "identities"
      ADD CONSTRAINT "identities_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "two_factor_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "two_factor_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "two_factor_challenges_tokenHash_key" ON "two_factor_challenges"("tokenHash");
CREATE INDEX IF NOT EXISTS "two_factor_challenges_userId_expiresAt_idx" ON "two_factor_challenges"("userId", "expiresAt");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'two_factor_challenges_userId_fkey') THEN
    ALTER TABLE "two_factor_challenges"
      ADD CONSTRAINT "two_factor_challenges_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "email_change_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_change_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_change_requests_tokenHash_key" ON "email_change_requests"("tokenHash");
CREATE INDEX IF NOT EXISTS "email_change_requests_userId_idx" ON "email_change_requests"("userId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_change_requests_userId_fkey') THEN
    ALTER TABLE "email_change_requests"
      ADD CONSTRAINT "email_change_requests_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "sse_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sse_tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "sse_tickets_tokenHash_key" ON "sse_tickets"("tokenHash");
CREATE INDEX IF NOT EXISTS "sse_tickets_userId_expiresAt_idx" ON "sse_tickets"("userId", "expiresAt");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sse_tickets_userId_fkey') THEN
    ALTER TABLE "sse_tickets"
      ADD CONSTRAINT "sse_tickets_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "routeKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_userId_routeKey_key_key" ON "idempotency_keys"("userId", "routeKey", "key");
CREATE INDEX IF NOT EXISTS "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");
