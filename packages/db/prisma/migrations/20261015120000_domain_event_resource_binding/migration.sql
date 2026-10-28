-- W02a: resource binding for realtime domain events.
-- Additive and nullable (metadata-only in PostgreSQL; no table rewrite, no
-- index). Existing rows keep NULL and are treated as legacy: live delivery
-- and Last-Event-ID replay only send them to explicitly addressed users.
ALTER TABLE "domain_events" ADD COLUMN IF NOT EXISTS "resource_type" TEXT;
ALTER TABLE "domain_events" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
