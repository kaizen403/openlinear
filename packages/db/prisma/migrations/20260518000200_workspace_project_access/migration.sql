-- Additive workspace + project access foundation for the hierarchy refactor.

DO $$
BEGIN
  CREATE TYPE "public"."workspace_roles" AS ENUM ('owner', 'admin', 'member', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "public"."project_permissions" AS ENUM ('full', 'view', 'deny');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "public"."workspaces" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "plan" TEXT NOT NULL DEFAULT 'free',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."workspace_members" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "public"."workspace_roles" NOT NULL DEFAULT 'member',
  "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "joinedAt" TIMESTAMP(3),

  CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."linear_projects"
  ADD COLUMN IF NOT EXISTS "workspaceId" TEXT,
  ADD COLUMN IF NOT EXISTS "key" TEXT;

CREATE TABLE IF NOT EXISTS "public"."project_access" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "permission" "public"."project_permissions" NOT NULL DEFAULT 'full',
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_key" ON "public"."workspaces"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspaceId_userId_key" ON "public"."workspace_members"("workspaceId", "userId");
CREATE INDEX IF NOT EXISTS "workspace_members_userId_idx" ON "public"."workspace_members"("userId");
CREATE INDEX IF NOT EXISTS "linear_projects_workspaceId_idx" ON "public"."linear_projects"("workspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS "linear_projects_workspaceId_key_key" ON "public"."linear_projects"("workspaceId", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "project_access_projectId_userId_key" ON "public"."project_access"("projectId", "userId");
CREATE INDEX IF NOT EXISTS "project_access_userId_idx" ON "public"."project_access"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_members_workspaceId_fkey'
  ) THEN
    ALTER TABLE "public"."workspace_members"
      ADD CONSTRAINT "workspace_members_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_members_userId_fkey'
  ) THEN
    ALTER TABLE "public"."workspace_members"
      ADD CONSTRAINT "workspace_members_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'linear_projects_workspaceId_fkey'
  ) THEN
    ALTER TABLE "public"."linear_projects"
      ADD CONSTRAINT "linear_projects_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "public"."workspaces"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'project_access_projectId_fkey'
  ) THEN
    ALTER TABLE "public"."project_access"
      ADD CONSTRAINT "project_access_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "public"."linear_projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint" WHERE "conname" = 'project_access_userId_fkey'
  ) THEN
    ALTER TABLE "public"."project_access"
      ADD CONSTRAINT "project_access_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

WITH user_slugs AS (
  SELECT
    "id",
    COALESCE(NULLIF("username", ''), 'User') AS "displayName",
    COALESCE(
      NULLIF(
        TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF("username", ''), "id")), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'workspace'
    ) AS "baseSlug"
  FROM "public"."users"
)
INSERT INTO "public"."workspaces" ("id", "name", "slug", "plan", "createdAt", "updatedAt")
SELECT
  'workspace-' || MD5("id"),
  "displayName" || '''s Workspace',
  "baseSlug" || '-' || SUBSTRING(MD5("id") FROM 1 FOR 8),
  'free',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM user_slugs
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "public"."workspace_members" ("id", "workspaceId", "userId", "role", "invitedAt", "joinedAt")
SELECT
  'workspace-member-' || MD5(w."id" || ':' || u."id"),
  w."id",
  u."id",
  'owner',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "public"."users" u
JOIN "public"."workspaces" w
  ON w."id" = 'workspace-' || MD5(u."id")
ON CONFLICT ("workspaceId", "userId") DO NOTHING;

INSERT INTO "public"."workspaces" ("id", "name", "slug", "plan", "createdAt", "updatedAt")
SELECT
  'workspace-system-default',
  'OpenLinear Workspace',
  'openlinear-workspace',
  'free',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "public"."linear_projects")
  AND NOT EXISTS (
    SELECT 1
    FROM "public"."workspaces"
    WHERE "id" = 'workspace-system-default'
  );

UPDATE "public"."linear_projects" p
SET "workspaceId" = (
  SELECT wm."workspaceId"
  FROM "public"."workspace_members" wm
  WHERE wm."userId" = p."leadId"
  ORDER BY wm."joinedAt" ASC NULLS LAST, wm."invitedAt" ASC, wm."id" ASC
  LIMIT 1
)
WHERE p."workspaceId" IS NULL
  AND p."leadId" IS NOT NULL;

UPDATE "public"."linear_projects" p
SET "workspaceId" = (
  SELECT wm."workspaceId"
  FROM "public"."project_teams" pt
  JOIN "public"."team_members" tm
    ON tm."teamId" = pt."teamId"
  JOIN "public"."workspace_members" wm
    ON wm."userId" = tm."userId"
  WHERE pt."projectId" = p."id"
  ORDER BY
    CASE tm."role"
      WHEN 'owner' THEN 1
      WHEN 'admin' THEN 2
      ELSE 3
    END,
    tm."createdAt" ASC,
    tm."id" ASC,
    wm."joinedAt" ASC NULLS LAST,
    wm."invitedAt" ASC,
    wm."id" ASC
  LIMIT 1
)
WHERE p."workspaceId" IS NULL;

UPDATE "public"."linear_projects" p
SET "workspaceId" = 'workspace-system-default'
WHERE p."workspaceId" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "public"."workspaces" w
    WHERE w."id" = 'workspace-system-default'
  );

DO $$
DECLARE
  project_row RECORD;
  clean_name TEXT;
  base_key TEXT;
  candidate_key TEXT;
  suffix INTEGER;
BEGIN
  FOR project_row IN
    SELECT "id", "workspaceId", "name"
    FROM "public"."linear_projects"
    WHERE "key" IS NULL
    ORDER BY "workspaceId" ASC NULLS LAST, "createdAt" ASC, "id" ASC
  LOOP
    clean_name := UPPER(REGEXP_REPLACE(project_row."name", '[^A-Za-z0-9]+', '', 'g'));
    IF clean_name IS NULL OR clean_name = '' THEN
      clean_name := 'PRJ';
    END IF;

    base_key := SUBSTRING(clean_name FROM 1 FOR 4);
    IF LENGTH(base_key) = 1 THEN
      base_key := base_key || 'X';
    END IF;

    candidate_key := base_key;
    suffix := 1;

    WHILE EXISTS (
      SELECT 1
      FROM "public"."linear_projects" p
      WHERE p."workspaceId" IS NOT DISTINCT FROM project_row."workspaceId"
        AND p."key" = candidate_key
        AND p."id" <> project_row."id"
    ) LOOP
      suffix := suffix + 1;
      candidate_key := SUBSTRING(base_key FROM 1 FOR GREATEST(1, 4 - LENGTH(suffix::TEXT))) || suffix::TEXT;
    END LOOP;

    UPDATE "public"."linear_projects"
    SET "key" = candidate_key
    WHERE "id" = project_row."id";
  END LOOP;
END $$;

INSERT INTO "public"."project_access" ("id", "projectId", "userId", "permission", "grantedAt")
SELECT
  'project-access-' || MD5(p."id" || ':' || wm."userId"),
  p."id",
  wm."userId",
  'full',
  CURRENT_TIMESTAMP
FROM "public"."linear_projects" p
JOIN "public"."workspace_members" wm
  ON wm."workspaceId" = p."workspaceId"
ON CONFLICT ("projectId", "userId") DO NOTHING;
