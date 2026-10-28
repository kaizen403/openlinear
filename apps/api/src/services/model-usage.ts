/**
 * Model invocation ledger (W15): one `model_usage` row per attempt of every
 * model call the API makes — chat rounds, titles, retried and failed calls.
 *
 * Rows are keyed by our own `invocationId`, so recording the same attempt
 * twice cannot inflate totals. Unknown usage stays NULL and unknown cost stays
 * NULL with `costBasis = 'unknown'` (enforced by a database CHECK as well).
 */
import { Prisma, prisma } from '@openlinear/db';
import { logger } from '../logger';
import { loadChatLLMConfig } from '../lib/chat-llm-config';
import { cacheHitRate, resolveCost, type CostBasis, type NormalizedUsage, type PricingTable } from '../lib/llm-usage';

export const USAGE_SURFACES = ['chat.turn', 'chat.title', 'chat.summary', 'transcription'] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];
export type UsageStatus = 'succeeded' | 'failed' | 'aborted';

export interface ModelUsageEntry {
  invocationId: string;
  surface: UsageSurface;
  provider: string;
  model: string;
  userId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  round?: number | null;
  attempt?: number;
  status: UsageStatus;
  finishReason?: string | null;
  errorCode?: string | null;
  usage: NormalizedUsage | null;
  latencyMs?: number | null;
  firstTokenMs?: number | null;
  promptHash?: string | null;
  toolsHash?: string | null;
  providerRequestId?: string | null;
}

export interface RecordedModelUsage {
  invocationId: string;
  usage: NormalizedUsage | null;
  costUsd: number | null;
  costBasis: CostBasis;
}

const INT4_MAX = 2_147_483_647;

function int(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(INT4_MAX, Math.max(0, Math.round(value)));
}

function text(value: string | null | undefined, max = 200): string | null {
  return value ? value.slice(0, max) : null;
}

function configuredPricing(): PricingTable | null {
  const loaded = loadChatLLMConfig();
  return loaded.ok ? loaded.config.pricing : null;
}

/**
 * Record one invocation attempt. Never throws: metering must not break the
 * user-facing call. The returned cost resolution is what callers report.
 */
export async function recordModelUsage(
  entry: ModelUsageEntry,
  pricing: PricingTable | null = configuredPricing(),
): Promise<RecordedModelUsage> {
  const cost = resolveCost(entry.usage, { provider: entry.provider, model: entry.model, pricing });
  const usage = entry.usage;
  const data: Prisma.ModelUsageCreateInput = {
    invocationId: entry.invocationId,
    surface: entry.surface,
    provider: text(entry.provider, 64) ?? 'unknown',
    model: text(entry.model) ?? 'unknown',
    userId: entry.userId ?? null,
    workspaceId: entry.workspaceId ?? null,
    sessionId: entry.sessionId ?? null,
    turnId: entry.turnId ?? null,
    round: entry.round ?? null,
    attempt: entry.attempt ?? 1,
    status: entry.status,
    finishReason: text(entry.finishReason, 64),
    errorCode: text(entry.errorCode, 64),
    usageReported: usage !== null,
    inputTokens: int(usage?.inputTokens),
    outputTokens: int(usage?.outputTokens),
    cacheReadTokens: int(usage?.cacheReadTokens),
    cacheWriteTokens: int(usage?.cacheWriteTokens),
    reasoningTokens: int(usage?.reasoningTokens),
    latencyMs: int(entry.latencyMs),
    firstTokenMs: int(entry.firstTokenMs),
    costUsd: cost.costUsd === null ? null : new Prisma.Decimal(cost.costUsd.toFixed(6)),
    costBasis: cost.basis,
    pricingRevision: cost.pricingRevision,
    promptHash: entry.promptHash ?? null,
    toolsHash: entry.toolsHash ?? null,
    providerRequestId: text(entry.providerRequestId),
    // `raw` is already a JSON round-trip of the provider object (llm-usage.ts).
    rawUsage: usage ? (usage.raw as Prisma.InputJsonObject) : Prisma.DbNull,
  };
  try {
    // First observation wins; a replayed record is a no-op.
    await prisma.modelUsage.upsert({ where: { invocationId: entry.invocationId }, create: data, update: {} });
  } catch (err) {
    logger.error({ err, invocationId: entry.invocationId, surface: entry.surface }, '[usage] failed to record model usage');
  }
  return { invocationId: entry.invocationId, usage, costUsd: cost.costUsd, costBasis: cost.basis };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

export type CostCoverage = 'complete' | 'partial' | 'none';

export interface ModelUsageTotals {
  calls: number;
  callsWithUsage: number;
  callsWithoutUsage: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Cache reads / prompt tokens, over calls that reported cache tokens. */
  cacheHitRate: number | null;
  cost: {
    /** Sum of known (reported or estimated) costs; null when none is known. */
    knownUsd: number | null;
    coverage: CostCoverage;
    byBasis: Record<CostBasis, number>;
  };
}

export interface ModelUsageGroup extends ModelUsageTotals {
  surface: string;
  provider: string;
  model: string;
}

export interface ModelUsageFilter {
  userId: string;
  since: Date;
  workspaceId?: string;
  surface?: UsageSurface;
  /** One chat session (history totals); served by the (sessionId, createdAt) index. */
  sessionId?: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toCount(value: unknown): number {
  return toNumber(value) ?? 0;
}

function toLabel(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown';
}

function whereSql(filter: ModelUsageFilter): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`"userId" = ${filter.userId}`,
    Prisma.sql`"createdAt" >= ${filter.since}`,
  ];
  if (filter.workspaceId) clauses.push(Prisma.sql`"workspaceId" = ${filter.workspaceId}`);
  if (filter.surface) clauses.push(Prisma.sql`"surface" = ${filter.surface}`);
  if (filter.sessionId) clauses.push(Prisma.sql`"sessionId" = ${filter.sessionId}`);
  return Prisma.join(clauses, ' AND ');
}

const AGGREGATES = Prisma.sql`
  COUNT(*) AS "calls",
  COUNT("inputTokens") AS "callsWithUsage",
  SUM("inputTokens") AS "inputTokens",
  SUM("outputTokens") AS "outputTokens",
  SUM("cacheReadTokens") AS "cacheReadTokens",
  SUM("cacheWriteTokens") AS "cacheWriteTokens",
  SUM("reasoningTokens") AS "reasoningTokens",
  SUM("inputTokens") FILTER (WHERE "cacheReadTokens" IS NOT NULL) AS "inputTokensWithCacheInfo",
  SUM("costUsd") AS "knownCostUsd",
  COUNT(*) FILTER (WHERE "costBasis" = 'provider_reported') AS "providerReported",
  COUNT(*) FILTER (WHERE "costBasis" = 'estimated') AS "estimated",
  COUNT(*) FILTER (WHERE "costBasis" = 'unknown') AS "unknownCost"`;

type AggregateRow = Record<string, unknown>;

function totalsFromRow(row: AggregateRow | undefined): ModelUsageTotals {
  const calls = toCount(row?.calls);
  const callsWithUsage = toCount(row?.callsWithUsage);
  const byBasis: Record<CostBasis, number> = {
    provider_reported: toCount(row?.providerReported),
    estimated: toCount(row?.estimated),
    unknown: toCount(row?.unknownCost),
  };
  const known = byBasis.provider_reported + byBasis.estimated;
  const knownUsd = known > 0 ? toNumber(row?.knownCostUsd) : null;
  return {
    calls,
    callsWithUsage,
    callsWithoutUsage: calls - callsWithUsage,
    inputTokens: toNumber(row?.inputTokens),
    outputTokens: toNumber(row?.outputTokens),
    cacheReadTokens: toNumber(row?.cacheReadTokens),
    cacheWriteTokens: toNumber(row?.cacheWriteTokens),
    reasoningTokens: toNumber(row?.reasoningTokens),
    cacheHitRate: cacheHitRate({ inputTokens: toNumber(row?.inputTokensWithCacheInfo), cacheReadTokens: toNumber(row?.cacheReadTokens) }),
    cost: {
      knownUsd: knownUsd === null ? null : Math.round(knownUsd * 1e6) / 1e6,
      coverage: calls === 0 || known === 0 ? 'none' : known === calls ? 'complete' : 'partial',
      byBasis,
    },
  };
}

/** Aggregated in SQL; at most `groupLimit` surface/provider/model groups (0 = totals only). */
export async function summarizeModelUsage(
  filter: ModelUsageFilter,
  groupLimit = 100,
): Promise<{ totals: ModelUsageTotals; groups: ModelUsageGroup[] }> {
  const where = whereSql(filter);
  const [totalRows, groupRows] = await Promise.all([
    prisma.$queryRaw<AggregateRow[]>(Prisma.sql`SELECT ${AGGREGATES} FROM "model_usage" WHERE ${where}`),
    groupLimit <= 0 ? Promise.resolve<AggregateRow[]>([]) : prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
      SELECT "surface", "provider", "model", ${AGGREGATES}
      FROM "model_usage"
      WHERE ${where}
      GROUP BY "surface", "provider", "model"
      ORDER BY COUNT(*) DESC, "surface" ASC, "provider" ASC, "model" ASC
      LIMIT ${groupLimit}`),
  ]);
  return {
    totals: totalsFromRow(totalRows[0]),
    groups: groupRows.map((row) => ({
      surface: toLabel(row.surface),
      provider: toLabel(row.provider),
      model: toLabel(row.model),
      ...totalsFromRow(row),
    })),
  };
}
