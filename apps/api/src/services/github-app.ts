import { createHash, sign } from 'node:crypto';
import { z } from 'zod';
import type { GitHubAppConfig } from './github-app-config';

/**
 * W10a: GitHub App REST client — App JWTs, installation lookup per repository
 * and installation access tokens restricted to ONE repository and the minimal
 * permissions of one git effect.
 *
 * Nothing here persists or logs a token. Callers (github-app-credentials.ts)
 * decide when a token is issued, recorded (encrypted, for revocation) and
 * revoked.
 */

export const GIT_CREDENTIAL_EFFECTS = ['fetch', 'push', 'pull_request'] as const;
export type GitCredentialEffect = (typeof GIT_CREDENTIAL_EFFECTS)[number];

export type PermissionLevel = 'read' | 'write';
export type InstallationPermissions = Readonly<Record<string, PermissionLevel>>;

/**
 * The narrowest installation permissions per effect.
 *
 * - fetch (clone, fetch, ls-remote, lazy blob fetch): contents:read
 * - push (ls-remote + push of the run branch): contents:write
 * - pull_request (find / create / update the run's PR): pull_requests:write,
 *   plus contents:write as the W10a brief requires for PR creation.
 *
 * GitHub always adds metadata:read to an installation token; it is tolerated
 * in the response and nothing else is. `workflows` is never requested, so a
 * run cannot push changes to `.github/workflows/*`.
 */
export const EFFECT_PERMISSIONS: Readonly<Record<GitCredentialEffect, InstallationPermissions>> = {
  fetch: { contents: 'read' },
  push: { contents: 'write' },
  pull_request: { contents: 'write', pull_requests: 'write' },
};

/** Permissions the App installation must hold for every effect to be brokered. */
export const REQUIRED_INSTALLATION_PERMISSIONS: InstallationPermissions = { contents: 'write', pull_requests: 'write' };

/** GitHub's own limit for installation access tokens. */
export const INSTALLATION_TOKEN_MAX_TTL_MS = 60 * 60 * 1000;
/** App JWTs: GitHub accepts at most 10 minutes; issue for 9 with a 60 s backdate for clock drift. */
export const APP_JWT_TTL_SECONDS = 9 * 60;
export const APP_JWT_BACKDATE_SECONDS = 60;

const INSTALLED_CACHE_TTL_MS = 5 * 60 * 1000;
const NOT_INSTALLED_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export type GitHubAppErrorKind = 'unavailable' | 'rejected' | 'permissions' | 'scope_violation';

/** A GitHub App call failed. Never carries a token in its message or details. */
export class GitHubAppError extends Error {
  constructor(readonly kind: GitHubAppErrorKind, message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

export function isGitHubAppError(error: unknown): error is GitHubAppError {
  return error instanceof GitHubAppError;
}

export interface RepositoryRef {
  fullName: string;
  /** GitHub's numeric repository id, when known (binds the token to the exact repository, not a re-created namesake). */
  githubRepoId?: number | null;
}

export interface InstallationInfo {
  id: number;
  accountLogin: string | null;
  accountType: string | null;
  suspended: boolean;
  repositorySelection: string | null;
  permissions: InstallationPermissions;
}

export type InstallationLookup = { status: 'installed'; installation: InstallationInfo } | { status: 'not_installed' };

export interface MintedInstallationToken {
  token: string;
  expiresAt: Date;
  permissions: InstallationPermissions;
  repositoryFullName: string;
  repositoryId: number | null;
}

export type RevocationResult = 'revoked' | 'already_invalid' | 'failed';

export function splitRepositoryFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubAppError('rejected', 'Invalid repository identity');
  }
  return { owner, repo };
}

export function hashInstallationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** RS256 App JWT: `iat` backdated 60 s, `exp` 9 min ahead, `iss` the App ID. */
export function signAppJwt(config: Pick<GitHubAppConfig, 'appId' | 'privateKey'>, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({ iat: now - APP_JWT_BACKDATE_SECONDS, exp: now + APP_JWT_TTL_SECONDS, iss: config.appId });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), config.privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const permissionsSchema = z.record(z.string());

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string(), type: z.string() }).nullable().optional(),
  suspended_at: z.string().nullable().optional(),
  repository_selection: z.string().optional(),
  permissions: permissionsSchema.optional(),
});

const tokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  permissions: permissionsSchema.optional(),
  repositories: z.array(z.object({ id: z.number().int(), full_name: z.string() })).optional(),
});

const appSchema = z.object({ slug: z.string().nullable().optional() });

function normalizePermissions(raw: Record<string, string> | undefined): InstallationPermissions {
  const out: Record<string, PermissionLevel> = {};
  for (const [name, level] of Object.entries(raw ?? {})) {
    // `admin` only exists for a few administration permissions; rank it as write.
    out[name] = level === 'read' ? 'read' : 'write';
  }
  return out;
}

function rank(level: string | undefined): number {
  if (level === 'read') return 1;
  if (level === 'write' || level === 'admin') return 2;
  return 0;
}

/** Permissions in `required` that `held` does not cover. */
export function missingPermissions(held: InstallationPermissions, required: InstallationPermissions): string[] {
  return Object.entries(required)
    .filter(([name, level]) => rank(held[name]) < rank(level))
    .map(([name, level]) => `${name}:${level}`);
}

/** Granted permissions beyond the request (metadata:read is always added by GitHub). */
export function excessPermissions(granted: Readonly<Record<string, string>>, requested: InstallationPermissions): string[] {
  return Object.entries(granted)
    .filter(([name, level]) => !(name === 'metadata' && level === 'read') && rank(level) > rank(requested[name]))
    .map(([name, level]) => `${name}:${level}`);
}

interface CacheEntry {
  value: InstallationLookup;
  expiresAt: number;
}

const installationCache = new Map<string, CacheEntry>();
let jwtCache: { key: string; jwt: string; refreshAt: number } | null = null;
const slugCache = new Map<string, string | null>();

/** Tests and key rotation: forget cached JWTs, installations and slugs. */
export function clearGitHubAppCaches(): void {
  installationCache.clear();
  slugCache.clear();
  jwtCache = null;
}

export interface GitHubAppClientOptions {
  now?: () => number;
}

export class GitHubAppClient {
  private readonly now: () => number;

  constructor(private readonly config: GitHubAppConfig, options: GitHubAppClientOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** A cached App JWT, re-signed a minute before it expires. */
  appJwt(): string {
    const key = `${this.config.apiBaseUrl}|${this.config.appId}`;
    const now = this.now();
    if (jwtCache && jwtCache.key === key && jwtCache.refreshAt > now) return jwtCache.jwt;
    const jwt = signAppJwt(this.config, now);
    jwtCache = { key, jwt, refreshAt: now + (APP_JWT_TTL_SECONDS - 60) * 1000 };
    return jwt;
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    bearer: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'User-Agent': 'openlinear-api',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GitHubAppError('unavailable', `GitHub App request failed (${method} ${path.split('?')[0]})`);
    }
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  private cacheKey(fullName: string): string {
    return `${this.config.apiBaseUrl}|${this.config.appId}|${fullName.toLowerCase()}`;
  }

  /** The App's installation that covers `fullName`, cached briefly (5 min installed, 1 min not installed). */
  async findRepositoryInstallation(fullName: string): Promise<InstallationLookup> {
    const { owner, repo } = splitRepositoryFullName(fullName);
    const key = this.cacheKey(fullName);
    const hit = installationCache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const res = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, this.appJwt());
    let value: InstallationLookup;
    if (res.status === 404) {
      value = { status: 'not_installed' };
    } else if (res.status === 200) {
      const parsed = installationSchema.safeParse(res.json);
      if (!parsed.success) throw new GitHubAppError('unavailable', 'Unexpected installation response from GitHub', res.status);
      value = {
        status: 'installed',
        installation: {
          id: parsed.data.id,
          accountLogin: parsed.data.account?.login ?? null,
          accountType: parsed.data.account?.type ?? null,
          suspended: Boolean(parsed.data.suspended_at),
          repositorySelection: parsed.data.repository_selection ?? null,
          permissions: normalizePermissions(parsed.data.permissions),
        },
      };
    } else if (res.status === 401 || res.status === 403) {
      // The App JWT was refused: wrong App ID, wrong or rolled-out key, clock skew.
      throw new GitHubAppError('rejected', `GitHub refused the App credentials (HTTP ${res.status})`, res.status);
    } else {
      throw new GitHubAppError('unavailable', `GitHub installation lookup failed (HTTP ${res.status})`, res.status);
    }
    if (installationCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = installationCache.keys().next().value;
      if (oldest !== undefined) installationCache.delete(oldest);
    }
    installationCache.set(key, {
      value,
      expiresAt: this.now() + (value.status === 'installed' ? INSTALLED_CACHE_TTL_MS : NOT_INSTALLED_CACHE_TTL_MS),
    });
    return value;
  }

  /** Drop a cached lookup (e.g. the installation disappeared between lookup and mint). */
  forgetInstallation(fullName: string): void {
    installationCache.delete(this.cacheKey(fullName));
  }

  /**
   * Mint an installation token for exactly one repository and exactly the
   * requested permissions. The response is verified: a token that covers more
   * repositories, other repositories or more permissions than requested, or
   * that lives longer than GitHub's one-hour limit, is revoked and refused.
   */
  async mintInstallationToken(input: {
    installationId: number;
    repository: RepositoryRef;
    permissions: InstallationPermissions;
  }): Promise<MintedInstallationToken> {
    const { repo } = splitRepositoryFullName(input.repository.fullName);
    const repoId = input.repository.githubRepoId && input.repository.githubRepoId > 0 ? input.repository.githubRepoId : null;
    const body = {
      ...(repoId ? { repository_ids: [repoId] } : { repositories: [repo] }),
      permissions: { ...input.permissions },
    };
    const res = await this.request('POST', `/app/installations/${input.installationId}/access_tokens`, this.appJwt(), body);
    if (res.status === 422) {
      // The installation does not grant a requested permission, or the
      // repository is outside its selection.
      throw new GitHubAppError('permissions', 'The GitHub App installation cannot grant the requested repository permissions', res.status);
    }
    if (res.status === 404) {
      throw new GitHubAppError('permissions', 'The GitHub App installation no longer exists', res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubAppError('rejected', `GitHub refused the App credentials (HTTP ${res.status})`, res.status);
    }
    if (res.status !== 201 && res.status !== 200) {
      throw new GitHubAppError('unavailable', `GitHub token minting failed (HTTP ${res.status})`, res.status);
    }
    const parsed = tokenSchema.safeParse(res.json);
    if (!parsed.success || !TOKEN_PATTERN.test(parsed.data.token)) {
      throw new GitHubAppError('unavailable', 'Unexpected token response from GitHub', res.status);
    }
    const token = parsed.data.token;
    const refuse = async (reason: string): Promise<never> => {
      await this.revokeInstallationToken(token);
      throw new GitHubAppError('scope_violation', `GitHub issued a token broader than requested (${reason}); it was revoked`);
    };
    const excess = excessPermissions(parsed.data.permissions ?? {}, input.permissions);
    if (excess.length > 0) return refuse(`permissions ${excess.join(', ')}`);
    const missing = missingPermissions(normalizePermissions(parsed.data.permissions), input.permissions);
    if (missing.length > 0) {
      await this.revokeInstallationToken(token);
      throw new GitHubAppError('permissions', `The GitHub App installation granted less than requested (${missing.join(', ')})`);
    }
    const repositories = parsed.data.repositories ?? [];
    const only = repositories[0];
    if (repositories.length !== 1 || !only || only.full_name.toLowerCase() !== input.repository.fullName.toLowerCase()
      || (repoId !== null && only.id !== repoId)) {
      return refuse('repository restriction');
    }
    const expiresAt = new Date(parsed.data.expires_at);
    const now = this.now();
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now
      || expiresAt.getTime() > now + INSTALLATION_TOKEN_MAX_TTL_MS + EXPIRY_SKEW_MS) {
      return refuse('expiry');
    }
    return {
      token,
      expiresAt,
      permissions: normalizePermissions(parsed.data.permissions),
      repositoryFullName: only.full_name,
      repositoryId: only.id,
    };
  }

  /** `DELETE /installation/token`, authenticated by the token itself. */
  async revokeInstallationToken(token: string): Promise<RevocationResult> {
    try {
      const res = await this.request('DELETE', '/installation/token', token, undefined, REVOKE_TIMEOUT_MS);
      if (res.status === 204) return 'revoked';
      if (res.status === 401) return 'already_invalid';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  /** The App's URL name: GITHUB_APP_SLUG, else `GET /app` (cached). */
  async appSlug(): Promise<string | null> {
    if (this.config.slug) return this.config.slug;
    const key = `${this.config.apiBaseUrl}|${this.config.appId}`;
    if (slugCache.has(key)) return slugCache.get(key) ?? null;
    const res = await this.request('GET', '/app', this.appJwt());
    if (res.status === 401 || res.status === 403) {
      throw new GitHubAppError('rejected', `GitHub refused the App credentials (HTTP ${res.status})`, res.status);
    }
    if (res.status !== 200) throw new GitHubAppError('unavailable', `GitHub App lookup failed (HTTP ${res.status})`, res.status);
    const parsed = appSchema.safeParse(res.json);
    const slug = parsed.success ? parsed.data.slug ?? null : null;
    slugCache.set(key, slug);
    return slug;
  }

  installUrl(slug: string): string {
    return `${this.config.webBaseUrl}/apps/${encodeURIComponent(slug)}/installations/new`;
  }

  manageUrl(installation: InstallationInfo): string {
    if (installation.accountType === 'Organization' && installation.accountLogin) {
      return `${this.config.webBaseUrl}/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.id}`;
    }
    return `${this.config.webBaseUrl}/settings/installations/${installation.id}`;
  }
}
