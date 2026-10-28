-- W04b: transactional outbox, durable relay bookkeeping, immutable events and
-- replay retention watermark. See docs/reports/revamp-2026-10-26/outbox.md.
--
-- Expand-only and backward compatible:
--   * one new table for transactional appends (`domain_event_outbox`), one
--     single-row table for the retention watermark;
--   * nullable / constant-default columns on `domain_events` (metadata-only in
--     PostgreSQL 11+, no table rewrite, no index build);
--   * triggers that reject UPDATEs of event columns. The previous API version
--     only ever updates `published_at`, which stays writable, so a rolling
--     deploy keeps working.
-- No CREATE INDEX, no destructive DDL.

-- Fail fast instead of queueing behind a long transaction on domain_events.
SET LOCAL lock_timeout = '5s';

-- Pending appends, written inside the domain transaction.
CREATE TABLE "domain_event_outbox" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "workspace_id" TEXT,
    "payload" JSONB NOT NULL,
    "user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "team_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "workspace_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "resource_type" TEXT,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_event_outbox_pkey" PRIMARY KEY ("id")
);

-- Stream provenance and relay bookkeeping.
ALTER TABLE "domain_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dead_lettered_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "lease_owner" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3),
ADD COLUMN     "source_id" BIGINT;

-- Highest domain_events.id removed by retention (single row, id = 1).
CREATE TABLE "domain_event_retention" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "pruned_through_id" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_event_retention_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "domain_event_retention_single_row" CHECK ("id" = 1),
    CONSTRAINT "domain_event_retention_nonnegative" CHECK ("pruned_through_id" >= 0)
);

INSERT INTO "domain_event_retention" ("id", "pruned_through_id") VALUES (1, 0)
ON CONFLICT ("id") DO NOTHING;

-- Immutable events. Deny by default: every column except the relay
-- bookkeeping allow-list below must be unchanged by an UPDATE, so a column
-- added later is protected without editing this function. SQLSTATE OLI01 is
-- matched by apps/api/src/events/types.ts (EVENT_IMMUTABLE_SQLSTATE).
CREATE OR REPLACE FUNCTION "domain_events_reject_event_update"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
    bookkeeping CONSTANT text[] := ARRAY[
        'published_at', 'attempts', 'next_attempt_at', 'lease_owner',
        'lease_expires_at', 'last_error', 'dead_lettered_at'
    ];
BEGIN
    IF (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
        RAISE EXCEPTION 'domain_events row % is immutable; only relay bookkeeping columns may change', OLD."id"
            USING ERRCODE = 'OLI01';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER "domain_events_immutable"
    BEFORE UPDATE ON "domain_events"
    FOR EACH ROW EXECUTE FUNCTION "domain_events_reject_event_update"();

-- Pending rows carry no bookkeeping at all: they are moved (deleted) by the
-- sequencer, never updated.
CREATE OR REPLACE FUNCTION "domain_event_outbox_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'domain_event_outbox row % is immutable', OLD."id"
        USING ERRCODE = 'OLI01';
END
$fn$;

CREATE OR REPLACE TRIGGER "domain_event_outbox_immutable"
    BEFORE UPDATE ON "domain_event_outbox"
    FOR EACH ROW EXECUTE FUNCTION "domain_event_outbox_reject_update"();
