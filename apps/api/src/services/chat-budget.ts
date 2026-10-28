/**
 * Monthly Home Chat budgets with reservations (W15).
 *
 * Caps exist per workspace and per member (within a workspace), in USD and/or
 * tokens. Effective cap = the tightest of the operator default
 * (`CHAT_BUDGET_*`) and the workspace's override; a member's own override
 * replaces the workspace's per-member default (still under the operator
 * ceiling). See lib/chat-budget-config.ts.
 *
 * Accounting, per cap:
 *   committed = spent (every `chat.*` call in `model_usage` this month)
 *             + held  (unconsumed part of active, unexpired reservations)
 *
 * A turn is admitted only while every applicable cap has headroom
 * (committed < cap). Admission reserves min(reserve, headroom) under a
 * per-workspace advisory lock, so concurrent turns on any replica cannot
 * jointly overshoot by more than what they were each granted. Between model
 * rounds the turn extends its reservation the same way once it has consumed
 * it; when a cap has no headroom left, the turn stops with
 * `CHAT_BUDGET_EXCEEDED` before the next model call. Overshoot is bounded by
 * one model call. At the end the reservation is settled; spend after that
 * (the session title) lands in `model_usage` and counts toward the next turn.
 *
 * Unknown cost: a USD cap can only be enforced on priced calls. When a USD cap
 * applies and the configured chat model has no price (no `MODEL_PRICING_JSON`
 * entry, provider does not report cost), policy decides: `block` refuses the
 * turn (`CHAT_BUDGET_COST_UNKNOWN`), `allow` runs it and emits a
 * `budget_warning`. A successful call whose cost resolves to unknown mid-turn
 * stops a `block` turn before its next round. Failed or aborted attempts
 * without usage count as zero (providers generally do not bill them); they
 * stay visible in the ledger.
 */
import { Prisma, prisma } from '@openlinear/db';
import { logger } from '../logger';
import { loadChatBudgetConfig, type ChatBudgetConfig, type UnknownCostPolicy } from '../lib/chat-budget-config';
import { loadChatLLMConfig, providerReportsCost } from '../lib/chat-llm-config';
import { lookupPrice } from '../lib/llm-usage';

type Db = Prisma.TransactionClient | typeof prisma;

export type BudgetScope = 'workspace' | 'user';
export type BudgetDimension = 'usd' | 'tokens';
export type BudgetLimitSource = 'config' | 'workspace' | 'member';

export interface BudgetLimit {
  value: number;
  source: BudgetLimitSource;
}

export interface EffectiveBudget {
  workspace: Record<BudgetDimension, BudgetLimit | null>;
  user: Record<BudgetDimension, BudgetLimit | null>;
  unknownCostPolicy: UnknownCostPolicy;
}

interface Measured {
  spentUsd: number;
  spentTokens: number;
  /** Successful calls whose cost is unknown: USD spent is then a lower bound. */
  unknownCostCalls: number;
  /** Successful calls that reported no tokens: token spend is then a lower bound. */
  unreportedCalls: number;
  heldUsd: number;
  heldTokens: number;
}

const NOW_UTC = Prisma.sql`timezone('UTC', clock_timestamp())`;
/** Reservations outlive the turn deadline by this much before they stop holding budget. */
const RESERVATION_GRACE_MS = 60_000;

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalOrNull(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function tightest(...candidates: Array<BudgetLimit | null>): BudgetLimit | null {
  let best: BudgetLimit | null = null;
  for (const candidate of candidates) {
    if (candidate && (best === null || candidate.value < best.value)) best = candidate;
  }
  return best;
}

function limit(value: number | null, source: BudgetLimitSource): BudgetLimit | null {
  return value === null ? null : { value, source };
}

export function budgetPeriod(now: Date = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function resolveEffectiveBudget(
  workspaceId: string,
  userId: string,
  config: ChatBudgetConfig,
  db: Db = prisma,
): Promise<EffectiveBudget> {
  const [workspace, member] = await Promise.all([
    db.chatWorkspaceBudget.findUnique({ where: { workspaceId } }),
    db.chatMemberBudget.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }),
  ]);
  const memberUsd = decimalOrNull(member?.monthlyUsdLimit);
  const memberTokens = member?.monthlyTokenLimit ?? null;
  return {
    workspace: {
      usd: tightest(limit(config.workspaceMonthlyUsd, 'config'), limit(decimalOrNull(workspace?.monthlyUsdLimit), 'workspace')),
      tokens: tightest(limit(config.workspaceMonthlyTokens, 'config'), limit(workspace?.monthlyTokenLimit ?? null, 'workspace')),
    },
    user: {
      usd: tightest(
        limit(config.userMonthlyUsd, 'config'),
        memberUsd !== null ? limit(memberUsd, 'member') : limit(decimalOrNull(workspace?.perUserMonthlyUsdLimit), 'workspace'),
      ),
      tokens: tightest(
        limit(config.userMonthlyTokens, 'config'),
        memberTokens !== null ? limit(memberTokens, 'member') : limit(workspace?.perUserMonthlyTokenLimit ?? null, 'workspace'),
      ),
    },
    unknownCostPolicy: config.unknownCostPolicy === 'block' || workspace?.unknownCostPolicy === 'block' ? 'block' : 'allow',
  };
}

function hasAnyLimit(budget: EffectiveBudget): boolean {
  return Boolean(budget.workspace.usd || budget.workspace.tokens || budget.user.usd || budget.user.tokens);
}

function hasUsdLimit(budget: EffectiveBudget): boolean {
  return Boolean(budget.workspace.usd || budget.user.usd);
}

function hasTokenLimit(budget: EffectiveBudget): boolean {
  return Boolean(budget.workspace.tokens || budget.user.tokens);
}

/**
 * Whether a chat turn's cost can be known: the operator price snapshot prices
 * the configured chat model, or the provider reports cost itself.
 */
export function chatCostPriceable(): boolean {
  const loaded = loadChatLLMConfig();
  if (!loaded.ok) return false;
  const { provider, model, pricing } = loaded.config;
  return providerReportsCost(provider) || lookupPrice(pricing, provider, model) !== null;
}

async function measure(db: Db, workspaceId: string, userId: string, periodStart: Date): Promise<Record<BudgetScope, Measured>> {
  const [usageRows, heldRows] = await Promise.all([
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        SUM("costUsd") AS "wsUsd",
        SUM(COALESCE("inputTokens", 0) + COALESCE("outputTokens", 0)) AS "wsTokens",
        COUNT(*) FILTER (WHERE "costBasis" = 'unknown' AND "status" = 'succeeded') AS "wsUnknown",
        COUNT(*) FILTER (WHERE "usageReported" = false AND "status" = 'succeeded') AS "wsUnreported",
        SUM("costUsd") FILTER (WHERE "userId" = ${userId}) AS "userUsd",
        SUM(COALESCE("inputTokens", 0) + COALESCE("outputTokens", 0)) FILTER (WHERE "userId" = ${userId}) AS "userTokens",
        COUNT(*) FILTER (WHERE "userId" = ${userId} AND "costBasis" = 'unknown' AND "status" = 'succeeded') AS "userUnknown",
        COUNT(*) FILTER (WHERE "userId" = ${userId} AND "usageReported" = false AND "status" = 'succeeded') AS "userUnreported"
      FROM "model_usage"
      WHERE "workspaceId" = ${workspaceId}
        AND "createdAt" >= ${periodStart}
        AND "surface" LIKE 'chat.%'`,
    db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        SUM(GREATEST("reservedUsd" - "consumedUsd", 0)) AS "wsUsd",
        SUM(GREATEST("reservedTokens" - "consumedTokens", 0)) AS "wsTokens",
        SUM(GREATEST("reservedUsd" - "consumedUsd", 0)) FILTER (WHERE "userId" = ${userId}) AS "userUsd",
        SUM(GREATEST("reservedTokens" - "consumedTokens", 0)) FILTER (WHERE "userId" = ${userId}) AS "userTokens"
      FROM "chat_budget_reservations"
      WHERE "workspaceId" = ${workspaceId}
        AND "status" = 'active'
        AND "expiresAt" > ${NOW_UTC}`,
  ]);
  const usage = usageRows[0] ?? {};
  const held = heldRows[0] ?? {};
  return {
    workspace: {
      spentUsd: roundUsd(toNumber(usage.wsUsd)),
      spentTokens: toNumber(usage.wsTokens),
      unknownCostCalls: toNumber(usage.wsUnknown),
      unreportedCalls: toNumber(usage.wsUnreported),
      heldUsd: roundUsd(toNumber(held.wsUsd)),
      heldTokens: toNumber(held.wsTokens),
    },
    user: {
      spentUsd: roundUsd(toNumber(usage.userUsd)),
      spentTokens: toNumber(usage.userTokens),
      unknownCostCalls: toNumber(usage.userUnknown),
      unreportedCalls: toNumber(usage.userUnreported),
      heldUsd: roundUsd(toNumber(held.userUsd)),
      heldTokens: toNumber(held.userTokens),
    },
  };
}

function headroom(limitValue: number, measured: Measured, dimension: BudgetDimension): number {
  const committed = dimension === 'usd' ? measured.spentUsd + measured.heldUsd : measured.spentTokens + measured.heldTokens;
  return dimension === 'usd' ? roundUsd(limitValue - committed) : limitValue - committed;
}

export interface BudgetRefusalDetails {
  scope: BudgetScope;
  dimension: BudgetDimension;
  /** Amounts are included for the caller's own (`user`) cap only; workspace-wide spend is admin data. */
  limit?: number;
  spent?: number;
  held?: number;
  source: BudgetLimitSource;
  resetsAt: string;
}

export type BudgetRefusal =
  | { code: 'CHAT_BUDGET_EXCEEDED'; status: 402; message: string; details: BudgetRefusalDetails }
  | { code: 'CHAT_BUDGET_COST_UNKNOWN'; status: 402; message: string; details: { policy: 'block'; resetsAt: string } }
  | { code: 'CHAT_BUDGET_MISCONFIGURED'; status: 503; message: string; details: { issues: string[] } };

export interface BudgetWarning {
  code: 'CHAT_BUDGET_COST_UNKNOWN' | 'CHAT_BUDGET_NEARLY_EXHAUSTED';
  message: string;
  details?: Record<string, unknown>;
}

function exceeded(scope: BudgetScope, dimension: BudgetDimension, cap: BudgetLimit, measured: Measured, periodEnd: Date): BudgetRefusal {
  const who = scope === 'workspace' ? "This workspace's" : 'Your';
  const what = dimension === 'usd' ? 'spending' : 'token';
  return {
    code: 'CHAT_BUDGET_EXCEEDED',
    status: 402,
    message: `${who} monthly chat ${what} budget is used up. It resets on ${periodEnd.toISOString().slice(0, 10)}.`,
    details: {
      scope,
      dimension,
      ...(scope === 'user'
        ? {
            limit: cap.value,
            spent: dimension === 'usd' ? measured.spentUsd : measured.spentTokens,
            held: dimension === 'usd' ? measured.heldUsd : measured.heldTokens,
          }
        : {}),
      source: cap.source,
      resetsAt: periodEnd.toISOString(),
    },
  };
}

interface CapCheck {
  scope: BudgetScope;
  dimension: BudgetDimension;
  cap: BudgetLimit;
}

function capsOf(budget: EffectiveBudget, dimensions: readonly BudgetDimension[]): CapCheck[] {
  const caps: CapCheck[] = [];
  for (const scope of ['workspace', 'user'] as const) {
    for (const dimension of dimensions) {
      const cap = budget[scope][dimension];
      if (cap) caps.push({ scope, dimension, cap });
    }
  }
  return caps;
}

async function lockWorkspaceBudget(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-chat-budget:${workspaceId}`}, 0))`;
}

interface ReservationState {
  id: string;
  reservedUsd: number;
  reservedTokens: number;
  consumedUsd: number;
  consumedTokens: number;
  unknownCostCalls: number;
}

export interface BudgetConsumption {
  status: 'succeeded' | 'failed' | 'aborted';
  costUsd: number | null;
  tokens: number | null;
}

export type HeadroomResult = { ok: true } | { ok: false; refusal: BudgetRefusal };

/**
 * The budget a running turn holds. `unlimited()` (no cap applies) does no
 * database work at all.
 */
export class TurnBudget {
  private settled = false;
  private costUnknownSeen = false;

  private constructor(
    readonly workspaceId: string,
    readonly userId: string,
    private readonly effective: EffectiveBudget | null,
    private readonly config: ChatBudgetConfig | null,
    private readonly priceable: boolean,
    private readonly period: { start: Date; end: Date },
    private readonly reservation: ReservationState | null,
    readonly warnings: BudgetWarning[],
  ) {}

  static unlimited(workspaceId: string, userId: string): TurnBudget {
    return new TurnBudget(workspaceId, userId, null, null, true, budgetPeriod(), null, []);
  }

  static limited(input: {
    workspaceId: string;
    userId: string;
    effective: EffectiveBudget;
    config: ChatBudgetConfig;
    priceable: boolean;
    period: { start: Date; end: Date };
    reservation: ReservationState;
    warnings: BudgetWarning[];
  }): TurnBudget {
    return new TurnBudget(input.workspaceId, input.userId, input.effective, input.config, input.priceable, input.period, input.reservation, input.warnings);
  }

  get limited(): boolean {
    return this.reservation !== null;
  }

  get reservationId(): string | null {
    return this.reservation?.id ?? null;
  }

  /** Account one recorded model attempt against the reservation. */
  async consume(entry: BudgetConsumption): Promise<void> {
    const reservation = this.reservation;
    if (!reservation || this.settled) return;
    if (entry.costUsd !== null) reservation.consumedUsd = roundUsd(reservation.consumedUsd + entry.costUsd);
    else if (entry.status === 'succeeded') {
      reservation.unknownCostCalls += 1;
      this.costUnknownSeen = true;
    }
    if (entry.tokens !== null) reservation.consumedTokens += entry.tokens;
    await this.persist(reservation);
  }

  private async persist(reservation: ReservationState, db: Db = prisma): Promise<void> {
    try {
      await db.chatBudgetReservation.update({
        where: { id: reservation.id },
        data: {
          reservedUsd: new Prisma.Decimal(reservation.reservedUsd.toFixed(6)),
          reservedTokens: reservation.reservedTokens,
          consumedUsd: new Prisma.Decimal(reservation.consumedUsd.toFixed(6)),
          consumedTokens: Math.min(2_147_483_647, reservation.consumedTokens),
          unknownCostCalls: reservation.unknownCostCalls,
        },
      });
    } catch (err) {
      logger.warn({ err, reservationId: reservation.id }, '[chat] could not persist budget consumption');
    }
  }

  /**
   * Before the next model call: stop when an unknown cost was seen under
   * `block`, and extend the reservation once it is consumed. Refuses when a
   * cap has no headroom left.
   */
  async ensureHeadroom(): Promise<HeadroomResult> {
    const reservation = this.reservation;
    const effective = this.effective;
    const config = this.config;
    if (!reservation || !effective || !config || this.settled) return { ok: true };
    if (this.costUnknownSeen && hasUsdLimit(effective) && effective.unknownCostPolicy === 'block') {
      return { ok: false, refusal: costUnknownRefusal(this.period.end) };
    }
    const dimensions: BudgetDimension[] = [];
    if (hasUsdLimit(effective) && this.priceable && reservation.consumedUsd >= reservation.reservedUsd) dimensions.push('usd');
    if (hasTokenLimit(effective) && reservation.consumedTokens >= reservation.reservedTokens) dimensions.push('tokens');
    if (dimensions.length === 0) return { ok: true };

    return prisma.$transaction(async (tx) => {
      await lockWorkspaceBudget(tx, this.workspaceId);
      const measured = await measure(tx, this.workspaceId, this.userId, this.period.start);
      let grantUsd = config.turnReserveUsd;
      let grantTokens = config.turnReserveTokens;
      for (const check of capsOf(effective, dimensions)) {
        const room = headroom(check.cap.value, measured[check.scope], check.dimension);
        if (room <= 0) return { ok: false as const, refusal: exceeded(check.scope, check.dimension, check.cap, measured[check.scope], this.period.end) };
        if (check.dimension === 'usd') grantUsd = Math.min(grantUsd, room);
        else grantTokens = Math.min(grantTokens, room);
      }
      if (dimensions.includes('usd')) reservation.reservedUsd = roundUsd(reservation.consumedUsd + grantUsd);
      if (dimensions.includes('tokens')) reservation.reservedTokens = reservation.consumedTokens + Math.floor(grantTokens);
      await this.persist(reservation, tx);
      return { ok: true as const };
    });
  }

  /**
   * Once per turn: a successful call's cost turned out unknown under a USD cap
   * with policy `allow` (with `block`, `ensureHeadroom` stops the turn).
   */
  takeMidTurnWarning(): BudgetWarning | null {
    const effective = this.effective;
    if (!effective || !this.costUnknownSeen || !hasUsdLimit(effective) || effective.unknownCostPolicy !== 'allow') return null;
    if (this.warnings.some((warning) => warning.code === 'CHAT_BUDGET_COST_UNKNOWN')) return null;
    const warning: BudgetWarning = {
      code: 'CHAT_BUDGET_COST_UNKNOWN',
      message: 'A model call in this reply had no price, so the USD chat budget cannot fully limit it.',
      details: { policy: 'allow' },
    };
    this.warnings.push(warning);
    return warning;
  }

  /** Close the reservation (idempotent; never throws). */
  async settle(stopCode?: string | null): Promise<void> {
    const reservation = this.reservation;
    if (!reservation || this.settled) return;
    this.settled = true;
    try {
      await prisma.$executeRaw`
        UPDATE "chat_budget_reservations"
        SET "status" = 'settled',
            "settledAt" = ${NOW_UTC},
            "stopCode" = ${stopCode ?? null},
            "consumedUsd" = ${new Prisma.Decimal(reservation.consumedUsd.toFixed(6))},
            "consumedTokens" = ${Math.min(2_147_483_647, reservation.consumedTokens)},
            "unknownCostCalls" = ${reservation.unknownCostCalls}
        WHERE "id" = ${reservation.id} AND "status" = 'active'`;
    } catch (err) {
      logger.warn({ err, reservationId: reservation.id }, '[chat] could not settle a budget reservation; it will expire');
    }
  }
}

function costUnknownRefusal(periodEnd: Date): BudgetRefusal {
  return {
    code: 'CHAT_BUDGET_COST_UNKNOWN',
    status: 402,
    message: 'This workspace blocks chat replies whose cost cannot be priced, and the configured model has no price.',
    details: { policy: 'block', resetsAt: periodEnd.toISOString() },
  };
}

export type AdmissionResult = { ok: true; budget: TurnBudget } | { ok: false; refusal: BudgetRefusal };

function turnDeadlineMs(): number {
  const loaded = loadChatLLMConfig();
  return loaded.ok ? loaded.config.turnTimeoutMs : 300_000;
}

/**
 * Admit a turn against every applicable cap and reserve its first slice.
 * No cap configured anywhere → an unlimited budget, no database writes.
 */
export async function admitChatTurn(input: {
  workspaceId: string;
  userId: string;
  sessionId: string | null;
  turnId: string;
}): Promise<AdmissionResult> {
  const loaded = loadChatBudgetConfig();
  if (!loaded.ok) {
    return {
      ok: false,
      refusal: {
        code: 'CHAT_BUDGET_MISCONFIGURED',
        status: 503,
        message: 'Chat budgets are misconfigured on this server, so chat is disabled until an operator fixes them.',
        details: { issues: loaded.issues },
      },
    };
  }
  const config = loaded.config;
  const effective = await resolveEffectiveBudget(input.workspaceId, input.userId, config);
  if (!hasAnyLimit(effective)) return { ok: true, budget: TurnBudget.unlimited(input.workspaceId, input.userId) };

  const period = budgetPeriod();
  const priceable = chatCostPriceable();
  const warnings: BudgetWarning[] = [];
  if (hasUsdLimit(effective) && !priceable) {
    if (effective.unknownCostPolicy === 'block') return { ok: false, refusal: costUnknownRefusal(period.end) };
    warnings.push({
      code: 'CHAT_BUDGET_COST_UNKNOWN',
      message: 'This model has no configured price, so the USD chat budget cannot limit this reply. Token caps still apply.',
      details: { policy: 'allow' },
    });
  }

  const dimensions: BudgetDimension[] = [];
  if (hasUsdLimit(effective)) dimensions.push('usd');
  if (hasTokenLimit(effective)) dimensions.push('tokens');

  return prisma.$transaction(async (tx) => {
    await lockWorkspaceBudget(tx, input.workspaceId);
    const measured = await measure(tx, input.workspaceId, input.userId, period.start);
    let reserveUsd = hasUsdLimit(effective) && priceable ? config.turnReserveUsd : 0;
    let reserveTokens = hasTokenLimit(effective) ? config.turnReserveTokens : 0;
    let tightestRatio = 0;
    let tightestCheck: CapCheck | null = null;
    for (const check of capsOf(effective, dimensions)) {
      const scopeMeasured = measured[check.scope];
      const room = headroom(check.cap.value, scopeMeasured, check.dimension);
      if (room <= 0) return { ok: false as const, refusal: exceeded(check.scope, check.dimension, check.cap, scopeMeasured, period.end) };
      if (check.dimension === 'usd' && reserveUsd > 0) reserveUsd = Math.min(reserveUsd, room);
      if (check.dimension === 'tokens') reserveTokens = Math.min(reserveTokens, room);
      const ratio = check.cap.value > 0 ? (check.cap.value - room) / check.cap.value : 1;
      if (ratio > tightestRatio) {
        tightestRatio = ratio;
        tightestCheck = check;
      }
      if (check.dimension === 'usd' && scopeMeasured.unknownCostCalls > 0 && !warnings.some((w) => w.code === 'CHAT_BUDGET_COST_UNKNOWN')) {
        warnings.push({
          code: 'CHAT_BUDGET_COST_UNKNOWN',
          message: `${scopeMeasured.unknownCostCalls} chat call${scopeMeasured.unknownCostCalls === 1 ? '' : 's'} this month had no price, so USD spend shown is a lower bound.`,
          details: { scope: check.scope, unknownCostCalls: scopeMeasured.unknownCostCalls, policy: effective.unknownCostPolicy },
        });
      }
    }
    if (tightestCheck && tightestRatio >= config.warnAt) {
      warnings.push({
        code: 'CHAT_BUDGET_NEARLY_EXHAUSTED',
        message: `${tightestCheck.scope === 'workspace' ? "This workspace's" : 'Your'} monthly chat ${tightestCheck.dimension === 'usd' ? 'spending' : 'token'} budget is ${Math.min(100, Math.round(tightestRatio * 100))}% used.`,
        details: {
          scope: tightestCheck.scope,
          dimension: tightestCheck.dimension,
          ...(tightestCheck.scope === 'user' ? { limit: tightestCheck.cap.value } : {}),
          resetsAt: period.end.toISOString(),
        },
      });
    }
    const expiresAt = new Date(Date.now() + turnDeadlineMs() + RESERVATION_GRACE_MS);
    const row = await tx.chatBudgetReservation.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        periodStart: period.start,
        reservedUsd: new Prisma.Decimal(roundUsd(reserveUsd).toFixed(6)),
        reservedTokens: Math.floor(reserveTokens),
        expiresAt,
      },
      select: { id: true },
    });
    return {
      ok: true as const,
      budget: TurnBudget.limited({
        workspaceId: input.workspaceId,
        userId: input.userId,
        effective,
        config,
        priceable,
        period,
        reservation: { id: row.id, reservedUsd: roundUsd(reserveUsd), reservedTokens: Math.floor(reserveTokens), consumedUsd: 0, consumedTokens: 0, unknownCostCalls: 0 },
        warnings,
      }),
    };
  });
}

// ─── Status (GET /api/usage/models) ───────────────────────────────────────────

export interface BudgetDimensionStatus {
  limit: number;
  source: BudgetLimitSource;
  spent: number;
  held: number;
  remaining: number;
  /** `partial` when some calls had no price (USD) or reported no tokens: `spent` is a lower bound. */
  coverage: 'complete' | 'partial';
  /** Calls with unknown cost (USD) or without reported tokens (tokens). */
  uncountedCalls: number;
}

export type BudgetState = 'unlimited' | 'ok' | 'warning' | 'exceeded';

export interface BudgetScopeStatus {
  usd: BudgetDimensionStatus | null;
  tokens: BudgetDimensionStatus | null;
  state: BudgetState;
  /**
   * False when the amounts are withheld: workspace-wide spend is shown to
   * owners/admins only (members see the state). `usd`/`tokens` are then null.
   */
  amountsVisible: boolean;
}

export interface ChatBudgetStatus {
  workspaceId: string;
  period: { start: string; end: string };
  unknownCostPolicy: UnknownCostPolicy;
  /** Whether the configured chat model can be priced (USD caps enforceable). */
  costPriceable: boolean;
  workspace: BudgetScopeStatus;
  user: BudgetScopeStatus;
  /** The worst of the two scopes. */
  state: BudgetState;
  /** Operator defaults, for display ("set by the server"). */
  defaults: Pick<ChatBudgetConfig, 'workspaceMonthlyUsd' | 'workspaceMonthlyTokens' | 'userMonthlyUsd' | 'userMonthlyTokens' | 'unknownCostPolicy'>;
}

const STATE_ORDER: Record<BudgetState, number> = { unlimited: 0, ok: 1, warning: 2, exceeded: 3 };

function worst(...states: BudgetState[]): BudgetState {
  return states.reduce((acc, state) => (STATE_ORDER[state] > STATE_ORDER[acc] ? state : acc), 'unlimited' as BudgetState);
}

function dimensionStatus(cap: BudgetLimit | null, measured: Measured, dimension: BudgetDimension): BudgetDimensionStatus | null {
  if (!cap) return null;
  const spent = dimension === 'usd' ? measured.spentUsd : measured.spentTokens;
  const held = dimension === 'usd' ? measured.heldUsd : measured.heldTokens;
  const uncounted = dimension === 'usd' ? measured.unknownCostCalls : measured.unreportedCalls;
  const remaining = dimension === 'usd' ? roundUsd(cap.value - spent - held) : cap.value - spent - held;
  return {
    limit: cap.value,
    source: cap.source,
    spent,
    held,
    remaining: Math.max(0, remaining),
    coverage: uncounted > 0 ? 'partial' : 'complete',
    uncountedCalls: uncounted,
  };
}

function dimensionState(status: BudgetDimensionStatus | null, warnAt: number): BudgetState {
  if (!status) return 'unlimited';
  if (status.remaining <= 0) return 'exceeded';
  return status.limit > 0 && (status.spent + status.held) / status.limit >= warnAt ? 'warning' : 'ok';
}

function scopeStatus(budget: EffectiveBudget, scope: BudgetScope, measured: Measured, warnAt: number, amountsVisible: boolean): BudgetScopeStatus {
  const usd = dimensionStatus(budget[scope].usd, measured, 'usd');
  const tokens = dimensionStatus(budget[scope].tokens, measured, 'tokens');
  const state = worst(dimensionState(usd, warnAt), dimensionState(tokens, warnAt));
  return amountsVisible ? { usd, tokens, state, amountsVisible } : { usd: null, tokens: null, state, amountsVisible };
}

/**
 * Budget status of `userId` in `workspaceId` this month. Null when the user is
 * not a member or budgets are misconfigured. Workspace-wide amounts are only
 * included for owners/admins.
 */
export async function chatBudgetStatus(workspaceId: string, userId: string): Promise<ChatBudgetStatus | null> {
  const loaded = loadChatBudgetConfig();
  if (!loaded.ok) return null;
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  const config = loaded.config;
  const effective = await resolveEffectiveBudget(workspaceId, userId, config);
  const period = budgetPeriod();
  const measured = await measure(prisma, workspaceId, userId, period.start);
  const admin = membership.role === 'owner' || membership.role === 'admin';
  const workspace = scopeStatus(effective, 'workspace', measured.workspace, config.warnAt, admin);
  const user = scopeStatus(effective, 'user', measured.user, config.warnAt, true);
  return {
    workspaceId,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    unknownCostPolicy: effective.unknownCostPolicy,
    costPriceable: chatCostPriceable(),
    workspace,
    user,
    state: worst(workspace.state, user.state),
    defaults: {
      workspaceMonthlyUsd: config.workspaceMonthlyUsd,
      workspaceMonthlyTokens: config.workspaceMonthlyTokens,
      userMonthlyUsd: config.userMonthlyUsd,
      userMonthlyTokens: config.userMonthlyTokens,
      unknownCostPolicy: config.unknownCostPolicy,
    },
  };
}
