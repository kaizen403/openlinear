import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * FE-03: user-managed trust grants ("allow runs without the sandbox for this
 * project"), persisted on this device.
 *
 * A grant never weakens the default. It applies only while no verified
 * sandbox is available (see `resolveSandboxMode` in ./mode), only to runs of
 * its project started by the user who created it, and only for checkouts
 * under the paths it records (the engine's agent worktree and verification
 * checkout roots). Every grant expires (at most 7 days); a revoked or
 * expired grant never applies again.
 *
 * Storage, in the sidecar's app-data directory (denied inside the sandbox):
 *
 *   <app data>/trust-grants/grants.json   current grants (atomic rewrite, 0600)
 *   <app data>/trust-grants/audit.jsonl   append-only audit (created, revoked,
 *                                         used, expired), one JSON per line
 *
 * A grants file that is not a regular file owned by this user with mode 0600
 * (or that does not parse) is ignored — no grant applies — and set aside on
 * the next write. Nothing here is a secret; the file permissions protect the
 * grants' integrity.
 */

export const TRUST_GRANT_MAX_HOURS = 168;
export const TRUST_GRANT_REASON_MIN = 10;
export const TRUST_GRANT_REASON_MAX = 500;
export const TRUST_GRANT_MAX_ACTIVE_PER_USER = 20;
export const TRUST_GRANT_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const TRUST_GRANT_ID = /^tg_[0-9a-f]{16}$/;
/** Ended (revoked/expired) grants are kept this long; the audit log keeps the history. */
const ENDED_RETENTION_MS = 30 * 86_400_000;
const AUDIT_ROTATE_BYTES = 1024 * 1024;
const HOUR_MS = 3_600_000;
/**
 * One run resolves its checkout's mode several times (an OpenCode run builds
 * its directory client 2–3 times; verification decides per check). Those are
 * one use: the first is audited, repeats for the same grant, run and kind
 * within this window are not.
 */
const USE_DEDUPE_MS = 10 * 60_000;

const grantSchema = z.object({
  id: z.string().regex(TRUST_GRANT_ID),
  projectId: z.string().regex(TRUST_GRANT_PROJECT_ID),
  projectName: z.string().nullable(),
  paths: z.array(z.string().min(1).refine((path) => isAbsolute(path), 'must be absolute')).min(1),
  reason: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  revokedBy: z.string().nullable(),
  expiryRecordedAt: z.string().datetime({ offset: true }).nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  useCount: z.number().int().nonnegative(),
}).strict();

const stateSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema) }).strict();

export type TrustGrant = z.infer<typeof grantSchema>;

export const TRUST_GRANT_AUDIT_EVENTS = ['created', 'revoked', 'used', 'expired'] as const;
export type TrustGrantAuditEvent = (typeof TRUST_GRANT_AUDIT_EVENTS)[number];

const auditSchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime({ offset: true }),
  event: z.enum(TRUST_GRANT_AUDIT_EVENTS),
  grantId: z.string().regex(TRUST_GRANT_ID),
  projectId: z.string(),
  projectName: z.string().nullable(),
  /** The grant's creator: whose audit trail this entry belongs to. */
  owner: z.string().min(1),
  /** Who caused it: the creator/revoker, the run's user, or null (expiry). */
  actor: z.string().nullable(),
  runId: z.string().nullable(),
  /** `agent` worktree or `verification` checkout, for `used`. */
  kind: z.enum(['agent', 'verification']).nullable(),
  path: z.string().nullable(),
});

export type TrustGrantAuditEntry = z.infer<typeof auditSchema>;

/** Which run a checkout belongs to (resolved from the run journal). */
export interface RunScope {
  runId: string;
  userId: string;
  projectId: string | null;
  kind: 'agent' | 'verification';
}

export type RunScopeResolver = (directory: string) => RunScope | null;

export interface CreateTrustGrantInput {
  userId: string;
  projectId: string;
  projectName?: string | null;
  reason: string;
  hours: number;
  paths: readonly string[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Clock skew tolerated for a grant created "in the future". */
const CREATED_SKEW_MS = 5 * 60_000;

/**
 * The creation rules, checked again on every read: the file is owner-only,
 * but an agent running without isolation under a grant runs as the same
 * user and could rewrite it — a stretched expiry or a forged grant must not
 * lie dormant until the sandbox is next unavailable.
 */
function plausible(grant: TrustGrant, now: number): boolean {
  const created = Date.parse(grant.createdAt);
  const expires = Date.parse(grant.expiresAt);
  return created <= now + CREATED_SKEW_MS
    && expires > created
    && expires - created <= TRUST_GRANT_MAX_HOURS * HOUR_MS
    && grant.reason.trim().length >= TRUST_GRANT_REASON_MIN;
}

function isActive(grant: TrustGrant, now: number): boolean {
  return grant.revokedAt === null && Date.parse(grant.expiresAt) > now && plausible(grant, now);
}

function cleanText(value: string, max: number): string {
  // Control characters have no place in a reason or a project name shown in the UI and the audit.
  let out = '';
  for (const char of value.trim()) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out.slice(0, max);
}

function secureFile(stats: Stats, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return true;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return (stats.mode & 0o077) === 0 && (uid === null || stats.uid === uid);
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

export class TrustGrantStore {
  readonly grantsFile: string;
  readonly auditFile: string;
  private readonly platform: NodeJS.Platform;
  /** Why the grants file was ignored on the last read (null when it was fine or absent). */
  problem: string | null = null;
  private readonly recentUses = new Map<string, number>();
  private readonly endedListeners = new Set<(grant: TrustGrant, runIds: string[]) => void>();

  constructor(readonly dir: string, options: { platform?: NodeJS.Platform } = {}) {
    this.grantsFile = join(dir, 'grants.json');
    this.auditFile = join(dir, 'audit.jsonl');
    this.platform = options.platform ?? process.platform;
  }

  /** Every grant still on file (ended ones for 30 days), after recording any newly expired. */
  list(now: number): TrustGrant[] {
    const grants = this.read();
    const expired: TrustGrant[] = [];
    for (const grant of grants) {
      if (grant.revokedAt === null && grant.expiryRecordedAt === null && Date.parse(grant.expiresAt) <= now) {
        grant.expiryRecordedAt = iso(now);
        expired.push(grant);
        this.appendAudit({ event: 'expired', grant, actor: null, runId: null, kind: null, path: null }, now);
      }
    }
    if (expired.length > 0) {
      this.write(grants, now);
      for (const grant of expired) this.ended(grant);
    }
    return grants;
  }

  /**
   * Called after a grant is revoked or its expiry is recorded, with the runs
   * that used it: a run started under a grant keeps running without OS
   * isolation, so the grant's end must stop it (the run service cancels them).
   */
  onGrantEnded(listener: (grant: TrustGrant, runIds: string[]) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  /** Runs that used the grant, from the audit trail (both files). */
  runsUsing(grantId: string): string[] {
    const runIds = new Set<string>();
    for (const file of [this.auditFile, `${this.auditFile}.1`]) {
      for (const entry of this.readAudit(file)) {
        if (entry.event === 'used' && entry.grantId === grantId && entry.runId) runIds.add(entry.runId);
      }
    }
    return [...runIds];
  }

  private ended(grant: TrustGrant): void {
    if (this.endedListeners.size === 0) return;
    const runIds = this.runsUsing(grant.id);
    for (const listener of this.endedListeners) {
      try {
        listener(grant, runIds);
      } catch (error) {
        logger.error({ err: error, grantId: grant.id }, '[Sandbox] stopping the runs of an ended trust grant failed');
      }
    }
  }

  /** Grants that apply right now (not revoked, not expired), any user; at most the newest TRUST_GRANT_MAX_ACTIVE_PER_USER each. */
  active(now: number): TrustGrant[] {
    const perUser = new Map<string, number>();
    return this.list(now)
      .filter((grant) => isActive(grant, now))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .filter((grant) => {
        const count = (perUser.get(grant.createdBy) ?? 0) + 1;
        perUser.set(grant.createdBy, count);
        return count <= TRUST_GRANT_MAX_ACTIVE_PER_USER;
      });
  }

  activeFor(userId: string, now: number): TrustGrant[] {
    return this.active(now).filter((grant) => grant.createdBy === userId);
  }

  create(input: CreateTrustGrantInput, now: number): TrustGrant {
    const reason = cleanText(input.reason, TRUST_GRANT_REASON_MAX);
    if (reason.length < TRUST_GRANT_REASON_MIN) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Give a reason of at least ${TRUST_GRANT_REASON_MIN} characters`, { fieldErrors: { reason: [`At least ${TRUST_GRANT_REASON_MIN} characters`] } });
    }
    if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > TRUST_GRANT_MAX_HOURS) {
      throw new HttpError(400, 'VALIDATION_ERROR', `A trust grant lasts 1 to ${TRUST_GRANT_MAX_HOURS} hours`, { fieldErrors: { hours: [`1 to ${TRUST_GRANT_MAX_HOURS} hours`] } });
    }
    if (!TRUST_GRANT_PROJECT_ID.test(input.projectId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid project id', { fieldErrors: { projectId: ['Invalid project id'] } });
    }
    if (input.paths.length === 0 || input.paths.some((path) => !isAbsolute(path))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A trust grant needs absolute paths');
    }
    const grants = this.list(now);
    const mine = grants.filter((grant) => grant.createdBy === input.userId && isActive(grant, now));
    if (mine.some((grant) => grant.projectId === input.projectId)) {
      throw new HttpError(409, 'TRUST_GRANT_EXISTS', 'Runs without the sandbox are already allowed for this project; revoke that grant first to change it');
    }
    if (mine.length >= TRUST_GRANT_MAX_ACTIVE_PER_USER) {
      throw new HttpError(409, 'TRUST_GRANT_LIMIT', `At most ${TRUST_GRANT_MAX_ACTIVE_PER_USER} trust grants can be active at once`);
    }
    const name = input.projectName ? cleanText(input.projectName, 200) : '';
    const grant: TrustGrant = {
      id: `tg_${randomBytes(8).toString('hex')}`,
      projectId: input.projectId,
      projectName: name || null,
      paths: [...new Set(input.paths)].sort(),
      reason,
      createdBy: input.userId,
      createdAt: iso(now),
      expiresAt: iso(now + input.hours * HOUR_MS),
      revokedAt: null,
      revokedBy: null,
      expiryRecordedAt: null,
      lastUsedAt: null,
      useCount: 0,
    };
    // Audit first: a grant that could not be audited is never stored.
    this.appendAudit({ event: 'created', grant, actor: input.userId, runId: null, kind: null, path: null }, now);
    this.write([...grants, grant], now);
    logger.warn({ grantId: grant.id, projectId: grant.projectId, userId: input.userId, expiresAt: grant.expiresAt }, '[Sandbox] trust grant created: runs of this project may run WITHOUT OS isolation while no verified sandbox is available');
    return grant;
  }

  /** Revokes the caller's own grant (idempotent). Another user's grant is "not found". */
  revoke(id: string, userId: string, now: number): TrustGrant {
    const grants = this.list(now);
    const grant = grants.find((candidate) => candidate.id === id && candidate.createdBy === userId);
    if (!grant) throw new HttpError(404, 'TRUST_GRANT_NOT_FOUND', 'Trust grant not found');
    if (grant.revokedAt !== null) return grant;
    grant.revokedAt = iso(now);
    grant.revokedBy = userId;
    this.appendAudit({ event: 'revoked', grant, actor: userId, runId: null, kind: null, path: null }, now);
    this.write(grants, now);
    logger.info({ grantId: grant.id, projectId: grant.projectId, userId }, '[Sandbox] trust grant revoked');
    this.ended(grant);
    return grant;
  }

  /**
   * Records one use (audit first; repeats for the same run and kind within
   * a few minutes are one use). Throws when the use cannot be audited;
   * callers then refuse.
   */
  recordUse(id: string, use: { runId: string; kind: 'agent' | 'verification'; path: string; userId: string }, now: number): TrustGrant {
    const grants = this.list(now);
    const grant = grants.find((candidate) => candidate.id === id);
    if (!grant || !isActive(grant, now)) throw new HttpError(404, 'TRUST_GRANT_NOT_FOUND', 'Trust grant not found');
    const key = `${id}\0${use.runId}\0${use.kind}`;
    const last = this.recentUses.get(key);
    if (last !== undefined && now >= last && now - last < USE_DEDUPE_MS) return grant;
    this.appendAudit({ event: 'used', grant, actor: use.userId, runId: use.runId, kind: use.kind, path: use.path }, now);
    grant.lastUsedAt = iso(now);
    grant.useCount += 1;
    this.write(grants, now);
    if (this.recentUses.size >= 1_000) this.recentUses.clear();
    this.recentUses.set(key, now);
    return grant;
  }

  /** Newest first: the owner's audit entries (all owners when `owner` is omitted). */
  audit(options: { owner?: string; limit?: number } = {}): TrustGrantAuditEntry[] {
    const limit = options.limit ?? 50;
    const out: TrustGrantAuditEntry[] = [];
    for (const file of [this.auditFile, `${this.auditFile}.1`]) {
      for (const entry of this.readAudit(file).reverse()) {
        if (options.owner !== undefined && entry.owner !== options.owner) continue;
        out.push(entry);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (this.platform !== 'win32') chmodSync(this.dir, 0o700);
  }

  private read(): TrustGrant[] {
    let stats: Stats;
    try {
      stats = lstatSync(this.grantsFile);
    } catch (error) {
      this.problem = errorCode(error) === 'ENOENT' ? null : 'the trust grants file could not be read';
      return [];
    }
    if (!stats.isFile()) return this.reject('the trust grants file is not a regular file');
    if (!secureFile(stats, this.platform)) return this.reject('the trust grants file is accessible to other users');
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof stateSchema>>;
    try {
      parsed = stateSchema.safeParse(JSON.parse(readFileSync(this.grantsFile, 'utf8')));
    } catch {
      return this.reject('the trust grants file is not valid JSON');
    }
    if (!parsed.success) return this.reject('the trust grants file is malformed');
    this.problem = null;
    return parsed.data.grants;
  }

  private reject(problem: string): TrustGrant[] {
    if (this.problem !== problem) logger.error({ file: this.grantsFile, problem }, '[Sandbox] trust grants ignored: no grant applies');
    this.problem = problem;
    return [];
  }

  private write(grants: TrustGrant[], now: number): void {
    this.ensureDir();
    if (this.problem) {
      // Keep the rejected file for inspection; never build on top of it.
      try {
        renameSync(this.grantsFile, `${this.grantsFile}.rejected-${now}`);
      } catch {
        // Nothing to set aside.
      }
    }
    const kept = grants.filter((grant) => {
      const ended = grant.revokedAt !== null ? Date.parse(grant.revokedAt) : Date.parse(grant.expiresAt);
      return isActive(grant, now) || now - ended < ENDED_RETENTION_MS;
    });
    const tmp = join(this.dir, `.grants.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ version: 1, grants: kept }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.grantsFile);
    this.problem = null;
  }

  private appendAudit(
    input: { event: TrustGrantAuditEvent; grant: TrustGrant; actor: string | null; runId: string | null; kind: 'agent' | 'verification' | null; path: string | null },
    now: number,
  ): void {
    this.ensureDir();
    try {
      if (lstatSync(this.auditFile).size >= AUDIT_ROTATE_BYTES) renameSync(this.auditFile, `${this.auditFile}.1`);
    } catch {
      // No audit file yet.
    }
    const entry: TrustGrantAuditEntry = {
      id: randomBytes(8).toString('hex'),
      at: iso(now),
      event: input.event,
      grantId: input.grant.id,
      projectId: input.grant.projectId,
      projectName: input.grant.projectName,
      owner: input.grant.createdBy,
      actor: input.actor,
      runId: input.runId,
      kind: input.kind,
      path: input.path,
    };
    const fd = openSync(this.auditFile, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.platform !== 'win32') chmodSync(this.auditFile, 0o600);
  }

  private readAudit(file: string): TrustGrantAuditEntry[] {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const entries: TrustGrantAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = auditSchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // A torn line (crash mid-append) is skipped.
      }
    }
    return entries;
  }
}

// ---------------------------------------------------------------------------
// Process-wide wiring (set once by the sidecar app; tests configure their own)
// ---------------------------------------------------------------------------

export interface TrustGrantRuntime {
  store: TrustGrantStore;
  /** Maps a checkout directory to its run (user and project). */
  scope: RunScopeResolver;
  /** The roots a new grant covers (agent worktrees and verification checkouts). */
  runRoots: () => string[];
}

let runtime: TrustGrantRuntime | null = null;

export function configureTrustGrants(next: TrustGrantRuntime | null): void {
  runtime = next;
}

export function trustGrantRuntime(): TrustGrantRuntime | null {
  return runtime;
}

/** `OPENLINEAR_SANDBOX_USER_GRANTS=0` turns stored grants off on this device (they are kept, never applied). */
export function userTrustGrantsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENLINEAR_SANDBOX_USER_GRANTS ?? '').trim() !== '0';
}
