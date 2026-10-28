/**
 * Provider error classification and bounded, jittered retry for model calls.
 *
 * Retries are only safe before any output reached the caller: the chat stream
 * forwards deltas to the client as they arrive, so a mid-stream failure is
 * surfaced rather than replayed. Context overflow is not retried here; the
 * orchestrator trims the history window and retries once.
 */

export type LLMErrorKind =
  | 'rate_limited'
  | 'quota'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'context_overflow'
  | 'bad_request'
  | 'rejected'
  | 'aborted'
  | 'stream'
  | 'config';

export interface LLMFailureClass {
  kind: LLMErrorKind;
  code: string;
  retryable: boolean;
  message: string;
}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context[\s_-]*length/i,
  /context[\s_-]*window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (input |prompt )?tokens/i,
  /maximum (allowed )?(input|prompt|context)( length| tokens| size)?/i,
  /exceeds? (the )?(model'?s? )?(maximum|max|context)/i,
  /reduce the length of the messages/i,
];

export function isContextOverflowMessage(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

const QUOTA_PATTERN = /insufficient[_\s-]?quota|exceeded your current quota|billing|credit balance|out of credits/i;

/** Classify a non-2xx provider response. `bodyText` is the (bounded) error body. */
export function classifyHttpFailure(status: number, bodyText: string): LLMFailureClass {
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: 'LLM_AUTH_FAILED', retryable: false, message: 'The chat model provider rejected the configured credentials' };
  }
  if (status === 404) {
    return { kind: 'not_found', code: 'LLM_MODEL_NOT_FOUND', retryable: false, message: 'The configured chat model or endpoint was not found at the provider' };
  }
  if (status === 408) {
    return { kind: 'timeout', code: 'LLM_TIMEOUT', retryable: true, message: 'The model request timed out before it returned a response' };
  }
  if (status === 413 || ((status === 400 || status === 422) && isContextOverflowMessage(bodyText))) {
    return { kind: 'context_overflow', code: 'LLM_CONTEXT_OVERFLOW', retryable: false, message: 'The conversation is too long for the model context window' };
  }
  if (status === 429) {
    if (QUOTA_PATTERN.test(bodyText)) {
      return { kind: 'quota', code: 'LLM_QUOTA_EXCEEDED', retryable: false, message: 'The chat model provider account has no remaining quota' };
    }
    return { kind: 'rate_limited', code: 'LLM_RATE_LIMITED', retryable: true, message: 'The chat model provider is rate limiting requests; try again shortly' };
  }
  if (status === 425) {
    return { kind: 'unavailable', code: 'LLM_PROVIDER_UNAVAILABLE', retryable: true, message: 'The chat model provider is temporarily unavailable' };
  }
  if (status >= 500) {
    return { kind: 'unavailable', code: 'LLM_PROVIDER_UNAVAILABLE', retryable: true, message: 'The chat model provider is temporarily unavailable' };
  }
  if (status === 400 || status === 422) {
    return { kind: 'bad_request', code: 'LLM_BAD_REQUEST', retryable: false, message: 'The chat model provider rejected the request' };
  }
  return { kind: 'rejected', code: 'LLM_REQUEST_REJECTED', retryable: false, message: `The chat model provider rejected the request (HTTP ${status})` };
}

/** `Retry-After` as milliseconds (delta-seconds or HTTP date), or null. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number.parseFloat(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/**
 * Exponential backoff with equal jitter: half the exponential step is fixed,
 * half is random, so concurrent clients spread out without ever retrying
 * immediately. `Retry-After` is a lower bound. Returns null when the provider
 * asks for a wait longer than the policy allows (the caller should give up).
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (retryAfterMs !== null && retryAfterMs > policy.maxDelayMs) return null;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.round(Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0)));
}

export class AbortedSleepError extends Error {
  constructor() {
    super('Sleep aborted');
    this.name = 'AbortError';
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedSleepError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedSleepError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Redact credentials and bound provider error text before it leaves the server. */
export function sanitizeProviderMessage(text: string, maxChars = 300): string {
  return text
    .slice(0, maxChars)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/\b(sk|fw|pk|rk|key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .trim();
}
