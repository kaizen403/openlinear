/**
 * Pure state for the Home Chat stream (`use-chat-stream.tsx`): tool-call
 * effects and outcomes, destructive-action confirmations, interrupted turns,
 * history replay and usage totals. No React here, so every rule is unit
 * tested directly.
 *
 * Server contract (apps/api `services/chat.ts`, `chat-tools/*`, `chat-history.ts`):
 * - `tool_call_start { toolCallId, toolName, effect, messageId, args }`; a
 *   destructive tool that redeems a code carries `args.confirmationToken`.
 *   `effect` is the server's class for the tool (null: unknown tool);
 *   `messageId` is the stored assistant row that announced the call.
 * - `tool_result { toolCallId, toolName, effect, messageId, result: { ok, code, message, data?, details? } }`.
 *   `CONFIRMATION_REQUIRED` results carry `details.confirmation { id, code,
 *   expiresAt }`, `details.summary` and `details.preview`; a redeemed call's
 *   result carries `details.confirmationId`. `TOOL_OUTCOME_UNKNOWN` marks a
 *   write that was interrupted after it started.
 * - `tool_reconciled { toolCallId, messageId, status, result, reconciledAfter }`:
 *   the real outcome of such a write, once it settled.
 * - `confirmation_required { toolCallId, toolName, code, expiresAt, summary }`
 *   follows the preview result.
 * - `budget_warning { code, message, details? }`: a budget notice that does
 *   not stop the turn.
 * - `done { usage? }`; `error { code, message, details? }` ends a turn early.
 * - History rows carry `incomplete`, `errorCode`, `finishReason`, `usage` and,
 *   on assistant rows that announced calls, `toolCallStates`; the session
 *   carries `confirmations` (pending / used / revoked / expired).
 */
import { describeApiError, type DescribedApiError } from '@/lib/api/errors';
import { ApiError } from '@/lib/api/fetch';
import {
  ChatStreamError,
  type ChatChunk,
  type ChatConfirmationSummary,
  type ChatMessage,
  type ChatToolCallState,
  type ChatToolEffect,
  type ChatToolResult,
  type ChatTurnUsage,
  type ToolCall,
} from '@/lib/api/chat';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * - `pending` / `in_progress`: queued / running;
 * - `completed` / `error`: done / failed;
 * - `unknown`: a change was interrupted after it started — it may or may not
 *   have been applied;
 * - `needs_confirmation`: a destructive tool returned a preview; nothing ran.
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'error' | 'unknown' | 'needs_confirmation';

export interface PreviewIssue {
  id: string | null;
  identifier: string | null;
  title: string;
  status: string | null;
}

/** The exact change a confirmation code is bound to, as the server previewed it. */
export interface ConfirmationPreview {
  kind: 'status_change' | 'archive' | 'generic';
  /** Target status (status changes). */
  status: string | null;
  /** Issues that will change. */
  issues: PreviewIssue[];
  /** Selected issues already in the target status (status changes). */
  unchangedCount: number;
  /** Requested ids/identifiers the server could not find in the project. */
  notFound: string[];
  /** The selection is every active issue in the project. */
  wholeProject: boolean;
  /** Exact arguments (generic confirmations). */
  argumentsText: string | null;
}

export interface ChatConfirmation {
  /** CONFIRM-XXXXXXXX, upper case. */
  code: string;
  /** Server row id; a redeemed result echoes it as `details.confirmationId`. */
  confirmationId: string | null;
  toolCallId: string;
  toolName: string;
  summary: string;
  expiresAt: string;
  preview: ConfirmationPreview | null;
}

/**
 * Client lifecycle of one confirmation code. Expiry is derived from
 * `expiresAt` at render time, not stored.
 * - `pending`: can be confirmed or dismissed;
 * - `submitting`: the user confirmed (button or typed code); waiting for the turn;
 * - `confirmed`: the server executed the change;
 * - `rejected`: the server refused it (expired, used, stale, ...);
 * - `outcome_unknown`: the confirmed change was interrupted mid-way;
 * - `superseded`: a newer preview replaced it in the confirming turn;
 * - `unresolved`: sent, but the reply never applied or refused it;
 * - `dismissed`: the user dismissed it; nothing was sent.
 */
export type ConfirmationPhase =
  | 'pending'
  | 'submitting'
  | 'confirmed'
  | 'rejected'
  | 'outcome_unknown'
  | 'superseded'
  | 'unresolved'
  | 'dismissed';

export interface ConfirmationState {
  phase: ConfirmationPhase;
  via?: 'button' | 'typed';
  /** Server refusal, interrupted outcome, a send that never reached the server, or a failed revoke. */
  error?: DescribedApiError;
  /** Server message when the change ran, e.g. "Issues updated". */
  outcome?: string;
  /**
   * Dismissed cards: the server-side revoke of the code. `done` (or absent on
   * a card loaded as revoked) means the code can never run; `failed` means it
   * still works until it expires.
   */
  revoke?: 'pending' | 'done' | 'failed';
}

export type ConfirmationStates = Readonly<Record<string, ConfirmationState>>;

/** The real outcome of a write that was first reported as outcome-unknown. */
export interface ToolReconciliationInfo {
  status: 'succeeded' | 'failed';
  /** What interrupted the call (`TOOL_TIMEOUT`, `CLIENT_ABORTED`, ...). */
  after: string | null;
  at: string | null;
}

export interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
  /** Effect class sent by the server; null when it sent none (unknown tool, older server). */
  effect?: ChatToolEffect | null;
  /** Stored assistant row that announced the call (matches reconciliation updates). */
  messageId?: string | null;
  /** Set once the server recorded the real outcome of an interrupted write. */
  reconciled?: ToolReconciliationInfo;
  result?: string;
  isError?: boolean;
  /** Result code (`OK`, `CONFIRMATION_REQUIRED`, `TOOL_OUTCOME_UNKNOWN`, ...). */
  code?: string;
  /** Server result message (`Issues updated`, ...). */
  message?: string;
  /** Actionable copy for a failed or unknown outcome. */
  error?: DescribedApiError;
  /** Confirmation code this call tried to redeem (`confirmationToken` argument). */
  redeems?: string;
  /** Preview + code when the call returned CONFIRMATION_REQUIRED. */
  confirmation?: ChatConfirmation;
}

/** Why a turn ended before a complete answer. */
export interface TurnInterruption {
  /** `error`: the stream failed; `stopped`: the user stopped it; `length`: the model hit its output limit. */
  reason: 'error' | 'stopped' | 'length';
  error?: DescribedApiError;
}

export interface StreamingMessage {
  /** Stable local id (history rows keep the server id). */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: StreamingToolCall[];
  createdAt: string;
  /** Produced by a stream in this view (not loaded from history). */
  live?: boolean;
  /** Set when the turn ended before a complete answer; partial content is kept. */
  incomplete?: TurnInterruption;
  /** `available`: Retry resends the request; `used`: it was retried. */
  retry?: 'available' | 'used';
  /** Token/cost totals from `done.usage` (live) or the stored row (history). */
  usage?: ChatTurnUsage;
  /** Budget notices from the turn (`budget_warning`); the turn still ran. */
  notices?: DescribedApiError[];
}

// ─── Confirmation codes ──────────────────────────────────────────────────────

const CODE_BODY = '[0-9A-HJKMNP-TV-Z]{8}';
const CODE_EXACT = new RegExp(`^\\s*CONFIRM-(${CODE_BODY})\\s*$`, 'i');

/** Canonical upper-case code, or null when `value` is not a confirmation code. */
export function normalizeConfirmationCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CODE_EXACT.exec(value);
  return match?.[1] ? `CONFIRM-${match[1].toUpperCase()}` : null;
}

/** Codes typed anywhere in `text` (the server accepts these as confirmations). */
export function extractConfirmationCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(new RegExp(`\\bCONFIRM-(${CODE_BODY})\\b`, 'gi'))) {
    if (match[1]) codes.add(`CONFIRM-${match[1].toUpperCase()}`);
  }
  return [...codes];
}

export function isConfirmationExpired(confirmation: Pick<ChatConfirmation, 'expiresAt'>, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(confirmation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/** Text of the user message a Confirm button sends; it names the code so the model can redeem it. */
export function confirmationMessage(confirmation: Pick<ChatConfirmation, 'code' | 'summary'>): string {
  return `Confirm ${confirmation.code}: ${confirmation.summary}`;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function stringifyStreamValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonObject(raw: string): JsonRecord | null {
  if (!raw.trim()) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function isToolEffect(value: unknown): value is ChatToolEffect {
  return value === 'read' || value === 'write' || value === 'destructive' || value === 'external';
}

/**
 * The effect the server sent for a tool, or null. The client keeps no copy of
 * the tool catalogue (it drifted); `name` is accepted for call-site symmetry.
 */
export function toolEffectFor(_name: string, serverEffect?: unknown): ChatToolEffect | null {
  return isToolEffect(serverEffect) ? serverEffect : null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

const GENERIC_TURN_FAILURE = "I couldn't get a response from the model.";

function detailsOf(error: unknown): Record<string, unknown> | null {
  return error instanceof ApiError ? asRecord(error.details) : null;
}

function resetDate(details: Record<string, unknown> | null): string | null {
  const value = details && typeof details.resetsAt === 'string' ? Date.parse(details.resetsAt) : Number.NaN;
  return Number.isFinite(value) ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
}

/**
 * Copy for the round-7 chat codes (single writer, budgets, revoked codes).
 * Consulted before the central map in lib/api/errors.ts, which predates them.
 */
const CHAT_CODE_COPY: Readonly<Record<string, (details: Record<string, unknown> | null) => Omit<DescribedApiError, 'code' | 'status'>>> = {
  TURN_IN_PROGRESS: (details) => {
    const seconds = details && typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds : null;
    return {
      message: 'Another reply is still being written in this chat, maybe in another window.',
      hint: 'Wait for it to finish, then send again.',
      retryable: true,
      ...(seconds !== null ? { retryAfterMs: seconds * 1000 } : {}),
    };
  },
  TURN_LEASE_LOST: () => ({
    message: 'Another reply took over this chat, so this one stopped.',
    hint: 'Reload the chat to see what was saved before sending again.',
    retryable: false,
  }),
  CHAT_BUDGET_EXCEEDED: (details) => {
    const scope = details?.scope === 'user' ? 'Your' : "This workspace's";
    const what = details?.dimension === 'tokens' ? 'token' : 'spending';
    const resets = resetDate(details);
    return {
      message: `${scope} monthly chat ${what} budget is used up.`,
      hint: `${resets ? `It resets on ${resets}. ` : ''}A workspace owner or admin can raise the limit.`,
      retryable: false,
    };
  },
  CHAT_BUDGET_COST_UNKNOWN: () => ({
    message: "This workspace only allows chat replies whose cost can be measured, and this model has no price set.",
    hint: 'Ask a workspace owner or admin to allow unpriced replies, or an operator to add a price for the model.',
    retryable: false,
  }),
  CHAT_BUDGET_NEARLY_EXHAUSTED: (details) => {
    const resets = resetDate(details);
    return {
      message: details?.scope === 'user' ? 'Your monthly chat budget is almost used up.' : "This workspace's monthly chat budget is almost used up.",
      ...(resets ? { hint: `It resets on ${resets}.` } : {}),
      retryable: false,
    };
  },
  CHAT_BUDGET_MISCONFIGURED: () => ({
    message: 'Chat is turned off: its budget settings on the server are invalid.',
    hint: 'An operator needs to fix the CHAT_BUDGET_* settings.',
    retryable: false,
  }),
  CONFIRMATION_REVOKED: () => ({
    message: 'You dismissed this preview, so its code no longer works. Nothing changed.',
    hint: 'Ask the assistant for a fresh preview if you still want the change.',
    retryable: false,
  }),
};

function describeChatCode(error: unknown): DescribedApiError | null {
  if (!(error instanceof ApiError) || !error.code) return null;
  const copy = CHAT_CODE_COPY[error.code];
  if (!copy) return null;
  return { code: error.code, status: error.status || null, ...copy(detailsOf(error)) };
}

/** Actionable copy for a failed chat request or stream (codes mapped in lib/api/errors.ts and above). */
export function describeChatError(error: unknown): DescribedApiError {
  if (error instanceof ChatStreamError && error.origin instanceof Error) {
    return describeChatCode(error.origin) ?? describeApiError(error.origin, GENERIC_TURN_FAILURE);
  }
  const chat = describeChatCode(error);
  if (chat) return chat;
  const described = describeApiError(error, GENERIC_TURN_FAILURE);
  const message = described.message.trim();
  if (!message || message === 'Stream error') {
    return { ...described, message: GENERIC_TURN_FAILURE };
  }
  return described;
}

/** Copy for a `budget_warning` chunk (the turn still runs). */
export function describeBudgetWarning(chunk: Pick<ChatChunk, 'code' | 'message' | 'details'>): DescribedApiError {
  const error = new ApiError(0, typeof chunk.message === 'string' ? chunk.message : 'Budget notice', chunk.code, chunk.details);
  const chat = describeChatCode(error);
  if (chat && chunk.code !== 'CHAT_BUDGET_COST_UNKNOWN') return chat;
  // Unknown cost under `allow`: the server's sentence says what it means for this reply.
  return {
    code: chunk.code ?? null,
    status: null,
    message: typeof chunk.message === 'string' && chunk.message.trim() ? chunk.message : 'Budget notice',
    retryable: false,
  };
}

/** Actionable copy for a tool result code. */
export function describeToolFailure(code: string | undefined, message: string | undefined, details?: unknown): DescribedApiError {
  const error = new ApiError(0, message?.trim() || 'The action failed.', code, details);
  return describeChatCode(error) ?? describeApiError(error, 'The action failed.');
}

const INTERRUPTED_READ: DescribedApiError = {
  code: null,
  status: null,
  message: 'Interrupted before it finished. Nothing was changed.',
  retryable: true,
};

// ─── Tool calls ──────────────────────────────────────────────────────────────

export function createToolCall(input: {
  id: string;
  name: string;
  arguments: string;
  effect?: unknown;
  messageId?: string | null;
  status?: ToolCallStatus;
}): StreamingToolCall {
  const args = parseJsonObject(input.arguments);
  const redeems = args ? normalizeConfirmationCode(args.confirmationToken) : null;
  return {
    id: input.id,
    name: input.name,
    arguments: input.arguments,
    status: input.status ?? 'in_progress',
    effect: toolEffectFor(input.name, input.effect),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(redeems ? { redeems } : {}),
  };
}

export function toolCallFromChunk(chunk: ChatChunk): StreamingToolCall | null {
  if (chunk.toolCall) {
    return createToolCall({ id: chunk.toolCall.id, name: chunk.toolCall.name, arguments: chunk.toolCall.arguments, effect: chunk.effect, messageId: chunk.messageId });
  }
  if (!chunk.toolCallId || !chunk.toolName) return null;
  return createToolCall({ id: chunk.toolCallId, name: chunk.toolName, arguments: stringifyStreamValue(chunk.args), effect: chunk.effect, messageId: chunk.messageId });
}

export function historyToolCall(toolCall: ToolCall, index: number, messageId?: string, state?: ChatToolCallState): StreamingToolCall {
  const nestedFunction = toolCall.function;
  return createToolCall({
    id: toolCall.id || `history_tool_${index}`,
    name: toolCall.name || nestedFunction?.name || 'tool',
    arguments: toolCall.arguments || nestedFunction?.arguments || '',
    effect: state?.effect,
    messageId,
  });
}

export interface ToolOutcome {
  status: ToolCallStatus;
  code?: string;
  isError: boolean;
  /** Shown as the Result section. */
  text: string;
  /** Server message (`Issues updated`, ...). */
  message?: string;
  error?: DescribedApiError;
}

export function interpretToolResult(result: ChatToolResult): ToolOutcome {
  const nested = result.error;
  const code = result.code ?? nested?.code;
  const message = result.message ?? nested?.message;
  const details = result.details ?? nested?.details;
  const failed = Boolean(nested) || result.ok === false;

  if (code === 'CONFIRMATION_REQUIRED') {
    return { status: 'needs_confirmation', code, isError: false, text: message ?? '', ...(message ? { message } : {}) };
  }
  if (code === 'TOOL_OUTCOME_UNKNOWN') {
    return { status: 'unknown', code, isError: true, text: message ?? '', ...(message ? { message } : {}), error: describeToolFailure(code, message, details) };
  }
  if (failed) {
    return {
      status: 'error',
      ...(code ? { code } : {}),
      isError: true,
      text: message || stringifyStreamValue(result.data ?? result),
      ...(message ? { message } : {}),
      error: describeToolFailure(code, message, details),
    };
  }
  return {
    status: 'completed',
    ...(code ? { code } : {}),
    isError: false,
    text: stringifyStreamValue(result.data ?? result),
    ...(message ? { message } : {}),
  };
}

function previewIssues(value: unknown): PreviewIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const issue = asRecord(item);
    if (!issue) return [];
    return [{
      id: stringOrNull(issue.id),
      identifier: stringOrNull(issue.identifier),
      title: stringOrNull(issue.title) ?? 'Untitled issue',
      status: stringOrNull(issue.status),
    }];
  });
}

function notFoundLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const record = asRecord(item);
    const label = record ? stringOrNull(record.identifier) ?? stringOrNull(record.id) : null;
    return label ? [label] : [];
  });
}

export function parseConfirmationPreview(raw: unknown): ConfirmationPreview | null {
  const preview = asRecord(raw);
  if (!preview) return null;
  if (Array.isArray(preview.willChange)) {
    return {
      kind: 'status_change',
      status: stringOrNull(preview.status),
      issues: previewIssues(preview.willChange),
      unchangedCount: nonNegativeNumber(preview.alreadyInStatus) ?? 0,
      notFound: notFoundLabels(preview.notFound),
      wholeProject: preview.selection === 'all_active_issues_in_project',
      argumentsText: null,
    };
  }
  if (Array.isArray(preview.willArchive)) {
    return {
      kind: 'archive',
      status: null,
      issues: previewIssues(preview.willArchive),
      unchangedCount: 0,
      notFound: notFoundLabels(preview.notFound),
      wholeProject: false,
      argumentsText: null,
    };
  }
  return {
    kind: 'generic',
    status: null,
    issues: [],
    unchangedCount: 0,
    notFound: [],
    wholeProject: false,
    argumentsText: preview.arguments === undefined ? null : stringifyStreamValue(preview.arguments),
  };
}

export function confirmationFromResult(toolCallId: string, toolName: string, result: ChatToolResult): ChatConfirmation | null {
  const code = result.code ?? result.error?.code;
  const details = asRecord(result.details ?? result.error?.details);
  if (code !== 'CONFIRMATION_REQUIRED' || !details) return null;
  const confirmation = asRecord(details.confirmation);
  const normalized = normalizeConfirmationCode(confirmation?.code);
  const expiresAt = stringOrNull(confirmation?.expiresAt);
  if (!normalized || !expiresAt) return null;
  return {
    code: normalized,
    confirmationId: stringOrNull(confirmation?.id),
    toolCallId,
    toolName,
    summary: stringOrNull(details.summary) ?? 'Confirm this change',
    expiresAt,
    preview: parseConfirmationPreview(details.preview),
  };
}

export function confirmationFromChunk(chunk: ChatChunk): ChatConfirmation | null {
  const code = normalizeConfirmationCode(chunk.code);
  if (!code || !chunk.toolCallId || !chunk.expiresAt) return null;
  return {
    code,
    confirmationId: null,
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName ?? 'tool',
    summary: chunk.summary?.trim() || 'Confirm this change',
    expiresAt: chunk.expiresAt,
    preview: null,
  };
}

/** Keep the richer of two descriptions of the same code. */
export function mergeConfirmation(existing: ChatConfirmation | undefined, incoming: ChatConfirmation): ChatConfirmation {
  if (!existing || existing.code !== incoming.code) return incoming;
  return {
    ...existing,
    confirmationId: existing.confirmationId ?? incoming.confirmationId,
    preview: existing.preview ?? incoming.preview,
  };
}

export function applyToolResult(call: StreamingToolCall, result: ChatToolResult): StreamingToolCall {
  const outcome = interpretToolResult(result);
  const confirmation = confirmationFromResult(call.id, call.name, result);
  const rest: StreamingToolCall = { ...call };
  delete rest.error;
  delete rest.message;
  return {
    ...rest,
    status: outcome.status,
    result: outcome.text,
    isError: outcome.isError,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    effect: call.effect ?? (confirmation ? 'destructive' : null),
    ...(confirmation ? { confirmation: mergeConfirmation(call.confirmation, confirmation) } : {}),
  };
}

/** Older stream shape: `{ toolResult: { toolCallId, content, isError } }`. */
export function applyLegacyToolResult(call: StreamingToolCall, content: string, isError: boolean): StreamingToolCall {
  return { ...call, status: isError ? 'error' : 'completed', result: content, isError };
}

/**
 * The server recorded the real outcome of a write it had reported as
 * outcome-unknown (`tool_reconciled`, or a reconciled history state). The call
 * now shows what happened; `reconciled` keeps the fact that it was resolved late.
 */
export function applyReconciliation(
  call: StreamingToolCall,
  input: { status: 'succeeded' | 'failed'; result?: ChatToolResult | null; reconciledAfter?: string | null; reconciledAt?: string | null; effect?: unknown },
): StreamingToolCall {
  const result: ChatToolResult = input.result ?? (input.status === 'succeeded'
    ? { ok: true, code: 'OK', message: 'The change was applied.' }
    : { ok: false, code: 'TOOL_ERROR', message: 'The change was not applied.' });
  const applied = applyToolResult({ ...call, effect: call.effect ?? toolEffectFor(call.name, input.effect) }, result);
  return {
    ...applied,
    // A redeemed confirmation stays linked to its code.
    ...(call.redeems ? { redeems: call.redeems } : {}),
    reconciled: { status: input.status, after: input.reconciledAfter ?? null, at: input.reconciledAt ?? null },
  };
}

/** Where a reconciliation update applies: the matching call, preferring the same announcing message. */
export function findReconciledCall(calls: readonly StreamingToolCall[], toolCallId: string, messageId?: string | null): number {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.id === toolCallId && (!messageId || !call.messageId || call.messageId === messageId)) return index;
  }
  return -1;
}

/** Apply a `tool_reconciled` chunk to committed messages (a turn that already finished). */
export function reconcileMessages(messages: readonly StreamingMessage[], chunk: ChatChunk): StreamingMessage[] | null {
  if (!chunk.toolCallId || (chunk.status !== 'succeeded' && chunk.status !== 'failed')) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const callIndex = findReconciledCall(message.toolCalls, chunk.toolCallId, chunk.messageId);
    const call = message.toolCalls[callIndex];
    if (!call) continue;
    const toolCalls = [...message.toolCalls];
    toolCalls[callIndex] = applyReconciliation(call, {
      status: chunk.status,
      result: chunk.result ?? null,
      reconciledAfter: chunk.reconciledAfter ?? null,
      reconciledAt: chunk.reconciledAt ?? null,
      effect: chunk.effect,
    });
    const next = [...messages];
    next[index] = { ...message, toolCalls };
    return next;
  }
  return null;
}

/**
 * A call still running when its turn ended. A read changed nothing; a write
 * (or a confirmed destructive call) may have committed, so its outcome is
 * unknown rather than failed.
 */
export function interruptToolCall(call: StreamingToolCall): StreamingToolCall {
  if (call.status !== 'in_progress' && call.status !== 'pending') return call;
  const harmless = call.effect === 'read' || ((call.effect === 'destructive' || call.effect === 'external') && !call.redeems);
  if (harmless) {
    return { ...call, status: 'error', isError: true, error: INTERRUPTED_READ };
  }
  return {
    ...call,
    status: 'unknown',
    isError: true,
    code: 'TOOL_OUTCOME_UNKNOWN',
    error: describeToolFailure('TOOL_OUTCOME_UNKNOWN', 'The turn ended while this action was running.'),
  };
}

export function findToolCallIndex(calls: readonly StreamingToolCall[], id: string): number {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index]?.id === id) return index;
  }
  return -1;
}

// ─── Confirmation lifecycle ──────────────────────────────────────────────────

export function registerConfirmation(states: ConfirmationStates, code: string): ConfirmationStates {
  return states[code] ? states : { ...states, [code]: { phase: 'pending' } };
}

/**
 * Mark the pending, still-valid codes a user message submits. Returns the
 * codes that moved to `submitting`; expired or already-settled codes are left
 * alone (the server decides those).
 */
export function markSubmitted(
  states: ConfirmationStates,
  codes: readonly string[],
  via: 'button' | 'typed',
  isLive: (code: string) => boolean,
): { states: ConfirmationStates; submitted: string[] } {
  let next = states;
  const submitted: string[] = [];
  for (const code of codes) {
    if (next[code]?.phase !== 'pending' || !isLive(code)) continue;
    next = { ...next, [code]: { phase: 'submitting', via } };
    submitted.push(code);
  }
  return { states: next, submitted };
}

/**
 * Apply the result of a call that redeemed `code`. A change that ran is
 * `confirmed` whatever the card showed; refusals only settle codes the user
 * submitted, so a model replaying a code on its own cannot kill the card.
 */
export function settleRedemption(states: ConfirmationStates, code: string, call: StreamingToolCall): ConfirmationStates {
  const current = states[code];
  if (!current) return states;
  if (call.status === 'completed') {
    if (current.phase === 'confirmed') return states;
    const outcome = call.message ?? (call.result ? firstLine(call.result) : undefined);
    return { ...states, [code]: { phase: 'confirmed', ...(current.via ? { via: current.via } : {}), ...(outcome ? { outcome } : {}) } };
  }
  if (current.phase !== 'submitting') return states;
  if (call.status === 'unknown') {
    return { ...states, [code]: { ...current, phase: 'outcome_unknown', ...(call.error ? { error: call.error } : {}) } };
  }
  if (call.status === 'error' || call.status === 'needs_confirmation') {
    return { ...states, [code]: { ...current, phase: 'rejected', error: call.error ?? describeToolFailure(call.code, call.result) } };
  }
  return states;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((value) => value.trim().length > 0) ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** A new preview for the same tool replaces codes submitted in this turn. */
export function supersedeSubmitted(
  states: ConfirmationStates,
  turnCodes: ReadonlySet<string>,
  toolName: string,
  newCode: string,
  toolNameOf: (code: string) => string | undefined,
): ConfirmationStates {
  let next = states;
  for (const code of turnCodes) {
    if (code === newCode || next[code]?.phase !== 'submitting' || toolNameOf(code) !== toolName) continue;
    next = { ...next, [code]: { ...next[code], phase: 'superseded' } };
  }
  return next;
}

function sendFailed(failure?: DescribedApiError): DescribedApiError {
  return {
    code: failure?.code ?? null,
    status: failure?.status ?? null,
    message: `Your confirmation wasn't acknowledged by the server.${failure ? ` ${failure.message}` : ''}`,
    hint: 'Confirm again when ready; a code can only run once, so nothing will be applied twice.',
    retryable: true,
  };
}

/**
 * Settle codes still `submitting` when their turn ends. If the server stored
 * the message, the code was delivered but the reply never applied or refused
 * it (`unresolved`). Otherwise the server never acknowledged it, so the card
 * is usable again (codes are single-use server-side, so a resend is safe).
 */
export function finishSubmitted(
  states: ConfirmationStates,
  turnCodes: ReadonlySet<string>,
  acknowledged: boolean,
  failure?: DescribedApiError,
): { states: ConfirmationStates; reopened: string[] } {
  let next = states;
  const reopened: string[] = [];
  for (const code of turnCodes) {
    const current = next[code];
    if (current?.phase !== 'submitting') continue;
    if (acknowledged) {
      next = { ...next, [code]: { ...current, phase: 'unresolved' } };
    } else {
      next = { ...next, [code]: { phase: 'pending', error: sendFailed(failure) } };
      reopened.push(code);
    }
  }
  return { states: next, reopened };
}

export function dismissConfirmationState(states: ConfirmationStates, code: string): ConfirmationStates {
  return states[code]?.phase === 'pending' ? { ...states, [code]: { phase: 'dismissed', revoke: 'pending' } } : states;
}

/** Record the server's answer to a Dismiss (revoke). */
export function settleRevoke(
  states: ConfirmationStates,
  code: string,
  outcome: { kind: 'revoked' } | { kind: 'already_ran' } | { kind: 'failed'; error: DescribedApiError },
): ConfirmationStates {
  const current = states[code];
  if (current?.phase !== 'dismissed') return states;
  if (outcome.kind === 'revoked') return { ...states, [code]: { ...current, revoke: 'done' } };
  if (outcome.kind === 'already_ran') {
    return { ...states, [code]: { phase: 'confirmed', outcome: 'This change had already been confirmed and ran.' } };
  }
  return { ...states, [code]: { ...current, revoke: 'failed', error: outcome.error } };
}

/**
 * Apply reconciled journal states from a fresh history page to calls that are
 * still `unknown` (matched by announcing message id and call id).
 */
export function applyOutcomeStates(messages: readonly StreamingMessage[], history: readonly ChatMessage[]): StreamingMessage[] {
  const known = new Map<string, ChatToolCallState>();
  for (const row of history) {
    for (const state of row.toolCallStates ?? []) {
      if ((state.reconciled && (state.status === 'succeeded' || state.status === 'failed')) || neverStarted(state)) {
        known.set(`${row.id}:${state.toolCallId}`, state);
      }
    }
  }
  if (known.size === 0) return [...messages];
  return messages.map((message) => {
    let changed = false;
    const toolCalls = message.toolCalls.map((call) => {
      const state = call.status === 'unknown' && call.messageId ? known.get(`${call.messageId}:${call.id}`) : undefined;
      if (!state) return call;
      changed = true;
      if (neverStarted(state)) return { ...call, status: 'error' as const, isError: true, code: state.code ?? undefined, error: INTERRUPTED_BEFORE_START };
      const status = state.status === 'succeeded' ? 'succeeded' : 'failed';
      return applyReconciliation(call, { status, result: state.result ?? null, reconciledAfter: state.reconciledAfter, reconciledAt: state.endedAt, effect: state.effect });
    });
    return changed ? { ...message, toolCalls } : message;
  });
}

const INTERRUPTED_BEFORE_START: DescribedApiError = {
  code: null,
  status: null,
  message: 'Interrupted before it started. Nothing was changed.',
  retryable: true,
};

/** The server journaled the call as cancelled before its handler ran (nothing changed). */
function neverStarted(state: ChatToolCallState): boolean {
  return state.status === 'cancelled' && !state.reconciled && state.code !== 'TOOL_OUTCOME_UNKNOWN';
}

/** Calls whose outcome is still unknown but can be looked up later (they have a stored announcing row). */
export function hasRefreshableUnknown(messages: readonly StreamingMessage[]): boolean {
  return messages.some((message) => message.toolCalls.some((call) => call.status === 'unknown' && Boolean(call.messageId)));
}

// ─── History ─────────────────────────────────────────────────────────────────

function parseStoredToolResult(content: string | null): ChatToolResult {
  if (!content) return { ok: true };
  try {
    const parsed = asRecord(JSON.parse(content) as unknown);
    if (parsed && typeof parsed.ok === 'boolean') return parsed as ChatToolResult;
    return { ok: true, data: parsed ?? content };
  } catch {
    return { ok: true, data: content };
  }
}

export interface DerivedHistory {
  messages: StreamingMessage[];
  confirmations: ChatConfirmation[];
  states: ConfirmationStates;
}

/** Session-level state that comes with a history page (`GET /api/chat/sessions/:id`). */
export interface HistoryExtras {
  confirmations?: readonly ChatConfirmationSummary[];
}

/** How a stored reply ended, from its row (`incomplete`, `errorCode`, `finishReason`). */
export function historyInterruption(row: Pick<ChatMessage, 'incomplete' | 'errorCode' | 'finishReason'>): TurnInterruption | undefined {
  if (row.finishReason === 'length') return { reason: 'length' };
  if (!row.incomplete) return undefined;
  if (row.errorCode === 'CLIENT_ABORTED') return { reason: 'stopped' };
  return { reason: 'error', error: describeChatError(new ChatStreamError('Stream error', { code: row.errorCode ?? undefined })) };
}

function stateFor(states: readonly ChatToolCallState[] | undefined, toolCallId: string): ChatToolCallState | undefined {
  return states?.find((state) => state.toolCallId === toolCallId);
}

/** A stored call whose result row is missing, but whose journal finished (e.g. a crash between rows). */
function settleFromJournal(call: StreamingToolCall, state: ChatToolCallState | undefined): StreamingToolCall {
  if (!state || (call.status !== 'in_progress' && call.status !== 'pending')) return call;
  if (state.status === 'succeeded') return applyToolResult(call, { ok: true, code: state.code ?? 'OK', message: 'Recorded by the server.' });
  if (state.status === 'failed') return applyToolResult(call, { ok: false, code: state.code ?? 'TOOL_ERROR', message: 'The action failed.' });
  if (neverStarted(state)) return { ...call, status: 'error', isError: true, error: INTERRUPTED_BEFORE_START };
  return call;
}

/**
 * Rebuild the transcript from stored rows: user and assistant messages, tool
 * results joined onto their calls (by the nearest preceding call id — ids may
 * repeat across turns), late (reconciled) outcomes from the journal states,
 * how each turn ended and its usage, confirmation cards and what became of
 * them (a server-revoked code shows as dismissed).
 */
export function deriveHistory(history: readonly ChatMessage[], extras: HistoryExtras = {}): DerivedHistory {
  const messages: StreamingMessage[] = [];
  const confirmations = new Map<string, ChatConfirmation>();
  const callIndex = new Map<string, { message: number; call: number; state?: ChatToolCallState }>();
  const journalByMessage = new Map<number, Array<ChatToolCallState | undefined>>();
  let states: ConfirmationStates = {};
  let turnCodes = new Set<string>();

  const toolNameOf = (code: string) => confirmations.get(code)?.toolName;

  for (const row of history) {
    if (row.role === 'user') {
      states = finishSubmitted(states, turnCodes, true).states;
      const sentAt = Date.parse(row.createdAt);
      const marked = markSubmitted(states, extractConfirmationCodes(row.content ?? ''), 'typed', (code) => {
        const confirmation = confirmations.get(code);
        return Boolean(confirmation) && !(confirmation && Number.isFinite(sentAt) && isConfirmationExpired(confirmation, sentAt));
      });
      states = marked.states;
      turnCodes = new Set(marked.submitted);
      messages.push({ id: row.id, role: 'user', content: row.content ?? '', toolCalls: [], createdAt: row.createdAt });
      continue;
    }

    if (row.role === 'assistant') {
      const calls = (row.toolCalls ?? []).map((toolCall, index) => {
        const id = toolCall.id || `history_tool_${index}`;
        return historyToolCall(toolCall, index, row.id, stateFor(row.toolCallStates, id));
      });
      const incomplete = historyInterruption(row);
      messages.push({
        id: row.id,
        role: 'assistant',
        content: row.content ?? '',
        toolCalls: calls,
        createdAt: row.createdAt,
        ...(incomplete ? { incomplete } : {}),
        ...(row.usage ? { usage: row.usage } : {}),
      });
      const journalStates = calls.map((call) => stateFor(row.toolCallStates, call.id));
      journalByMessage.set(messages.length - 1, journalStates);
      calls.forEach((call, index) => callIndex.set(call.id, { message: messages.length - 1, call: index, state: journalStates[index] }));
      continue;
    }

    const location = row.toolCallId ? callIndex.get(row.toolCallId) : undefined;
    const owner = location ? messages[location.message] : undefined;
    const call = location && owner ? owner.toolCalls[location.call] : undefined;
    if (!location || !owner || !call) continue;
    let updated = applyToolResult(call, parseStoredToolResult(row.content));
    const journal = location.state;
    if (journal?.reconciled && (journal.status === 'succeeded' || journal.status === 'failed')) {
      // The stored row is what the model saw (outcome unknown); the journal
      // recorded what really happened afterwards.
      updated = applyReconciliation(updated, { status: journal.status, result: journal.result ?? null, reconciledAfter: journal.reconciledAfter, reconciledAt: journal.endedAt });
    }
    const toolCalls = [...owner.toolCalls];
    toolCalls[location.call] = updated;
    messages[location.message] = { ...owner, toolCalls };

    if (updated.confirmation) {
      confirmations.set(updated.confirmation.code, updated.confirmation);
      states = registerConfirmation(states, updated.confirmation.code);
      states = supersedeSubmitted(states, turnCodes, updated.name, updated.confirmation.code, toolNameOf);
    }
    if (updated.redeems) states = settleRedemption(states, updated.redeems, updated);
  }

  states = finishSubmitted(states, turnCodes, true).states;

  // Codes the server revoked (the user dismissed them, possibly elsewhere).
  for (const summary of extras.confirmations ?? []) {
    if (summary.state !== 'revoked') continue;
    const confirmation = [...confirmations.values()].find((candidate) => candidate.confirmationId === summary.id);
    const phase = confirmation ? states[confirmation.code]?.phase : undefined;
    if (confirmation && (phase === 'pending' || phase === 'unresolved')) {
      states = { ...states, [confirmation.code]: { phase: 'dismissed' } };
    }
  }

  const settled = messages.map((message, messageIndex) => {
    if (!message.toolCalls.some((call) => call.status === 'in_progress' || call.status === 'pending')) return message;
    const journalStates = journalByMessage.get(messageIndex) ?? [];
    return {
      ...message,
      toolCalls: message.toolCalls.map((call, index) => interruptToolCall(settleFromJournal(call, journalStates[index]))),
    };
  });
  return { messages: settled, confirmations: [...confirmations.values()], states };
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface SessionUsage {
  /** Turns that reported usage. */
  turns: number;
  /** Turns that ended without usage (failed, stopped, or not metered). */
  turnsWithoutUsage: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Null when no turn reported cache reads. */
  cacheReadTokens: number | null;
  /** Sum of the turns whose cost is known; null when none is known. */
  knownCostUsd: number | null;
  /** True when any counted turn has an unknown cost (the total is then a lower bound). */
  costIncomplete: boolean;
  /** True when some known cost is an estimate from a price snapshot, not provider-reported. */
  costEstimated: boolean;
  /** True when some turn's tokens were only partly reported. */
  tokensIncomplete: boolean;
}

export function isUsageCostKnown(usage: ChatTurnUsage): usage is ChatTurnUsage & { costUsd: number } {
  return typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd);
}

/**
 * Totals over every turn of the chat: stored replies carry their turn's usage
 * (so the total survives a reload) and live replies carry `done.usage`. A turn
 * without usage counts as such when it streamed here or was stored as
 * incomplete; older stored rows without usage (pre-metering) are not counted.
 */
export function summarizeSessionUsage(messages: readonly StreamingMessage[]): SessionUsage | null {
  let turns = 0;
  let turnsWithoutUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens: number | null = null;
  let knownCostUsd: number | null = null;
  let costIncomplete = false;
  let costEstimated = false;
  let tokensIncomplete = false;

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const usage = message.usage;
    if (!usage) {
      if (message.live || message.incomplete) turnsWithoutUsage += 1;
      continue;
    }
    turns += 1;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
    if (typeof usage.cacheReadTokens === 'number') cacheReadTokens = (cacheReadTokens ?? 0) + usage.cacheReadTokens;
    if (usage.coverage === 'partial') tokensIncomplete = true;
    if (isUsageCostKnown(usage)) {
      knownCostUsd = (knownCostUsd ?? 0) + usage.costUsd;
      if (usage.costBasis !== 'provider_reported') costEstimated = true;
    } else {
      costIncomplete = true;
    }
  }

  if (turns === 0 && turnsWithoutUsage === 0) return null;
  return {
    turns,
    turnsWithoutUsage,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    knownCostUsd: knownCostUsd === null ? null : Math.round(knownCostUsd * 1e6) / 1e6,
    costIncomplete,
    costEstimated,
    tokensIncomplete,
  };
}
