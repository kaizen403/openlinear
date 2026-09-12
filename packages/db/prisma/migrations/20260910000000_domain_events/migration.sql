-- Phase 1.3 transactional outbox. `id` is the SSE Last-Event-ID.
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "workspace_id" TEXT,
    "payload" JSONB NOT NULL,
    "user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "team_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "workspace_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "domain_events_published_at_id_idx" ON "domain_events"("published_at", "id");
CREATE INDEX "domain_events_workspace_id_id_idx" ON "domain_events"("workspace_id", "id");
