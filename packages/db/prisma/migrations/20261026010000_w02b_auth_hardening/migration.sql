-- W02b: authorization follow-ups and auth-primitive hardening.
-- See docs/reports/revamp-2026-10-26/authz.md.
--
-- Expand-only. Existing tables only gain nullable columns (metadata-only in
-- PostgreSQL: no rewrite, no default, no index build) and one row trigger.
-- Two new tables are created empty. Nothing is dropped, renamed or narrowed.
--
-- migration-safety: allow
-- Reason: the three CREATE INDEX statements below index the tables created in
-- this same migration. They are empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on (CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction). No existing table gets an index. This file contains no
-- destructive DDL.

-- 1. SSE tickets remember the Session that minted them, so revoking that
--    session can invalidate the ticket and close the stream it opened.
ALTER TABLE "sse_tickets" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

-- 2. Refresh-token rotation marks the rotated session, so presenting a rotated
--    refresh token again is detected as reuse (family revocation).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);

-- 3. TOTP replay protection: highest accepted time step per user.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpLastUsedStep" INTEGER;

-- 4. Server-side SSO login state (opaque state, PKCE verifier and nonce never
--    travel in the authorization URL).
CREATE TABLE IF NOT EXISTS "sso_auth_states" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "browserBindingHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ssoConfigId" TEXT NOT NULL,
    "issuerUrl" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "codeVerifierEncrypted" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_auth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sso_auth_states_stateHash_key" ON "sso_auth_states"("stateHash");
CREATE INDEX IF NOT EXISTS "sso_auth_states_expiresAt_idx" ON "sso_auth_states"("expiresAt");

-- 5. Account-level security audit (account-wide PAT lifecycle, remediation,
--    refresh-token reuse). `audit_logs` requires a workspace and its rows
--    cascade with the workspace.
CREATE TABLE IF NOT EXISTS "account_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_audit_logs_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "account_audit_logs_userId_createdAt_idx" ON "account_audit_logs"("userId", "createdAt");

-- 6. Fail safe at the database level: `personal_access_tokens.workspaceId` is
--    ON DELETE SET NULL, and NULL means account-wide. Deleting a workspace by
--    any path other than the API route (which revokes first) used to widen
--    every token bound to it. This trigger revokes a token in the same
--    statement whenever its workspace binding goes from set to NULL,
--    including the UPDATE issued by the foreign key's SET NULL action.
CREATE OR REPLACE FUNCTION "openlinear_revoke_unbound_pat"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS NULL THEN
    NEW."revokedAt" := COALESCE(NEW."revokedAt", OLD."revokedAt", CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'personal_access_tokens_revoke_on_unbind'
      AND tgrelid = '"personal_access_tokens"'::regclass
  ) THEN
    CREATE TRIGGER "personal_access_tokens_revoke_on_unbind"
      BEFORE UPDATE OF "workspaceId" ON "personal_access_tokens"
      FOR EACH ROW
      WHEN (OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS NULL)
      EXECUTE FUNCTION "openlinear_revoke_unbound_pat"();
  END IF;
END $$;
