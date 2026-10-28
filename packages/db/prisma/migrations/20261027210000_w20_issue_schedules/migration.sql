-- W20 / FE-14: recurring issues. A schedule creates one issue per slot
-- (cadence + local time in an IANA time zone); occurrences are unique per
-- (schedule, slot), which makes creation idempotent across job workers and
-- "run now". See docs/reports/revamp-2026-10-26/schedules.md.
--
-- Additive only: two new tables.
--
-- migration-safety: allow
-- Reason: the CREATE [UNIQUE] INDEX statements below index tables created in
-- this same migration. They are empty and invisible to other sessions until
-- the migration commits, so a plain build takes no lock any running query can
-- wait on. CREATE INDEX CONCURRENTLY cannot run inside the migration
-- transaction. This file contains no destructive DDL.

-- CreateTable
CREATE TABLE "issue_schedules" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "labelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigneeId" TEXT,
    "cadence" TEXT NOT NULL,
    "weekday" INTEGER,
    "dayOfMonth" INTEGER,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_schedules_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "issue_schedules_description_check" CHECK ("description" IS NULL OR char_length("description") <= 10000),
    CONSTRAINT "issue_schedules_label_ids_check" CHECK (cardinality("labelIds") <= 20),
    CONSTRAINT "issue_schedules_cadence_check" CHECK ("cadence" IN ('daily', 'weekdays', 'weekly', 'monthly')),
    CONSTRAINT "issue_schedules_weekday_check" CHECK (("cadence" = 'weekly') = ("weekday" IS NOT NULL) AND ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6)),
    CONSTRAINT "issue_schedules_day_of_month_check" CHECK (("cadence" = 'monthly') = ("dayOfMonth" IS NOT NULL) AND ("dayOfMonth" IS NULL OR "dayOfMonth" BETWEEN 1 AND 28)),
    CONSTRAINT "issue_schedules_time_check" CHECK ("hour" BETWEEN 0 AND 23 AND "minute" BETWEEN 0 AND 59),
    CONSTRAINT "issue_schedules_timezone_check" CHECK (char_length("timezone") BETWEEN 1 AND 64),
    CONSTRAINT "issue_schedules_pause_reason_check" CHECK ("pauseReason" IS NULL OR "pausedAt" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "issue_schedule_occurrences" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "slotAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'scheduled',
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "skippedSlots" INTEGER NOT NULL DEFAULT 0,
    "taskId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_schedule_occurrences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_schedule_occurrences_kind_check" CHECK ("kind" IN ('scheduled', 'manual')),
    -- A created occurrence names no reason (its task may be deleted later: SET NULL);
    -- a skipped one always has a reason and never a task.
    CONSTRAINT "issue_schedule_occurrences_outcome_check" CHECK (
        ("outcome" = 'created' AND "reason" IS NULL)
        OR ("outcome" = 'skipped' AND "reason" IS NOT NULL AND "taskId" IS NULL)
    ),
    CONSTRAINT "issue_schedule_occurrences_skipped_slots_check" CHECK ("skippedSlots" >= 0),
    -- Slots are whole minutes (the idempotency grain of "run now").
    CONSTRAINT "issue_schedule_occurrences_slot_check" CHECK ("slotAt" = date_trunc('minute', "slotAt"))
);

-- CreateIndex
CREATE INDEX "issue_schedules_projectId_createdAt_idx" ON "issue_schedules"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "issue_schedules_nextRunAt_idx" ON "issue_schedules"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "issue_schedule_occurrences_taskId_key" ON "issue_schedule_occurrences"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "issue_schedule_occurrences_scheduleId_slotAt_key" ON "issue_schedule_occurrences"("scheduleId", "slotAt");

-- AddForeignKey
ALTER TABLE "issue_schedules" ADD CONSTRAINT "issue_schedules_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_schedule_occurrences" ADD CONSTRAINT "issue_schedule_occurrences_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "issue_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_schedule_occurrences" ADD CONSTRAINT "issue_schedule_occurrences_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
