import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  RUN_EFFECT_KINDS,
  RUN_EVENT_KINDS,
  RUN_STATES,
  RunTransitionError,
  canTransition,
  isRunEffectKind,
  isRunState,
  isTerminalRunState,
  type RunEffectKind,
  type RunEffectRecord,
  type RunEffectStatus,
  type RunEventEnvelope,
  type RunEventKind,
  type RunState,
} from '@openlinear/execution-core';
import { z } from 'zod';
import {
  emptyCounters,
  runCountersSchema,
  runSnapshotSchema,
  runTerminalSchema,
  runtimeEndpointSchema,
  runUsageSchema,
  runVerificationSchema,
  runWorkspaceSchema,
  type RunCounters,
  type RunSnapshot,
  type RunTerminal,
  type RunUsage,
  type RunVerification,
  type RunWorkspace,
  type RuntimeEndpoint,
} from '../run/types';

/**
 * W06a — the local durable run journal (SQLite, `node:sqlite`).
 *
 * Source of truth for every v2 run on this device:
 * - `run_attempts`: one row per run — state + compare-and-set version,
 *   attempt identity and capability, workspace, runtime endpoint, counters,
 *   terminal decision, and the control plane's acknowledged event cursor.
 * - `run_attempt_events`: append-only, gap-free per-run sequence (an UPDATE
 *   trigger refuses mutation).
 * - `run_effects`: the effect ledger (intent → receipt), keyed by the
 *   deterministic idempotency key.
 *
 * A transition, its event and its effect intents commit in one
 * `BEGIN IMMEDIATE` transaction; WAL with `synchronous=FULL` makes a commit
 * durable before the call returns, so a SIGKILL right after a call never
 * loses it. The file and its directory are private (0600/0700) and sit in
 * the app-data root that the W09a sandbox denies to agents: it holds the
 * attempt capability and the runtime password.
 */

/**
 * 3 (W13a): `run_batches` / `run_batch_members` (additive tables; no rebuild).
 * 2 (W11a): `verifying` state, `verify.run` / `verification.record` effects,
 * `run_attempts.verification_json`, and the workspace retention tables. A
 * version-1 file is upgraded in place on open (tables whose CHECK lists are
 * stale are rebuilt in one transaction; rows are copied unchanged).
 */
export const DURABLE_JOURNAL_SCHEMA_VERSION = 3;
/** Bound per run; past it only critical events are kept (state, effects, errors). */
export const MAX_EVENTS_PER_RUN = 20_000;
export const MAX_EVENT_PAYLOAD_CHARS = 32_000;

export interface NewRun {
  runId: string;
  taskId: string;
  userId: string;
  attemptId: string | null;
  capability: string | null;
  capabilityExpiresAt: number | null;
  runner: string;
  model: string | null;
  state: 'queued' | 'preparing';
  snapshot: RunSnapshot;
  bootId: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  userId: string;
  attemptId: string | null;
  capability: string | null;
  capabilityExpiresAt: number | null;
  runner: string;
  model: string | null;
  state: RunState;
  stateVersion: number;
  snapshot: RunSnapshot;
  workspace: RunWorkspace | null;
  runtime: RuntimeEndpoint | null;
  sessionId: string | null;
  cancelRequestedAt: number | null;
  cancelReason: string | null;
  terminal: RunTerminal | null;
  lastSeq: number;
  relayAckSeq: number;
  usage: RunUsage | null;
  counters: RunCounters;
  /** W11a: the verification manifest sealed before the prompt (null = none resolved). */
  verification: RunVerification | null;
  bootId: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** Fields a transition or an update may change (state goes through `transition`). */
export interface RunPatch {
  attemptId?: string | null;
  capability?: string | null;
  capabilityExpiresAt?: number | null;
  model?: string | null;
  workspace?: RunWorkspace | null;
  runtime?: RuntimeEndpoint | null;
  sessionId?: string | null;
  cancelRequestedAt?: number | null;
  cancelReason?: string | null;
  usage?: RunUsage | null;
  counters?: RunCounters;
  verification?: RunVerification | null;
  bootId?: string;
}

export interface AppendInput {
  kind: RunEventKind;
  payload: Record<string, unknown>;
  /** Relayed to the control plane (log/progress/run.state only). */
  relay?: boolean;
  /** Kept even past the per-run bound. */
  critical?: boolean;
}

export interface EffectIntent {
  key: string;
  kind: RunEffectKind;
  intent: Record<string, unknown>;
}

export interface TransitionInput {
  from: RunState | readonly RunState[];
  to: RunState;
  reason: string;
  payload?: Record<string, unknown>;
  effects?: readonly EffectIntent[];
  patch?: RunPatch;
  terminal?: RunTerminal;
  /** Extra events appended in the same transaction (after the state event). */
  events?: readonly AppendInput[];
}

export interface TransitionResult {
  record: RunRecord;
  seq: number;
  from: RunState;
}

export class JournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptError';
  }
}

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

function asRow(value: unknown): Row | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JournalCorruptError('journal row is not an object');
  return Object.fromEntries(Object.entries(value));
}

function rows(values: unknown[]): Row[] {
  return values.map((value) => {
    const row = asRow(value);
    if (!row) throw new JournalCorruptError('journal row is empty');
    return row;
  });
}

function changesOf(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    const changes = result.changes;
    if (typeof changes === 'number' || typeof changes === 'bigint') return Number(changes);
  }
  return 0;
}

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new JournalCorruptError(`journal column ${column} is not text`);
  return value;
}

function optStr(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new JournalCorruptError(`journal column ${column} is not text`);
  return value;
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new JournalCorruptError(`journal column ${column} is not a number`);
}

function optNum(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return num(row, column);
}

function parseJson<T>(schema: z.ZodType<T>, raw: string | null, column: string): T | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalCorruptError(`journal column ${column} is not JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new JournalCorruptError(`journal column ${column} failed validation`);
  return result.data;
}

const recordSchema = z.record(z.unknown());

function json(value: unknown): string {
  return JSON.stringify(value);
}

function boundedPayload(payload: Record<string, unknown>): string {
  const raw = json(payload);
  if (raw.length <= MAX_EVENT_PAYLOAD_CHARS) return raw;
  // Keep the envelope valid JSON: record the truncation instead of cutting text.
  return json({ truncated: true, originalChars: raw.length, preview: raw.slice(0, MAX_EVENT_PAYLOAD_CHARS - 200) });
}

export function defaultAppDataRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.OPENLINEAR_APP_DATA) return env.OPENLINEAR_APP_DATA;
  const home = env.HOME ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenLinear');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'openlinear');
}

const SQL_STATES = RUN_STATES.map((state) => `'${state}'`).join(', ');
const SQL_EFFECT_KINDS = RUN_EFFECT_KINDS.map((kind) => `'${kind}'`).join(', ');
const SQL_EVENT_KINDS = RUN_EVENT_KINDS.map((kind) => `'${kind}'`).join(', ');

function runAttemptsDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        attempt_id TEXT,
        capability TEXT,
        capability_expires_at INTEGER,
        runner TEXT NOT NULL,
        model TEXT,
        state TEXT NOT NULL CHECK (state IN (${SQL_STATES})),
        state_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        workspace_json TEXT,
        runtime_json TEXT,
        session_id TEXT,
        cancel_requested_at INTEGER,
        cancel_reason TEXT,
        terminal_json TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        relay_ack_seq INTEGER NOT NULL DEFAULT 0 CHECK (relay_ack_seq >= 0),
        usage_json TEXT,
        counters_json TEXT NOT NULL,
        verification_json TEXT,
        boot_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );`;
}

function runEventsDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${SQL_EVENT_KINDS})),
        relay INTEGER NOT NULL CHECK (relay IN (0, 1)),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );`;
}

function runEffectsDdl(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${SQL_EFFECT_KINDS})),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
        intent_json TEXT NOT NULL,
        receipt_json TEXT,
        dispatches INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, key)
      );`;
}

/**
 * W11a worktree retention: a cleanup receipt is recorded BEFORE a worktree
 * is deleted (`pending`), then settled (`removed`/`failed`), so "workspace
 * expired" is reported honestly and an interrupted deletion is retried.
 * `task_hints` holds closure signals the sidecar observed for a task.
 */
const RETENTION_DDL = `
      CREATE TABLE IF NOT EXISTS workspace_cleanups (
        worktree_path TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        branch TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'removed', 'failed')),
        bytes INTEGER,
        detail TEXT,
        recorded_at INTEGER NOT NULL,
        removed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_hints (
        task_id TEXT PRIMARY KEY,
        closed_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`;

/**
 * W13a batches on the v2 run service: one row per batch, one per member.
 * A member's live status comes from its run (`run_id`); `outcome` records a
 * member that never ran (skipped, cancelled before start, or refused at
 * submit) and `final_status` freezes every member when the batch finishes
 * (run records are pruned later than batches are read, but not never).
 */
const BATCH_DDL = `
      CREATE TABLE IF NOT EXISTS run_batches (
        batch_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('parallel', 'queue', 'combined')),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        settings_json TEXT NOT NULL,
        cancel_requested_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS run_batch_members (
        batch_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        run_id TEXT,
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('skipped', 'cancelled', 'failed')),
        error TEXT,
        final_status TEXT CHECK (final_status IS NULL OR final_status IN ('queued', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, position)
      );`;

const INDEX_DDL = `
      CREATE INDEX IF NOT EXISTS run_attempts_state ON run_attempts(state);
      CREATE INDEX IF NOT EXISTS run_attempts_task ON run_attempts(task_id, created_at);
      CREATE TRIGGER IF NOT EXISTS run_attempt_events_immutable
        BEFORE UPDATE ON run_attempt_events
        BEGIN SELECT RAISE(ABORT, 'run events are immutable'); END;
      CREATE INDEX IF NOT EXISTS workspace_cleanups_task ON workspace_cleanups(task_id, recorded_at);
      CREATE INDEX IF NOT EXISTS run_batch_members_run ON run_batch_members(run_id);
      CREATE INDEX IF NOT EXISTS run_batches_status ON run_batches(status, created_at);
    `;

export type WorkspaceCleanupReason =
  | 'retention_expired'
  | 'superseded'
  | 'task_closed'
  | 'disk_budget'
  | 'legacy_age'
  | 'orphan_checkout'
  | 'unused_cache';

export interface WorkspaceCleanupRecord {
  worktreePath: string;
  runId: string | null;
  taskId: string | null;
  branch: string | null;
  reason: WorkspaceCleanupReason;
  status: 'pending' | 'removed' | 'failed';
  bytes: number | null;
  detail: string | null;
  recordedAt: number;
  removedAt: number | null;
}

const CLEANUP_REASONS: readonly WorkspaceCleanupReason[] = ['retention_expired', 'superseded', 'task_closed', 'disk_budget', 'legacy_age', 'orphan_checkout', 'unused_cache'];

function toCleanup(row: Row): WorkspaceCleanupRecord {
  const reason = str(row, 'reason');
  const status = str(row, 'status');
  const knownReason = CLEANUP_REASONS.find((candidate) => candidate === reason);
  if (!knownReason) throw new JournalCorruptError(`unknown cleanup reason ${reason}`);
  if (status !== 'pending' && status !== 'removed' && status !== 'failed') throw new JournalCorruptError(`unknown cleanup status ${status}`);
  return {
    worktreePath: str(row, 'worktree_path'),
    runId: optStr(row, 'run_id'),
    taskId: optStr(row, 'task_id'),
    branch: optStr(row, 'branch'),
    reason: knownReason,
    status,
    bytes: optNum(row, 'bytes'),
    detail: optStr(row, 'detail'),
    recordedAt: num(row, 'recorded_at'),
    removedAt: optNum(row, 'removed_at'),
  };
}

export type BatchModeRecord = 'parallel' | 'queue' | 'combined';
export type BatchStatusRecord = 'running' | 'completed' | 'failed' | 'cancelled';
export type BatchMemberOutcome = 'skipped' | 'cancelled' | 'failed';
export type BatchMemberStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface BatchRecord {
  batchId: string;
  userId: string;
  mode: BatchModeRecord;
  status: BatchStatusRecord;
  settings: Record<string, unknown>;
  cancelRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface BatchMemberRecord {
  batchId: string;
  position: number;
  taskId: string;
  title: string;
  runId: string | null;
  outcome: BatchMemberOutcome | null;
  error: string | null;
  finalStatus: BatchMemberStatus | null;
  updatedAt: number;
}

const BATCH_MODES: readonly BatchModeRecord[] = ['parallel', 'queue', 'combined'];
const BATCH_STATUSES: readonly BatchStatusRecord[] = ['running', 'completed', 'failed', 'cancelled'];
const MEMBER_OUTCOMES: readonly BatchMemberOutcome[] = ['skipped', 'cancelled', 'failed'];
const MEMBER_STATUSES: readonly BatchMemberStatus[] = ['queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'];

function oneOf<T extends string>(values: readonly T[], value: string | null, label: string): T {
  const found = values.find((candidate) => candidate === value);
  if (!found) throw new JournalCorruptError(`unknown ${label} ${value ?? 'null'}`);
  return found;
}

function toBatch(row: Row): BatchRecord {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(str(row, 'settings_json'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    throw new JournalCorruptError('batch settings_json is not JSON');
  }
  return {
    batchId: str(row, 'batch_id'),
    userId: str(row, 'user_id'),
    mode: oneOf(BATCH_MODES, str(row, 'mode'), 'batch mode'),
    status: oneOf(BATCH_STATUSES, str(row, 'status'), 'batch status'),
    settings,
    cancelRequestedAt: optNum(row, 'cancel_requested_at'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    finishedAt: optNum(row, 'finished_at'),
  };
}

function toMember(row: Row): BatchMemberRecord {
  const outcome = optStr(row, 'outcome');
  const finalStatus = optStr(row, 'final_status');
  return {
    batchId: str(row, 'batch_id'),
    position: num(row, 'position'),
    taskId: str(row, 'task_id'),
    title: str(row, 'title'),
    runId: optStr(row, 'run_id'),
    outcome: outcome === null ? null : oneOf(MEMBER_OUTCOMES, outcome, 'batch member outcome'),
    error: optStr(row, 'error'),
    finalStatus: finalStatus === null ? null : oneOf(MEMBER_STATUSES, finalStatus, 'batch member status'),
    updatedAt: num(row, 'updated_at'),
  };
}

export class DurableRunJournal {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const fresh = path === ':memory:' || !existsSync(path);
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      if (fresh) chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      ${runAttemptsDdl('run_attempts')}
      ${runEventsDdl('run_attempt_events')}
      ${runEffectsDdl('run_effects')}
      ${RETENTION_DDL}
      ${BATCH_DDL}
    `);
    this.upgradeStaleTables();
    this.db.exec(INDEX_DDL);
    this.db.prepare('INSERT INTO journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(DURABLE_JOURNAL_SCHEMA_VERSION));
  }

  /**
   * SQLite cannot alter a CHECK constraint. A table whose stored definition
   * lacks a value the current contract allows (a new run state, effect kind
   * or event kind) or a column (verification_json) is rebuilt: create the
   * current shape, copy every shared column, drop the old table, rename —
   * one IMMEDIATE transaction, so a crash leaves either the old or the new
   * table, never both or neither. Indexes and the immutability trigger are
   * (re)created by INDEX_DDL afterwards.
   */
  private upgradeStaleTables(): void {
    const plans: Array<{ table: string; ddl: (name: string) => string; tokens: string[] }> = [
      { table: 'run_attempts', ddl: runAttemptsDdl, tokens: [...RUN_STATES.map((state) => `'${state}'`), 'verification_json'] },
      { table: 'run_attempt_events', ddl: runEventsDdl, tokens: RUN_EVENT_KINDS.map((kind) => `'${kind}'`) },
      { table: 'run_effects', ddl: runEffectsDdl, tokens: RUN_EFFECT_KINDS.map((kind) => `'${kind}'`) },
    ];
    for (const plan of plans) {
      const row = asRow(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(plan.table));
      const sql = row ? optStr(row, 'sql') ?? '' : '';
      if (plan.tokens.every((token) => sql.includes(token))) continue;
      const temporary = `${plan.table}__upgrade`;
      this.tx(() => {
        this.db.exec(`DROP TABLE IF EXISTS ${temporary}`);
        this.db.exec(plan.ddl(temporary));
        const columnsOf = (table: string) => rows(this.db.prepare(`PRAGMA table_info(${table})`).all()).map((info) => str(info, 'name'));
        const target = new Set(columnsOf(temporary));
        const list = columnsOf(plan.table).filter((column) => target.has(column)).join(', ');
        this.db.exec(`INSERT INTO ${temporary} (${list}) SELECT ${list} FROM ${plan.table}`);
        this.db.exec(`DROP TABLE ${plan.table}`);
        this.db.exec(`ALTER TABLE ${temporary} RENAME TO ${plan.table}`);
      });
    }
  }

  /** `<app data>/journal/runs-v2.sqlite` (the legacy prototype journal keeps `runs.sqlite`). */
  static defaultPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(defaultAppDataRoot(env), 'journal', 'runs-v2.sqlite');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private row(runId: string): Row | undefined {
    return asRow(this.db.prepare('SELECT * FROM run_attempts WHERE run_id = ?').get(runId));
  }

  private toRecord(row: Row): RunRecord {
    const state = str(row, 'state');
    if (!isRunState(state)) throw new JournalCorruptError(`unknown run state ${state}`);
    const snapshot = parseJson(runSnapshotSchema, str(row, 'snapshot_json'), 'snapshot_json');
    const counters = parseJson(runCountersSchema, str(row, 'counters_json'), 'counters_json');
    if (!snapshot || !counters) throw new JournalCorruptError('journal run row is incomplete');
    return {
      runId: str(row, 'run_id'),
      taskId: str(row, 'task_id'),
      userId: str(row, 'user_id'),
      attemptId: optStr(row, 'attempt_id'),
      capability: optStr(row, 'capability'),
      capabilityExpiresAt: optNum(row, 'capability_expires_at'),
      runner: str(row, 'runner'),
      model: optStr(row, 'model'),
      state,
      stateVersion: num(row, 'state_version'),
      snapshot,
      workspace: parseJson(runWorkspaceSchema, optStr(row, 'workspace_json'), 'workspace_json'),
      runtime: parseJson(runtimeEndpointSchema, optStr(row, 'runtime_json'), 'runtime_json'),
      sessionId: optStr(row, 'session_id'),
      cancelRequestedAt: optNum(row, 'cancel_requested_at'),
      cancelReason: optStr(row, 'cancel_reason'),
      terminal: parseJson(runTerminalSchema, optStr(row, 'terminal_json'), 'terminal_json'),
      lastSeq: num(row, 'last_seq'),
      relayAckSeq: num(row, 'relay_ack_seq'),
      usage: parseJson(runUsageSchema, optStr(row, 'usage_json'), 'usage_json'),
      counters,
      verification: parseJson(runVerificationSchema, optStr(row, 'verification_json'), 'verification_json'),
      bootId: str(row, 'boot_id'),
      createdAt: num(row, 'created_at'),
      updatedAt: num(row, 'updated_at'),
      finishedAt: optNum(row, 'finished_at'),
    };
  }

  private requireRecord(runId: string): RunRecord {
    const row = this.row(runId);
    if (!row) throw new JournalCorruptError(`run ${runId} is not in the journal`);
    return this.toRecord(row);
  }

  get(runId: string): RunRecord | null {
    const row = this.row(runId);
    return row ? this.toRecord(row) : null;
  }

  /** Durable acceptance: the run row and its `run.accepted` event, atomically. */
  createRun(run: NewRun, accepted: Record<string, unknown>): RunRecord {
    const now = Date.now();
    return this.tx(() => {
      this.db.prepare(`
        INSERT INTO run_attempts (
          run_id, task_id, user_id, attempt_id, capability, capability_expires_at, runner, model,
          state, state_version, snapshot_json, counters_json, boot_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        run.runId, run.taskId, run.userId, run.attemptId, run.capability, run.capabilityExpiresAt,
        run.runner, run.model, run.state, json(run.snapshot), json(emptyCounters()), run.bootId, now, now,
      );
      this.appendInTx(run.runId, { kind: 'run.accepted', payload: { ...accepted, state: run.state }, critical: true }, now);
      return this.requireRecord(run.runId);
    });
  }

  private patchAssignments(patch: RunPatch): { sql: string[]; values: SqlValue[] } {
    const sql: string[] = [];
    const values: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      sql.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.attemptId !== undefined) set('attempt_id', patch.attemptId);
    if (patch.capability !== undefined) set('capability', patch.capability);
    if (patch.capabilityExpiresAt !== undefined) set('capability_expires_at', patch.capabilityExpiresAt);
    if (patch.model !== undefined) set('model', patch.model);
    if (patch.workspace !== undefined) set('workspace_json', patch.workspace === null ? null : json(runWorkspaceSchema.parse(patch.workspace)));
    if (patch.runtime !== undefined) set('runtime_json', patch.runtime === null ? null : json(runtimeEndpointSchema.parse(patch.runtime)));
    if (patch.sessionId !== undefined) set('session_id', patch.sessionId);
    if (patch.cancelRequestedAt !== undefined) set('cancel_requested_at', patch.cancelRequestedAt);
    if (patch.cancelReason !== undefined) set('cancel_reason', patch.cancelReason);
    if (patch.usage !== undefined) set('usage_json', patch.usage === null ? null : json(runUsageSchema.parse(patch.usage)));
    if (patch.counters !== undefined) set('counters_json', json(runCountersSchema.parse(patch.counters)));
    if (patch.verification !== undefined) {
      set('verification_json', patch.verification === null ? null : json(runVerificationSchema.parse(patch.verification)));
    }
    if (patch.bootId !== undefined) set('boot_id', patch.bootId);
    return { sql, values };
  }

  /** Update non-state fields (capability rotation, runtime endpoint, counters, …). */
  update(runId: string, patch: RunPatch): RunRecord {
    return this.tx(() => {
      const { sql, values } = this.patchAssignments(patch);
      if (sql.length > 0) {
        this.db.prepare(`UPDATE run_attempts SET ${sql.join(', ')}, updated_at = ? WHERE run_id = ?`)
          .run(...values, Date.now(), runId);
      }
      return this.requireRecord(runId);
    });
  }

  /**
   * Compare-and-set state transition. Validates the state machine, appends the
   * `run.state` event (relayed), applies the patch, records effect intents and
   * the terminal decision — all or nothing.
   */
  transition(runId: string, input: TransitionInput): TransitionResult {
    const now = Date.now();
    return this.tx(() => {
      const current = this.requireRecord(runId);
      const allowedFrom: readonly RunState[] = typeof input.from === 'string' ? [input.from] : input.from;
      if (!allowedFrom.includes(current.state)) {
        throw new RunTransitionError(current.state, input.to, `Run ${runId} is ${current.state}, not ${allowedFrom.join('/')}`);
      }
      if (!canTransition(current.state, input.to)) throw new RunTransitionError(current.state, input.to);
      if (isTerminalRunState(input.to) !== Boolean(input.terminal)) {
        throw new Error('A terminal transition must carry exactly one terminal decision');
      }
      const { sql, values } = this.patchAssignments(input.patch ?? {});
      sql.push('state = ?', 'state_version = state_version + 1', 'updated_at = ?');
      values.push(input.to, now);
      if (input.terminal) {
        sql.push('terminal_json = ?', 'finished_at = ?');
        values.push(json(runTerminalSchema.parse(input.terminal)), now);
      }
      const updated = this.db.prepare(`UPDATE run_attempts SET ${sql.join(', ')} WHERE run_id = ? AND state = ? AND state_version = ?`)
        .run(...values, runId, current.state, current.stateVersion);
      if (changesOf(updated) !== 1) throw new RunTransitionError(current.state, input.to, 'Concurrent transition lost the compare-and-set');
      const seq = this.appendInTx(runId, {
        kind: 'run.state',
        payload: { from: current.state, to: input.to, reason: input.reason, ...(input.payload ?? {}) },
        relay: true,
        critical: true,
      }, now);
      for (const event of input.events ?? []) this.appendInTx(runId, event, now);
      for (const effect of input.effects ?? []) this.recordEffectInTx(runId, effect, now);
      return { record: this.requireRecord(runId), seq: seq ?? 0, from: current.state };
    });
  }

  private appendInTx(runId: string, input: AppendInput, now: number): number | null {
    const row = asRow(this.db.prepare('SELECT last_seq, counters_json FROM run_attempts WHERE run_id = ?').get(runId));
    if (!row) throw new JournalCorruptError(`run ${runId} is not in the journal`);
    const lastSeq = num(row, 'last_seq');
    if (lastSeq >= MAX_EVENTS_PER_RUN && !input.critical) {
      const counters = parseJson(runCountersSchema, str(row, 'counters_json'), 'counters_json') ?? emptyCounters();
      counters.droppedEvents += 1;
      this.db.prepare('UPDATE run_attempts SET counters_json = ? WHERE run_id = ?').run(json(counters), runId);
      return null;
    }
    const seq = lastSeq + 1;
    this.db.prepare('INSERT INTO run_attempt_events (run_id, seq, at, kind, relay, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, seq, now, input.kind, input.relay ? 1 : 0, boundedPayload(input.payload));
    this.db.prepare('UPDATE run_attempts SET last_seq = ? WHERE run_id = ?').run(seq, runId);
    return seq;
  }

  /** Append one event; returns its sequence, or null when dropped past the per-run bound. */
  append(runId: string, input: AppendInput): number | null {
    return this.tx(() => this.appendInTx(runId, input, Date.now()));
  }

  private recordEffectInTx(runId: string, effect: EffectIntent, now: number): RunEffectRecord {
    const existing = this.effect(runId, effect.key);
    if (existing) {
      if (existing.kind !== effect.kind) throw new Error(`Effect key ${effect.key} already names a ${existing.kind}`);
      return existing;
    }
    this.db.prepare(`
      INSERT INTO run_effects (run_id, key, kind, status, intent_json, receipt_json, dispatches, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, NULL, 0, ?, ?)
    `).run(runId, effect.key, effect.kind, json(effect.intent), now, now);
    this.appendInTx(runId, { kind: 'effect', payload: { key: effect.key, kind: effect.kind, status: 'pending' }, critical: true }, now);
    const created = this.effect(runId, effect.key);
    if (!created) throw new JournalCorruptError('effect insert was not visible');
    return created;
  }

  /** Journal an effect intent before dispatch. Idempotent per key. */
  recordEffect(runId: string, effect: EffectIntent): RunEffectRecord {
    return this.tx(() => this.recordEffectInTx(runId, effect, Date.now()));
  }

  /** Count a dispatch attempt (bookkeeping only; the effect stays pending). */
  markDispatched(runId: string, key: string): void {
    this.db.prepare('UPDATE run_effects SET dispatches = dispatches + 1, updated_at = ? WHERE run_id = ? AND key = ?')
      .run(Date.now(), runId, key);
  }

  /** Record a receipt. Only a pending effect settles; a settled one is returned unchanged. */
  settleEffect(runId: string, key: string, status: Exclude<RunEffectStatus, 'pending'>, receipt: Record<string, unknown>): RunEffectRecord {
    const now = Date.now();
    return this.tx(() => {
      const existing = this.effect(runId, key);
      if (!existing) throw new JournalCorruptError(`effect ${key} was never journaled`);
      if (existing.status !== 'pending') return existing;
      this.db.prepare('UPDATE run_effects SET status = ?, receipt_json = ?, updated_at = ? WHERE run_id = ? AND key = ?')
        .run(status, json(receipt), now, runId, key);
      this.appendInTx(runId, { kind: 'effect', payload: { key, kind: existing.kind, status }, critical: true }, now);
      const settled = this.effect(runId, key);
      if (!settled) throw new JournalCorruptError('effect update was not visible');
      return settled;
    });
  }

  private toEffect(row: Row): RunEffectRecord {
    const kind = str(row, 'kind');
    const status = str(row, 'status');
    if (!isRunEffectKind(kind)) throw new JournalCorruptError(`unknown effect kind ${kind}`);
    if (status !== 'pending' && status !== 'confirmed' && status !== 'failed') throw new JournalCorruptError(`unknown effect status ${status}`);
    return {
      runId: str(row, 'run_id'),
      key: str(row, 'key'),
      kind,
      status,
      intent: parseJson(recordSchema, str(row, 'intent_json'), 'intent_json') ?? {},
      receipt: parseJson(recordSchema, optStr(row, 'receipt_json'), 'receipt_json'),
      dispatches: num(row, 'dispatches'),
      createdAt: num(row, 'created_at'),
      updatedAt: num(row, 'updated_at'),
    };
  }

  effect(runId: string, key: string): RunEffectRecord | null {
    const row = asRow(this.db.prepare('SELECT * FROM run_effects WHERE run_id = ? AND key = ?').get(runId, key));
    return row ? this.toEffect(row) : null;
  }

  effects(runId: string): RunEffectRecord[] {
    return rows(this.db.prepare('SELECT * FROM run_effects WHERE run_id = ? ORDER BY created_at, rowid').all(runId))
      .map((row) => this.toEffect(row));
  }

  /** The latest effect of a kind (several keys can share a kind, e.g. one push per commit). */
  latestEffect(runId: string, kind: RunEffectKind): RunEffectRecord | null {
    const row = asRow(this.db.prepare('SELECT * FROM run_effects WHERE run_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(runId, kind));
    return row ? this.toEffect(row) : null;
  }

  private toEvent(row: Row): RunEventEnvelope {
    const kind = str(row, 'kind');
    if (!(RUN_EVENT_KINDS as readonly string[]).includes(kind)) throw new JournalCorruptError(`unknown event kind ${kind}`);
    const payload = parseJson(recordSchema, str(row, 'payload_json'), 'payload_json') ?? {};
    return {
      runId: str(row, 'run_id'),
      seq: num(row, 'seq'),
      at: num(row, 'at'),
      kind: RUN_EVENT_KINDS.find((candidate) => candidate === kind) ?? 'log',
      relay: num(row, 'relay') === 1,
      payload,
    };
  }

  events(runId: string, afterSeq = 0, limit = 1_000): RunEventEnvelope[] {
    const found = this.db.prepare('SELECT * FROM run_attempt_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, limit);
    return rows(found).map((row) => this.toEvent(row));
  }

  /**
   * W15: the events phase timing needs (state changes and setup step
   * records), in journal order. Not capped: a run has one state row per
   * transition (an approval wait adds two), and dropping the newest would
   * lose the run's last phases.
   */
  timingEvents(runId: string): RunEventEnvelope[] {
    const found = this.db.prepare(`SELECT * FROM run_attempt_events WHERE run_id = ? AND (kind = 'run.state' OR (kind = 'progress' AND payload_json LIKE '%"setupRecord"%')) ORDER BY seq`)
      .all(runId);
    return rows(found).map((row) => this.toEvent(row));
  }

  /** Relayable events after the acknowledged cursor, in sequence order. */
  unrelayed(runId: string, limit = 50): RunEventEnvelope[] {
    const record = this.requireRecord(runId);
    const found = this.db.prepare('SELECT * FROM run_attempt_events WHERE run_id = ? AND seq > ? AND relay = 1 ORDER BY seq LIMIT ?')
      .all(runId, record.relayAckSeq, limit);
    return rows(found).map((row) => this.toEvent(row));
  }

  /** Persist the control plane's acknowledged cursor (monotonic). */
  ackRelay(runId: string, seq: number): number {
    this.db.prepare('UPDATE run_attempts SET relay_ack_seq = MAX(relay_ack_seq, ?), updated_at = ? WHERE run_id = ?')
      .run(Math.max(0, Math.floor(seq)), Date.now(), runId);
    return this.requireRecord(runId).relayAckSeq;
  }

  /** Runs that need work after a restart: not terminal, or terminal with pending effects. */
  listRecoverable(): RunRecord[] {
    const terminal = ['succeeded', 'failed', 'cancelled', 'recovery_required', 'abandoned'].map((state) => `'${state}'`).join(', ');
    const found = this.db.prepare(`
      SELECT * FROM run_attempts
      WHERE state NOT IN (${terminal})
         OR EXISTS (SELECT 1 FROM run_effects e WHERE e.run_id = run_attempts.run_id AND e.status = 'pending')
         OR (state IN (${terminal}) AND relay_ack_seq < (
              SELECT COALESCE(MAX(seq), 0) FROM run_attempt_events v WHERE v.run_id = run_attempts.run_id AND v.relay = 1))
      ORDER BY created_at
    `).all();
    return rows(found).map((row) => this.toRecord(row));
  }

  /** The newest run of a task (any state). */
  latestForTask(taskId: string): RunRecord | null {
    const row = asRow(this.db.prepare('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId));
    return row ? this.toRecord(row) : null;
  }

  /**
   * Single-owner guard: one sidecar process drives the runs of a journal
   * file. A recorded owner whose process is still alive keeps it; a dead
   * owner (crash, SIGKILL) is replaced.
   */
  claimOwnership(owner: { pid: number; bootId: string }, isAlive: (pid: number) => boolean): { ok: true } | { ok: false; pid: number } {
    return this.tx(() => {
      const row = asRow(this.db.prepare('SELECT value FROM journal_meta WHERE key = ?').get('owner'));
      if (row) {
        const parsed = parseJson(z.object({ pid: z.number(), bootId: z.string() }), str(row, 'value'), 'owner');
        if (parsed && parsed.pid !== owner.pid && isAlive(parsed.pid)) return { ok: false as const, pid: parsed.pid };
      }
      this.db.prepare('INSERT INTO journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('owner', json(owner));
      return { ok: true as const };
    });
  }

  /** Retention: drop finished runs (and their events/effects) with nothing left to deliver. */
  pruneFinished(olderThanMs: number, now = Date.now()): number {
    const cutoff = now - olderThanMs;
    return this.tx(() => {
      const ids = rows(this.db.prepare(`
        SELECT run_id FROM run_attempts a
        WHERE finished_at IS NOT NULL AND finished_at < ?
          AND NOT EXISTS (SELECT 1 FROM run_effects e WHERE e.run_id = a.run_id AND e.status = 'pending')
      `).all(cutoff)).map((row) => str(row, 'run_id'));
      for (const id of ids) {
        this.db.prepare('DELETE FROM run_attempt_events WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM run_effects WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM run_attempts WHERE run_id = ?').run(id);
      }
      return ids.length;
    });
  }

  // -------------------------------------------------------------------------
  // W11a worktree retention
  // -------------------------------------------------------------------------

  /** Every run that recorded a workspace, oldest first (retention input). */
  listWorkspaceRuns(): RunRecord[] {
    return rows(this.db.prepare('SELECT * FROM run_attempts WHERE workspace_json IS NOT NULL ORDER BY created_at, rowid').all())
      .map((row) => this.toRecord(row));
  }

  /** The newest runs of a task, newest first. */
  runsForTask(taskId: string, limit = 10): RunRecord[] {
    return rows(this.db.prepare('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(taskId, limit))
      .map((row) => this.toRecord(row));
  }

  /**
   * Record the receipt BEFORE deleting (status `pending`). Idempotent per
   * path: a removed receipt is returned unchanged; a pending/failed one is
   * re-armed with the new reason.
   */
  recordWorkspaceCleanup(
    input: { worktreePath: string; runId: string | null; taskId: string | null; branch: string | null; reason: WorkspaceCleanupReason; bytes: number | null; detail?: string | null },
    now = Date.now(),
  ): WorkspaceCleanupRecord {
    return this.tx(() => {
      const existing = asRow(this.db.prepare('SELECT * FROM workspace_cleanups WHERE worktree_path = ?').get(input.worktreePath));
      if (existing && str(existing, 'status') === 'removed') return toCleanup(existing);
      this.db.prepare(`
        INSERT INTO workspace_cleanups (worktree_path, run_id, task_id, branch, reason, status, bytes, detail, recorded_at, removed_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
        ON CONFLICT(worktree_path) DO UPDATE SET reason = excluded.reason, status = 'pending', bytes = excluded.bytes,
          detail = excluded.detail, recorded_at = excluded.recorded_at
      `).run(input.worktreePath, input.runId, input.taskId, input.branch, input.reason, input.bytes, input.detail ?? null, now);
      const row = asRow(this.db.prepare('SELECT * FROM workspace_cleanups WHERE worktree_path = ?').get(input.worktreePath));
      if (!row) throw new JournalCorruptError('cleanup receipt insert was not visible');
      return toCleanup(row);
    });
  }

  settleWorkspaceCleanup(worktreePath: string, status: 'removed' | 'failed', detail: string | null = null, now = Date.now()): WorkspaceCleanupRecord | null {
    return this.tx(() => {
      this.db.prepare(`UPDATE workspace_cleanups SET status = ?, detail = COALESCE(?, detail), removed_at = ? WHERE worktree_path = ? AND status != 'removed'`)
        .run(status, detail, status === 'removed' ? now : null, worktreePath);
      const row = asRow(this.db.prepare('SELECT * FROM workspace_cleanups WHERE worktree_path = ?').get(worktreePath));
      return row ? toCleanup(row) : null;
    });
  }

  workspaceCleanups(status?: WorkspaceCleanupRecord['status']): WorkspaceCleanupRecord[] {
    const found = status
      ? this.db.prepare('SELECT * FROM workspace_cleanups WHERE status = ? ORDER BY recorded_at').all(status)
      : this.db.prepare('SELECT * FROM workspace_cleanups ORDER BY recorded_at').all();
    return rows(found).map(toCleanup);
  }

  workspaceCleanup(worktreePath: string): WorkspaceCleanupRecord | null {
    const row = asRow(this.db.prepare('SELECT * FROM workspace_cleanups WHERE worktree_path = ?').get(worktreePath));
    return row ? toCleanup(row) : null;
  }

  /** The most recent completed cleanup of one of the task's workspaces. */
  latestCleanupForTask(taskId: string): WorkspaceCleanupRecord | null {
    const row = asRow(this.db.prepare(`SELECT * FROM workspace_cleanups WHERE task_id = ? AND status = 'removed' ORDER BY removed_at DESC LIMIT 1`).get(taskId));
    return row ? toCleanup(row) : null;
  }

  /** A closure signal for a task (archived/deleted, as the control plane reported it). */
  noteTaskClosed(taskId: string, reason: string, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO task_hints (task_id, closed_at, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
    `).run(taskId, now, reason.slice(0, 200), now);
  }

  closedTasks(): Map<string, { closedAt: number; reason: string }> {
    const found = rows(this.db.prepare('SELECT task_id, closed_at, reason FROM task_hints').all());
    return new Map(found.map((row) => [str(row, 'task_id'), { closedAt: num(row, 'closed_at'), reason: str(row, 'reason') }]));
  }

  /** Bound the retention tables: settled receipts and hints older than `olderThanMs`. */
  pruneRetention(olderThanMs: number, now = Date.now()): number {
    const cutoff = now - olderThanMs;
    return this.tx(() => {
      const receipts = changesOf(this.db.prepare(`DELETE FROM workspace_cleanups WHERE status = 'removed' AND removed_at < ?`).run(cutoff));
      const hints = changesOf(this.db.prepare('DELETE FROM task_hints WHERE updated_at < ?').run(cutoff));
      return receipts + hints;
    });
  }

  // -------------------------------------------------------------------------
  // W13a batches
  // -------------------------------------------------------------------------

  createBatch(input: { batchId: string; userId: string; mode: BatchModeRecord; settings: Record<string, unknown>; taskIds: string[] }, now = Date.now()): BatchRecord {
    return this.tx(() => {
      this.db.prepare(`
        INSERT INTO run_batches (batch_id, user_id, mode, status, settings_json, cancel_requested_at, created_at, updated_at, finished_at)
        VALUES (?, ?, ?, 'running', ?, NULL, ?, ?, NULL)
      `).run(input.batchId, input.userId, input.mode, JSON.stringify(input.settings), now, now);
      input.taskIds.forEach((taskId, position) => {
        this.db.prepare('INSERT INTO run_batch_members (batch_id, position, task_id, title, updated_at) VALUES (?, ?, ?, \'\', ?)')
          .run(input.batchId, position, taskId, now);
      });
      const row = asRow(this.db.prepare('SELECT * FROM run_batches WHERE batch_id = ?').get(input.batchId));
      if (!row) throw new JournalCorruptError('batch insert was not visible');
      return toBatch(row);
    });
  }

  getBatch(batchId: string): { batch: BatchRecord; members: BatchMemberRecord[] } | null {
    const row = asRow(this.db.prepare('SELECT * FROM run_batches WHERE batch_id = ?').get(batchId));
    if (!row) return null;
    const members = rows(this.db.prepare('SELECT * FROM run_batch_members WHERE batch_id = ? ORDER BY position').all(batchId)).map(toMember);
    return { batch: toBatch(row), members };
  }

  listBatches(filter: { status?: BatchStatusRecord; userId?: string } = {}): BatchRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    if (filter.userId) {
      clauses.push('user_id = ?');
      values.push(filter.userId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return rows(this.db.prepare(`SELECT * FROM run_batches ${where} ORDER BY created_at, rowid`).all(...values)).map(toBatch);
  }

  /** The batch member a run belongs to, if any. */
  batchMemberForRun(runId: string): BatchMemberRecord | null {
    const row = asRow(this.db.prepare('SELECT * FROM run_batch_members WHERE run_id = ?').get(runId));
    return row ? toMember(row) : null;
  }

  updateBatchMember(batchId: string, position: number, patch: { runId?: string | null; title?: string; outcome?: BatchMemberOutcome | null; error?: string | null }, now = Date.now()): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.runId !== undefined) {
      sets.push('run_id = ?');
      values.push(patch.runId);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title.slice(0, 500));
    }
    if (patch.outcome !== undefined) {
      sets.push('outcome = ?');
      values.push(patch.outcome);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      values.push(patch.error === null ? null : patch.error.slice(0, 1_000));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE run_batch_members SET ${sets.join(', ')}, updated_at = ? WHERE batch_id = ? AND position = ?`)
      .run(...values, now, batchId, position);
  }

  requestBatchCancel(batchId: string, now = Date.now()): void {
    this.db.prepare('UPDATE run_batches SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE batch_id = ?').run(now, now, batchId);
  }

  /** Finish a running batch once: freezes every member's status. False when it was already finished. */
  finishBatch(batchId: string, status: Exclude<BatchStatusRecord, 'running'>, finalStatuses: Array<{ position: number; status: BatchMemberStatus }>, now = Date.now()): boolean {
    return this.tx(() => {
      const updated = changesOf(this.db.prepare(`UPDATE run_batches SET status = ?, finished_at = ?, updated_at = ? WHERE batch_id = ? AND status = 'running'`)
        .run(status, now, now, batchId));
      if (updated !== 1) return false;
      for (const member of finalStatuses) {
        this.db.prepare('UPDATE run_batch_members SET final_status = ?, updated_at = ? WHERE batch_id = ? AND position = ?')
          .run(member.status, now, batchId, member.position);
      }
      return true;
    });
  }
}
