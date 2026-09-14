import pino, { type Logger } from "pino";

export function createLogger(options: { name?: string; level?: string } = {}): Logger {
  const isProd = process.env.NODE_ENV === "production";
  return pino({
    name: options.name,
    level: options.level ?? process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.query.token",
        "req.query.ticket",
        "res.headers[\"set-cookie\"]",
        "req.body.accessToken",
        "req.body.token",
        "req.body.refreshToken",
      ],
      censor: "[REDACTED]",
    },
  });
}
