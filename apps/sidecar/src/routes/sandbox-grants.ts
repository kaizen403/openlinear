import { join } from 'node:path';
import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, requireSidecarAuth } from '../auth/principal';
import { sidecarAppDataDir } from '../config/app-data';
import { DurableRunJournal } from '../journal/durable';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { resolveEnvSandboxMode } from '../sandbox/mode';
import { getLastCapabilityReport, getVerifiedProvider } from '../sandbox/provider';
import { createJournalRunScope, runRootsFor } from '../sandbox/trust-grant-scope';
import {
  configureTrustGrants,
  TRUST_GRANT_ID,
  TRUST_GRANT_MAX_HOURS,
  TRUST_GRANT_PROJECT_ID,
  TRUST_GRANT_REASON_MAX,
  TRUST_GRANT_REASON_MIN,
  TrustGrantStore,
  trustGrantRuntime,
  userTrustGrantsEnabled,
  type TrustGrant,
  type TrustGrantAuditEntry,
  type TrustGrantRuntime,
} from '../sandbox/trust-grants';
import { appReposDir } from '../workspace/local-worktree';

/**
 * FE-03: `/api/sandbox/grants` — the user's project trust grants on this
 * device ("allow runs without the sandbox for a project").
 *
 * - `GET /` — the sandbox state (verified / unavailable / …, after running
 *   the live preflight if it has not run yet), the caller's active grants
 *   and their recent audit entries.
 * - `POST /` `{ projectId, projectName?, reason, hours }` — create a grant.
 *   Only with a signed-in session (not a PAT), only while no verified
 *   sandbox is available, reason 10–500 characters, 1–168 hours, one active
 *   grant per project.
 * - `POST /:id/revoke` — revoke one of the caller's own grants.
 *
 * Every route authenticates like the other sidecar routes; users only ever
 * see and revoke their own grants (another user's grant is "not found").
 */

export const TRUST_GRANT_DURATIONS_HOURS = [1, 24, 168] as const;
const STATUS_TIMEOUT_MS = 20_000;
const AUDIT_LIMIT = 50;

export type SandboxGrantState = 'verified' | 'unavailable' | 'unknown' | 'env-grant' | 'invalid' | 'disabled';

export interface SandboxGrantStatus {
  state: SandboxGrantState;
  provider: string | null;
  blockers: string[];
  checkedAt: string | null;
  /** Stored grants are in effect for runs on this device right now. */
  grantsApply: boolean;
}

export interface TrustGrantView {
  id: string;
  projectId: string;
  projectName: string | null;
  reason: string;
  paths: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

export type TrustGrantAuditView = Omit<TrustGrantAuditEntry, 'owner'>;

export interface SandboxGrantsResponse {
  sandbox: SandboxGrantStatus;
  maxHours: number;
  durations: readonly number[];
  grants: TrustGrantView[];
  audit: TrustGrantAuditView[];
  /** Why stored grants are being ignored (e.g. an unsafe grants file); null when fine. */
  problem: string | null;
}

export function toGrantView(grant: TrustGrant): TrustGrantView {
  return {
    id: grant.id,
    projectId: grant.projectId,
    projectName: grant.projectName,
    reason: grant.reason,
    paths: [...grant.paths],
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    lastUsedAt: grant.lastUsedAt,
    useCount: grant.useCount,
  };
}

function toAuditView(entry: TrustGrantAuditEntry): TrustGrantAuditView {
  const { owner: _owner, ...view } = entry;
  return view;
}

export function defaultTrustGrantDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(sidecarAppDataDir(env), 'trust-grants');
}

/**
 * Registers this device's grant store with the sandbox mode resolver (once
 * per process) and, when active grants exist, starts the sandbox preflight
 * so the first run after a restart already knows whether they apply.
 */
export function installDefaultTrustGrants(env: NodeJS.ProcessEnv = process.env): TrustGrantRuntime {
  const existing = trustGrantRuntime();
  if (existing) return existing;
  const runtime: TrustGrantRuntime = {
    store: new TrustGrantStore(defaultTrustGrantDir(env)),
    scope: createJournalRunScope({ journalPath: () => DurableRunJournal.defaultPath(), reposRoot: appReposDir }),
    runRoots: () => {
      const roots = runRootsFor(appReposDir());
      return [roots.agent, roots.verification];
    },
  };
  configureTrustGrants(runtime);
  runtime.store.onGrantEnded((grant, runIds) => stopRunsOfEndedGrant(grant.id, runIds));
  // Expiry is recorded when the store is read; read it regularly so a grant's
  // runs stop when it runs out, not at the next unrelated read.
  setInterval(() => {
    try {
      runtime.store.list(Date.now());
    } catch {
      // An unreadable store applies no grant.
    }
  }, GRANT_EXPIRY_SWEEP_MS).unref();
  try {
    if (userTrustGrantsEnabled(env) && runtime.store.active(Date.now()).length > 0) {
      void getVerifiedProvider().catch(() => undefined);
    }
  } catch {
    // An unreadable store applies no grant; the routes report it.
  }
  return runtime;
}

const GRANT_EXPIRY_SWEEP_MS = 30_000;

/** Cancels the v2 runs that used an ended grant (they run without OS isolation). */
export function stopRunsOfEndedGrant(grantId: string, runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  void import('../run/index').then(({ runEngineActive, getRunService }) => {
    if (!runEngineActive()) return;
    const cancelled = getRunService().cancelRuns(runIds, 'trust grant ended');
    if (cancelled.length > 0) logger.warn({ grantId, runIds: cancelled }, '[Sandbox] trust grant ended: cancelled the runs it let start without OS isolation');
  }).catch((error: unknown) => logger.error({ err: error, grantId }, '[Sandbox] could not stop the runs of an ended trust grant'));
}

/** The sandbox state for the grants UI; runs the live preflight first when it has not run yet. */
export async function currentSandboxGrantStatus(env: NodeJS.ProcessEnv = process.env, timeoutMs = STATUS_TIMEOUT_MS): Promise<SandboxGrantStatus> {
  const none = { provider: null, checkedAt: null, grantsApply: false };
  try {
    const mode = resolveEnvSandboxMode(env).mode;
    if (mode === 'trusted-host') return { ...none, state: 'env-grant', blockers: [] };
  } catch (error) {
    return { ...none, state: 'invalid', blockers: [error instanceof Error ? error.message : 'invalid sandbox mode'] };
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    getVerifiedProvider().then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  const report = getLastCapabilityReport();
  if (!report) return { ...none, state: 'unknown', blockers: [] };
  const base = { provider: report.provider === 'none' ? null : report.provider, checkedAt: report.checkedAt, blockers: [...report.blockers] };
  if (report.available) return { ...base, state: 'verified', grantsApply: false };
  if (!userTrustGrantsEnabled(env)) return { ...base, state: 'disabled', grantsApply: false };
  return { ...base, state: 'unavailable', grantsApply: true };
}

const createSchema = z.object({
  projectId: z.string().trim().regex(TRUST_GRANT_PROJECT_ID, 'Choose a project'),
  projectName: z.string().trim().max(200).optional(),
  reason: z.string().trim()
    .min(TRUST_GRANT_REASON_MIN, `Give a reason of at least ${TRUST_GRANT_REASON_MIN} characters`)
    .max(TRUST_GRANT_REASON_MAX, `Keep the reason under ${TRUST_GRANT_REASON_MAX} characters`),
  hours: z.number().int().min(1).max(TRUST_GRANT_MAX_HOURS, `A grant lasts at most ${TRUST_GRANT_MAX_HOURS / 24} days`),
}).strict();

function notCreatable(status: SandboxGrantStatus): HttpError | null {
  switch (status.state) {
    case 'unavailable':
      return null;
    case 'verified':
      return new HttpError(409, 'TRUST_GRANT_NOT_NEEDED', 'The sandbox is verified on this device, so runs are isolated and no trust grant is needed');
    case 'unknown':
      return new HttpError(503, 'SANDBOX_CHECK_PENDING', 'The sandbox check has not finished yet; try again in a moment');
    case 'env-grant':
      return new HttpError(409, 'TRUST_GRANT_NOT_APPLICABLE', 'This sidecar runs under a trusted-host grant from its environment; project grants are not used');
    case 'disabled':
      return new HttpError(409, 'TRUST_GRANT_NOT_APPLICABLE', 'Project trust grants are turned off on this device (OPENLINEAR_SANDBOX_USER_GRANTS=0)');
    case 'invalid':
      return new HttpError(409, 'TRUST_GRANT_NOT_APPLICABLE', 'The sandbox setting on this device is invalid; fix it before allowing runs without the sandbox');
  }
}

export interface SandboxGrantsRouterDeps {
  runtime?: () => TrustGrantRuntime;
  sandboxStatus?: () => Promise<SandboxGrantStatus>;
  now?: () => number;
}

export function createSandboxGrantsRouter(deps: SandboxGrantsRouterDeps = {}): Router {
  // Installed when the app is built, so stored grants apply from the first run after a restart.
  if (!deps.runtime) installDefaultTrustGrants();
  const runtime = deps.runtime ?? (() => installDefaultTrustGrants());
  const sandboxStatus = deps.sandboxStatus ?? (() => currentSandboxGrantStatus());
  const now = deps.now ?? Date.now;

  const router = Router();
  router.use(requireSidecarAuth);

  router.get('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = credentialOf(req).principal.userId;
      const sandbox = await sandboxStatus();
      const { store } = runtime();
      const at = now();
      const grants = store.activeFor(userId, at).map(toGrantView);
      const body: SandboxGrantsResponse = {
        sandbox,
        maxHours: TRUST_GRANT_MAX_HOURS,
        durations: TRUST_GRANT_DURATIONS_HOURS,
        grants,
        audit: store.audit({ owner: userId, limit: AUDIT_LIMIT }).map(toAuditView),
        problem: store.problem,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { principal } = credentialOf(req);
      if (principal.authSource !== 'session') {
        throw new HttpError(403, 'SESSION_REQUIRED', 'Allowing runs without the sandbox needs a signed-in session, not a personal access token');
      }
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        const flat = parsed.error.flatten();
        const first = Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid trust grant';
        throw new HttpError(400, 'VALIDATION_ERROR', first, flat);
      }
      const refusal = notCreatable(await sandboxStatus());
      if (refusal) throw refusal;
      const { store, runRoots } = runtime();
      const grant = store.create({
        userId: principal.userId,
        projectId: parsed.data.projectId,
        projectName: parsed.data.projectName ?? null,
        reason: parsed.data.reason,
        hours: parsed.data.hours,
        paths: runRoots(),
      }, now());
      res.status(201).json({ grant: toGrantView(grant) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/revoke', (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = credentialOf(req).principal.userId;
      const id = String(req.params.id ?? '');
      if (!TRUST_GRANT_ID.test(id)) throw new HttpError(404, 'TRUST_GRANT_NOT_FOUND', 'Trust grant not found');
      const grant = runtime().store.revoke(id, userId, now());
      res.json({ grant: toGrantView(grant) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
