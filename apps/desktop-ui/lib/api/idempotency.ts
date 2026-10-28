import { ApiError, NetworkError } from "./fetch"

/**
 * Client side of the W04a `Idempotency-Key` contract (POST /api/tasks and
 * POST /api/tasks/bulk): one key per user action, reused verbatim whenever the
 * same action is sent again, so the server replays the first result instead
 * of creating a duplicate.
 */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"

/** RFC 4122 v4 UUID (36 chars, within the server's 8-128 char key alphabet). */
export function createIdempotencyKey(): string {
  const cryptoApi: Crypto | undefined = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function idempotencyHeaders(key: string): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: key }
}

function retryAfterSeconds(details: unknown): number | null {
  if (!details || typeof details !== "object") return null
  const value = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * True when re-sending the same keyed request is safe and useful: the request
 * may never have arrived (network), the first attempt is still running
 * (409 IDEMPOTENCY_IN_PROGRESS), or a gateway dropped it (502/503/504). A
 * replay returns the original result, so none of these can duplicate work.
 */
export function isRetryableWithSameKey(error: unknown): boolean {
  if (error instanceof NetworkError) return true
  if (error instanceof ApiError) {
    if (error.code === "IDEMPOTENCY_IN_PROGRESS") return true
    return error.status === 502 || error.status === 503 || error.status === 504
  }
  return false
}

export function retryDelayMs(error: unknown, attempt: number, baseDelayMs: number): number {
  if (error instanceof ApiError && error.code === "IDEMPOTENCY_IN_PROGRESS") {
    return Math.round((retryAfterSeconds(error.details) ?? 1) * 1000)
  }
  const backoff = baseDelayMs * 2 ** Math.max(0, attempt - 1)
  if (error instanceof NetworkError) return Math.max(backoff, error.retryAfterMs)
  return backoff
}

export interface IdempotentSendOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number
  /** Backoff base for network/gateway errors. Default 400 ms, doubled per retry. */
  baseDelayMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Observes each automatic retry (attempt is the one that just failed). */
  onRetry?: (attempt: number, error: unknown, key: string) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send `request` with `key`, automatically re-sending with the same key while
 * the failure is retryable (see isRetryableWithSameKey). Non-retryable errors,
 * including 409 IDEMPOTENCY_CONFLICT, are thrown immediately.
 */
export async function sendWithIdempotencyKey<T>(
  key: string,
  request: (key: string) => Promise<T>,
  options: IdempotentSendOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3))
  const baseDelayMs = options.baseDelayMs ?? 400
  const sleep = options.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request(key)
    } catch (error) {
      if (attempt >= attempts || !isRetryableWithSameKey(error)) throw error
      options.onRetry?.(attempt, error, key)
      await sleep(retryDelayMs(error, attempt, baseDelayMs))
    }
  }
}

/**
 * Holds the key for one pending user intent (e.g. an open "create task" form).
 * The same payload keeps its key across manual retries and double submits; a
 * changed payload gets a new key (reusing the old one would be a 409
 * IDEMPOTENCY_CONFLICT); `complete()` after success starts a fresh intent.
 */
export class IdempotencyIntent {
  private current: { fingerprint: string; key: string } | null = null

  keyFor(fingerprint: string): string {
    if (!this.current || this.current.fingerprint !== fingerprint) {
      this.current = { fingerprint, key: createIdempotencyKey() }
    }
    return this.current.key
  }

  get pendingKey(): string | null {
    return this.current?.key ?? null
  }

  complete(): void {
    this.current = null
  }
}
