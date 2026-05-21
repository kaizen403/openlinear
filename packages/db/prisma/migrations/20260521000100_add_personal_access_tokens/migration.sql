CREATE TABLE IF NOT EXISTS "public"."personal_access_tokens" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_tokens_tokenHash_key"
  ON "public"."personal_access_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "personal_access_tokens_userId_idx"
  ON "public"."personal_access_tokens"("userId");

CREATE INDEX IF NOT EXISTS "personal_access_tokens_tokenHash_idx"
  ON "public"."personal_access_tokens"("tokenHash");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'personal_access_tokens_userId_fkey'
  ) THEN
    ALTER TABLE "public"."personal_access_tokens"
      ADD CONSTRAINT "personal_access_tokens_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
