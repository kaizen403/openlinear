-- Step 1: Add nullable project_id column to teams
ALTER TABLE "teams" ADD COLUMN "project_id" TEXT;

-- Step 2: Backfill from project_teams (pick oldest project by created_at)
UPDATE "teams" SET "project_id" = (
  SELECT pt."projectId"
  FROM "project_teams" pt
  INNER JOIN "linear_projects" lp ON lp."id" = pt."projectId"
  WHERE pt."teamId" = "teams"."id"
  ORDER BY lp."createdAt" ASC
  LIMIT 1
);

-- Step 3: Delete orphan teams that have no project link
DELETE FROM "teams" WHERE "project_id" IS NULL;

-- Step 4: Make project_id NOT NULL
ALTER TABLE "teams" ALTER COLUMN "project_id" SET NOT NULL;

-- Step 5: Add foreign key constraint
ALTER TABLE "teams" ADD CONSTRAINT "teams_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 6: Drop the old global unique constraint on key
DROP INDEX IF EXISTS "teams_key_key";

-- Step 7: Create composite unique index (projectId, key)
CREATE UNIQUE INDEX "teams_project_id_key_key" ON "teams"("project_id", "key");

-- Step 8: Create index on project_id
CREATE INDEX "teams_project_id_idx" ON "teams"("project_id");

-- Step 9: Drop project_teams table
DROP TABLE "project_teams";
