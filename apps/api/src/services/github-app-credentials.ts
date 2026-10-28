import { decryptToken, encryptToken, prisma, Prisma, type ExecutionAttempt } from '@openlinear/db';
import { HttpError } from '../errors';
import { logger } from '../logger';
import { logAudit } from './audit';
import { decryptUserAccessToken } from './github';
import {
  getGitCredentialFallbackPolicy,
  getGitHubAppConfig,
  type GitCredentialFallbackPolicy,
  type GitHubAppConfig,
} from './github-app-config';
import {
  EFFECT_PERMISSIONS,
  GitHubAppClient,
  hashInstallationToken,
  isGitHubAppError,
  missingPermissions,
  REQUIRED_INSTALLATION_PERMISSIONS,
  type GitCredentialEffect,
  type InstallationInfo,
  type InstallationPermissions,
} from './github-app';
import { assertProjectAccess } from './ownership';
import { assertWorkspaceRole } from './workspaces';

/**
 * W10a credential broker for execution attempts.
 *
 * Per effect (`fetch` | `push` | `pull_request`) the attempt receives the
 * narrowest credential available:
 *
 * 1. a GitHub App installation token restricted to the attempt's repository
 *    and the effect's permissions (EFFECT_PERMISSIONS), expiring within an
 *    hour; reused for the same attempt+effect while it has more than ten
 *    minutes left, otherwise a fresh one is minted (refresh);
 * 2. otherwise — App not configured, not installed on the repository,
 *    installation suspended or lacking a permission — the initiating user's
 *    OAuth token, ONLY when OPENLINEAR_GIT_CREDENTIAL_FALLBACK allows it
 *    (default `user_oauth`, an owner decision so current users keep working).
 *    Workspace-bound PAT attempts never get the account-wide token.
 *
 * A GitHub outage or refused App credentials never fall back (502): a
 * failure must not silently widen a repo-scoped grant to the user's whole
 * account.
 *
 * Every issue is recorded (`execution_git_credentials`, plus the workspace
 * audit log) with the credential kind, effect, repository, permissions and
 * fallback reason — never a token value. Installation tokens are stored
 * encrypted only so they can be revoked (`DELETE /installation/token`) when
 * the attempt closes; the ciphertext is cleared at revocation.
 */

export type GitCredentialKind = 'installation' | 'user_oauth' | 'none';
export type GitCredentialFallbackReason =
  | 'app_not_configured'
  | 'app_not_installed'
  | 'installation_suspended'
  | 'installation_permissions_insufficient'
  | 'repository_not_linked';

export interface IssuedGitCredential {
  provider: 'github';
  kind: GitCredentialKind;
  effect: GitCredentialEffect;
  token: string | null;
  repository: string | null;
  permissions: InstallationPermissions | null;
  /** When the token itself expires (installation tokens); null for OAuth tokens. */
  expiresAt: string | null;
  /** The sidecar must not use the credential after this (min of token and capability expiry). */
  notAfter: string;
  grantId: string;
  reused: boolean;
  fallbackReason: GitCredentialFallbackReason | null;
}

/** Reuse a recorded installation token only while it has at least this long left. */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

function clientFor(config: GitHubAppConfig): GitHubAppClient {
  return new GitHubAppClient(config);
}

function unavailable(message: string): HttpError {
  return new HttpError(502, 'GITHUB_APP_UNAVAILABLE', message);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

async function repositoryRefFor(attempt: ExecutionAttempt): Promise<{ fullName: string; githubRepoId: number | null }> {
  const fullName = attempt.repositoryFullName ?? '';
  if (!attempt.repositoryId) return { fullName, githubRepoId: null };
  const row = await prisma.repository.findUnique({ where: { id: attempt.repositoryId }, select: { githubRepoId: true, fullName: true } });
  // Bind to GitHub's repository id only while the stored repository still names the same repository.
  if (!row || row.fullName.toLowerCase() !== fullName.toLowerCase() || row.githubRepoId <= 0) return { fullName, githubRepoId: null };
  return { fullName, githubRepoId: row.githubRepoId };
}

interface RecordInput {
  attempt: ExecutionAttempt;
  effect: GitCredentialEffect;
  kind: GitCredentialKind;
  installationId?: number | null;
  permissions?: InstallationPermissions | null;
  fallbackReason?: GitCredentialFallbackReason | null;
  token?: string | null;
  expiresAt?: Date | null;
}

async function recordGrant(input: RecordInput): Promise<string> {
  const installationToken = input.kind === 'installation' && input.token ? input.token : null;
  const row = await prisma.executionGitCredential.create({
    data: {
      attemptId: input.attempt.id,
      userId: input.attempt.userId,
      effect: input.effect,
      kind: input.kind,
      repositoryFullName: input.attempt.repositoryFullName,
      installationId: input.installationId ? String(input.installationId) : null,
      permissions: input.permissions ? { ...input.permissions } : Prisma.DbNull,
      fallbackReason: input.fallbackReason ?? null,
      tokenHash: installationToken ? hashInstallationToken(installationToken) : null,
      encryptedToken: installationToken ? encryptToken(installationToken) : null,
      expiresAt: input.expiresAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function audit(attempt: ExecutionAttempt, action: string, metadata: Prisma.InputJsonObject): Promise<void> {
  logger.info({ attemptId: attempt.id, taskId: attempt.taskId, ...metadata }, `[git-credential] ${action}`);
  if (!attempt.workspaceId) return;
  try {
    await logAudit({
      workspaceId: attempt.workspaceId,
      actorId: attempt.userId,
      action,
      resourceType: 'execution_attempt',
      resourceId: attempt.id,
      metadata,
    });
  } catch (err) {
    logger.warn({ err, attemptId: attempt.id }, '[git-credential] audit log write failed');
  }
}

async function reuseInstallationToken(attempt: ExecutionAttempt, effect: GitCredentialEffect, now: Date) {
  const row = await prisma.executionGitCredential.findFirst({
    where: {
      attemptId: attempt.id,
      effect,
      kind: 'installation',
      revokedAt: null,
      encryptedToken: { not: null },
      expiresAt: { gt: new Date(now.getTime() + INSTALLATION_TOKEN_REFRESH_MARGIN_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!row?.encryptedToken || !row.expiresAt) return null;
  let token: string | null;
  try {
    token = decryptToken(row.encryptedToken);
  } catch {
    return null;
  }
  if (!token) return null;
  return { id: row.id, token, expiresAt: row.expiresAt, permissions: storedPermissions(row.permissions), installationId: row.installationId };
}

function storedPermissions(value: Prisma.JsonValue | null): InstallationPermissions {
  const out: Record<string, 'read' | 'write'> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, level] of Object.entries(value)) {
      if (level === 'read' || level === 'write') out[name] = level;
    }
  }
  return out;
}

type InstallationOutcome =
  | { kind: 'issued'; credential: IssuedGitCredential }
  | { kind: 'fallback'; reason: GitCredentialFallbackReason; installUrl: string | null };

async function tryInstallationToken(
  config: GitHubAppConfig,
  attempt: ExecutionAttempt,
  effect: GitCredentialEffect,
  notAfterCap: Date,
): Promise<InstallationOutcome> {
  const now = new Date();
  const reused = await reuseInstallationToken(attempt, effect, now);
  if (reused) {
    await audit(attempt, 'execution.git_credential_issued', {
      grantId: reused.id, effect, kind: 'installation', repository: attempt.repositoryFullName, installationId: reused.installationId,
      permissions: { ...reused.permissions }, expiresAt: reused.expiresAt.toISOString(), reused: true,
    });
    return {
      kind: 'issued',
      credential: {
        provider: 'github', kind: 'installation', effect, token: reused.token, repository: attempt.repositoryFullName,
        permissions: reused.permissions, expiresAt: reused.expiresAt.toISOString(),
        notAfter: minDate(reused.expiresAt, notAfterCap).toISOString(), grantId: reused.id, reused: true, fallbackReason: null,
      },
    };
  }

  const client = clientFor(config);
  const repository = await repositoryRefFor(attempt);
  let installation: InstallationInfo;
  try {
    const lookup = await client.findRepositoryInstallation(repository.fullName);
    if (lookup.status === 'not_installed') {
      return { kind: 'fallback', reason: 'app_not_installed', installUrl: await installUrlQuietly(client) };
    }
    installation = lookup.installation;
  } catch (err) {
    throw toBrokerError(err);
  }
  if (installation.suspended) return { kind: 'fallback', reason: 'installation_suspended', installUrl: client.manageUrl(installation) };
  const permissions = EFFECT_PERMISSIONS[effect];
  if (missingPermissions(installation.permissions, permissions).length > 0) {
    return { kind: 'fallback', reason: 'installation_permissions_insufficient', installUrl: client.manageUrl(installation) };
  }

  let minted: Awaited<ReturnType<GitHubAppClient['mintInstallationToken']>>;
  try {
    minted = await client.mintInstallationToken({ installationId: installation.id, repository, permissions });
  } catch (err) {
    if (isGitHubAppError(err) && err.kind === 'permissions') {
      client.forgetInstallation(repository.fullName);
      return { kind: 'fallback', reason: 'installation_permissions_insufficient', installUrl: client.manageUrl(installation) };
    }
    throw toBrokerError(err);
  }

  let grantId: string;
  try {
    grantId = await recordGrant({
      attempt, effect, kind: 'installation', installationId: installation.id, permissions: minted.permissions,
      token: minted.token, expiresAt: minted.expiresAt,
    });
  } catch (err) {
    // A token that cannot be recorded cannot be revoked at close: revoke it now.
    await client.revokeInstallationToken(minted.token);
    throw err;
  }
  await audit(attempt, 'execution.git_credential_issued', {
    grantId, effect, kind: 'installation', repository: minted.repositoryFullName, installationId: String(installation.id),
    permissions: { ...minted.permissions }, expiresAt: minted.expiresAt.toISOString(), reused: false,
  });
  return {
    kind: 'issued',
    credential: {
      provider: 'github', kind: 'installation', effect, token: minted.token, repository: minted.repositoryFullName,
      permissions: minted.permissions, expiresAt: minted.expiresAt.toISOString(),
      notAfter: minDate(minted.expiresAt, notAfterCap).toISOString(), grantId, reused: false, fallbackReason: null,
    },
  };
}

async function installUrlQuietly(client: GitHubAppClient): Promise<string | null> {
  try {
    const slug = await client.appSlug();
    return slug ? client.installUrl(slug) : null;
  } catch {
    return null;
  }
}

function toBrokerError(err: unknown): unknown {
  if (!isGitHubAppError(err)) return err;
  if (err.kind === 'rejected') {
    logger.error({ status: err.status }, '[git-credential] GitHub refused the App credentials; check GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY');
    return unavailable('GitHub refused the OpenLinear GitHub App credentials');
  }
  if (err.kind === 'scope_violation') {
    logger.error({ reason: err.message }, '[git-credential] refused an over-broad installation token');
    return new HttpError(502, 'GITHUB_APP_TOKEN_REJECTED', 'GitHub issued a broader token than requested; it was revoked and not used');
  }
  return unavailable('GitHub is unavailable; no repository credential could be issued');
}

/**
 * Issue the credential for one git effect of an attempt. The caller has
 * already re-authorized the initiator and checked the attempt state/fence.
 */
export async function brokerAttemptGitCredential(input: {
  attempt: ExecutionAttempt;
  effect: GitCredentialEffect;
  capabilityExpiresAt: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<IssuedGitCredential> {
  const { attempt, effect } = input;
  const env = input.env ?? process.env;
  const policy: GitCredentialFallbackPolicy = getGitCredentialFallbackPolicy(env);
  const config = getGitHubAppConfig(env);

  let reason: GitCredentialFallbackReason;
  let installUrl: string | null = null;
  if (!attempt.repositoryFullName) {
    reason = 'repository_not_linked';
  } else if (!config) {
    reason = 'app_not_configured';
  } else {
    const outcome = await tryInstallationToken(config, attempt, effect, input.capabilityExpiresAt);
    if (outcome.kind === 'issued') return outcome.credential;
    reason = outcome.reason;
    installUrl = outcome.installUrl;
  }
  return fallbackCredential({ attempt, effect, policy, reason, installUrl, capabilityExpiresAt: input.capabilityExpiresAt });
}

async function fallbackCredential(input: {
  attempt: ExecutionAttempt;
  effect: GitCredentialEffect;
  policy: GitCredentialFallbackPolicy;
  reason: GitCredentialFallbackReason;
  installUrl: string | null;
  capabilityExpiresAt: Date;
}): Promise<IssuedGitCredential> {
  const { attempt, effect, policy, reason } = input;
  const base = {
    provider: 'github' as const,
    effect,
    repository: attempt.repositoryFullName,
    permissions: null,
    expiresAt: null,
    notAfter: input.capabilityExpiresAt.toISOString(),
    reused: false,
    fallbackReason: reason,
  };

  if (policy === 'deny') {
    if (reason === 'repository_not_linked') {
      // Nothing to scope a token to: no credential, local-only work proceeds.
      const grantId = await recordGrant({ attempt, effect, kind: 'none', fallbackReason: reason });
      await audit(attempt, 'execution.git_credential_issued', { grantId, effect, kind: 'none', fallbackReason: reason, policy });
      return { ...base, kind: 'none', token: null, grantId };
    }
    await audit(attempt, 'execution.git_credential_denied', {
      effect, repository: attempt.repositoryFullName, fallbackReason: reason, policy,
    });
    throw new HttpError(403, 'GITHUB_APP_REQUIRED',
      'This workspace requires the OpenLinear GitHub App for repository access; install it on the repository and retry', {
        reason,
        repository: attempt.repositoryFullName,
        installUrl: input.installUrl,
      });
  }

  if (attempt.workspaceRestriction) {
    throw new HttpError(403, 'PAT_WORKSPACE_RESTRICTED',
      'Account-wide credentials are not available to an execution started with a workspace-bound personal access token', {
        reason,
        installUrl: input.installUrl,
      });
  }
  const user = await prisma.user.findUnique({ where: { id: attempt.userId }, select: { accessToken: true } });
  const token = decryptUserAccessToken(user?.accessToken ?? null);
  const kind: GitCredentialKind = token ? 'user_oauth' : 'none';
  const grantId = await recordGrant({ attempt, effect, kind, fallbackReason: reason });
  await audit(attempt, 'execution.git_credential_issued', {
    grantId, effect, kind, repository: attempt.repositoryFullName, fallbackReason: reason, policy,
  });
  return { ...base, kind, token, grantId };
}

/**
 * Revoke every installation token still recorded for the attempt (attempt
 * close, release, rejected claim). Expired tokens are only cleared. The
 * ciphertext is cleared whatever GitHub answers, so no token material
 * outlives the attempt; a failed revocation leaves a token that expires on
 * its own within the hour. Never throws.
 */
export async function revokeAttemptGitCredentials(attemptId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ revoked: number; expired: number; failed: number }> {
  const summary = { revoked: 0, expired: 0, failed: 0 };
  try {
    const rows = await prisma.executionGitCredential.findMany({
      where: { attemptId, kind: 'installation', revokedAt: null, encryptedToken: { not: null } },
      select: { id: true, encryptedToken: true, expiresAt: true, effect: true },
    });
    if (rows.length === 0) return summary;
    let config: GitHubAppConfig | null = null;
    try {
      config = getGitHubAppConfig(env);
    } catch {
      config = null;
    }
    const now = new Date();
    await Promise.all(rows.map(async (row) => {
      let status: 'revoked' | 'already_invalid' | 'expired' | 'failed';
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
        status = 'expired';
      } else if (!config) {
        status = 'failed';
      } else {
        let token: string | null = null;
        try {
          token = decryptToken(row.encryptedToken);
        } catch {
          token = null;
        }
        status = token ? await clientFor(config).revokeInstallationToken(token) : 'failed';
      }
      await prisma.executionGitCredential.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), revocationStatus: status, encryptedToken: null },
      });
      if (status === 'expired') summary.expired += 1;
      else if (status === 'failed') summary.failed += 1;
      else summary.revoked += 1;
    }));
    const attempt = await prisma.executionAttempt.findUnique({ where: { id: attemptId } });
    if (attempt) {
      await audit(attempt, 'execution.git_credential_revoked', { ...summary });
    }
  } catch (err) {
    logger.warn({ err, attemptId }, '[git-credential] revocation at attempt close failed');
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Installation discovery (workspace admins)
// ---------------------------------------------------------------------------

export interface ProjectGitHubAppStatus {
  projectId: string;
  repository: string | null;
  configured: boolean;
  installed: boolean | null;
  suspended: boolean | null;
  installationId: number | null;
  account: { login: string | null; type: string | null } | null;
  repositorySelection: string | null;
  missingPermissions: string[];
  installUrl: string | null;
  manageUrl: string | null;
  fallbackPolicy: GitCredentialFallbackPolicy;
  effectPermissions: Readonly<Record<GitCredentialEffect, InstallationPermissions>>;
}

/**
 * Whether the GitHub App can broker credentials for a project's repository,
 * and where to install or fix it. Workspace owners/admins only (projects
 * outside a workspace: full project access).
 */
export async function describeProjectGitHubApp(input: { projectId: string; userId: string; env?: NodeJS.ProcessEnv }): Promise<ProjectGitHubAppStatus> {
  const env = input.env ?? process.env;
  const access = await assertProjectAccess(input.projectId, input.userId, 'view');
  if (access.workspaceId) await assertWorkspaceRole(access.workspaceId, input.userId, ['owner', 'admin']);
  else await assertProjectAccess(input.projectId, input.userId, 'full');

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { repository: { select: { fullName: true } } },
  });
  const repository = project?.repository?.fullName ?? null;
  const config = getGitHubAppConfig(env);
  const status: ProjectGitHubAppStatus = {
    projectId: input.projectId,
    repository,
    configured: Boolean(config),
    installed: null,
    suspended: null,
    installationId: null,
    account: null,
    repositorySelection: null,
    missingPermissions: [],
    installUrl: null,
    manageUrl: null,
    fallbackPolicy: getGitCredentialFallbackPolicy(env),
    effectPermissions: EFFECT_PERMISSIONS,
  };
  if (!config) return status;
  const client = clientFor(config);
  try {
    const slug = await client.appSlug();
    status.installUrl = slug ? client.installUrl(slug) : null;
    if (!repository) return status;
    const lookup = await client.findRepositoryInstallation(repository);
    if (lookup.status === 'not_installed') {
      status.installed = false;
      return status;
    }
    const installation = lookup.installation;
    status.installed = true;
    status.suspended = installation.suspended;
    status.installationId = installation.id;
    status.account = { login: installation.accountLogin, type: installation.accountType };
    status.repositorySelection = installation.repositorySelection;
    status.missingPermissions = missingPermissions(installation.permissions, REQUIRED_INSTALLATION_PERMISSIONS);
    status.manageUrl = client.manageUrl(installation);
    return status;
  } catch (err) {
    throw toBrokerError(err);
  }
}
