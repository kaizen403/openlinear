/**
 * Stored chat history as clients replay it (`GET /api/chat/sessions/:id`).
 *
 * Besides the raw rows, a page carries what a client needs to render the
 * transcript truthfully after a reload (W18a):
 *  - on assistant rows that announced tool calls, `toolCallStates`: each
 *    call's effect class and journal outcome, including outcomes reconciled
 *    after a call was reported as `TOOL_OUTCOME_UNKNOWN`. The stored `tool`
 *    row keeps what the model saw; the journal holds what really happened;
 *  - row columns `incomplete`, `errorCode`, `finishReason` (a turn that ended
 *    early) and `usage` (the turn's usage, on its last assistant row);
 *  - session-level `confirmations` (pending / used / revoked / expired),
 *    `usage` totals from the model ledger (every chat call in the session,
 *    titles and failed attempts included) and the `activeTurn`, if a turn is
 *    running on any replica.
 */
import { prisma, type ChatMessage } from '@openlinear/db';
import { listSessionConfirmations, type ConfirmationSummary } from './chat-tools/confirmations';
import { isRecord, type ToolEffect, type ToolResult } from './chat-tools/types';
import { activeTurnLease } from './chat-turn-lease';
import { summarizeModelUsage, type ModelUsageTotals } from './model-usage';

export type ToolCallJournalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ToolCallState {
  /** Provider-visible id, as in the assistant row's `toolCalls[].id`. */
  toolCallId: string;
  toolName: string;
  effect: ToolEffect | null;
  status: ToolCallJournalStatus;
  /** Result code (`OK`, `TOOL_OUTCOME_UNKNOWN`, `CONFIRMATION_REQUIRED`, …); null while running. */
  code: string | null;
  /** The journal recorded the real outcome after the call was reported as outcome-unknown. */
  reconciled: boolean;
  /** What interrupted the call before it was reconciled. */
  reconciledAfter: string | null;
  endedAt: string | null;
  /** The recorded result, for reconciled calls only (others are in the `tool` row). */
  result?: ToolResult;
}

export type HistoryMessage = ChatMessage & { toolCallStates?: ToolCallState[] };

const EFFECTS: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'external']);

function asEffect(value: string | null): ToolEffect | null {
  return value !== null && EFFECTS.has(value) ? (value as ToolEffect) : null;
}

function asResult(value: unknown): ToolResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.code !== 'string' || typeof value.message !== 'string') return null;
  return {
    ok: value.ok,
    code: value.code,
    message: value.message,
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
}

/** Journal states of the calls announced by `assistantIds`, keyed by assistant message id. */
export async function toolCallStatesFor(sessionId: string, assistantIds: string[]): Promise<Map<string, ToolCallState[]>> {
  const states = new Map<string, ToolCallState[]>();
  if (assistantIds.length === 0) return states;
  const rows = await prisma.chatToolCall.findMany({
    where: { sessionId, messageId: { in: assistantIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      messageId: true,
      toolCallId: true,
      providerToolCallId: true,
      toolName: true,
      effect: true,
      status: true,
      errorCode: true,
      output: true,
      endedAt: true,
    },
  });
  for (const row of rows) {
    if (!row.messageId) continue;
    const result = asResult(row.output);
    const details = result && isRecord(result.details) ? result.details : null;
    const reconciledAfter = details && typeof details.reconciledAfter === 'string' ? details.reconciledAfter : null;
    const state: ToolCallState = {
      toolCallId: row.providerToolCallId ?? row.toolCallId,
      toolName: row.toolName,
      effect: asEffect(row.effect),
      status: row.status,
      code: result?.code ?? row.errorCode ?? null,
      reconciled: reconciledAfter !== null,
      reconciledAfter,
      endedAt: row.endedAt?.toISOString() ?? null,
      ...(reconciledAfter !== null && result ? { result } : {}),
    };
    const list = states.get(row.messageId) ?? [];
    list.push(state);
    states.set(row.messageId, list);
  }
  return states;
}

/** Attach `toolCallStates` to assistant rows that announced tool calls. */
export async function withToolCallStates(sessionId: string, messages: ChatMessage[]): Promise<HistoryMessage[]> {
  const assistantIds = messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
    .map((message) => message.id);
  const states = await toolCallStatesFor(sessionId, assistantIds);
  return messages.map((message) => {
    const list = states.get(message.id);
    return list ? { ...message, toolCallStates: list } : message;
  });
}

export interface SessionHistoryExtras {
  confirmations: ConfirmationSummary[];
  /** Ledger totals for every chat model call of the session (all turns, titles, failed attempts). */
  usage: ModelUsageTotals;
  /** A turn currently holding the session lease, on any replica. */
  activeTurn: { turnId: string; expiresAt: string } | null;
}

export async function sessionHistoryExtras(session: { id: string; userId: string; createdAt: Date }): Promise<SessionHistoryExtras> {
  const [confirmations, usage, active] = await Promise.all([
    listSessionConfirmations(session.id),
    summarizeModelUsage({ userId: session.userId, since: session.createdAt, sessionId: session.id }, 0),
    activeTurnLease(session.id),
  ]);
  return {
    confirmations,
    usage: usage.totals,
    activeTurn: active ? { turnId: active.turnId, expiresAt: active.expiresAt.toISOString() } : null,
  };
}
