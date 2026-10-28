/**
 * Errors raised by the OpenLinear API client.
 *
 * The API answers failures with the envelope built by `buildErrorEnvelope`
 * (`{ error: { code, message, details }, code, message, details, requestId }`);
 * a few older routes still answer `{ error: string, code }`. Both shapes are
 * read here. Bodies that are not JSON (an HTML page from a proxy, for example)
 * are never forwarded to the model.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface ParsedApiError {
  code?: string;
  message?: string;
  details?: unknown;
  requestId?: string;
  retryAfterSeconds?: number;
}

/** Read the API error envelope (and `Retry-After` / `x-request-id` headers). */
export function parseApiErrorBody(text: string, headers: Headers): ParsedApiError {
  const parsed: ParsedApiError = {};
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (isRecord(body)) {
    const nested = isRecord(body.error) ? body.error : undefined;
    parsed.code = stringField(body.code) ?? stringField(nested?.code);
    parsed.message = stringField(nested?.message) ?? stringField(body.message) ?? stringField(body.error);
    parsed.details = body.details ?? nested?.details;
    parsed.requestId = stringField(body.requestId);
    const details = isRecord(parsed.details) ? parsed.details : undefined;
    parsed.retryAfterSeconds = numberField(body.retryAfterSeconds) ?? numberField(details?.retryAfterSeconds);
  }
  parsed.requestId ??= stringField(headers.get('x-request-id'));
  if (parsed.retryAfterSeconds === undefined) {
    const header = headers.get('retry-after');
    const seconds = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) parsed.retryAfterSeconds = seconds;
  }
  return parsed;
}

/** A non-2xx answer from the OpenLinear API. */
export class OpenLinearApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly code: string | undefined;
  readonly apiMessage: string | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, method: string, path: string, parsed: ParsedApiError) {
    super(`OpenLinear API ${method} ${path} answered ${status}${parsed.code ? ` ${parsed.code}` : ''}`);
    this.name = 'OpenLinearApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.code = parsed.code;
    this.apiMessage = parsed.message;
    this.details = parsed.details;
    this.requestId = parsed.requestId;
    this.retryAfterSeconds = parsed.retryAfterSeconds;
  }
}

/** The API could not be reached, or did not answer in time. */
export class OpenLinearNetworkError extends Error {
  readonly method: string;
  readonly path: string;
  readonly reason: 'timeout' | 'network';

  constructor(method: string, path: string, reason: 'timeout' | 'network', cause?: unknown) {
    super(
      reason === 'timeout'
        ? `OpenLinear API ${method} ${path} timed out`
        : `OpenLinear API ${method} ${path} could not be reached`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'OpenLinearNetworkError';
    this.method = method;
    this.path = path;
    this.reason = reason;
  }
}

/** A 2xx answer whose body did not have the documented shape. */
export class OpenLinearResponseError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, detail: string) {
    super(`OpenLinear API ${method} ${path} returned an unexpected response: ${detail}`);
    this.name = 'OpenLinearResponseError';
    this.method = method;
    this.path = path;
  }
}
