-- W19b / FE-13: project knowledge. Notes the team wants every agent run in a
-- project to know; people write or approve them, agents can only propose;
-- every change is a revision. See docs/reports/revamp-2026-10-26/knowledge.md.
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
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'note',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retractedById" TEXT,
    "retractedAt" TIMESTAMP(3),
    "retractReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_entries_kind_check" CHECK ("kind" IN ('note', 'convention', 'procedure')),
    CONSTRAINT "knowledge_entries_title_check" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "knowledge_entries_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000),
    CONSTRAINT "knowledge_entries_status_check" CHECK ("status" IN ('proposed', 'active', 'retracted')),
    CONSTRAINT "knowledge_entries_source_check" CHECK ("source" IN ('user', 'agent', 'review_finding')),
    CONSTRAINT "knowledge_entries_version_check" CHECK ("version" >= 1),
    CONSTRAINT "knowledge_entries_approval_check" CHECK (("approvedById" IS NULL) = ("approvedAt" IS NULL)),
    CONSTRAINT "knowledge_entries_retraction_check" CHECK (("status" = 'retracted') = ("retractedAt" IS NOT NULL) AND ("retractedById" IS NULL) = ("retractedAt" IS NULL)),
    CONSTRAINT "knowledge_entries_retract_reason_check" CHECK ("retractReason" IS NULL OR char_length("retractReason") <= 500)
);

-- CreateTable
CREATE TABLE "knowledge_versions" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "note" TEXT,
    "editedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_versions_version_check" CHECK ("version" >= 1),
    CONSTRAINT "knowledge_versions_change_check" CHECK ("change" IN ('created', 'edited', 'approved', 'retracted', 'restored')),
    CONSTRAINT "knowledge_versions_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

-- CreateIndex
CREATE INDEX "knowledge_entries_projectId_status_updatedAt_idx" ON "knowledge_entries"("projectId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_versions_entryId_version_key" ON "knowledge_versions"("entryId", "version");

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "knowledge_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
