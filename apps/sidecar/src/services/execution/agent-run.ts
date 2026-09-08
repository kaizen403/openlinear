import { Prisma, prisma } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';
import { logActivity } from '@openlinear/api/activity';

import type { ExecutionState } from './state';

export type AgentRunFinalStatus = 'succeeded' | 'failed' | 'cancelled';

export async function createAgentRun(params: {
  taskId: string;
  userId: string | null;
  agent: string;
  model: string;
}): Promise<string | null> {
  try {
    const row = await prisma.agentRun.create({
      data: {
        taskId: params.taskId,
        userId: params.userId,
        agent: params.agent,
        model: params.model,
        status: 'running',
      },
      select: { id: true },
    });

    if (params.userId) {
      const taskScope = await prisma.task.findUnique({
        where: { id: params.taskId },
        select: { teamId: true, projectId: true },
      });
      await logActivity({
        taskId: params.taskId,
        teamId: taskScope?.teamId ?? null,
        projectId: taskScope?.projectId ?? null,
        userId: params.userId,
        action: 'agent_run_started',
        payload: { agentRunId: row.id, agent: params.agent, model: params.model },
      });
    }

    return row.id;
  } catch (err) {
    logger.error(
      { err, taskId: params.taskId },
      '[AgentRun] failed to create row — execution will continue without capture',
    );
    return null;
  }
}

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
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): void {
  state.messageUsage.set(messageId, snapshot);
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

export async function finalizeAgentRun(
  state: ExecutionState,
  status: AgentRunFinalStatus,
  extra: { prUrl?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  if (!state.agentRunId) return;
  try {
    const data: Prisma.AgentRunUpdateInput = {
      endedAt: new Date(),
      status,
    };
    if (state.cost.total > 0) {
      data.costUsd = new Prisma.Decimal(state.cost.total.toFixed(6));
    }
    if (state.tokens.input > 0) data.inputTokens = state.tokens.input;
    if (state.tokens.output > 0) data.outputTokens = state.tokens.output;
    if (extra.prUrl) data.prUrl = extra.prUrl;
    if (extra.errorMessage) data.errorMessage = extra.errorMessage.slice(0, 1000);

    await prisma.agentRun.update({
      where: { id: state.agentRunId },
      data,
    });

    if (state.userId) {
      const taskScope = await prisma.task.findUnique({
        where: { id: state.taskId },
        select: { teamId: true, projectId: true },
      });
      // T8 (H-06) — `AgentRun` has no columns for reasoning or cache-split
      // tokens (only `inputTokens`/`outputTokens`/`costUsd`). Rather than
      // change the schema (owned by another workstream), record what we
      // have in the activity log's JSON payload so the data isn't discarded
      // — the columns to add, when that migration lands, are
      // `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` (all `Int?`).
      await logActivity({
        taskId: state.taskId,
        teamId: taskScope?.teamId ?? null,
        projectId: taskScope?.projectId ?? null,
        userId: state.userId,
        action: 'agent_run_completed',
        payload: {
          agentRunId: state.agentRunId,
          status,
          ...(extra.prUrl ? { prUrl: extra.prUrl } : {}),
          ...(extra.errorMessage ? { errorMessage: extra.errorMessage.slice(0, 500) } : {}),
          ...(state.tokens.reasoning > 0 ? { reasoningTokens: state.tokens.reasoning } : {}),
          ...(state.tokens.cacheRead > 0 ? { cacheReadTokens: state.tokens.cacheRead } : {}),
          ...(state.tokens.cacheWrite > 0 ? { cacheWriteTokens: state.tokens.cacheWrite } : {}),
        },
      });
    }
  } catch (err) {
    logger.error(
      { err, taskId: state.taskId, agentRunId: state.agentRunId, status },
      '[AgentRun] failed to finalize row',
    );
  }
}
