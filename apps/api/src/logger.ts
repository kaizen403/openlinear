import pino, { Logger } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const CENSOR = '[REDACTED]';

/**
 * Query-string parameters whose values are credentials or one-time secrets:
 * SSE tickets, legacy `?token=`, OAuth `code`/`state`, refresh/access tokens,
 * 2FA challenges. Compared case-insensitively.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'ticket',
  'token',
  'code',
  'state',
  'access_token',
  'refresh_token',
  'refreshtoken',
  'temptoken',
  'id_token',
  'client_secret',
  'session_state',
]);

const SENSITIVE_FIELDS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'tempToken',
  'clientSecret',
  'apiKey',
  'authorization',
  'code',
  'verifier',
  'codeVerifier',
];

/**
 * Redaction paths shared by the base logger and the HTTP logger (W02b; the
 * HTTP logger previously redacted only the auth header, cookies and
 * `?token=`). Covers credential headers, redirect locations (which carry
 * session tokens), sensitive query parameters and credential-bearing body or
 * object fields one level deep.
 */
export const LOG_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'res.headers.location',
  ...[...SENSITIVE_QUERY_PARAMS].map((param) => `req.query.${param}`),
  'req.query.refreshToken',
  'req.query.tempToken',
  ...SENSITIVE_FIELDS.map((field) => `req.body.${field}`),
  ...SENSITIVE_FIELDS.filter((field) => field !== 'code').map((field) => `*.${field}`),
  ...SENSITIVE_FIELDS.filter((field) => field !== 'code').map((field) => field),
];

/** Replace the values of sensitive query parameters in a URL or path. */
export function redactUrlSecrets(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  let changed = false;
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      // keep the raw key
    }
    if (eq < 0 || !SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) return part;
    changed = true;
    return `${rawKey}=${CENSOR}`;
  });
  if (!changed) return url;
  return `${url.slice(0, queryStart + 1)}${parts.join('&')}${hashStart < 0 ? '' : url.slice(hashStart)}`;
}

/** pino-http request serializer hook: the logged URL keeps its path, not its secrets. */
export function redactRequestForLog<T extends { url?: unknown }>(req: T): T {
  if (typeof req.url === 'string') {
    (req as { url: string }).url = redactUrlSecrets(req.url);
  }
  return req;
}

/**
 * Redaction options for the HTTP request logger (pino-http), shared by
 * `createApp()` and the redaction test so they cannot drift.
 */
export function httpLogRedaction(): {
  redact: { paths: string[]; censor: string };
  serializers: { req: typeof redactRequestForLog };
} {
  return {
    redact: { paths: LOG_REDACT_PATHS, censor: CENSOR },
    serializers: { req: redactRequestForLog },
  };
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Personal access tokens.
  [/ol_pat_[A-Za-z0-9]{8,}/g, `ol_pat_${CENSOR}`],
  // SSE tickets.
  [/ol_sse_[A-Za-z0-9_-]{8,}/g, `ol_sse_${CENSOR}`],
  // JWTs (session access tokens) anywhere in a line.
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, CENSOR],
];

/**
 * Last line of defence on the serialized log line: credential formats with a
 * recognisable shape are masked wherever they appear (messages, error text,
 * unexpected fields), not only at the paths above.
 */
export function scrubSecrets(line: string): string {
  let out = line;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: {
    paths: LOG_REDACT_PATHS,
    censor: CENSOR,
  },
  hooks: {
    streamWrite: scrubSecrets,
  },
});
