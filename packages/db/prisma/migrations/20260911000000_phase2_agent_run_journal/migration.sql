-- Phase 2: runner/session/usage columns on AgentRun, Task.agent,
-- Project.defaultAgent, and cloud-side journal mirror for SSE replay.

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "runner" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "externalSessionId" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "costBasis" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cacheWriteTokens" INTEGER;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "reasoningTokens" INTEGER;

CREATE INDEX IF NOT EXISTS "agent_runs_externalSessionId_idx" ON "agent_runs"("externalSessionId");

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent" TEXT;
ALTER TABLE "linear_projects" ADD COLUMN IF NOT EXISTS "defaultAgent" TEXT;

CREATE TABLE IF NOT EXISTS "agent_run_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_events_runId_seq_key" ON "agent_run_events"("runId", "seq");
CREATE INDEX IF NOT EXISTS "agent_run_events_runId_seq_idx" ON "agent_run_events"("runId", "seq");

ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
