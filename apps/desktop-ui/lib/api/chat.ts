import { apiFetch, apiFetchRaw, ApiError } from './fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  _count?: { messages: number };
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool';

/**
 * What a Home Chat tool does, as the server classifies it and sends it on
 * every tool event (`effect`) and in history (`toolCallStates`):
 *  - `read`: no change;
 *  - `write`: an ordinary change, applied immediately;
 *  - `destructive`: a broad or hard-to-reverse change that only runs after the
 *    user confirms a server-issued preview code;
 *  - `external`: an effect outside OpenLinear, gated like `destructive`.
 * The client keeps no copy of the tool catalogue: an event without an effect
 * (older server, unknown tool) renders without a badge and is treated as a
 * possible change when interrupted.
 */
export type ChatToolEffect = 'read' | 'write' | 'destructive' | 'external';

/** Journal state of one tool call, on history assistant rows that announced calls. */
export interface ChatToolCallState {
  /** Provider-visible id, as in `toolCalls[].id`. */
  toolCallId: string;
  toolName: string;
  effect: ChatToolEffect | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  code: string | null;
  /** The real outcome was recorded after the call was reported as outcome-unknown. */
  reconciled: boolean;
  reconciledAfter: string | null;
  endedAt: string | null;
  /** The recorded result (reconciled calls only). */
  result?: ChatToolResult;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string | null;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  /** Tool name on `tool` rows (server column `toolName`). */
  toolName?: string | null;
  /** Older clients typed the tool name as `name`. */
  name?: string | null;
  createdAt: string;
  /** The turn that wrote the row. */
  turnId?: string | null;
  /** The turn's last reply ended early (error, stop, budget, lease) or was cut off. */
  incomplete?: boolean;
  /** Why the turn ended early (`CLIENT_ABORTED` when the user stopped it). */
  errorCode?: string | null;
  /** Provider finish reason of a final reply (`stop`, `length`, ...). */
  finishReason?: string | null;
  /** The turn's usage, stored on its last assistant row. */
  usage?: ChatTurnUsage | null;
  /** Assistant rows that announced tool calls: each call's effect and journal outcome. */
  toolCallStates?: ChatToolCallState[];
}

export interface ToolCall {
  id?: string;
  name?: string;
  arguments?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * Tool result as the server streams it: flat `{ ok, code, message, data?,
 * details? }`. `error` is the older nested shape, still accepted.
 */
export interface ChatToolResult {
  ok?: boolean;
  code?: string;
  message?: string;
  data?: unknown;
  details?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export type ChatCostBasis = 'provider_reported' | 'estimated' | 'unknown' | 'mixed';

/**
 * Per-turn usage on the `done` chunk (server `TurnUsageSummary`). Input tokens
 * include cache reads/writes; output tokens include reasoning. `costUsd` is
 * null when any call's cost is unknown — never a guessed zero — and absent on
 * servers that predate metering.
 */
export interface ChatTurnUsage {
  modelCalls?: number;
  /** `partial` when some model calls in the turn did not report usage. */
  coverage?: 'complete' | 'partial';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  costUsd?: number | null;
  costBasis?: ChatCostBasis;
}

export type ChatChunkType =
  | 'user_message'
  | 'assistant_delta'
  | 'tool_call_start'
  | 'tool_result'
  | 'tool_reconciled'
  | 'confirmation_required'
  | 'budget_warning'
  | 'assistant_final'
  | 'done'
  | 'error';

export interface ChatChunk {
  type: ChatChunkType;
  /**
   * user_message / assistant_final: the stored row. Tool events: the stored
   * assistant row that announced the call (matches history and later
   * `tool_reconciled` updates).
   */
  messageId?: string | null;
  sessionId?: string;
  /** user_message: the turn's id (all rows of the turn carry it). */
  turnId?: string;
  /** Text delta for assistant_delta */
  content?: string;
  /** Legacy/nested tool call metadata for tool_call_start */
  toolCall?: { id: string; name: string; arguments: string };
  /** Backend stream shape for tool_call_start, tool_result, tool_reconciled and confirmation_required */
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  /** The tool's effect class (server-sent); null for a tool the server does not know. */
  effect?: ChatToolEffect | null;
  /** tool_reconciled: the journaled outcome of an interrupted write. */
  status?: 'succeeded' | 'failed';
  /** tool_reconciled: what interrupted the call (`TOOL_TIMEOUT`, `CLIENT_ABORTED`, ...). */
  reconciledAfter?: string;
  reconciledAt?: string;
  /** Legacy/nested tool result for tool_result */
  toolResult?: { toolCallId: string; name: string; content: string; isError?: boolean };
  /** Backend stream shape for tool_result */
  result?: ChatToolResult;
  /** Final assembled assistant message, or flat backend error text on error chunks */
  message?: ChatMessage | string;
  /** Error info for error chunks — backend may send either nested or flat */
  error?: { code: string; message: string };
  /** Error code on error chunks; the confirmation code on confirmation_required. */
  code?: string;
  details?: unknown;
  /** confirmation_required: when the code stops working (ISO 8601). */
  expiresAt?: string;
  /** confirmation_required: one line describing the pending change. */
  summary?: string;
  /** assistant_final: provider finish reason when it is not `stop` (e.g. `length`). */
  finishReason?: string;
  /** Usage stats for done chunks */
  usage?: ChatTurnUsage;
}

/**
 * A chat request or stream that failed. Extends `ApiError` so the central
 * error map (`describeApiError`) can describe it by `code`.
 *
 * - Stream `error` chunks: the server's `code` and `details`, status 0.
 * - Request failures (non-2xx before streaming): the HTTP status, with the
 *   original error kept in `origin`.
 * - `CHAT_STREAM_INTERRUPTED` (client code): the connection closed before the
 *   server sent `done` or `error`.
 */
export class ChatStreamError extends ApiError {
  readonly origin?: unknown;

  constructor(message: string, options: { code?: string; details?: unknown; status?: number; origin?: unknown } = {}) {
    super(options.status ?? 0, message, options.code, options.details);
    this.name = 'ChatStreamError';
    this.origin = options.origin;
  }
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

export async function fetchChatSessions(workspaceId: string, cursor?: string): Promise<{ data: ChatSession[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ workspaceId });
  if (cursor) params.set('cursor', cursor);
  return apiFetch<{ data: ChatSession[]; nextCursor: string | null }>(`/api/chat/sessions?${params}`);
}

export async function createChatSession(workspaceId: string, projectId?: string): Promise<ChatSession> {
  return apiFetch<ChatSession>('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, projectId }),
  });
}

/** A confirmation code's server state (history replay; Dismiss revokes). */
export interface ChatConfirmationSummary {
  id: string;
  toolName: string;
  state: 'pending' | 'used' | 'revoked' | 'expired';
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

/** `GET /api/chat/sessions/:id`: a page of history (oldest first) plus session state. */
export interface ChatSessionHistory {
  session: ChatSession;
  messages: ChatMessage[];
  nextCursor: string | null;
  /** Confirmation codes issued in this chat (newest first). */
  confirmations?: ChatConfirmationSummary[];
  /** Ledger totals for every model call of this chat (turns, titles, failed attempts). */
  usage?: ModelUsageTotals;
  /** A reply is being written right now (possibly in another window). */
  activeTurn?: { turnId: string; expiresAt: string } | null;
}

export async function fetchChatSession(sessionId: string, before?: string): Promise<ChatSessionHistory> {
  const params = before ? `?before=${before}` : '';
  return apiFetch<ChatSessionHistory>(`/api/chat/sessions/${sessionId}${params}`);
}

/**
 * Dismiss a confirmation: the server revokes the code so it can never run
 * later. Idempotent; a code that already ran answers 409 `CONFIRMATION_USED`.
 */
export async function revokeChatConfirmation(sessionId: string, code: string): Promise<{ confirmation: ChatConfirmationSummary }> {
  return apiFetch<{ confirmation: ChatConfirmationSummary }>(`/api/chat/sessions/${sessionId}/confirmations/revoke`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function updateChatSession(sessionId: string, data: { title?: string; projectId?: string | null }): Promise<ChatSession> {
  return apiFetch<ChatSession>(`/api/chat/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function archiveChatSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
}

// ─── Voice Transcription ────────────────────────────────────────────────────

export async function transcribeChatAudio(audioBlob: Blob): Promise<{ text: string }> {
  return apiFetch<{ text: string }>('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': audioBlob.type || 'audio/webm' },
    body: audioBlob,
  });
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export interface ChatAttachment {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
  size: number;
  createdAt: string;
}

export async function uploadChatAttachment(file: File): Promise<ChatAttachment> {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch<ChatAttachment>('/api/chat/attachments', {
    method: 'POST',
    body: formData,
  });
}

// ─── Model usage (W15) ───────────────────────────────────────────────────────

export type ModelUsageSurface = 'chat.turn' | 'chat.title' | 'chat.summary' | 'transcription';

export interface ModelUsageTotals {
  calls: number;
  callsWithUsage: number;
  callsWithoutUsage: number;
  /** Null when no call reported tokens. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Cache reads / prompt tokens over calls that reported cache tokens. */
  cacheHitRate: number | null;
  cost: {
    /** Sum of known (reported or estimated) costs; null when none is known. */
    knownUsd: number | null;
    coverage: 'complete' | 'partial' | 'none';
    byBasis: { provider_reported: number; estimated: number; unknown: number };
  };
}

export interface ModelUsageGroup extends ModelUsageTotals {
  surface: string;
  provider: string;
  model: string;
}

export type ChatBudgetState = 'unlimited' | 'ok' | 'warning' | 'exceeded';

export interface ChatBudgetDimension {
  limit: number;
  /** Who set the effective cap: the server operator, the workspace, or a per-member override. */
  source: 'config' | 'workspace' | 'member';
  spent: number;
  /** Reserved by replies being written right now. */
  held: number;
  remaining: number;
  /** `partial`: some calls had no price (USD) or no token count, so `spent` is a lower bound. */
  coverage: 'complete' | 'partial';
  uncountedCalls: number;
}

export interface ChatBudgetScope {
  /** USD cap; null when none applies (or amounts are withheld). */
  usd: ChatBudgetDimension | null;
  tokens: ChatBudgetDimension | null;
  state: ChatBudgetState;
  /** False when workspace-wide amounts are withheld (members see the state only). */
  amountsVisible: boolean;
}

/** Monthly chat budget of the caller in a workspace (W15), on `GET /api/usage/models?workspaceId=`. */
export interface ChatBudgetStatus {
  workspaceId: string;
  period: { start: string; end: string };
  unknownCostPolicy: 'block' | 'allow';
  /** Whether the chat model can be priced (USD caps enforceable). */
  costPriceable: boolean;
  workspace: ChatBudgetScope;
  user: ChatBudgetScope;
  state: ChatBudgetState;
}

export interface ModelUsageReport {
  since: string;
  days: number;
  workspaceId: string | null;
  surface: ModelUsageSurface | null;
  totals: ModelUsageTotals;
  groups: ModelUsageGroup[];
  /** Null without a workspace in scope; absent on servers that predate budgets. */
  budget?: ChatBudgetStatus | null;
}

/**
 * The caller's own model invocations (Home Chat turns, titles, retries,
 * failed calls) over the last `days` days, from `GET /api/usage/models`.
 */
export async function fetchModelUsage(
  options: { days?: number; workspaceId?: string; surface?: ModelUsageSurface } = {},
): Promise<ModelUsageReport> {
  const params = new URLSearchParams({ days: String(options.days ?? 30) });
  if (options.workspaceId) params.set('workspaceId', options.workspaceId);
  if (options.surface) params.set('surface', options.surface);
  return apiFetch<ModelUsageReport>(`/api/usage/models?${params}`);
}

// ─── Streaming Message Send ──────────────────────────────────────────────────

export interface SendMessageOptions {
  sessionId: string;
  content: string;
  attachmentIds?: string[];
  /**
   * Confirmation codes (CONFIRM-XXXXXXXX) the user approved with an explicit
   * control. The server treats them exactly like a code typed in `content`.
   */
  confirmationTokens?: string[];
  signal?: AbortSignal;
  onChunk: (chunk: ChatChunk) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

function errorFromChunk(chunk: ChatChunk): ChatStreamError {
  const flatMessage = typeof chunk.message === 'string' ? chunk.message : undefined;
  return new ChatStreamError(chunk.error?.message || flatMessage || 'Stream error', {
    code: chunk.error?.code ?? chunk.code,
    details: chunk.details,
  });
}

/**
 * Sends a message and consumes the SSE stream of ChatChunks from the cloud
 * API. Uses `apiFetchRaw` (routing, auth, refresh on 401) and reads the body
 * itself. Failures are reported through `onError`; this never throws.
 *
 * A stream ends with exactly one of `onDone` (a `done` chunk or `[DONE]`) or
 * `onError` (an `error` chunk, a failed request, or a connection that closed
 * before either — `CHAT_STREAM_INTERRUPTED`). Nothing is reported after the
 * caller aborts.
 */
export async function sendChatMessage({ sessionId, content, attachmentIds, confirmationTokens, signal, onChunk, onError, onDone }: SendMessageOptions): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (attachmentIds?.length) body.attachmentIds = attachmentIds;
  if (confirmationTokens?.length) body.confirmationTokens = confirmationTokens;

  let response: Response;
  try {
    response = await apiFetchRaw(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    if (err instanceof ApiError) {
      onError?.(new ChatStreamError(`Chat request failed: ${err.status} ${err.message}`, {
        code: err.code,
        details: err.details,
        status: err.status,
        origin: err,
      }));
      return;
    }
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.body) {
    onError?.(new Error('No response body'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Handles one SSE line; true once the stream reached a terminal chunk. */
  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      onDone?.();
      return true;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      // Skip malformed JSON lines
      return false;
    }
    onChunk(chunk);
    if (chunk.type === 'done') {
      onDone?.();
      return true;
    }
    if (chunk.type === 'error') {
      onError?.(errorFromChunk(chunk));
      return true;
    }
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (handleLine(line)) return;
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split('\n')) {
        if (handleLine(line)) return;
      }
    }

    if (signal?.aborted) return;
    // The server always ends a turn with `done` or `error`; a stream that just
    // stops was cut off (proxy timeout, network drop, server crash).
    onError?.(new ChatStreamError('The connection closed before the reply finished', { code: 'CHAT_STREAM_INTERRUPTED' }));
  } catch (err) {
    if (signal?.aborted) return;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
