-- Hot-path indexes for workspace/project ACL checks.
CREATE INDEX IF NOT EXISTS "team_members_userId_idx" ON "team_members"("userId");
CREATE INDEX IF NOT EXISTS "tasks_projectId_archived_createdAt_idx" ON "tasks"("projectId", "archived", "createdAt");
