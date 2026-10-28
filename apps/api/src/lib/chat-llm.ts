import { logger } from '../logger';
import {
  describeChatDataProcessor,
  loadChatLLMConfig,
  providerReportsCost,
  shouldSendCacheHints,
  type CacheHintMode,
  type ChatLLMConfig,
  type ChatLLMProvider,
} from './chat-llm-config';
import {
  backoffDelayMs,
  classifyHttpFailure,
  DEFAULT_RETRY_POLICY,
  parseRetryAfterMs,
  sanitizeProviderMessage,
  sleep,
  type LLMErrorKind,
  type RetryPolicy,
} from './llm-retry';
import { normalizeProviderUsage, type NormalizedUsage } from './llm-usage';

export type ChatLLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatLLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Anthropic-style prompt-cache breakpoint, forwarded by compatible gateways. */
export interface ChatLLMCacheControl {
  type: 'ephemeral';
}

export interface ChatLLMContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
  cache_control?: ChatLLMCacheControl;
}

export interface ChatLLMMessage {
  role: ChatLLMRole;
  content?: string | ChatLLMContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatLLMToolCall[];
}

export interface ChatLLMFunctionSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/** Normalised usage for one call; see lib/llm-usage.ts for field semantics. */
export type ChatLLMUsage = NormalizedUsage;

/** One failed attempt of a model call (retried or final). */
export interface ChatLLMAttemptFailure {
  attempt: number;
  code: string;
  kind: LLMErrorKind;
  httpStatus?: number;
  latencyMs: number;
  retryAfterMs?: number;
  providerRequestId?: string;
}

export type ChatLLMEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  /** An attempt failed before producing output and will be retried after `delayMs`. */
  | { type: 'retry'; failure: ChatLLMAttemptFailure; delayMs: number }
  | {
      type: 'done';
      finishReason?: string;
      /** Normalised usage; null when the provider reported none. */
      usage?: ChatLLMUsage | null;
      /** Legacy mirrors of `usage.inputTokens` / `usage.outputTokens`. */
      inputTokens?: number;
      outputTokens?: number;
      attempt?: number;
      latencyMs?: number;
      firstTokenMs?: number;
      providerRequestId?: string;
      model?: string;
    };

export interface StreamChatCompletionInput {
  messages: ChatLLMMessage[];
  tools?: ChatLLMFunctionSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  temperature?: number;
  /** Per-call model override (title generation may use a smaller model). */
  model?: string;
  abortSignal?: AbortSignal;
  /** Stable per-conversation key for providers that route prompt caches by key. */
  cacheKey?: string;
}

export interface ChatLLMCompletion {
  content: string;
  finishReason?: string;
  usage: ChatLLMUsage | null;
  attempt: number;
  latencyMs: number;
  /** Earlier attempts that failed and were retried. */
  failures: ChatLLMAttemptFailure[];
  providerRequestId?: string;
  model: string;
}

export interface ChatLLMClient {
  readonly model: string;
  /** Provider label used for metering; test doubles may omit it. */
  readonly provider?: string;
  /** Model used for session titles, when it differs from `model`. */
  readonly titleModel?: string;
  streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent>;
  completeChatCompletion?(input: StreamChatCompletionInput & { json?: boolean }): Promise<ChatLLMCompletion>;
}

export interface ChatLLMErrorInfo {
  kind?: LLMErrorKind;
  retryable?: boolean;
  httpStatus?: number;
  /** Attempts made, including the one that produced this error. */
  attempts?: number;
  /** Every failed attempt, including the final one. */
  failures?: ChatLLMAttemptFailure[];
  /** Sanitised, bounded provider error text. */
  providerMessage?: string;
  retryAfterMs?: number;
  latencyMs?: number;
}

export class ChatLLMError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 502,
    public readonly info: ChatLLMErrorInfo = {},
  ) {
    super(message);
    this.name = 'ChatLLMError';
  }
}

export function isContextOverflowError(error: unknown): boolean {
  return error instanceof ChatLLMError && error.code === 'LLM_CONTEXT_OVERFLOW';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Per-attempt abort signal with an idle deadline: it fires when no response
 * headers or stream bytes arrived for `idleMs`. A long answer that keeps
 * streaming is not cut off; the orchestrator bounds the whole turn.
 */
class AttemptSignal {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timedOut = false;
  private disposed = false;
  private readonly onParentAbort = () => this.controller.abort();

  constructor(private readonly idleMs: number, private readonly parent?: AbortSignal) {
    if (parent?.aborted) this.controller.abort();
    else parent?.addEventListener('abort', this.onParentAbort, { once: true });
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get didTimeout(): boolean {
    return this.timedOut;
  }

  touch(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.idleMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.onParentAbort);
  }
}

const ERROR_BODY_MAX_BYTES = 4096;

async function readBoundedText(response: Response, maxBytes = ERROR_BODY_MAX_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A failed error body read still leaves the status code to classify.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxBytes);
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return headers.get('x-request-id') ?? headers.get('request-id') ?? headers.get('fireworks-request-id') ?? undefined;
}

/** Hold back a trailing CR: it may be the first half of a CRLF split across reads. */
function normalizeNewlines(buffer: string): string {
  const holdCr = buffer.endsWith('\r');
  const body = holdCr ? buffer.slice(0, -1) : buffer;
  return body.replace(/\r\n?/g, '\n') + (holdCr ? '\r' : '');
}

/** The `data` payload of one SSE event (multi-line data joined per the spec), or null. */
function frameData(frame: string): string | null {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;
  return dataLines.join('\n').trim();
}

/**
 * Yield SSE `data` payloads. Handles LF, CRLF and CR line endings, frames split
 * across reads, comment/keep-alive lines, and a final frame that arrives
 * without its terminating blank line.
 */
async function* readSseData(body: ReadableStream<Uint8Array>, onBytes: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onBytes();
      buffer = normalizeNewlines(buffer + decoder.decode(value, { stream: true }));
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const data = frameData(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (data) yield data;
        separator = buffer.indexOf('\n\n');
      }
    }
    const tail = frameData((buffer + decoder.decode()).replace(/\r\n?/g, '\n'));
    finished = true;
    if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface StreamState {
  finishReason?: string;
  usage: ChatLLMUsage | null;
  providerRequestId?: string;
}

/**
 * Cache breakpoints for gateways that accept Anthropic-style `cache_control`:
 *  1. the static system block (tools render before it, so it covers both);
 *  2. the newest user/tool message, so the next round or turn reads the whole
 *     conversation prefix from cache.
 * Two of the four allowed breakpoints; nothing volatile precedes breakpoint 1.
 */
export function applyCacheBreakpoints(messages: ChatLLMMessage[]): ChatLLMMessage[] {
  const marked = messages.map((message) => ({ ...message }));
  const first = marked[0];
  if (first?.role === 'system') {
    const parts = toParts(first.content);
    if (parts.length > 0) {
      parts[0] = { ...parts[0], cache_control: { type: 'ephemeral' } };
      first.content = parts;
    }
  }
  const last = marked.at(-1);
  if (last && last !== first && (last.role === 'user' || last.role === 'tool')) {
    const parts = toParts(last.content);
    if (parts.length > 0) {
      const index = parts.length - 1;
      parts[index] = { ...parts[index], cache_control: { type: 'ephemeral' } };
      last.content = parts;
    }
  }
  return marked;
}

function toParts(content: ChatLLMMessage['content']): ChatLLMContentPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.map((part) => ({ ...part })) : [];
}

/** Without cache hints, send system content as one string (widest compatibility). */
function flattenSystemContent(messages: ChatLLMMessage[]): ChatLLMMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content
        .map((part) => part.text ?? '')
        .filter((text) => text.length > 0)
        .join('\n\n'),
    };
  });
}

export interface OpenAICompatibleChatLLMOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  titleModel?: string;
  /** Idle timeout: response headers, then the gap between stream chunks. */
  timeoutMs?: number;
  provider?: ChatLLMProvider;
  retry?: Partial<RetryPolicy>;
  cacheHints?: CacheHintMode;
  streamUsage?: boolean;
  maxOutputTokens?: number | null;
  /** Jitter source; injectable for deterministic tests. */
  random?: () => number;
  env?: NodeJS.ProcessEnv;
}

let processorLogged = false;

export class OpenAICompatibleChatLLM implements ChatLLMClient {
  readonly model: string;
  readonly titleModel: string;
  readonly provider: ChatLLMProvider;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly cacheHints: CacheHintMode;
  private readonly streamUsage: boolean;
  private readonly maxOutputTokens: number | null;
  private readonly random: () => number;
  private readonly configError: string | null;

  constructor(options: OpenAICompatibleChatLLMOptions = {}) {
    const env = options.env ?? process.env;
    const loaded = loadChatLLMConfig({
      ...env,
      ...(options.baseUrl !== undefined ? { CHAT_LLM_BASE_URL: options.baseUrl } : {}),
      ...(options.provider !== undefined ? { CHAT_LLM_PROVIDER: options.provider } : {}),
    });
    const config: ChatLLMConfig | null = loaded.ok ? loaded.config : null;
    this.configError = loaded.ok ? null : loaded.issues.join('; ');

    this.baseUrl = config?.baseUrl ?? '';
    this.provider = config?.provider ?? 'openai_compatible';
    this.apiKey = options.apiKey ?? config?.apiKey ?? '';
    this.model = options.model ?? config?.model ?? '';
    this.titleModel = options.titleModel ?? (options.model !== undefined ? options.model : config?.titleModel) ?? this.model;
    this.timeoutMs = options.timeoutMs ?? config?.requestTimeoutMs ?? 60_000;
    this.retry = { ...(config?.retry ?? DEFAULT_RETRY_POLICY), ...(options.retry ?? {}) };
    this.cacheHints = options.cacheHints ?? config?.cacheHints ?? 'auto';
    this.streamUsage = options.streamUsage ?? config?.streamUsage ?? true;
    this.maxOutputTokens = options.maxOutputTokens !== undefined ? options.maxOutputTokens : config?.maxOutputTokens ?? null;
    this.random = options.random ?? Math.random;

    if (config && !processorLogged && !options.baseUrl && process.env.NODE_ENV !== 'test') {
      processorLogged = true;
      logger.info({ processor: describeChatDataProcessor(config) }, '[chat] Home Chat model processor');
    }
  }

  private assertUsable(): void {
    if (this.configError) {
      throw new ChatLLMError('LLM_MISCONFIGURED', `Chat model configuration is invalid: ${this.configError}`, 500, { kind: 'config' });
    }
    if (!this.apiKey) {
      throw new ChatLLMError('LLM_NOT_CONFIGURED', 'Chat LLM API key is not configured', 500, { kind: 'config' });
    }
  }

  /** Request body shared by both call styles. */
  buildRequestBody(input: StreamChatCompletionInput, options: { stream: boolean; json?: boolean }): Record<string, unknown> {
    const model = input.model ?? this.model;
    const hints = shouldSendCacheHints({ cacheHints: this.cacheHints, provider: this.provider }, model);
    const messages = hints ? applyCacheBreakpoints(input.messages) : flattenSystemContent(input.messages);
    const maxTokens = input.maxTokens ?? this.maxOutputTokens ?? undefined;
    const hasTools = Boolean(input.tools?.length);
    return {
      model,
      messages,
      // `tool_choice` without `tools` is rejected by strict OpenAI-compatible servers.
      ...(hasTools ? { tools: input.tools, tool_choice: input.toolChoice ?? 'auto' } : {}),
      temperature: input.temperature ?? (options.stream ? 0.1 : 0),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(options.stream ? { stream: true } : {}),
      // Without this flag OpenAI-compatible providers omit usage from streams.
      ...(options.stream && this.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      ...(this.provider === 'openai' && input.cacheKey ? { prompt_cache_key: input.cacheKey } : {}),
    };
  }

  private async post(body: Record<string, unknown>, attempt: AttemptSignal): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: attempt.signal,
    });
    if (response.ok) return response;
    const text = await readBoundedText(response);
    const failure = classifyHttpFailure(response.status, text);
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new ChatLLMError(failure.code, failure.message, response.status >= 500 ? 502 : response.status, {
      kind: failure.kind,
      retryable: failure.retryable,
      httpStatus: response.status,
      providerMessage: sanitizeProviderMessage(text) || undefined,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
  }

  private classifyThrown(error: unknown, attempt: AttemptSignal, parent?: AbortSignal): ChatLLMError {
    if (parent?.aborted) {
      return new ChatLLMError('CLIENT_ABORTED', 'Chat request was aborted by the client', 499, { kind: 'aborted', retryable: false });
    }
    if (attempt.didTimeout) {
      return new ChatLLMError('LLM_TIMEOUT', 'The model request timed out before it returned a response', 504, { kind: 'timeout', retryable: true });
    }
    if (error instanceof ChatLLMError) return error;
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
    const detail = error instanceof Error ? [error.message, cause].filter(Boolean).join(': ') : undefined;
    return new ChatLLMError('LLM_NETWORK_ERROR', 'Could not reach the chat model provider', 502, {
      kind: 'network',
      retryable: true,
      ...(detail ? { providerMessage: sanitizeProviderMessage(detail) } : {}),
    });
  }

  /** Delay before the next attempt, or null to give up. */
  private nextDelay(error: ChatLLMError, attempt: number): number | null {
    if (!error.info.retryable || attempt >= this.retry.maxAttempts) return null;
    return backoffDelayMs(attempt, this.retry, error.info.retryAfterMs ?? null, this.random);
  }

  private failureRecord(error: ChatLLMError, attempt: number, startedAt: number, providerRequestId?: string): ChatLLMAttemptFailure {
    return {
      attempt,
      code: error.code,
      kind: error.info.kind ?? 'network',
      ...(error.info.httpStatus !== undefined ? { httpStatus: error.info.httpStatus } : {}),
      latencyMs: Date.now() - startedAt,
      ...(error.info.retryAfterMs !== undefined ? { retryAfterMs: error.info.retryAfterMs } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
    };
  }

  private finalError(error: ChatLLMError, attempt: number, failures: ChatLLMAttemptFailure[]): ChatLLMError {
    return new ChatLLMError(error.code, error.message, error.statusCode, {
      ...error.info,
      attempts: attempt,
      failures,
      latencyMs: failures.at(-1)?.latencyMs,
    });
  }

  private normalizeUsage(raw: unknown): ChatLLMUsage | null {
    return normalizeProviderUsage(raw, { trustProviderCost: providerReportsCost(this.provider) });
  }

  /** Apply one parsed stream chunk to `state`; return the events it produces. */
  private decodeChunk(data: string, state: StreamState, nothingYielded: boolean): ChatLLMEvent[] {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asRecord(JSON.parse(data));
    } catch {
      throw new ChatLLMError('LLM_STREAM_MALFORMED', 'The model stream contained a malformed frame', 502, { kind: 'stream', retryable: nothingYielded });
    }
    if (!parsed) return [];

    const streamError = asRecord(parsed.error);
    if (streamError && asArray(parsed.choices).length === 0) {
      const message = stringValue(streamError.message) ?? 'The model provider reported an error mid-stream';
      const status = numberValue(streamError.code) ?? numberValue(streamError.status);
      const failure = status !== undefined ? classifyHttpFailure(status, message) : null;
      throw new ChatLLMError(failure?.code ?? 'LLM_STREAM_ERROR', failure?.message ?? 'The model provider reported an error mid-stream', 502, {
        kind: failure?.kind ?? 'stream',
        retryable: nothingYielded && (failure?.retryable ?? false),
        providerMessage: sanitizeProviderMessage(message),
        ...(status !== undefined ? { httpStatus: status } : {}),
      });
    }

    state.providerRequestId ??= stringValue(parsed.id);
    if (parsed.usage !== undefined && parsed.usage !== null) {
      state.usage = this.normalizeUsage(parsed.usage) ?? state.usage;
    }

    const events: ChatLLMEvent[] = [];
    const choice = asRecord(asArray(parsed.choices)[0]);
    if (!choice) return events;
    const delta = asRecord(choice.delta);
    if (delta) {
      const content = stringValue(delta.content);
      if (content) events.push({ type: 'delta', content });
      for (const rawToolCall of asArray(delta.tool_calls)) {
        const toolCall = asRecord(rawToolCall);
        if (!toolCall) continue;
        const fn = asRecord(toolCall.function);
        events.push({
          type: 'tool_call_delta',
          index: numberValue(toolCall.index) ?? 0,
          id: stringValue(toolCall.id),
          name: fn ? stringValue(fn.name) : undefined,
          argumentsDelta: fn ? stringValue(fn.arguments) : undefined,
        });
      }
    }
    const finishReason = stringValue(choice.finish_reason);
    if (finishReason) state.finishReason = finishReason;
    return events;
  }

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    this.assertUsable();
    const body = this.buildRequestBody(input, { stream: true });
    const model = String(body.model);
    const failures: ChatLLMAttemptFailure[] = [];

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();
      const signal = new AttemptSignal(this.timeoutMs, input.abortSignal);
      let yielded = false;
      let headerRequestId: string | undefined;
      try {
        const response = await this.post(body, signal);
        headerRequestId = requestIdFromHeaders(response.headers);
        signal.touch();
        if (!response.body) {
          throw new ChatLLMError('LLM_EMPTY_STREAM', 'Provider returned an empty stream', 502, { kind: 'unavailable', retryable: true });
        }
        const state: StreamState = { usage: null };
        let sawDone = false;
        let firstTokenAt: number | undefined;
        for await (const data of readSseData(response.body, () => signal.touch())) {
          if (data === '[DONE]') {
            sawDone = true;
            break;
          }
          for (const event of this.decodeChunk(data, state, !yielded)) {
            firstTokenAt ??= Date.now();
            yielded = true;
            yield event;
          }
        }
        if (!sawDone && state.finishReason === undefined) {
          throw new ChatLLMError('LLM_STREAM_TRUNCATED', 'The model stream ended before the response was complete', 502, { kind: 'stream', retryable: true });
        }
        const usage = state.usage;
        yield {
          type: 'done',
          finishReason: state.finishReason,
          usage,
          ...(usage?.inputTokens !== null && usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage?.outputTokens !== null && usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          attempt,
          latencyMs: Date.now() - startedAt,
          ...(firstTokenAt !== undefined ? { firstTokenMs: firstTokenAt - startedAt } : {}),
          ...((state.providerRequestId ?? headerRequestId) ? { providerRequestId: state.providerRequestId ?? headerRequestId } : {}),
          model,
        };
        return;
      } catch (thrown) {
        signal.dispose();
        const error = this.classifyThrown(thrown, signal, input.abortSignal);
        const record = this.failureRecord(error, attempt, startedAt, headerRequestId);
        // Output already reached the caller: replaying would duplicate it.
        const delay = yielded ? null : this.nextDelay(error, attempt);
        if (delay === null) throw this.finalError(error, attempt, [...failures, record]);
        failures.push(record);
        yield { type: 'retry', failure: record, delayMs: delay };
        try {
          await sleep(delay, input.abortSignal);
        } catch {
          throw new ChatLLMError('CLIENT_ABORTED', 'Chat request was aborted by the client', 499, { kind: 'aborted', attempts: attempt, failures });
        }
      } finally {
        signal.dispose();
      }
    }
  }

  async completeChatCompletion(input: StreamChatCompletionInput & { json?: boolean }): Promise<ChatLLMCompletion> {
    this.assertUsable();
    const body = this.buildRequestBody(input, { stream: false, json: input.json });
    const model = String(body.model);
    const failures: ChatLLMAttemptFailure[] = [];

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();
      const signal = new AttemptSignal(this.timeoutMs, input.abortSignal);
      let headerRequestId: string | undefined;
      try {
        const response = await this.post(body, signal);
        headerRequestId = requestIdFromHeaders(response.headers);
        signal.touch();
        let payload: Record<string, unknown> | null;
        try {
          payload = asRecord(await response.json());
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new ChatLLMError('LLM_RESPONSE_MALFORMED', 'The model provider returned a malformed response', 502, { kind: 'stream', retryable: true });
          }
          throw error;
        }
        const choice = asRecord(asArray(payload?.choices)[0]);
        const message = asRecord(choice?.message);
        return {
          content: stringValue(message?.content) ?? '',
          finishReason: stringValue(choice?.finish_reason),
          usage: this.normalizeUsage(payload?.usage),
          attempt,
          latencyMs: Date.now() - startedAt,
          failures,
          ...((stringValue(payload?.id) ?? headerRequestId) ? { providerRequestId: stringValue(payload?.id) ?? headerRequestId } : {}),
          model,
        };
      } catch (thrown) {
        signal.dispose();
        const error = this.classifyThrown(thrown, signal, input.abortSignal);
        const record = this.failureRecord(error, attempt, startedAt, headerRequestId);
        const delay = this.nextDelay(error, attempt);
        if (delay === null) throw this.finalError(error, attempt, [...failures, record]);
        failures.push(record);
        try {
          await sleep(delay, input.abortSignal);
        } catch {
          throw new ChatLLMError('CLIENT_ABORTED', 'Chat request was aborted by the client', 499, { kind: 'aborted', attempts: attempt, failures });
        }
      } finally {
        signal.dispose();
      }
    }
  }
}

let testClient: ChatLLMClient | null = null;

export function setChatLLMClientForTesting(client: ChatLLMClient | null): void {
  testClient = client;
}

export function getChatLLMClient(): ChatLLMClient {
  return testClient ?? new OpenAICompatibleChatLLM();
}
