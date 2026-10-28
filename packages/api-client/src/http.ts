/** Non-2xx response from the OpenLinear API. `code` is parsed from the error envelope. */
export class OpenLinearApiError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(`OpenLinear API ${status}: ${responseText}`);
    this.name = "OpenLinearApiError";
    const envelope = parseEnvelope(responseText);
    this.code = envelope.code;
    this.details = envelope.details;
  }
}

/** The API could not be reached (connection refused, DNS, TLS, timeout or abort). */
export class OpenLinearNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenLinearNetworkError";
  }
}

export interface RequestOptions {
  /** Aborts the request. Combined with `timeoutMs` when both are set. */
  signal?: AbortSignal;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
}

export type TokenSource = string | (() => string | Promise<string>);

export interface HttpTransport {
  baseUrl: string;
  fetchImpl: typeof fetch;
  defaultTimeoutMs?: number;
}

function parseEnvelope(text: string): { code: string | undefined; details: unknown } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return {
        code: typeof record.code === "string" ? record.code : undefined,
        details: record.details,
      };
    }
  } catch {
    // Not a JSON envelope.
  }
  return { code: undefined, details: undefined };
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function resolveToken(token: TokenSource): Promise<string> {
  return typeof token === "function" ? await token() : token;
}

function combineSignals(options: RequestOptions | undefined, defaultTimeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options?.signal) signals.push(options.signal);
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * One JSON request. Network failures (including timeouts) surface as
 * `OpenLinearNetworkError`; non-2xx responses as `OpenLinearApiError`.
 */
export async function sendJson<T>(
  transport: HttpTransport,
  token: TokenSource,
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await resolveToken(token)}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await transport.fetchImpl(`${transport.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combineSignals(options, transport.defaultTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenLinearNetworkError(`OpenLinear API unreachable: ${reason}`, error);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    // The request may have been applied; its response was lost.
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenLinearNetworkError(`OpenLinear API response was interrupted: ${reason}`, error);
  }
  if (!res.ok) {
    throw new OpenLinearApiError(res.status, text);
  }
  if (res.status === 204 || text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenLinearApiError(res.status, `Invalid JSON response: ${text.slice(0, 200)}`);
  }
}
