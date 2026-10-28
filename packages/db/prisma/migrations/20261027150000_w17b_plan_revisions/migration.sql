-- W17b: reviewable plans with immutable revisions; approving a revision
-- creates its tasks (plan_tasks maps plan keys to tasks). See
-- docs/reports/revamp-2026-10-26/plans.md.
--
-- Additive only: three new tables.
--
-- migration-safety: allow
-- Reason: the CREATE [UNIQUE] INDEX statements below index tables created in
-- this same migration. They are empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "latestRevision" INTEGER NOT NULL DEFAULT 1,
    "approvedRevision" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plans_status_check" CHECK ("status" IN ('draft', 'approved', 'archived')),
    CONSTRAINT "plans_revision_check" CHECK ("latestRevision" >= 1 AND ("approvedRevision" IS NULL OR ("approvedRevision" >= 1 AND "approvedRevision" <= "latestRevision"))),
    CONSTRAINT "plans_title_check" CHECK (char_length("title") BETWEEN 1 AND 200)
);

-- CreateTable
CREATE TABLE "plan_revisions" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "specHash" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,

    CONSTRAINT "plan_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_revisions_number_check" CHECK ("number" >= 1),
    CONSTRAINT "plan_revisions_spec_hash_check" CHECK ("specHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "plan_revisions_approval_check" CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL))
);

-- CreateTable
CREATE TABLE "plan_tasks" (
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_tasks_pkey" PRIMARY KEY ("planId","key"),
    CONSTRAINT "plan_tasks_key_check" CHECK ("key" ~ '^[A-Za-z0-9._-]{1,40}$')
);

-- CreateIndex
CREATE INDEX "plans_projectId_createdAt_idx" ON "plans"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "plan_revisions_planId_number_key" ON "plan_revisions"("planId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "plan_tasks_taskId_key" ON "plan_tasks"("taskId");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
