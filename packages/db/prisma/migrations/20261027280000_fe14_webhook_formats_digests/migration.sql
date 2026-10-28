-- FE-14 follow-up: receiver formats and the daily digest of webhook
-- endpoints. See docs/reports/revamp-2026-10-26/webhooks.md §11.
--
--   format          openlinear (signed JSON, the default and the previous
--                   behaviour) | slack (incoming webhook message) | discord
--                   (webhook message). Which URLs a format accepts is checked
--                   in the API (services/webhook-formats.ts).
--   digestHour      `digest.daily`: the local hour (0-23) the digest is sent,
--   digestTimezone  in this IANA zone; both or neither.
--   digestNextAt    When the next digest is due (set while the endpoint is on
--                   and subscribed to `digest.daily`).
--
-- Additive only: four new columns (nullable, or NOT NULL with a constant
-- default, which PostgreSQL 11+ adds without rewriting the table) and two
-- CHECK constraints on `webhook_endpoints` (created by the previous
-- migration, small). No index: the digest sweep reads the endpoints table,
-- bounded at 10 endpoints per project or workspace.

-- AlterTable
ALTER TABLE "webhook_endpoints"
    ADD COLUMN "format" TEXT NOT NULL DEFAULT 'openlinear',
    ADD COLUMN "digestHour" INTEGER,
    ADD COLUMN "digestTimezone" TEXT,
    ADD COLUMN "digestNextAt" TIMESTAMP(3);

ALTER TABLE "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_format_check" CHECK ("format" IN ('openlinear', 'slack', 'discord')),
    -- A digest time is an hour in a named zone; a due time needs one.
    ADD CONSTRAINT "webhook_endpoints_digest_check" CHECK (
        ("digestHour" IS NULL) = ("digestTimezone" IS NULL)
        AND ("digestHour" IS NULL OR "digestHour" BETWEEN 0 AND 23)
        AND ("digestTimezone" IS NULL OR char_length("digestTimezone") BETWEEN 1 AND 64)
        AND ("digestNextAt" IS NULL OR "digestHour" IS NOT NULL)
    );
