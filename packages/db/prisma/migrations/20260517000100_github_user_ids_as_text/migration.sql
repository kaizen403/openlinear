ALTER TABLE "users"
  ALTER COLUMN "githubId" TYPE TEXT
  USING "githubId"::TEXT;
