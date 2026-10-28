-- W17a: "blocked by" relations between tasks (the first edge of the plan
-- graph). See docs/reports/revamp-2026-10-26/deps.md.
--
-- Additive only: one new table.
--
-- migration-safety: allow
-- Reason: the CREATE [UNIQUE] INDEX statements below index the table created
-- in this same migration. It is empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- CreateTable
CREATE TABLE "task_dependencies" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_dependencies_not_self_check" CHECK ("taskId" <> "dependsOnTaskId")
);

-- CreateIndex
CREATE INDEX "task_dependencies_dependsOnTaskId_idx" ON "task_dependencies"("dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependencies_taskId_dependsOnTaskId_key" ON "task_dependencies"("taskId", "dependsOnTaskId");

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
