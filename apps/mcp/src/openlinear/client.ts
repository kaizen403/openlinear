import { USER_AGENT } from '../version';
import {
  OpenLinearApiError,
  OpenLinearNetworkError,
  OpenLinearResponseError,
  parseApiErrorBody,
} from './errors';

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/**
 * - `safe`: the request may be repeated without side effects: every GET, and
 *   POSTs to routes with transactional `Idempotency-Key` support
 *   (`POST /api/tasks`, `/api/tasks/bulk`, `/api/projects`, `/api/teams`)
 *   when a key is sent.
 * - `never`: send once. Used for every other write.
 */
export type RetryPolicy = 'safe' | 'never';

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts for `safe` requests (first try included). */
  maxAttempts?: number;
  /** Longest server-requested `Retry-After` the client waits for before giving up. */
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Forwarded as `X-Request-Id` so API logs correlate with one MCP tool call. */
  requestId?: string;
  /** Called on every 401 from the API (the worker evicts its auth cache). */
  onUnauthorized?: () => void;
}

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  retry?: RetryPolicy;
  signal?: AbortSignal;
}

export interface ApiResult {
  status: number;
  body: unknown;
  /** The API replayed a stored result for this `Idempotency-Key` instead of writing again. */
  replayed: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;
const BACKOFF_MS = [250, 750, 1_500];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(error: OpenLinearApiError): boolean {
  if (error.status === 502 || error.status === 503 || error.status === 504) return true;
  return error.status === 409 && error.code === 'IDEMPOTENCY_IN_PROGRESS';
}

/**
 * Minimal HTTP client for the OpenLinear REST API, used only by the MCP
 * worker. It adds what the shared `@openlinear/api-client` does not have yet:
 * per-request `Idempotency-Key`, timeouts, cancellation, bounded retries for
 * safe requests, and structured errors.
 */
export class OpenLinearClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestId: string | undefined;
  private readonly onUnauthorized: (() => void) | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.requestId = options.requestId;
    this.onUnauthorized = options.onUnauthorized;
  }

  async call(method: string, path: string, options: CallOptions = {}): Promise<ApiResult> {
    const policy = options.retry ?? (method === 'GET' ? 'safe' : 'never');
    const attempts = policy === 'safe' ? this.maxAttempts : 1;
    const url = this.url(path, options.query);
    const headers = this.headers(options);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= attempts;
      let response: Response;
      try {
        response = await this.send(method, path, url, headers, payload, options.signal);
      } catch (error) {
        if (last || !(error instanceof OpenLinearNetworkError)) throw error;
        await this.sleep(BACKOFF_MS[attempt - 1] ?? 1_500);
        continue;
      }

      if (response.ok) return this.success(method, path, response);

      const apiError = new OpenLinearApiError(
        response.status,
        method,
        path,
        parseApiErrorBody(await response.text(), response.headers),
      );
      if (apiError.status === 401) this.onUnauthorized?.();
      if (last || !isTransient(apiError)) throw apiError;
      const requested = apiError.retryAfterSeconds === undefined ? undefined : apiError.retryAfterSeconds * 1_000;
      if (requested !== undefined && requested > this.maxRetryDelayMs) throw apiError;
      await this.sleep(requested ?? BACKOFF_MS[attempt - 1] ?? 1_500);
    }
  }

  private url(path: string, query: CallOptions['query']): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    return `${this.baseUrl}${path}${search ? `?${search}` : ''}`;
  }

  private headers(options: CallOptions): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-OpenLinear-Client': 'mcp',
    });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (this.requestId) headers.set('X-Request-Id', this.requestId);
    return headers;
  }

  private async send(
    method: string,
    path: string,
    url: string,
    headers: Headers,
    payload: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      return await this.fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new OpenLinearNetworkError(method, path, timedOut ? 'timeout' : 'network', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async success(method: string, path: string, response: Response): Promise<ApiResult> {
    const replayed = response.headers.get('idempotency-replayed') === 'true';
    if (response.status === 204) return { status: 204, body: undefined, replayed };
    const text = await response.text();
    if (text.length === 0) return { status: response.status, body: undefined, replayed };
    try {
      return { status: response.status, body: JSON.parse(text), replayed };
    } catch {
      throw new OpenLinearResponseError(method, path, 'body is not JSON');
    }
  }
}
