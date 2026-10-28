import { Prisma, prisma } from '@openlinear/db';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, userTarget } from '../events/targets';
import {
  ChatLLMError,
  getChatLLMClient,
  isContextOverflowError,
  type ChatLLMAttemptFailure,
  type ChatLLMClient,
  type ChatLLMContentPart,
  type ChatLLMEvent,
  type ChatLLMMessage,
  type ChatLLMToolCall,
  type ChatLLMUsage,
} from '../lib/chat-llm';
import { loadChatLLMConfig } from '../lib/chat-llm-config';
import { buildChatSummaryMessage, buildChatSystemMessage, CHAT_TITLE_PROMPT } from '../lib/chat-prompts';
import type { CostBasis } from '../lib/llm-usage';
import { assertProjectAccess } from './ownership';
import { assertWorkspaceRole } from './workspaces';
import { dispatchTool, getOpenAIFunctionSpecs, getToolEffect, getToolSpecsHash, journalRejectedToolCall } from './chat-tools';
import { collectUserConfirmations } from './chat-tools/confirmations';
import {
  abortCodeFor,
  ChatTurnDeadlineError,
  fail,
  isRecord,
  toJsonInput,
  type JsonObject,
  type ToolContext,
  type ToolEffect,
  type ToolReconciliation,
  type ToolResult,
} from './chat-tools/types';
import { compactToolContent, historyToLLM, loadHistoryWindow, MonotonicClock, stablePrefixHash, trimMessagesForOverflow } from './chat-context';
import { recordModelUsage, type UsageSurface, type UsageStatus } from './model-usage';
import { acquireTurnLease, isTurnLeaseLostError, turnInProgressError, type TurnLease } from './chat-turn-lease';
import { admitChatTurn, type BudgetConsumption, type BudgetRefusal, type TurnBudget } from './chat-budget';
import { completeMetered, ensureHistorySummary, historySummaryEnabled, type HistorySummary } from './chat-summary';

/** Token/cost totals for one turn, sent on the `done` chunk when usage was reported. */
export interface TurnUsageSummary {
  modelCalls: number;
  /** `complete` when every model call in the turn reported usage. */
  coverage: 'complete' | 'partial';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Null when any call's cost is unknown; never a guessed zero. */
  costUsd: number | null;
  costBasis: CostBasis | 'mixed';
}

/**
 * SSE chunks of one chat turn (`POST /api/chat/sessions/:id/messages`).
 *
 * Tool events carry the tool's `effect` class (null for an unknown tool) and
 * the id of the stored assistant message that announced the call, so clients
 * need no local copy of the tool catalogue and can match later outcome
 * updates (`tool_reconciled`, history `toolCallStates`) to the call.
 */
export type ChatChunk =
  | { type: 'user_message'; messageId: string; sessionId: string; turnId: string }
  | { type: 'assistant_delta'; content: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; effect: ToolEffect | null; messageId: string; args: JsonObject }
  | { type: 'tool_result'; toolCallId: string; toolName: string; effect: ToolEffect | null; messageId: string; result: ToolResult }
  /** The real outcome of a write that was earlier reported as `TOOL_OUTCOME_UNKNOWN`. */
  | {
      type: 'tool_reconciled';
      toolCallId: string;
      toolName: string;
      effect: ToolEffect;
      messageId: string | null;
      status: 'succeeded' | 'failed';
      result: ToolResult;
      reconciledAfter: string;
      reconciledAt: string;
    }
  | { type: 'confirmation_required'; toolCallId: string; toolName: string; code: string; expiresAt: string; summary: string }
  /** Budget notice that does not stop the turn (unknown cost under `allow`, nearly used up). */
  | { type: 'budget_warning'; code: string; message: string; details?: Record<string, unknown> }
  | { type: 'assistant_final'; messageId: string; content: string; finishReason?: string }
  | { type: 'done'; sessionId: string; usage?: TurnUsageSummary }
  | { type: 'error'; code: string; message: string; details?: unknown };

type ErrorChunk = Extract<ChatChunk, { type: 'error' }>;

export interface RunChatTurnInput {
  sessionId: string;
  userId: string;
  userMessage: string;
  attachmentIds?: string[];
  /** Confirmation codes the client sent with the message (structured approval). */
  confirmationTokens?: string[];
  abortSignal?: AbortSignal;
  /**
   * Session lease acquired by the caller (`prepareChatTurn`). Ownership moves
   * to the turn, which releases it when it ends. Without one, the turn
   * acquires its own and ends with `TURN_IN_PROGRESS` when the session is busy.
   */
  lease?: TurnLease;
  /** Budget reservation from `prepareChatTurn`; settled by the turn. Admitted here when absent. */
  budget?: TurnBudget;
}

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

interface ChatRuntimeLimits {
  turnTimeoutMs: number;
  maxToolRounds: number;
}

function runtimeLimits(): ChatRuntimeLimits {
  const loaded = loadChatLLMConfig();
  return loaded.ok
    ? { turnTimeoutMs: loaded.config.turnTimeoutMs, maxToolRounds: loaded.config.maxToolRounds }
    : { turnTimeoutMs: 300_000, maxToolRounds: 16 };
}

type ParsedArguments = { ok: true; args: JsonObject } | { ok: false; reason: string };

/** Malformed arguments are refused, never silently replaced with `{}`. */
function parseToolArguments(raw: string): ParsedArguments {
  if (!raw.trim()) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ok: true, args: parsed } : { ok: false, reason: 'arguments must be a JSON object' };
  } catch {
    return { ok: false, reason: 'arguments are not valid JSON' };
  }
}

async function loadSessionForTurn(sessionId: string, userId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, archivedAt: null },
    select: { id: true, userId: true, workspaceId: true, projectId: true, title: true },
  });
  if (!session) return null;
  await assertWorkspaceRole(session.workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
  if (session.projectId) await assertProjectAccess(session.projectId, userId, 'view');
  return session;
}

type TurnSession = NonNullable<Awaited<ReturnType<typeof loadSessionForTurn>>>;

async function buildMessages(session: TurnSession, summary: HistorySummary | null = null): Promise<ChatLLMMessage[]> {
  const rows = await loadHistoryWindow(session.id);
  return [
    buildChatSystemMessage({ userId: session.userId, workspaceId: session.workspaceId, projectId: session.projectId }),
    // Older turns that left the window, summarised (optional compaction).
    ...(summary ? [buildChatSummaryMessage(summary.content)] : []),
    ...historyToLLM(rows),
  ];
}

/**
 * Tool calls in transcript order. Provider ids are kept for the transcript
 * (the model sees its own ids), except when missing or repeated within this
 * turn; then a turn-scoped id is used. Replay protection never relies on these
 * ids: dispatch is keyed by `<turnId>:<round>:<index>`.
 */
function accumulatedToToolCalls(
  calls: AccumulatedToolCall[],
  round: number,
  turnId: string,
  usedIds: Set<string>,
): ChatLLMToolCall[] {
  return calls
    .sort((a, b) => a.index - b.index)
    .filter((call) => Boolean(call.name))
    .map((call) => {
      const id = call.id && !usedIds.has(call.id) ? call.id : `${turnId}_${round}_${call.index}`;
      usedIds.add(id);
      return {
        id,
        type: 'function' as const,
        function: {
          name: call.name ?? 'unknown',
          arguments: call.arguments,
        },
      };
    });
}

function providerLabel(client: ChatLLMClient): string {
  return client.provider ?? 'unknown';
}

/**
 * Meters every model attempt of a turn (W15) and keeps the per-turn totals
 * reported on the `done` chunk.
 */
class TurnMeter {
  private calls = 0;
  private callsWithUsage = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens: number | null = null;
  private cacheWriteTokens: number | null = null;
  private reasoningTokens: number | null = null;
  private knownCostUsd = 0;
  private costUnknown = false;
  private readonly bases = new Set<CostBasis>();

  constructor(private readonly base: {
    client: ChatLLMClient;
    surface: UsageSurface;
    userId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    promptHash?: string;
    toolsHash?: string;
    /** Budget accounting for each recorded attempt (W15 reservations). */
    onRecorded?: (entry: BudgetConsumption) => Promise<void>;
  }) {}

  private async record(input: {
    invocationId: string;
    round: number | null;
    attempt: number;
    status: UsageStatus;
    usage: ChatLLMUsage | null;
    latencyMs?: number;
    firstTokenMs?: number;
    finishReason?: string;
    errorCode?: string;
    providerRequestId?: string;
    model?: string;
  }): Promise<void> {
    const recorded = await recordModelUsage({
      invocationId: input.invocationId,
      surface: this.base.surface,
      provider: providerLabel(this.base.client),
      model: input.model ?? this.base.client.model,
      userId: this.base.userId,
      workspaceId: this.base.workspaceId,
      sessionId: this.base.sessionId,
      turnId: this.base.turnId,
      round: input.round,
      attempt: input.attempt,
      status: input.status,
      finishReason: input.finishReason ?? null,
      errorCode: input.errorCode ?? null,
      usage: input.usage,
      latencyMs: input.latencyMs ?? null,
      firstTokenMs: input.firstTokenMs ?? null,
      promptHash: this.base.promptHash ?? null,
      toolsHash: this.base.toolsHash ?? null,
      providerRequestId: input.providerRequestId ?? null,
    });
    this.calls += 1;
    this.bases.add(recorded.costBasis);
    if (recorded.costUsd === null) this.costUnknown = true;
    else this.knownCostUsd += recorded.costUsd;
    const usage = input.usage;
    const reported = usage && usage.inputTokens !== null && usage.outputTokens !== null ? usage : null;
    if (reported && reported.inputTokens !== null && reported.outputTokens !== null) {
      this.callsWithUsage += 1;
      this.inputTokens += reported.inputTokens;
      this.outputTokens += reported.outputTokens;
      if (reported.cacheReadTokens !== null) this.cacheReadTokens = (this.cacheReadTokens ?? 0) + reported.cacheReadTokens;
      if (reported.cacheWriteTokens !== null) this.cacheWriteTokens = (this.cacheWriteTokens ?? 0) + reported.cacheWriteTokens;
      if (reported.reasoningTokens !== null) this.reasoningTokens = (this.reasoningTokens ?? 0) + reported.reasoningTokens;
    }
    if (this.base.onRecorded) {
      const tokens = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : null;
      await this.base.onRecorded({ status: input.status, costUsd: recorded.costUsd, tokens });
    }
  }

  private invocationId(key: string, attempt: number): string {
    return `${this.base.turnId}:${this.base.surface}:${key}:a${attempt}`;
  }

  /** The ledger key of one attempt (audit records point at it). */
  invocationIdOf(key: string, attempt: number): string {
    return this.invocationId(key, attempt);
  }

  async retried(key: string, round: number | null, failure: ChatLLMAttemptFailure): Promise<void> {
    await this.record({
      invocationId: this.invocationId(key, failure.attempt),
      round,
      attempt: failure.attempt,
      status: 'failed',
      usage: null,
      latencyMs: failure.latencyMs,
      errorCode: failure.code,
      providerRequestId: failure.providerRequestId,
    });
  }

  async failed(key: string, round: number | null, error: unknown, fallbackLatencyMs: number): Promise<void> {
    const llm = error instanceof ChatLLMError ? error : null;
    const final = llm?.info.failures?.at(-1);
    await this.record({
      invocationId: this.invocationId(key, llm?.info.attempts ?? 1),
      round,
      attempt: llm?.info.attempts ?? 1,
      status: llm?.code === 'CLIENT_ABORTED' ? 'aborted' : 'failed',
      usage: null,
      latencyMs: final?.latencyMs ?? fallbackLatencyMs,
      errorCode: llm?.code ?? 'CHAT_TURN_FAILED',
      providerRequestId: final?.providerRequestId,
    });
  }

  async succeeded(key: string, round: number | null, done: Extract<ChatLLMEvent, { type: 'done' }>, fallbackLatencyMs: number): Promise<void> {
    const attempt = done.attempt ?? 1;
    await this.record({
      invocationId: this.invocationId(key, attempt),
      round,
      attempt,
      status: 'succeeded',
      usage: done.usage ?? legacyUsage(done),
      latencyMs: done.latencyMs ?? fallbackLatencyMs,
      firstTokenMs: done.firstTokenMs,
      finishReason: done.finishReason,
      providerRequestId: done.providerRequestId,
      model: done.model,
    });
  }

  summary(): TurnUsageSummary | undefined {
    if (this.callsWithUsage === 0) return undefined;
    const bases = [...this.bases];
    return {
      modelCalls: this.calls,
      coverage: this.callsWithUsage === this.calls ? 'complete' : 'partial',
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      costUsd: this.costUnknown ? null : Math.round(this.knownCostUsd * 1e6) / 1e6,
      costBasis: bases.length === 1 && bases[0] ? bases[0] : 'mixed',
    };
  }
}

/** Test doubles may report only the legacy token fields on `done`. */
function legacyUsage(done: Extract<ChatLLMEvent, { type: 'done' }>): ChatLLMUsage | null {
  if (done.inputTokens === undefined && done.outputTokens === undefined) return null;
  return {
    inputTokens: done.inputTokens ?? null,
    outputTokens: done.outputTokens ?? null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    providerCostUsd: null,
    raw: { prompt_tokens: done.inputTokens ?? null, completion_tokens: done.outputTokens ?? null },
  };
}

async function maybeAutoTitle(input: {
  sessionId: string;
  userId: string;
  workspaceId: string;
  turnId: string;
  userMessage: string;
  assistantMessage: string;
}) {
  const session = await prisma.chatSession.findUnique({
    where: { id: input.sessionId },
    select: { title: true },
  });
  if (!session || session.title !== 'New chat') return;

  const userMessageCount = await prisma.chatMessage.count({
    where: { sessionId: input.sessionId, role: 'user' },
  });
  if (userMessageCount !== 1) return;

  // Off the turn's critical path. Bounded: at most two logical attempts (the
  // client separately retries transient provider failures), every attempt
  // metered as `chat.title`.
  const client = getChatLLMClient();
  const meter = new TurnMeter({
    client,
    surface: 'chat.title',
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  void (async () => {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rawTitle = await generateTitle(client, meter, `t${attempt}`, input);
        const parsed = parseTitleResponse(rawTitle);
        const cleaned = parsed.replace(/["""]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!cleaned) continue;
        // W04b: the title and its event commit together (owner-only audience,
        // as `broadcastToChatSession`).
        await transactionWithEvents(async (tx) => {
          const updated = await tx.chatSession.update({
            where: { id: input.sessionId },
            data: { title: cleaned },
          });
          await appendToTarget(tx, userTarget(updated.userId), 'chat:session:updated', updated, input.userId);
        });
        return;
      } catch (err) {
        logger.warn({ err, sessionId: input.sessionId, attempt }, '[chat] auto-title failed');
      }
    }
  })().catch((err: unknown) => {
    logger.warn({ err, sessionId: input.sessionId }, '[chat] auto-title task failed');
  });
}

async function generateTitle(
  client: ChatLLMClient,
  meter: TurnMeter,
  key: string,
  input: { userMessage: string; assistantMessage: string },
): Promise<string> {
  const titleMessages: ChatLLMMessage[] = [
    { role: 'system', content: CHAT_TITLE_PROMPT },
    { role: 'user', content: `User message:\n${input.userMessage.slice(0, 2000)}\n\nAssistant answer:\n${input.assistantMessage.slice(0, 2000)}` },
  ];
  const completion = await completeMetered(client, meter, key, {
    messages: titleMessages,
    maxTokens: 80,
    streamMaxTokens: 60,
    model: client.titleModel ?? client.model,
    json: true,
  });
  return completion.content;
}

function parseTitleResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && typeof parsed.title === 'string') {
      return parsed.title;
    }
  } catch {
    // Fall through to plain text cleanup for test doubles and older providers.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return parseTitleResponse(fenced[1]);
  const titleMatch = trimmed.match(/"title"\s*:\s*"([^"]+)"/i);
  if (titleMatch?.[1]) return titleMatch[1];
  return trimmed.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

const LEASE_LOST_CHUNK: ErrorChunk = {
  type: 'error',
  code: 'TURN_LEASE_LOST',
  message: 'Another reply took over this chat, so this reply stopped. Reload the chat to see what was saved.',
};

function interruptedChunk(signal: AbortSignal): ErrorChunk {
  switch (abortCodeFor(signal)) {
    case 'TURN_TIMEOUT':
      return { type: 'error', code: 'TURN_TIMEOUT', message: 'The chat turn exceeded its time limit' };
    case 'TURN_LEASE_LOST':
      return LEASE_LOST_CHUNK;
    default:
      return { type: 'error', code: 'CLIENT_ABORTED', message: 'Chat request was aborted' };
  }
}

function refusalChunk(refusal: BudgetRefusal): ErrorChunk {
  return { type: 'error', code: refusal.code, message: refusal.message, details: refusal.details };
}

function providerErrorToChunk(error: unknown, signal: AbortSignal): ErrorChunk {
  if (signal.aborted) return interruptedChunk(signal);
  if (error instanceof ChatLLMError) {
    const details = {
      ...(error.info.httpStatus !== undefined ? { httpStatus: error.info.httpStatus } : {}),
      ...(error.info.attempts !== undefined ? { attempts: error.info.attempts } : {}),
      ...(error.info.retryAfterMs !== undefined ? { retryAfterSeconds: Math.ceil(error.info.retryAfterMs / 1000) } : {}),
      ...(error.info.providerMessage ? { providerMessage: error.info.providerMessage } : {}),
    };
    return { type: 'error', code: error.code, message: error.message, ...(Object.keys(details).length > 0 ? { details } : {}) };
  }
  if (error instanceof Error) {
    return { type: 'error', code: 'CHAT_TURN_FAILED', message: error.message };
  }
  return { type: 'error', code: 'CHAT_TURN_FAILED', message: 'Chat turn failed' };
}

/**
 * Wrap third-party content so the model can tell data from instructions.
 *
 * Attachment text and workspace records are authored by other people. They were
 * previously spliced into the prompt as plain text, which is indistinguishable
 * from a user instruction. The closing tag is escaped so content cannot break
 * out of its own envelope.
 */
function untrusted(source: string, kind: string, body: string): string {
  const safe = body.replace(/<\/?untrusted/gi, '&lt;untrusted');
  return `<untrusted source="${source}" kind="${kind}">\n${safe}\n</untrusted>`;
}

async function attachmentParts(userMessage: string, attachmentIds: string[], userId: string): Promise<ChatLLMContentPart[]> {
  const attachments = await prisma.chatAttachment.findMany({
    where: { id: { in: attachmentIds }, userId },
  });
  const contentParts: ChatLLMContentPart[] = [{ type: 'text', text: userMessage }];
  for (const att of attachments) {
    const filePath = path.resolve(process.cwd(), att.url.replace(/^\//, ''));
    if (att.mimeType.startsWith('image/')) {
      try {
        const data = await fs.readFile(filePath);
        const b64 = data.toString('base64');
        contentParts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${b64}`, detail: 'auto' } });
      } catch { /* skip unreadable */ }
    } else if (att.mimeType === 'application/pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const data = await fs.readFile(filePath);
        const parser = new PDFParse({ data });
        const result = await parser.getText();
        contentParts.push({ type: 'text', text: untrusted(`file:${att.filename}`, 'pdf', result.text.slice(0, 10000)) });
      } catch { /* skip unreadable */ }
    } else {
      try {
        const text = await fs.readFile(filePath, 'utf-8');
        contentParts.push({ type: 'text', text: untrusted(`file:${att.filename}`, 'text', text.slice(0, 50000)) });
      } catch { /* skip unreadable */ }
    }
  }
  return contentParts;
}

/** Turn-wide abort: the client going away, the session lease being lost, or the turn deadline. */
function createTurnSignal(timeoutMs: number, parents: ReadonlyArray<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<{ parent: AbortSignal; onAbort: () => void }> = [];
  for (const parent of parents) {
    if (!parent) continue;
    if (parent.aborted) {
      if (!controller.signal.aborted) controller.abort(parent.reason);
      continue;
    }
    const onAbort = () => {
      if (!controller.signal.aborted) controller.abort(parent.reason);
    };
    parent.addEventListener('abort', onAbort, { once: true });
    listeners.push({ parent, onAbort });
  }
  const timer = setTimeout(() => controller.abort(new ChatTurnDeadlineError()), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      for (const { parent, onAbort } of listeners) parent.removeEventListener('abort', onAbort);
    },
  };
}


export type PreparedChatTurn =
  | { ok: true; turnId: string; lease: TurnLease; budget: TurnBudget }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

/**
 * Admission for a turn, before any byte of the response is sent: become the
 * session's single writer (409 `TURN_IN_PROGRESS` otherwise), then reserve
 * budget (402 `CHAT_BUDGET_EXCEEDED` / `CHAT_BUDGET_COST_UNKNOWN`, 503
 * `CHAT_BUDGET_MISCONFIGURED`). Nothing is stored for a refused turn.
 * On success the caller hands both to `runChatTurn`, which releases them.
 */
export async function prepareChatTurn(input: { sessionId: string; userId: string; workspaceId: string }): Promise<PreparedChatTurn> {
  const turnId = randomUUID();
  const acquired = await acquireTurnLease(input.sessionId, turnId);
  if (!acquired.ok) {
    const refusal = turnInProgressError(acquired.holder);
    return { ok: false, status: 409, ...refusal };
  }
  try {
    const admission = await admitChatTurn({ workspaceId: input.workspaceId, userId: input.userId, sessionId: input.sessionId, turnId });
    if (!admission.ok) {
      await acquired.lease.release();
      const { status, code, message, details } = admission.refusal;
      return { ok: false, status, code, message, details };
    }
    return { ok: true, turnId, lease: acquired.lease, budget: admission.budget };
  } catch (error) {
    await acquired.lease.release();
    throw error;
  }
}

function reconciledChunk(reconciliation: ToolReconciliation): ChatChunk {
  return {
    type: 'tool_reconciled',
    toolCallId: reconciliation.toolCallId,
    toolName: reconciliation.toolName,
    effect: reconciliation.effect,
    messageId: reconciliation.messageId,
    status: reconciliation.status,
    result: reconciliation.result,
    reconciledAfter: reconciliation.reconciledAfter,
    reconciledAt: reconciliation.reconciledAt,
  };
}

type ChatMessageWrite = Omit<Prisma.ChatMessageUncheckedCreateInput, 'sessionId' | 'turnId' | 'createdAt'>;

export async function* runChatTurn(input: RunChatTurnInput): AsyncIterable<ChatChunk> {
  let lease: TurnLease | null = input.lease ?? null;
  let budget: TurnBudget | null = input.budget ?? null;
  // Unique per turn: the tool-call journal, the usage ledger, the lease and
  // the budget reservation key on it.
  const turnId = lease?.turnId ?? randomUUID();
  let turnSignal: { signal: AbortSignal; dispose: () => void } | null = null;
  let stopCode: string | null = null;

  try {
    const session = await loadSessionForTurn(input.sessionId, input.userId);
    if (!session) {
      yield { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Chat session not found' };
      return;
    }
    if (!lease) {
      const acquired = await acquireTurnLease(session.id, turnId);
      if (!acquired.ok) {
        stopCode = 'TURN_IN_PROGRESS';
        yield { type: 'error', ...turnInProgressError(acquired.holder) };
        return;
      }
      lease = acquired.lease;
    }
    if (!budget) {
      const admission = await admitChatTurn({ workspaceId: session.workspaceId, userId: input.userId, sessionId: session.id, turnId });
      if (!admission.ok) {
        stopCode = admission.refusal.code;
        yield refusalChunk(admission.refusal);
        return;
      }
      budget = admission.budget;
    }
    const activeLease = lease;
    const activeBudget = budget;

    // Rows of one turn get strictly increasing timestamps; ties at millisecond
    // precision could otherwise reorder an assistant message and its results.
    const clock = new MonotonicClock();
    // Every transcript write is fenced by the session lease.
    const writeRow = (data: ChatMessageWrite) =>
      activeLease.fenced((tx) => tx.chatMessage.create({ data: { ...data, sessionId: session.id, turnId, createdAt: clock.next() } }));

    let userRowId: string;
    try {
      userRowId = await activeLease.fenced(async (tx) => {
        const row = await tx.chatMessage.create({
          data: { sessionId: session.id, userId: input.userId, role: 'user', content: input.userMessage, turnId, createdAt: clock.next() },
          select: { id: true },
        });
        if (input.attachmentIds?.length) {
          await tx.chatAttachment.updateMany({
            where: { id: { in: input.attachmentIds }, userId: input.userId, messageId: null },
            data: { messageId: row.id },
          });
        }
        return row.id;
      });
    } catch (error) {
      if (!isTurnLeaseLostError(error)) throw error;
      stopCode = LEASE_LOST_CHUNK.code;
      yield LEASE_LOST_CHUNK;
      return;
    }

    yield { type: 'user_message', messageId: userRowId, sessionId: session.id, turnId };
    for (const warning of activeBudget.warnings) yield { type: 'budget_warning', ...warning };

    const limits = runtimeLimits();
    turnSignal = createTurnSignal(limits.turnTimeoutMs, [input.abortSignal, activeLease.signal]);
    const signal = turnSignal.signal;
    const client = getChatLLMClient();
    const tools = getOpenAIFunctionSpecs();
    const meter = new TurnMeter({
      client,
      surface: 'chat.turn',
      userId: input.userId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      turnId,
      promptHash: stablePrefixHash(tools),
      toolsHash: getToolSpecsHash(),
      onRecorded: (entry) => activeBudget.consume(entry),
    });
    const userConfirmations = collectUserConfirmations(input.userMessage, input.confirmationTokens);
    const usedToolCallIds = new Set<string>();

    // Late outcomes of interrupted writes, forwarded while the stream is open.
    const reconciled: ToolReconciliation[] = [];
    const onReconciled = (reconciliation: ToolReconciliation) => {
      reconciled.push(reconciliation);
    };
    const drainReconciled = (): ChatChunk[] => reconciled.splice(0).map(reconciledChunk);

    let lastAssistantRowId: string | null = null;

    /**
     * End the turn early: record in history that the turn's last reply is
     * incomplete and why (partial text kept), then return the chunks to send.
     * Writes happen before anything is yielded, so a consumer that stops
     * reading at the error cannot skip them.
     */
    const endEarly = async (chunk: ErrorChunk, partial: string): Promise<ChatChunk[]> => {
      stopCode = chunk.code;
      const summary = meter.summary();
      const usage = summary ? toJsonInput(summary) : Prisma.DbNull;
      try {
        if (partial.trim()) {
          const row = await writeRow({ role: 'assistant', content: partial, incomplete: true, errorCode: chunk.code, usage });
          lastAssistantRowId = row.id;
        } else if (lastAssistantRowId) {
          const rowId = lastAssistantRowId;
          await activeLease.fenced((tx) => tx.chatMessage.update({ where: { id: rowId }, data: { incomplete: true, errorCode: chunk.code, usage } }));
        } else {
          // No reply row yet: an empty marker, so history shows the failure.
          await writeRow({ role: 'assistant', content: null, incomplete: true, errorCode: chunk.code, usage });
        }
      } catch (error) {
        if (!isTurnLeaseLostError(error)) {
          logger.warn({ err: error, sessionId: session.id, turnId }, '[chat] could not mark an interrupted turn in history');
        }
      }
      return [...drainReconciled(), chunk];
    };

    let summary: HistorySummary | null = null;
    if (historySummaryEnabled()) {
      const summaryMeter = new TurnMeter({
        client,
        surface: 'chat.summary',
        userId: input.userId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        turnId,
        onRecorded: (entry) => activeBudget.consume(entry),
      });
      summary = await ensureHistorySummary({
        sessionId: session.id,
        total: await prisma.chatMessage.count({ where: { sessionId: session.id } }),
        turnId,
        client,
        meter: summaryMeter,
        abortSignal: signal,
      });
    }
    let messages = await buildMessages(session, summary);

    if (input.attachmentIds?.length) {
      const contentParts = await attachmentParts(input.userMessage, input.attachmentIds, input.userId);
      if (contentParts.length > 1) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          messages[messages.length - 1] = { ...lastMsg, content: contentParts };
        }
      }
    }

    for (let round = 0; round < limits.maxToolRounds; round += 1) {
      yield* drainReconciled();
      if (signal.aborted) {
        yield* await endEarly(interruptedChunk(signal), '');
        return;
      }
      if (round > 0) {
        // W15: the next model call needs budget headroom.
        const headroom = await activeBudget.ensureHeadroom();
        if (!headroom.ok) {
          yield* await endEarly(refusalChunk(headroom.refusal), '');
          return;
        }
        const warning = activeBudget.takeMidTurnWarning();
        if (warning) yield { type: 'budget_warning', ...warning };
      }

      let assistantContent = '';
      let toolCallMap = new Map<number, AccumulatedToolCall>();
      let done: Extract<ChatLLMEvent, { type: 'done' }> | null = null;
      let roundStartedAt = Date.now();
      let attemptKey = `r${round}o0`;
      let failure: ErrorChunk | null = null;

      // One deterministic trim-and-retry when the provider reports a context
      // overflow; a second overflow is reported to the user.
      for (let overflowAttempt = 0; ; overflowAttempt += 1) {
        const key = `r${round}o${overflowAttempt}`;
        attemptKey = key;
        assistantContent = '';
        toolCallMap = new Map();
        done = null;
        roundStartedAt = Date.now();
        let produced = false;
        try {
          for await (const event of client.streamChatCompletion({
            messages,
            tools,
            toolChoice: 'auto',
            temperature: 0.1,
            abortSignal: signal,
            cacheKey: session.id,
          })) {
            if (event.type === 'delta') {
              produced = true;
              assistantContent += event.content;
              yield { type: 'assistant_delta', content: event.content };
            } else if (event.type === 'tool_call_delta') {
              produced = true;
              const existing = toolCallMap.get(event.index) ?? { index: event.index, arguments: '' };
              toolCallMap.set(event.index, {
                ...existing,
                id: event.id ?? existing.id,
                name: event.name ?? existing.name,
                arguments: existing.arguments + (event.argumentsDelta ?? ''),
              });
            } else if (event.type === 'retry') {
              await meter.retried(key, round, event.failure);
            } else if (event.type === 'done') {
              done = event;
            }
          }
        } catch (error) {
          await meter.failed(key, round, error, Date.now() - roundStartedAt);
          if (isContextOverflowError(error) && !produced && overflowAttempt === 0 && !signal.aborted) {
            const trimmed = trimMessagesForOverflow(messages);
            logger.info(
              { sessionId: session.id, turnId, round, droppedMessages: trimmed.droppedMessages },
              '[chat] context overflow: trimmed the history window and retrying once',
            );
            messages = trimmed.messages;
            continue;
          }
          failure = providerErrorToChunk(error, signal);
        }
        break;
      }

      if (failure) {
        yield* await endEarly(failure, assistantContent);
        return;
      }

      if (!done) {
        // The stream ended without a terminal event: an incomplete answer is
        // not reported as a completed one.
        const truncated = new ChatLLMError('LLM_STREAM_TRUNCATED', 'The model stream ended before the response was complete', 502, { kind: 'stream' });
        await meter.failed(attemptKey, round, truncated, Date.now() - roundStartedAt);
        yield* await endEarly(providerErrorToChunk(truncated, signal), assistantContent);
        return;
      }
      await meter.succeeded(attemptKey, round, done, Date.now() - roundStartedAt);

      const toolCalls = accumulatedToToolCalls(Array.from(toolCallMap.values()), round, turnId, usedToolCallIds);
      if (toolCalls.length > 0 && done.finishReason === 'length') {
        // Output hit the token limit mid tool call: the arguments are
        // incomplete, so nothing is executed.
        yield* await endEarly(
          { type: 'error', code: 'LLM_OUTPUT_TRUNCATED', message: 'The model ran out of output tokens while preparing a tool call; nothing was executed' },
          assistantContent,
        );
        return;
      }

      if (toolCalls.length === 0) {
        const usage = meter.summary();
        const finishReason = done.finishReason && done.finishReason !== 'stop' ? done.finishReason : undefined;
        let assistantId: string;
        try {
          const assistant = await writeRow({
            role: 'assistant',
            content: assistantContent,
            finishReason: done.finishReason ?? null,
            // A reply cut off at the output limit is stored as incomplete.
            incomplete: done.finishReason === 'length',
            usage: usage ? toJsonInput(usage) : Prisma.DbNull,
          });
          assistantId = assistant.id;
        } catch (error) {
          if (!isTurnLeaseLostError(error)) throw error;
          stopCode = LEASE_LOST_CHUNK.code;
          yield* drainReconciled();
          yield LEASE_LOST_CHUNK;
          return;
        }
        yield {
          type: 'assistant_final',
          messageId: assistantId,
          content: assistantContent,
          ...(finishReason ? { finishReason } : {}),
        };
        yield* drainReconciled();
        yield { type: 'done', sessionId: session.id, ...(usage ? { usage } : {}) };
        await maybeAutoTitle({
          sessionId: session.id,
          userId: input.userId,
          workspaceId: session.workspaceId,
          turnId,
          userMessage: input.userMessage,
          assistantMessage: assistantContent,
        });
        return;
      }

      let assistantWithToolsId: string;
      try {
        const assistantWithTools = await writeRow({
          role: 'assistant',
          content: assistantContent || null,
          toolCalls: toJsonInput(toolCalls),
        });
        assistantWithToolsId = assistantWithTools.id;
        lastAssistantRowId = assistantWithTools.id;
      } catch (error) {
        if (!isTurnLeaseLostError(error)) throw error;
        stopCode = LEASE_LOST_CHUNK.code;
        yield LEASE_LOST_CHUNK;
        return;
      }

      messages = [
        ...messages,
        { role: 'assistant', content: assistantContent || null, tool_calls: toolCalls },
      ];

      for (const [index, call] of toolCalls.entries()) {
        const toolName = call.function.name;
        const effect = getToolEffect(toolName);
        const parsed = parseToolArguments(call.function.arguments);
        const args = parsed.ok ? parsed.args : {};
        // Fence the side effect: the lease must still be ours right before the
        // tool runs (the heartbeat keeps it while the tool runs).
        if (signal.aborted || !(await activeLease.renew())) {
          yield* await endEarly(signal.aborted ? interruptedChunk(signal) : LEASE_LOST_CHUNK, '');
          return;
        }
        yield { type: 'tool_call_start', toolCallId: call.id, toolName, effect, messageId: assistantWithToolsId, args };
        const ctx: ToolContext = {
          userId: input.userId,
          sessionId: session.id,
          workspaceId: session.workspaceId,
          projectId: session.projectId,
          toolCallId: call.id,
          journalKey: `${turnId}:${round}:${index}`,
          turnId,
          messageId: assistantWithToolsId,
          abortSignal: signal,
          userConfirmations,
          onReconciled,
        };
        let result: ToolResult;
        if (parsed.ok) {
          result = await dispatchTool(toolName, ctx, args);
        } else {
          result = fail('INVALID_TOOL_ARGUMENTS', `The ${toolName} call was not executed: its ${parsed.reason}. Retry with a valid JSON object.`);
          await journalRejectedToolCall(ctx, toolName, { rawArguments: call.function.arguments.slice(0, 2000) }, result);
        }
        yield { type: 'tool_result', toolCallId: call.id, toolName, effect, messageId: assistantWithToolsId, result };
        const details = isRecord(result.details) ? result.details : null;
        const confirmation = result.code === 'CONFIRMATION_REQUIRED' && details && isRecord(details.confirmation) ? details.confirmation : null;
        if (confirmation && typeof confirmation.code === 'string' && typeof confirmation.expiresAt === 'string') {
          // Additive SSE event so a client can render an explicit confirm control.
          yield {
            type: 'confirmation_required',
            toolCallId: call.id,
            toolName,
            code: confirmation.code,
            expiresAt: confirmation.expiresAt,
            summary: typeof details?.summary === 'string' ? details.summary : result.message,
          };
        }
        let toolContent: string;
        try {
          const toolMessage = await writeRow({
            role: 'tool',
            content: JSON.stringify(result),
            toolCallId: call.id,
            toolName,
          });
          toolContent = toolMessage.content ?? JSON.stringify(result);
        } catch (error) {
          if (!isTurnLeaseLostError(error)) throw error;
          stopCode = LEASE_LOST_CHUNK.code;
          yield* drainReconciled();
          yield LEASE_LOST_CHUNK;
          return;
        }
        yield* drainReconciled();
        messages = [
          ...messages,
          {
            role: 'tool',
            tool_call_id: call.id,
            // Compact in-flight exactly as the replay path does, so the next
            // round's prompt is byte-identical to what a later turn replays.
            content: compactToolContent(toolContent),
          },
        ];
      }
    }

    yield* await endEarly({ type: 'error', code: 'ROUND_LIMIT', message: 'The chat turn exceeded the safe tool-call round limit' }, '');
  } finally {
    turnSignal?.dispose();
    await budget?.settle(stopCode);
    await lease?.release();
  }
}
