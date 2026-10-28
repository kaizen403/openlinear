import { logger } from '../../lib/logger';
import { getSidecarStore } from '../../persistence/store';

import type { ExecutionState } from './state';

export type AgentRunFinalStatus = 'succeeded' | 'failed' | 'cancelled';

// W03a: the AgentRun row is created by the attempt claim (lifecycle.ts →
// SidecarStore.claimAttempt), atomically with the in_progress transition.

/**
 * T8 (H-06) — wired to the `message.updated` event (see
 * event-stream-processor.ts / events.ts). Previously this had zero
 * production call sites, so `AgentRun.costUsd`/`inputTokens`/`outputTokens`
 * were always null and the entire cost/usage surface showed zeros.
 *
 * `message.updated` reports per-message TOTALS-to-date, not deltas, so we
 * keep the latest snapshot per assistant messageId and re-sum on every call
 * — repeated updates for the same streaming message never double-count.
 */
export function recordMessageUsage(
  state: ExecutionState,
  messageId: string,
  snapshot: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): void {
  state.messageUsage.set(messageId, {
    cost: snapshot.cost,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    reasoningTokens: snapshot.reasoningTokens ?? 0,
    cacheReadTokens: snapshot.cacheReadTokens ?? 0,
    cacheWriteTokens: snapshot.cacheWriteTokens ?? 0,
  });
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const v of state.messageUsage.values()) {
    totalCost += v.cost;
    inputTokens += v.inputTokens;
    outputTokens += v.outputTokens;
    reasoningTokens += v.reasoningTokens;
    cacheReadTokens += v.cacheReadTokens;
    cacheWriteTokens += v.cacheWriteTokens;
  }
  state.cost.total = totalCost;
  state.cost.input = 0;
  state.cost.output = 0;
  state.tokens.input = inputTokens;
  state.tokens.output = outputTokens;
  state.tokens.reasoning = reasoningTokens;
  state.tokens.cacheRead = cacheReadTokens;
  state.tokens.cacheWrite = cacheWriteTokens;
}

/** Usage fields the run finalization carries, mirroring the legacy row write. */
export function buildRunUsage(state: Pick<ExecutionState, 'cost' | 'tokens' | 'messageUsage'>) {
  return {
    ...(state.cost.total > 0 ? { costUsd: Number(state.cost.total.toFixed(6)) } : {}),
    ...(state.tokens.input > 0 ? { inputTokens: state.tokens.input } : {}),
    ...(state.tokens.output > 0 ? { outputTokens: state.tokens.output } : {}),
    ...(state.messageUsage.size > 0 ? {
      cachedInputTokens: state.tokens.cacheRead,
      cacheWriteTokens: state.tokens.cacheWrite,
      reasoningTokens: state.tokens.reasoning,
      costBasis: 'opencode.message.updated',
    } : {}),
  };
}

export async function finalizeAgentRun(
  state: ExecutionState,
  status: AgentRunFinalStatus,
  extra: { prUrl?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  if (!state.agentRunId) return;
  try {
    // Usage snapshot. The store writes the AgentRun row (Prisma mode) or the
    // attempt's run callback (API mode: `succeeded` requires the confirmed
    // done projection, `cancelled` a positive stop receipt) and records the
    // `agent_run_completed` activity, including the reasoning/cache split.
    const store = await getSidecarStore();
    await store.finalizeRun(state.attempt ?? null, {
      taskId: state.taskId,
      userId: state.userId,
      agentRunId: state.agentRunId,
      status,
      usage: buildRunUsage(state),
      ...(extra.prUrl ? { prUrl: extra.prUrl } : {}),
      ...(extra.errorMessage ? { errorMessage: extra.errorMessage.slice(0, 1000) } : {}),
    });
  } catch (err) {
    logger.error(
      { err, taskId: state.taskId, agentRunId: state.agentRunId, status },
      '[AgentRun] failed to finalize row',
    );
  }
}
