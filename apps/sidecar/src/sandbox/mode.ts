import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { SandboxUnavailableError } from './errors';
import { collapseNested, isWithin, realpathOrResolve } from './paths';
import { getLastCapabilityReport, getVerifiedProvider } from './provider';
import { trustGrantRuntime, userTrustGrantsEnabled, type TrustGrant } from './trust-grants';

/**
 * Sandbox modes.
 *
 * - `enforce` (default): agent processes run only under a provider whose live
 *   preflight passed. Otherwise SANDBOX_UNAVAILABLE, and nothing is spawned.
 * - `trusted-host`: an explicit, recorded grant lets attempts run on the host
 *   exactly as before W09a (shared OpenCode server, user's filesystem and
 *   network). Never selected automatically; never a fallback for a failed
 *   preflight.
 *
 * Where the grant lives: the sidecar's environment (the desktop launcher's
 * env, or the sidecar `.env` in development):
 *
 *   OPENLINEAR_SANDBOX_MODE=trusted-host
 *   OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT='{"actor":"you@example.com",
 *     "reason":"…at least 10 chars…","expiresAt":"2026-11-01T00:00:00Z",
 *     "paths":["/abs/path/to/trusted/checkouts"]}'
 *
 * or `OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE=/abs/path/grant.json` with
 * the same JSON. `expiresAt` is required and at most 30 days ahead; `paths`
 * (optional) limits the grant to worktrees under those directories. Every
 * use is logged at warn level with the grant id and included in the
 * attempt's sandbox metadata.
 *
 * FE-03 adds user-managed project grants (./trust-grants, created in
 * Settings → Agents). In enforce mode they apply ONLY while the last
 * preflight on this machine FAILED (no verified sandbox), only to checkouts
 * of their project's runs started by the grant's creator, and never once
 * expired or revoked. A working sandbox ignores them entirely; an unknown
 * sandbox state (no preflight yet) is treated as enforce. Each use is
 * audited (`grantCovers`); a use that cannot be audited is refused. The
 * environment grant above is unchanged and takes precedence (it selects
 * trusted-host mode explicitly).
 */

export const MAX_GRANT_DAYS = 30;

const grantSchema = z.object({
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(10).max(500),
  expiresAt: z.string().datetime({ offset: true }),
  paths: z.array(z.string().min(1)).max(50).optional(),
}).strict();

export interface TrustedHostGrant {
  grantId: string;
  actor: string;
  reason: string;
  expiresAt: string;
  paths: string[] | null;
  /** `store`: a user-managed project grant (FE-03), applied only while no verified sandbox is available. */
  source: 'env' | 'file' | 'store';
}

export type SandboxModeDecision = { mode: 'enforce' } | { mode: 'trusted-host'; grant: TrustedHostGrant };

function grantUnavailable(detail: string): SandboxUnavailableError {
  return new SandboxUnavailableError('Trusted-host execution was requested without a valid grant', [detail]);
}

export function parseTrustedHostGrant(raw: string, source: TrustedHostGrant['source'], now = Date.now()): TrustedHostGrant {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw grantUnavailable('trusted-host grant is not valid JSON');
  }
  const parsed = grantSchema.safeParse(json);
  if (!parsed.success) {
    throw grantUnavailable(`trusted-host grant is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'grant'} ${issue.message}`).join('; ')}`);
  }
  const expires = Date.parse(parsed.data.expiresAt);
  if (!(expires > now)) throw grantUnavailable('trusted-host grant has expired');
  if (expires - now > MAX_GRANT_DAYS * 86_400_000) throw grantUnavailable(`trusted-host grant may not exceed ${MAX_GRANT_DAYS} days`);
  const paths = parsed.data.paths?.map((path) => {
    if (!path.startsWith('/')) throw grantUnavailable('trusted-host grant paths must be absolute');
    return realpathOrResolve(path);
  }) ?? null;
  const canonical = JSON.stringify({ ...parsed.data, paths });
  return {
    grantId: createHash('sha256').update(canonical).digest('hex').slice(0, 12),
    actor: parsed.data.actor,
    reason: parsed.data.reason,
    expiresAt: new Date(expires).toISOString(),
    paths,
    source,
  };
}

/**
 * Resolves the mode for the next attempt: the environment's explicit mode,
 * or — in enforce mode with no verified sandbox — the user's active project
 * grants (narrowed to the one that applies by `grantCovers`). Throws on
 * invalid explicit config.
 */
export function resolveSandboxMode(env: NodeJS.ProcessEnv = process.env, now = Date.now()): SandboxModeDecision {
  const decision = resolveEnvSandboxMode(env, now);
  if (decision.mode !== 'enforce') return decision;
  return storedGrantDecision(env, now) ?? decision;
}

/** The mode selected by the sidecar environment alone (stored grants not considered). Throws on invalid explicit config. */
export function resolveEnvSandboxMode(env: NodeJS.ProcessEnv = process.env, now = Date.now()): SandboxModeDecision {
  const mode = (env.OPENLINEAR_SANDBOX_MODE ?? 'enforce').trim().toLowerCase();
  if (mode === '' || mode === 'enforce') return { mode: 'enforce' };
  if (mode !== 'trusted-host') {
    throw new SandboxUnavailableError(`Unknown OPENLINEAR_SANDBOX_MODE "${mode}"`, ['set OPENLINEAR_SANDBOX_MODE to enforce or trusted-host']);
  }
  if (env.OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT) {
    return { mode: 'trusted-host', grant: parseTrustedHostGrant(env.OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT, 'env', now) };
  }
  const file = env.OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE;
  if (file) {
    if (!file.startsWith('/')) throw grantUnavailable('grant file path must be absolute');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw grantUnavailable('grant file could not be read');
    }
    return { mode: 'trusted-host', grant: parseTrustedHostGrant(raw, 'file', now) };
  }
  throw grantUnavailable('set OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT or OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE');
}

/**
 * Whether `grant` covers `directory` (no `paths` = every directory). For a
 * stored grant this is also the point of use: it finds the grant of the
 * checkout's project and user, audits the use (refusing when it cannot be
 * audited) and narrows `grant` to it, so the attempt's sandbox metadata and
 * logs name the grant that applied.
 */
export function grantCovers(grant: TrustedHostGrant, directory: string): boolean {
  if (grant.source === 'store') return storedGrantCovers(grant, directory, Date.now());
  if (!grant.paths) return true;
  const real = realpathOrResolve(directory);
  return grant.paths.some((path) => isWithin(real, path));
}

// ---------------------------------------------------------------------------
// FE-03 stored project grants
// ---------------------------------------------------------------------------

/** Mirrors the provider's failure retry window: an older failure is re-checked in the background. */
const PREFLIGHT_RETRY_MS = 30_000;
let recheck: Promise<void> | null = null;

function recheckSandbox(): void {
  if (recheck) return;
  recheck = getVerifiedProvider()
    .then(() => undefined, () => undefined)
    .finally(() => {
      recheck = null;
    });
}

function decisionGrant(active: readonly TrustGrant[]): TrustedHostGrant {
  const sorted = [...active].sort((a, b) => a.id.localeCompare(b.id));
  const ids = sorted.map((grant) => grant.id);
  const latest = sorted.reduce((max, grant) => (grant.expiresAt > max ? grant.expiresAt : max), sorted[0].expiresAt);
  return {
    grantId: ids.length === 1 ? ids[0] : `tg_set_${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 12)}`,
    actor: [...new Set(sorted.map((grant) => grant.createdBy))].join(','),
    reason: sorted.length === 1 ? sorted[0].reason : `${sorted.length} project trust grants`,
    expiresAt: latest,
    paths: collapseNested(sorted.flatMap((grant) => grant.paths)),
    source: 'store',
  };
}

/**
 * Enforce mode's fallback to stored grants: only when the cached preflight
 * says no verified sandbox is available and an active grant exists. The
 * returned grant spans every active grant; `grantCovers` decides per checkout.
 */
function storedGrantDecision(env: NodeJS.ProcessEnv, now: number): SandboxModeDecision | null {
  const runtime = trustGrantRuntime();
  if (!runtime || !userTrustGrantsEnabled(env)) return null;
  const report = getLastCapabilityReport();
  if (!report || report.available) return null;
  const checkedAt = Date.parse(report.checkedAt);
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= PREFLIGHT_RETRY_MS) recheckSandbox();
  let active: TrustGrant[];
  try {
    active = runtime.store.active(now);
  } catch (error) {
    logger.error({ err: error }, '[Sandbox] trust grants unreadable: no grant applies');
    return null;
  }
  return active.length > 0 ? { mode: 'trusted-host', grant: decisionGrant(active) } : null;
}

function storedGrantCovers(grant: TrustedHostGrant, directory: string, now: number): boolean {
  const runtime = trustGrantRuntime();
  if (!runtime || !grant.paths) return false;
  const real = realpathOrResolve(directory);
  if (!grant.paths.some((path) => isWithin(real, path))) return false;
  try {
    const scope = runtime.scope(real);
    if (!scope?.projectId) {
      logger.warn({ directory: real }, '[Sandbox] no trust grant applies: the checkout is not a journaled run of a project');
      return false;
    }
    const match = runtime.store.active(now)
      .filter((candidate) => candidate.projectId === scope.projectId && candidate.createdBy === scope.userId && candidate.paths.some((path) => isWithin(real, path)))
      .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
    if (!match) return false;
    runtime.store.recordUse(match.id, { runId: scope.runId, kind: scope.kind, path: real, userId: scope.userId }, now);
    grant.grantId = match.id;
    grant.actor = match.createdBy;
    grant.reason = match.reason;
    grant.expiresAt = match.expiresAt;
    grant.paths = [...match.paths];
    logger.warn({ grantId: match.id, projectId: match.projectId, runId: scope.runId, kind: scope.kind }, '[Sandbox] project trust grant used: no verified sandbox, this run proceeds WITHOUT OS isolation');
    return true;
  } catch (error) {
    logger.error({ err: error, directory: real }, '[Sandbox] trust grant use could not be audited: refused');
    return false;
  }
}
