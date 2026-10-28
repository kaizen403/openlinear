import {
  ExecutionAttemptClient,
  OpenLinearApiError,
  OpenLinearClient,
  OpenLinearNetworkError,
} from '@openlinear/api-client';
import { HttpError, isHttpError } from '../lib/errors';

/**
 * W03a cloud API configuration. The sidecar persists and authorizes through
 * the OpenLinear control plane named by `OPENLINEAR_API_URL` (the same name
 * the MCP worker uses). It never holds a database URL, the JWT signing secret
 * or the token-encryption key.
 *
 * Plain http is accepted only for loopback hosts (local development and
 * tests); anything else must be https. Credentials in the URL are refused.
 */
export const CLOUD_API_URL_ENV = 'OPENLINEAR_API_URL';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const CLOUD_API_TIMEOUT_MS = 10_000;
export const CLOUD_API_START_TIMEOUT_MS = 15_000;

export interface CloudApiConfig {
  baseUrl: string;
  fetch?: typeof fetch;
}

let configured: CloudApiConfig | null = null;

export function parseCloudApiUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${CLOUD_API_URL_ENV} is not a valid URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${CLOUD_API_URL_ENV} must not embed credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${CLOUD_API_URL_ENV} must not carry a query string or fragment`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:' && !LOOPBACK.has(host)) {
    throw new Error(`${CLOUD_API_URL_ENV} must use https unless it points at a loopback host`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${CLOUD_API_URL_ENV} must be an http(s) URL`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** Read `OPENLINEAR_API_URL` at boot. Returns null when unset; throws when invalid. */
export function configureCloudApiFromEnv(env: NodeJS.ProcessEnv = process.env): CloudApiConfig | null {
  const raw = env[CLOUD_API_URL_ENV]?.trim();
  configured = raw ? { baseUrl: parseCloudApiUrl(raw) } : null;
  return configured;
}

/** Tests and embedders: inject a configuration (and optionally a fetch). */
export function setCloudApiConfig(config: CloudApiConfig | null): void {
  configured = config ? { ...config, baseUrl: parseCloudApiUrl(config.baseUrl) } : null;
}

export function getCloudApiConfig(): CloudApiConfig | null {
  return configured;
}

export function requireCloudApiConfig(): CloudApiConfig {
  if (!configured) {
    throw new HttpError(503, 'CLOUD_API_NOT_CONFIGURED',
      `The sidecar has no ${CLOUD_API_URL_ENV}; it cannot authenticate callers or execute tasks`);
  }
  return configured;
}

/** A client authenticated as one request principal. Built per request. */
export function createPrincipalClient(token: string, timeoutMs = CLOUD_API_TIMEOUT_MS): OpenLinearClient {
  const config = requireCloudApiConfig();
  return new OpenLinearClient({ baseUrl: config.baseUrl, token, fetch: config.fetch, timeoutMs });
}

/** A client bound to one attempt's capability. Never carries a user token. */
export function createAttemptClient(attemptId: string, capability: string): ExecutionAttemptClient {
  const config = requireCloudApiConfig();
  return new ExecutionAttemptClient({
    baseUrl: config.baseUrl,
    attemptId,
    capability,
    fetch: config.fetch,
    timeoutMs: CLOUD_API_TIMEOUT_MS,
  });
}

const PASS_THROUGH_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

/**
 * Map a cloud API failure to a sidecar HttpError. Unreachable or failing
 * (5xx) control planes become 503 CLOUD_API_UNREACHABLE: the caller is denied,
 * never allowed through (fail closed), and the desktop client does not mistake
 * an outage for an expired session.
 */
export function toSidecarError(error: unknown, context: string): HttpError {
  if (isHttpError(error)) return error;
  if (error instanceof OpenLinearNetworkError) {
    return new HttpError(503, 'CLOUD_API_UNREACHABLE', `OpenLinear API is unreachable (${context})`);
  }
  if (error instanceof OpenLinearApiError) {
    if (PASS_THROUGH_STATUSES.has(error.status)) {
      return new HttpError(error.status, error.code ?? 'CLOUD_API_REJECTED', messageOf(error) ?? `OpenLinear API rejected ${context}`, error.details);
    }
    return new HttpError(503, 'CLOUD_API_UNREACHABLE', `OpenLinear API failed (${context}, HTTP ${error.status})`);
  }
  return new HttpError(503, 'CLOUD_API_UNREACHABLE', `OpenLinear API call failed (${context})`);
}

function messageOf(error: OpenLinearApiError): string | undefined {
  try {
    const parsed: unknown = JSON.parse(error.responseText);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.message === 'string') return record.message;
      if (typeof record.error === 'string') return record.error;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

export function isCloudUnavailable(error: unknown): boolean {
  return isHttpError(error) && (error.code === 'CLOUD_API_UNREACHABLE' || error.code === 'CLOUD_API_NOT_CONFIGURED');
}
