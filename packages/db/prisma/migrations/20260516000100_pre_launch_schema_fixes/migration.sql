-- Add Settings.userId, matching the Prisma schema used by settings routes.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "userId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "settings_userId_key" ON "settings"("userId");

ALTER TABLE "settings"
  ADD CONSTRAINT "settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill missing Notification foreign keys so task/comment deletion cannot
-- leave dangling notification references.
DELETE FROM "notifications"
WHERE "taskId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "tasks" WHERE "tasks"."id" = "notifications"."taskId"
  );

DELETE FROM "notifications"
WHERE "commentId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "comments" WHERE "comments"."id" = "notifications"."commentId"
  );

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
