import pino, { type Logger } from 'pino';

/**
 * Sidecar-local structured logger (W03a: the sidecar no longer imports the
 * cloud API package). Credentials never belong in log fields; the redaction
 * list is a second line of defence for bearer tokens, attempt capabilities
 * and git credentials that reach a logged object by mistake.
 */
const isProd = process.env.NODE_ENV === 'production';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'token',
      'capability',
      'accessToken',
      '*.token',
      '*.capability',
      '*.accessToken',
    ],
    censor: '[REDACTED]',
  },
});
