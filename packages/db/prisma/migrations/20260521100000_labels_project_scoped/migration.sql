ALTER TABLE "labels" ADD COLUMN "projectId" TEXT;

UPDATE "labels" l
SET "projectId" = t."project_id"
FROM "teams" t
WHERE l."teamId" = t."id" AND t."project_id" IS NOT NULL;

DELETE FROM "labels" WHERE "projectId" IS NULL;

ALTER TABLE "labels" ALTER COLUMN "projectId" SET NOT NULL;

DROP INDEX IF EXISTS "labels_teamId_idx";
ALTER TABLE "labels" DROP CONSTRAINT IF EXISTS "labels_teamId_name_key";
ALTER TABLE "labels" DROP CONSTRAINT IF EXISTS "labels_teamId_fkey";
ALTER TABLE "labels" DROP COLUMN "teamId";

ALTER TABLE "labels" ADD CONSTRAINT "labels_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "labels_projectId_name_key" ON "labels"("projectId", "name");
CREATE INDEX "labels_projectId_idx" ON "labels"("projectId");
