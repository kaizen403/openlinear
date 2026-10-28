/**
 * Durable single writer per chat session (W18a).
 *
 * At most one turn per session may run at a time, across every API replica.
 * The lease lives in Postgres (`chat_turn_leases`, one row per session):
 *
 *  - acquire: insert the row, or take over a row that was released or whose
 *    lease expired, in ONE statement (`INSERT … ON CONFLICT DO UPDATE … WHERE
 *    released OR expired`). Concurrent acquirers serialise on the primary key;
 *    exactly one gets a row back, the others get `TURN_IN_PROGRESS`. A takeover
 *    increments `fence`, the fencing token.
 *  - renew: a heartbeat (every ttl/3) extends `expiresAt` while the turn runs,
 *    conditional on (turnId, fence) still matching. A replica that crashed
 *    stops renewing, so its lease expires after `ttl` and the session unlocks.
 *  - fenced writes: every transcript write of a turn runs in a transaction that
 *    first renews the lease with the same condition. The UPDATE holds the
 *    lease row lock until commit, so a concurrent takeover waits and then sees
 *    the fresh expiry, and a turn whose lease was taken over cannot write: its
 *    conditional UPDATE matches no row and the write is refused
 *    (`TURN_LEASE_LOST`).
 *  - release: the turn marks the row released when it ends (also on errors).
 *
 * Tool side effects (task writes) run in their own transactions and are not
 * conditional on the lease. They are fenced by renewing the lease right before
 * each dispatch and by the heartbeat while the tool runs; a turn that loses
 * its lease is aborted, and an interrupted write is reported as outcome-unknown
 * and reconciled (see chat-tools/index.ts).
 *
 * All timestamps are computed by the database (`clock_timestamp()` in UTC), so
 * replica clock skew cannot shorten or extend a lease.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Prisma, prisma } from '@openlinear/db';
import { z } from 'zod';
import { logger } from '../logger';

export const DEFAULT_TURN_LEASE_TTL_MS = 45_000;

const ttlSchema = z.string().trim().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1_000).max(600_000));

/** `CHAT_TURN_LEASE_TTL_MS` (1 s – 10 min); invalid values fall back to the default with a warning. */
export function turnLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAT_TURN_LEASE_TTL_MS?.trim();
  if (!raw) return DEFAULT_TURN_LEASE_TTL_MS;
  const parsed = ttlSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn({ value: raw }, '[chat] CHAT_TURN_LEASE_TTL_MS is invalid; using the default');
  return DEFAULT_TURN_LEASE_TTL_MS;
}

/** Identifies the process holding a lease (diagnostics only; never trusted). */
const HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 200);

const NOW_UTC = Prisma.sql`timezone('UTC', clock_timestamp())`;

function expiresIn(ttlMs: number): Prisma.Sql {
  return Prisma.sql`${NOW_UTC} + (${ttlMs}::int * interval '1 millisecond')`;
}

/** Raised when a turn no longer holds its session's lease (taken over after expiry). */
export class TurnLeaseLostError extends Error {
  readonly code = 'TURN_LEASE_LOST' as const;

  constructor(message = 'Another reply took over this chat; this reply stopped writing.') {
    super(message);
    this.name = 'TurnLeaseLostError';
  }
}

export function isTurnLeaseLostError(error: unknown): error is TurnLeaseLostError {
  return error instanceof TurnLeaseLostError;
}

export interface TurnLeaseHolder {
  turnId: string;
  expiresAt: Date;
}

export class TurnLease {
  private readonly controller = new AbortController();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private released = false;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    readonly fence: number,
    private expiresAtValue: Date,
    readonly ttlMs: number,
  ) {}

  /** Aborted (reason: `TurnLeaseLostError`) once the lease is known to be lost. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lost(): boolean {
    return this.controller.signal.aborted;
  }

  get expiresAt(): Date {
    return this.expiresAtValue;
  }

  private markLost(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new TurnLeaseLostError());
    this.stopHeartbeat();
  }

  private renewSql(): Prisma.Sql {
    return Prisma.sql`
      UPDATE "chat_turn_leases"
      SET "renewedAt" = ${NOW_UTC}, "expiresAt" = ${expiresIn(this.ttlMs)}
      WHERE "sessionId" = ${this.sessionId}
        AND "turnId" = ${this.turnId}
        AND "fence" = ${this.fence}
        AND "releasedAt" IS NULL
      RETURNING "expiresAt"`;
  }

  /**
   * Extend the lease. False when it is no longer ours (released, or taken over
   * after it expired): the turn must stop. A lease that expired but was not
   * taken over is still ours: nobody else can have written in between, because
   * any takeover changes (turnId, fence).
   */
  async renew(): Promise<boolean> {
    if (this.released || this.lost) return false;
    const rows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>(this.renewSql());
    const row = rows[0];
    if (!row) {
      this.markLost();
      return false;
    }
    this.expiresAtValue = row.expiresAt;
    return true;
  }

  /** Renew every ttl/3 until released or lost. */
  startHeartbeat(): void {
    if (this.heartbeat || this.released) return;
    const interval = Math.max(250, Math.floor(this.ttlMs / 3));
    this.heartbeat = setInterval(() => {
      this.renew().catch((err: unknown) => {
        logger.warn({ err, sessionId: this.sessionId, turnId: this.turnId }, '[chat] turn lease heartbeat failed');
      });
    }, interval);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Run `fn` in a transaction that first renews the lease. Throws
   * `TurnLeaseLostError` (and runs nothing) when the lease is not ours.
   */
  async fenced<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.released || this.lost) throw new TurnLeaseLostError();
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ expiresAt: Date }>>(this.renewSql());
      const row = rows[0];
      if (!row) {
        this.markLost();
        throw new TurnLeaseLostError();
      }
      this.expiresAtValue = row.expiresAt;
      return fn(tx);
    });
  }

  /** Release the lease (idempotent; never throws: an unreleased lease just expires). */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();
    try {
      await prisma.$executeRaw`
        UPDATE "chat_turn_leases"
        SET "releasedAt" = ${NOW_UTC}
        WHERE "sessionId" = ${this.sessionId}
          AND "turnId" = ${this.turnId}
          AND "fence" = ${this.fence}
          AND "releasedAt" IS NULL`;
    } catch (err) {
      logger.warn({ err, sessionId: this.sessionId, turnId: this.turnId }, '[chat] could not release a turn lease; it will expire');
    }
  }
}

export type AcquireTurnLeaseResult =
  | { ok: true; lease: TurnLease }
  | { ok: false; holder: TurnLeaseHolder | null };

/**
 * Try to become the session's single writer for `turnId`. Never waits: a busy
 * session answers immediately with the current holder.
 */
export async function acquireTurnLease(
  sessionId: string,
  turnId: string,
  options: { ttlMs?: number; heartbeat?: boolean } = {},
): Promise<AcquireTurnLeaseResult> {
  const ttlMs = options.ttlMs ?? turnLeaseTtlMs();
  const rows = await prisma.$queryRaw<Array<{ fence: number; expiresAt: Date }>>`
    INSERT INTO "chat_turn_leases" ("sessionId", "turnId", "fence", "holder", "acquiredAt", "renewedAt", "expiresAt", "releasedAt")
    VALUES (${sessionId}, ${turnId}, 1, ${HOLDER}, ${NOW_UTC}, ${NOW_UTC}, ${expiresIn(ttlMs)}, NULL)
    ON CONFLICT ("sessionId") DO UPDATE SET
      "turnId" = EXCLUDED."turnId",
      "fence" = "chat_turn_leases"."fence" + 1,
      "holder" = EXCLUDED."holder",
      "acquiredAt" = EXCLUDED."acquiredAt",
      "renewedAt" = EXCLUDED."renewedAt",
      "expiresAt" = EXCLUDED."expiresAt",
      "releasedAt" = NULL
    WHERE "chat_turn_leases"."releasedAt" IS NOT NULL
       OR "chat_turn_leases"."expiresAt" <= ${NOW_UTC}
    RETURNING "fence", "expiresAt"`;
  const row = rows[0];
  if (!row) return { ok: false, holder: await activeTurnLease(sessionId) };
  const lease = new TurnLease(sessionId, turnId, Number(row.fence), row.expiresAt, ttlMs);
  if (options.heartbeat !== false) lease.startHeartbeat();
  return { ok: true, lease };
}

/** The live lease of a session (a turn is running), or null. */
export async function activeTurnLease(sessionId: string): Promise<TurnLeaseHolder | null> {
  const rows = await prisma.$queryRaw<Array<{ turnId: string; expiresAt: Date }>>`
    SELECT "turnId", "expiresAt" FROM "chat_turn_leases"
    WHERE "sessionId" = ${sessionId}
      AND "releasedAt" IS NULL
      AND "expiresAt" > ${NOW_UTC}`;
  const row = rows[0];
  return row ? { turnId: row.turnId, expiresAt: row.expiresAt } : null;
}

/** Error payload for a refused turn (HTTP 409 body and SSE error chunk). */
export function turnInProgressError(holder: TurnLeaseHolder | null): {
  code: 'TURN_IN_PROGRESS';
  message: string;
  details: { retryAfterSeconds: number; leaseExpiresAt: string | null };
} {
  const retryAfterMs = holder ? Math.max(0, holder.expiresAt.getTime() - Date.now()) : 0;
  return {
    code: 'TURN_IN_PROGRESS',
    message: 'Another reply is still being written in this chat. Wait for it to finish, then send again.',
    details: {
      // The holder renews while it runs, so this is a lower bound, not a promise.
      retryAfterSeconds: Math.max(1, Math.min(60, Math.ceil(retryAfterMs / 1000))),
      leaseExpiresAt: holder ? holder.expiresAt.toISOString() : null,
    },
  };
}
