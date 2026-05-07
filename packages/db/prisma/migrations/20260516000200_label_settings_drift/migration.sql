-- Bring older databases in line with the current Label and Settings schema.
ALTER TABLE "labels" ADD COLUMN IF NOT EXISTS "teamId" TEXT;

DROP INDEX IF EXISTS "labels_name_key";

CREATE INDEX IF NOT EXISTS "labels_teamId_idx" ON "labels"("teamId");
CREATE UNIQUE INDEX IF NOT EXISTS "labels_teamId_name_key" ON "labels"("teamId", "name");

ALTER TABLE "labels"
  ADD CONSTRAINT "labels_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings" ALTER COLUMN "id" DROP DEFAULT;
