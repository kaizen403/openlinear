import { createHash } from "node:crypto";

/**
 * Prisma query observation (performance plan, Phase 0).
 *
 * The client in `client.ts` subscribes to Prisma `query` events when a
 * slow-query threshold is configured and forwards every event here. Two
 * consumers exist:
 *
 *  - the default sink, which writes one JSON line to stderr for each query at
 *    or above the threshold (worker, scripts, any process without an observer);
 *  - an installed observer (the API's route-timing middleware), which counts
 *    queries per request and logs slow ones with route context.
 *
 * Parameter values are never read. Prisma sends values as bind parameters, so
 * the SQL text only holds placeholders; string literals that a raw query may
 * still inline are masked by `redactSql` before anything is emitted.
 *
 * `OPENLINEAR_SLOW_QUERY_MS`:
 *   - unset: 250 ms in production, 100 ms elsewhere, disabled under NODE_ENV=test;
 *   - a number >= 0: that threshold (0 reports every query; development only);
 *   - `off` / `false` / `-1`: disabled. No query events are subscribed, so the
 *     client is constructed exactly as before.
 */

export const DEFAULT_SLOW_QUERY_MS_PRODUCTION = 250;
export const DEFAULT_SLOW_QUERY_MS_DEVELOPMENT = 100;

/** Upper bound on emitted SQL text, so a huge IN-list cannot flood the log. */
export const MAX_LOGGED_SQL_CHARS = 2_000;

export interface QueryObservation {
  /** Driver-reported duration of one SQL statement, in milliseconds. */
  readonly durationMs: number;
  /** The threshold this observation was compared with. */
  readonly thresholdMs: number;
  /** `durationMs >= thresholdMs`. */
  readonly slow: boolean;
  /**
   * Redacted, whitespace-collapsed and truncated SQL text. Computed on demand;
   * call it only for queries you are going to log.
   */
  sql(): string;
  /** Stable 12-hex-char id of the redacted statement, for grouping. */
  fingerprint(): string;
}

export type QueryObserver = (observation: QueryObservation) => void;

let observer: QueryObserver | null = null;

/**
 * Install (or clear, with `null`) the process-wide query observer. When an
 * observer is installed it owns slow-query reporting; the default stderr sink
 * is skipped.
 */
export function setQueryObserver(next: QueryObserver | null): void {
  observer = next;
}

function defaultThreshold(env: NodeJS.ProcessEnv): number | null {
  if (env.NODE_ENV === "test") return null;
  return env.NODE_ENV === "production"
    ? DEFAULT_SLOW_QUERY_MS_PRODUCTION
    : DEFAULT_SLOW_QUERY_MS_DEVELOPMENT;
}

/** Slow-query threshold in ms, or `null` when query observation is disabled. */
export function resolveSlowQueryThresholdMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.OPENLINEAR_SLOW_QUERY_MS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultThreshold(env);
  if (raw === "off" || raw === "false" || raw === "-1") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultThreshold(env);
  return parsed;
}

const STRING_LITERAL = /(?:\bE)?'(?:[^']|'')*'/g;
const DOLLAR_QUOTED = /\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g;
const WHITESPACE = /\s+/g;

/**
 * Mask literal values and bound the size of a SQL statement. Bind
 * placeholders (`$1`), identifiers and numeric literals such as `LIMIT 1` are
 * kept so the statement stays recognisable.
 */
export function redactSql(sql: string): string {
  const masked = sql
    .replace(DOLLAR_QUOTED, "$$?$$")
    .replace(STRING_LITERAL, "'?'")
    .replace(WHITESPACE, " ")
    .trim();
  return masked.length > MAX_LOGGED_SQL_CHARS
    ? `${masked.slice(0, MAX_LOGGED_SQL_CHARS)}…[+${masked.length - MAX_LOGGED_SQL_CHARS} chars]`
    : masked;
}

export function fingerprintSql(redacted: string): string {
  return createHash("sha1").update(redacted).digest("hex").slice(0, 12);
}

function writeDefaultSlowQueryLine(observation: QueryObservation): void {
  const line = JSON.stringify({
    level: 40,
    time: Date.now(),
    evt: "slow_query",
    durationMs: Math.round(observation.durationMs * 100) / 100,
    thresholdMs: observation.thresholdMs,
    fingerprint: observation.fingerprint(),
    sql: observation.sql(),
    msg: "prisma slow query",
  });
  process.stderr.write(`${line}\n`);
}

/** Entry point for the client's `query` event. Never throws. */
export function recordQueryEvent(durationMs: number, rawSql: string, thresholdMs: number): void {
  let redacted: string | undefined;
  const sql = (): string => {
    redacted ??= redactSql(rawSql);
    return redacted;
  };
  const observation: QueryObservation = {
    durationMs,
    thresholdMs,
    slow: durationMs >= thresholdMs,
    sql,
    fingerprint: () => fingerprintSql(sql()),
  };
  try {
    if (observer) {
      observer(observation);
    } else if (observation.slow) {
      writeDefaultSlowQueryLine(observation);
    }
  } catch {
    // Observability must never break a query.
  }
}
