-- W15a: per-run budgets on user settings (null = no limit). Additive:
-- nullable columns without defaults are a catalog-only change in PostgreSQL.

-- AlterTable
ALTER TABLE "settings" ADD COLUMN "maxRunCostUsd" DOUBLE PRECISION,
ADD COLUMN "maxRunTokens" INTEGER;

ALTER TABLE "settings" ADD CONSTRAINT "settings_max_run_cost_usd_check" CHECK ("maxRunCostUsd" IS NULL OR ("maxRunCostUsd" > 0 AND "maxRunCostUsd" <= 10000));
ALTER TABLE "settings" ADD CONSTRAINT "settings_max_run_tokens_check" CHECK ("maxRunTokens" IS NULL OR ("maxRunTokens" >= 1000 AND "maxRunTokens" <= 1000000000));
