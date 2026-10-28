/**
 * Realtime/outbox configuration (W04b).
 *
 * Relay ownership. Exactly one process ROLE owns the periodic outbox relay
 * (sequence leftovers, publish to the bus, retry with backoff, dead-letter).
 * Every process of that role runs it; that is safe because claims are leased
 * and sequencing is serialized by an advisory lock, so N replicas of the
 * owner role only share the work.
 *
 *   OPENLINEAR_OUTBOX_RELAY = api | worker | off     (default: api)
 *
 * Set the same value in every container of a deployment. `off` (or the
 * legacy `0`/`false`) disables the relay in the process that reads it; it is
 * a per-process opt-out kept for compatibility, not a deployment setting.
 *
 * A process learns its role from `startRealtime({ role })`, else from
 * `OPENLINEAR_PROCESS_ROLE` (api | worker), else from its entry file name
 * (`worker.ts` / `worker.js`), else `api`.
 *
 * Fast flush. Independently of ownership, a process that commits a
 * transaction with appended events sequences and delivers them right away
 * (one attempt, no retry loop) so live latency does not depend on the relay
 * tick. Disable with OPENLINEAR_OUTBOX_FAST_FLUSH=0 (the owner relay then
 * picks the events up within one relay interval).
 */
import { basename } from 'node:path';

export type ProcessRole = 'api' | 'worker';
export type RelayOwner = ProcessRole | 'off';

export interface RealtimeConfig {
  relayOwner: RelayOwner;
  relayIntervalMs: number;
  /** Stream catch-up poll; null = choose from the bus (see pollIntervalFor). */
  pollIntervalMs: number | null;
  fastFlush: boolean;
  maxAttempts: number;
  leaseMs: number;
  batchSize: number;
}

export const DEFAULT_RELAY_INTERVAL_MS = 500;
/** Poll when no distributed bus carries events between processes. */
export const DEFAULT_LOCAL_POLL_MS = 500;
/** Safety-net poll when a distributed bus is configured. */
export const DEFAULT_DISTRIBUTED_POLL_MS = 2_000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 200;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseOwner(raw: string | undefined): RelayOwner {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'api';
  if (value === 'api' || value === 'worker') return value;
  if (value === 'off' || value === '0' || value === 'false' || value === 'none') return 'off';
  // Legacy truthy values meant "run the relay here".
  if (value === '1' || value === 'true' || value === 'on') return 'api';
  return 'api';
}

export function readRealtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const poll = env.OPENLINEAR_OUTBOX_POLL_MS;
  return {
    relayOwner: parseOwner(env.OPENLINEAR_OUTBOX_RELAY),
    relayIntervalMs: positiveInt(env.OPENLINEAR_OUTBOX_RELAY_INTERVAL_MS, DEFAULT_RELAY_INTERVAL_MS),
    pollIntervalMs: poll === undefined || poll.trim() === '' ? null : positiveInt(poll, DEFAULT_LOCAL_POLL_MS),
    fastFlush: !['0', 'false', 'off'].includes((env.OPENLINEAR_OUTBOX_FAST_FLUSH ?? '').trim().toLowerCase()),
    maxAttempts: positiveInt(env.OPENLINEAR_OUTBOX_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    leaseMs: positiveInt(env.OPENLINEAR_OUTBOX_LEASE_MS, DEFAULT_LEASE_MS),
    batchSize: positiveInt(env.OPENLINEAR_OUTBOX_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  };
}

export function resolveProcessRole(
  explicit?: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
  entry: string | undefined = process.argv[1],
): ProcessRole {
  if (explicit) return explicit;
  const fromEnv = env.OPENLINEAR_PROCESS_ROLE?.trim().toLowerCase();
  if (fromEnv === 'api' || fromEnv === 'worker') return fromEnv;
  if (entry && /^worker\.(ts|js|mjs|cjs)$/.test(basename(entry))) return 'worker';
  return 'api';
}

/** True when this process (of `role`) runs the periodic relay. */
export function ownsRelay(config: RealtimeConfig, role: ProcessRole): boolean {
  return config.relayOwner !== 'off' && config.relayOwner === role;
}

export function pollIntervalFor(config: RealtimeConfig, distributedBus: boolean): number {
  return config.pollIntervalMs ?? (distributedBus ? DEFAULT_DISTRIBUTED_POLL_MS : DEFAULT_LOCAL_POLL_MS);
}
