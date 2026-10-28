-- Desktop sign-in exchange codes.
-- See docs/reports/revamp-2026-10-26/desk.md.
--
-- The cloud API completes GitHub OAuth in the system browser and hands the
-- desktop app a short-lived, single-use code through the openlinear:// deep
-- link. The app redeems it with its PKCE verifier (RFC 7636, S256) and gets
-- tokens in the response body, so no token ever travels in a URL.
--
-- Additive only: one new table. No existing table is altered, locked or
-- rewritten.
--
-- migration-safety: allow
-- Reason: the CREATE INDEX statements below index the table created in this
-- same migration. It is empty and invisible to other sessions until the
-- migration commits, so a plain build takes no lock that any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

CREATE TABLE "desktop_auth_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_auth_codes_pkey" PRIMARY KEY ("id"),
    -- SHA-256 hex of the code; the code itself is never stored.
    CONSTRAINT "desktop_auth_codes_code_hash_check"
        CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
    -- base64url(SHA-256(verifier)) without padding is exactly 43 characters.
    CONSTRAINT "desktop_auth_codes_code_challenge_check"
        CHECK ("codeChallenge" ~ '^[A-Za-z0-9_-]{43}$')
);

-- Redemption looks the code up by hash.
CREATE UNIQUE INDEX "desktop_auth_codes_codeHash_key" ON "desktop_auth_codes"("codeHash");

-- ON DELETE CASCADE from users.
CREATE INDEX "desktop_auth_codes_userId_idx" ON "desktop_auth_codes"("userId");

-- Retention sweep of expired codes.
CREATE INDEX "desktop_auth_codes_expiresAt_idx" ON "desktop_auth_codes"("expiresAt");

ALTER TABLE "desktop_auth_codes" ADD CONSTRAINT "desktop_auth_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
