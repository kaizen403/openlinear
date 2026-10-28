/**
 * W04a request idempotency.
 *
 * Contract (docs/plans/backend-product-contracts.md): mutating endpoints accept
 * `Idempotency-Key`, scoped to principal, workspace and operation kind. An equal
 * key with equal canonical arguments returns the same result; different
 * arguments return `409 IDEMPOTENCY_CONFLICT`.
 *
 * Flow for a keyed request:
 *   1. Validate the header (400 IDEMPOTENCY_KEY_INVALID). No header: run the
 *      command exactly as before, with no idempotency record.
 *   2. Authorize the caller against the target resource. A stored response is
 *      never replayed to a principal that has since lost access.
 *   3. Fast path: a known, unexpired key answers immediately — conflict on a
 *      different request hash, replay of the stored bytes on an equal one.
 *   4. Validate (command.prepare), then in ONE transaction: reserve the key
 *      (`INSERT ... ON CONFLICT DO NOTHING`), run the domain writes, and store
 *      the serialized response as `completed`. Any failure rolls back the
 *      reservation together with the writes, so a retry can succeed.
 *   5. A concurrent duplicate blocks on the unique index until the holder
 *      commits or rolls back (bounded by IDEMPOTENCY_LOCK_WAIT_MS), then replays
 *      the committed result, conflicts, or takes over the key after a rollback.
 *      If the holder is still running when the bound expires, the duplicate
 *      gets `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.
 *   6. Realtime events are appended inside `mutate` (W04b transactional
 *      outbox), so they commit with the record and are never re-emitted on
 *      replay. Other post-commit side effects (activity, notifications, cache
 *      invalidation) run once, after commit, and never on replay.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma, type IdempotencyRecord, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionAppendedEvents } from '../events/outbox';
import { requestOutboxFlush } from '../events/relay';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logger } from '../logger';
import type { AuthRequest } from '../middleware/auth';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '../schemas/idempotency';
import { getTenancyContext } from '../tenancy/context';

/** Records are forgotten after this; the key may then be reused. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long a duplicate waits for an in-flight holder of the same key. */
export const IDEMPOTENCY_LOCK_WAIT_MS = 5_000;
/** Matches the `idempotency_records_response_size_check` constraint. */
export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 1;
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** Bump when the canonical request form changes. */
const REQUEST_HASH_VERSION = 1;
/** Partition for operations whose target has no resolvable workspace. */
const NO_WORKSPACE = '';
const MAX_RESERVATION_ATTEMPTS = 3;
const LOCK_NOT_AVAILABLE = '55P03';

/** Stable operation kinds. Part of the key scope and the request hash. */
export type IdempotencyOperation =
  | 'tasks.create'
  | 'tasks.bulk_create'
  // W04b: routes migrated off the legacy `idempotency_keys` cache.
  | 'projects.create'
  | 'projects.access.grant'
  | 'projects.access.bulk_grant'
  | 'teams.create'
  | 'teams.join'
  | 'teams.members.add'
  | 'workspaces.create'
  | 'workspaces.members.add'
  | 'workspaces.members.bulk_add'
  // W17b
  | 'plans.create'
  // W20
  | 'schedules.create'
  // W19b
  | 'knowledge.create'
  // FE-14 outbound webhooks
  | 'webhooks.create';

export interface IdempotencyPrincipal {
  principalId: string;
  workspaceId: string;
}

/**
 * The ONLY place idempotency reads request identity (W04a/W02a seam), now fed
 * by the W02a PrincipalContext.
 *
 * Keys are scoped per credential (W04b decision): an interactive session's
 * scope is the user (`<userId>`, shared by the user's sessions, so a token
 * refresh or a second device does not change it), and every personal access
 * token has its own scope (`<userId>:pat:<tokenId>`). Two clients of one
 * user (desktop session, MCP worker PAT, a CI PAT) therefore never replay or
 * conflict with each other's keys, and a PAT can never receive a response
 * stored for another credential. The workspace stays the one owning the
 * target resource; for a workspace-bound PAT that is always its binding
 * (authorization runs first and refuses anything else).
 */
export function resolveIdempotencyPrincipal(
  req: AuthRequest,
  resourceWorkspaceId: string | null,
): IdempotencyPrincipal {
  if (!req.userId) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const principal = req.tenancy ?? getTenancyContext();
  const patId = principal?.userId === req.userId && principal.authSource === 'pat'
    ? principal.credentialId
    : req.authSource === 'pat' ? req.patId ?? null : null;
  return {
    principalId: patId ? `${req.userId}:pat:${patId}` : req.userId,
    workspaceId: resourceWorkspaceId ?? NO_WORKSPACE,
  };
}

export interface IdempotencyScope extends IdempotencyPrincipal {
  operation: IdempotencyOperation;
  key: string;
}

export interface IdempotentMutationResult<TBody> {
  status: number;
  body: TBody;
  /**
   * Post-commit side effects. Run once after commit, never on replay. A
   * failure is logged and does not change the committed response.
   */
  afterCommit?: () => Promise<void>;
}

/**
 * An authorized domain command, split so the idempotency layer can replay
 * between authorization and validation and run the writes in its transaction.
 */
export interface IdempotentCommand<TPrepared, TBody> {
  /** Workspace owning the target resource. Evaluated only for keyed requests. */
  resolveWorkspaceId: () => Promise<string | null>;
  /** Read-only validation. Skipped when a stored response is replayed. */
  prepare: () => Promise<TPrepared>;
  /**
   * Domain writes. Use only `tx`: while duplicates wait on the reservation,
   * touching the global client here could wait on an exhausted pool.
   */
  mutate: (tx: Prisma.TransactionClient, prepared: TPrepared) => Promise<IdempotentMutationResult<TBody>>;
}

export interface IdempotencySettings {
  lockWaitMs: number;
  maxResponseBytes: number;
  retentionMs: number;
}

export interface RespondIdempotentlyOptions<TPrepared, TBody> {
  operation: IdempotencyOperation;
  /** Validated arguments defining request equality: the parsed body plus route params. */
  args: { params?: Record<string, string>; body: unknown };
  /** Authorize the caller and build the command. Runs before any replay. */
  authorize: () => Promise<IdempotentCommand<TPrepared, TBody>>;
  settings?: Partial<IdempotencySettings>;
}

/**
 * Parse `Idempotency-Key`. Returns null when the header is absent; throws
 * 400 IDEMPOTENCY_KEY_INVALID when it is present but malformed (including
 * empty or repeated).
 */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.header(IDEMPOTENCY_KEY_HEADER);
  if (raw === undefined) return null;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', `Invalid ${IDEMPOTENCY_KEY_HEADER} header`, {
      header: IDEMPOTENCY_KEY_HEADER,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members omitted (as
 * JSON.stringify does), array order preserved. Throws on values JSON cannot
 * represent so two different requests can never hash alike by accident.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize a ${typeof value}`);
}

/** SHA-256 (hex) of the canonical request: version, method, operation, params and body. */
export function computeRequestHash(input: {
  method: string;
  operation: IdempotencyOperation;
  params?: Record<string, string>;
  body: unknown;
}): string {
  const canonical = canonicalJson({
    v: REQUEST_HASH_VERSION,
    method: input.method.toUpperCase(),
    operation: input.operation,
    params: input.params ?? {},
    body: input.body,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Ask this process to deliver events appended by a committed transaction (W04b). */
function flushIfAppended(tx: Prisma.TransactionClient | undefined): void {
  if (tx && transactionAppendedEvents(tx)) requestOutboxFlush();
}

/** Run `mutate` in its own transaction (no idempotency record). */
async function commitCommand<TPrepared, TBody>(
  command: IdempotentCommand<TPrepared, TBody>,
  prepared: TPrepared,
): Promise<IdempotentMutationResult<TBody>> {
  const used: { tx?: Prisma.TransactionClient } = {};
  const result = await prisma.$transaction((tx) => {
    used.tx = tx;
    return command.mutate(tx, prepared);
  }, PRISMA_TX_OPTIONS);
  flushIfAppended(used.tx);
  return result;
}

/** Run a command without HTTP idempotency (chat tools, plan import). */
export async function runCommand<TPrepared, TBody>(command: IdempotentCommand<TPrepared, TBody>): Promise<TBody> {
  return (await runCommandWithStatus(command)).body;
}

/** `runCommand`, keeping the status the HTTP route would answer with. */
export async function runCommandWithStatus<TPrepared, TBody>(
  command: IdempotentCommand<TPrepared, TBody>,
): Promise<{ status: number; body: TBody }> {
  const prepared = await command.prepare();
  const result = await commitCommand(command, prepared);
  await runAfterCommit(result);
  return { status: result.status, body: result.body };
}

/**
 * Execute an authorized command for an HTTP request, honouring
 * `Idempotency-Key` when present. Errors propagate to the global handler.
 */
export async function respondIdempotently<TPrepared, TBody>(
  req: AuthRequest,
  res: Response,
  options: RespondIdempotentlyOptions<TPrepared, TBody>,
): Promise<void> {
  const key = readIdempotencyKey(req);
  const command = await options.authorize();

  if (key === null) {
    const prepared = await command.prepare();
    const result = await commitCommand(command, prepared);
    await runAfterCommit(result);
    res.status(result.status).json(result.body);
    return;
  }

  const settings = resolveSettings(options.settings);
  const scope: IdempotencyScope = {
    ...resolveIdempotencyPrincipal(req, await command.resolveWorkspaceId()),
    operation: options.operation,
    key,
  };
  const requestHash = computeRequestHash({
    method: req.method,
    operation: options.operation,
    params: options.args.params,
    body: options.args.body,
  });
  // One clock reading per request: expiry is judged "as of arrival".
  const now = new Date();

  const known = await prisma.idempotencyRecord.findUnique({
    where: { principalId_workspaceId_operation_key: scope },
  });
  if (known && known.expiresAt > now) {
    answerFromRecord(res, known, requestHash, settings);
    return;
  }

  const prepared = await command.prepare();
  let phase: 'reserve' | 'mutate' = 'reserve';
  let outcome: ReservedOutcome<TBody>;
  const used: { tx?: Prisma.TransactionClient } = {};
  try {
    outcome = await prisma.$transaction(async (tx): Promise<ReservedOutcome<TBody>> => {
      used.tx = tx;
      const reservation = await reserve(tx, scope, requestHash, now, settings);
      if (reservation.kind !== 'reserved') return reservation;

      phase = 'mutate';
      const result = await command.mutate(tx, prepared);
      const serialized = serializeResponse(result.body, settings.maxResponseBytes);
      await tx.idempotencyRecord.update({
        where: { id: reservation.id },
        data: {
          state: 'completed',
          responseStatus: result.status,
          responseBody: serialized,
          completedAt: new Date(),
        },
      });
      return { kind: 'executed', result, serialized };
    }, PRISMA_TX_OPTIONS);
  } catch (err) {
    // Only the bounded wait on the key maps to IN_PROGRESS; a lock failure in
    // the domain writes keeps its own error.
    if (phase === 'reserve' && hasPostgresCode(err, LOCK_NOT_AVAILABLE)) {
      throw inProgressError(res);
    }
    throw err;
  }

  if (outcome.kind === 'busy') {
    throw inProgressError(res);
  }
  if (outcome.kind === 'existing') {
    answerFromRecord(res, outcome.record, requestHash, settings);
    return;
  }
  flushIfAppended(used.tx);
  await runAfterCommit(outcome.result);
  sendSerialized(res, outcome.result.status, outcome.serialized, false);
}

type Reservation =
  | { kind: 'reserved'; id: string }
  | { kind: 'existing'; record: IdempotencyRecord }
  | { kind: 'busy' };

type ReservedOutcome<TBody> =
  | Exclude<Reservation, { kind: 'reserved' }>
  | { kind: 'executed'; result: IdempotentMutationResult<TBody>; serialized: string };

/**
 * Claim the key inside the caller's transaction. The insert waits on the
 * unique index while another transaction holds an uncommitted reservation for
 * the same scope; `lock_timeout` bounds that wait and is restored before the
 * domain writes so their row locks keep normal semantics.
 */
async function reserve(
  tx: Prisma.TransactionClient,
  scope: IdempotencyScope,
  requestHash: string,
  now: Date,
  settings: IdempotencySettings,
): Promise<Reservation> {
  const [current] = await tx.$queryRaw<Array<{ value: string }>>`SELECT current_setting('lock_timeout') AS value`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${settings.lockWaitMs}ms`}, true)`;

  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    // An expired record is forgotten: take the key over.
    await tx.idempotencyRecord.deleteMany({ where: { ...scope, expiresAt: { lte: now } } });
    const id = randomUUID();
    const inserted = await tx.idempotencyRecord.createMany({
      data: [{
        id,
        ...scope,
        requestHash,
        state: 'in_progress',
        expiresAt: new Date(now.getTime() + settings.retentionMs),
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${current?.value ?? '0'}, true)`;
      return { kind: 'reserved', id };
    }
    const record = await tx.idempotencyRecord.findUnique({
      where: { principalId_workspaceId_operation_key: scope },
    });
    if (record && record.expiresAt > now) {
      return { kind: 'existing', record };
    }
    // The conflicting row vanished (pruned) or expired between statements; claim again.
  }
  return { kind: 'busy' };
}

function answerFromRecord(
  res: Response,
  record: IdempotencyRecord,
  requestHash: string,
  settings: IdempotencySettings,
): void {
  if (record.requestHash !== requestHash) {
    throw new HttpError(
      409,
      'IDEMPOTENCY_CONFLICT',
      `${IDEMPOTENCY_KEY_HEADER} was already used with a different request`,
      { operation: record.operation, retentionSeconds: Math.round(settings.retentionMs / 1000) },
    );
  }
  if (record.state !== 'completed' || record.responseStatus === null || record.responseBody === null) {
    throw inProgressError(res);
  }
  sendSerialized(res, record.responseStatus, record.responseBody, true);
}

function inProgressError(res: Response): HttpError {
  res.setHeader('Retry-After', String(IDEMPOTENCY_RETRY_AFTER_SECONDS));
  return new HttpError(
    409,
    'IDEMPOTENCY_IN_PROGRESS',
    `A request with this ${IDEMPOTENCY_KEY_HEADER} is still being processed`,
    { retryAfterSeconds: IDEMPOTENCY_RETRY_AFTER_SECONDS },
  );
}

function serializeResponse(body: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new TypeError('Idempotent commands must return a JSON-serializable body');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new HttpError(
      422,
      'IDEMPOTENCY_RESPONSE_TOO_LARGE',
      `The result is too large to retain for ${IDEMPOTENCY_KEY_HEADER} replay; nothing was written. Retry with a smaller request or without the header.`,
      { maxBytes },
    );
  }
  return serialized;
}

/** Original and replayed responses are the same bytes with the same content type. */
function sendSerialized(res: Response, status: number, serialized: string, replayed: boolean): void {
  if (replayed) res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  res.status(status).type('application/json').send(serialized);
}

async function runAfterCommit(result: { afterCommit?: () => Promise<void> }): Promise<void> {
  if (!result.afterCommit) return;
  try {
    await result.afterCommit();
  } catch (err) {
    logger.error({ err }, '[idempotency] post-commit side effect failed; returning the committed result');
  }
}

function resolveSettings(overrides: Partial<IdempotencySettings> | undefined): IdempotencySettings {
  return {
    lockWaitMs: Math.max(1, Math.trunc(overrides?.lockWaitMs ?? IDEMPOTENCY_LOCK_WAIT_MS)),
    maxResponseBytes: Math.min(overrides?.maxResponseBytes ?? IDEMPOTENCY_MAX_RESPONSE_BYTES, IDEMPOTENCY_MAX_RESPONSE_BYTES),
    retentionMs: overrides?.retentionMs ?? IDEMPOTENCY_RETENTION_MS,
  };
}

/** True when `err` (or its cause chain) carries the given SQLSTATE. */
function hasPostgresCode(err: unknown, sqlState: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; originalCode?: unknown; cause?: unknown };
    if (candidate.code === sqlState || candidate.originalCode === sqlState) return true;
    current = candidate.cause;
  }
  return false;
}

/** Retention sweep; called by the maintenance job. */
export async function pruneIdempotencyRecords(now: Date = new Date()): Promise<number> {
  const result = await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}
