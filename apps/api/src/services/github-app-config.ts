import { createPrivateKey, type KeyObject } from 'node:crypto';

/**
 * W10a: GitHub App configuration (optional).
 *
 * When `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set, the execution
 * control plane brokers short-lived, single-repository installation tokens
 * for sidecar git operations instead of the initiating user's OAuth token
 * (services/github-app-credentials.ts). Nothing is required: without the App
 * the previous behaviour applies, subject to the fallback policy below.
 *
 * Validated at boot (`validateStartupEnv`): a half-configured App, a key that
 * is not a >= 2048-bit RSA private key, or an unknown fallback policy is a
 * startup failure rather than a silent downgrade at the first run. Error
 * messages never include key material.
 *
 * Variables:
 *   GITHUB_APP_ID                  numeric App ID (or the App's client ID, `Iv…`)
 *   GITHUB_APP_PRIVATE_KEY         PEM (PKCS#1 or PKCS#8). Literal `\n`
 *                                  escapes and a base64-encoded PEM are accepted.
 *   GITHUB_APP_SLUG                optional; the App's URL name for install links
 *                                  (otherwise looked up with `GET /app`)
 *   GITHUB_APP_WEBHOOK_SECRET      optional; >= 32 characters when set (reserved
 *                                  for the installation webhook, not yet routed)
 *   OPENLINEAR_GIT_CREDENTIAL_FALLBACK
 *                                  `user_oauth` (default) | `deny`: what to do when
 *                                  the App is not configured or not installed on
 *                                  the attempt's repository.
 *   OPENLINEAR_GITHUB_API_URL      tests only: an http loopback GitHub stub,
 *                                  honoured only when NODE_ENV=test.
 */

export const GIT_CREDENTIAL_FALLBACK_POLICIES = ['user_oauth', 'deny'] as const;
export type GitCredentialFallbackPolicy = (typeof GIT_CREDENTIAL_FALLBACK_POLICIES)[number];

/** Owner decision (W10a): allow the user-OAuth fallback until the App is rolled out. */
export const DEFAULT_GIT_CREDENTIAL_FALLBACK: GitCredentialFallbackPolicy = 'user_oauth';

export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_WEB_BASE_URL = 'https://github.com';

const MIN_RSA_BITS = 2048;
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const APP_ID_PATTERN = /^(?:[1-9][0-9]{0,19}|Iv[0-9A-Za-z.]{4,64})$/;
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export interface GitHubAppConfig {
  /** JWT `iss`: the numeric App ID or the client ID. */
  appId: string;
  privateKey: KeyObject;
  slug: string | null;
  webhookSecretConfigured: boolean;
  apiBaseUrl: string;
  webBaseUrl: string;
}

export class GitHubAppConfigError extends Error {
  constructor(message: string) {
    super(`[config] ${message}`);
    this.name = 'GitHubAppConfigError';
  }
}

/** Accepts a PEM with real newlines, with literal `\n` escapes, or base64 of a PEM. */
export function normalizePrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  if (decoded.includes('-----BEGIN')) return decoded.trim();
  throw new GitHubAppConfigError('GITHUB_APP_PRIVATE_KEY is not a PEM private key (nor base64 of one)');
}

function parsePrivateKey(raw: string): KeyObject {
  const pem = normalizePrivateKeyPem(raw);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new GitHubAppConfigError('GITHUB_APP_PRIVATE_KEY could not be parsed as a private key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubAppConfigError('GITHUB_APP_PRIVATE_KEY must be an RSA private key (GitHub signs App JWTs with RS256)');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new GitHubAppConfigError(`GITHUB_APP_PRIVATE_KEY must be at least ${MIN_RSA_BITS} bits (got ${bits})`);
  }
  return key;
}

/** Loopback GitHub stub for tests; production always talks to api.github.com. */
export function resolveGitHubApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENLINEAR_GITHUB_API_URL?.trim();
  if (override && env.NODE_ENV === 'test') {
    try {
      const url = new URL(override);
      if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
        return override.replace(/\/+$/, '');
      }
    } catch {
      // fall through to the real API
    }
  }
  return GITHUB_API_BASE_URL;
}

/** Parses and validates the App variables; null when the App is not configured. Throws on misconfiguration. */
export function readGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim() ?? '';
  const rawKey = env.GITHUB_APP_PRIVATE_KEY?.trim() ?? '';
  const slug = env.GITHUB_APP_SLUG?.trim() ?? '';
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim() ?? '';

  if (!appId && !rawKey) {
    if (slug || webhookSecret) {
      throw new GitHubAppConfigError('GITHUB_APP_SLUG / GITHUB_APP_WEBHOOK_SECRET are set but GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not');
    }
    return null;
  }
  if (!appId) throw new GitHubAppConfigError('GITHUB_APP_PRIVATE_KEY is set but GITHUB_APP_ID is not');
  if (!rawKey) throw new GitHubAppConfigError('GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is not');
  if (!APP_ID_PATTERN.test(appId)) {
    throw new GitHubAppConfigError('GITHUB_APP_ID must be the numeric App ID or the App client ID (Iv…)');
  }
  if (slug && !APP_SLUG_PATTERN.test(slug)) {
    throw new GitHubAppConfigError('GITHUB_APP_SLUG must be the App URL name (lowercase letters, digits and dashes)');
  }
  if (webhookSecret && webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new GitHubAppConfigError(`GITHUB_APP_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters when set`);
  }
  return {
    appId,
    privateKey: parsePrivateKey(rawKey),
    slug: slug || null,
    webhookSecretConfigured: Boolean(webhookSecret),
    apiBaseUrl: resolveGitHubApiBaseUrl(env),
    webBaseUrl: GITHUB_WEB_BASE_URL,
  };
}

export function readGitCredentialFallbackPolicy(env: NodeJS.ProcessEnv = process.env): GitCredentialFallbackPolicy {
  const raw = env.OPENLINEAR_GIT_CREDENTIAL_FALLBACK?.trim();
  if (!raw) return DEFAULT_GIT_CREDENTIAL_FALLBACK;
  const found = GIT_CREDENTIAL_FALLBACK_POLICIES.find((policy) => policy === raw);
  if (!found) {
    throw new GitHubAppConfigError(
      `OPENLINEAR_GIT_CREDENTIAL_FALLBACK must be one of ${GIT_CREDENTIAL_FALLBACK_POLICIES.join(', ')}`,
    );
  }
  return found;
}

/** Boot validation: throws GitHubAppConfigError on any misconfiguration. */
export function validateGitHubAppEnv(env: NodeJS.ProcessEnv = process.env): void {
  readGitHubAppConfig(env);
  readGitCredentialFallbackPolicy(env);
}

let cached: { fingerprint: string; config: GitHubAppConfig | null } | null = null;

function fingerprintOf(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    env.GITHUB_APP_ID ?? '',
    env.GITHUB_APP_PRIVATE_KEY ?? '',
    env.GITHUB_APP_SLUG ?? '',
    env.GITHUB_APP_WEBHOOK_SECRET ?? '',
    env.OPENLINEAR_GITHUB_API_URL ?? '',
    env.NODE_ENV ?? '',
  ]);
}

/** The current App configuration (parsed once per distinct environment). */
export function getGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const fingerprint = fingerprintOf(env);
  if (cached?.fingerprint === fingerprint) return cached.config;
  const config = readGitHubAppConfig(env);
  cached = { fingerprint, config };
  return config;
}

export function getGitCredentialFallbackPolicy(env: NodeJS.ProcessEnv = process.env): GitCredentialFallbackPolicy {
  return readGitCredentialFallbackPolicy(env);
}
