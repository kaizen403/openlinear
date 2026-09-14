import { createHash, randomBytes } from 'node:crypto';

/**
 * Single source of truth for process secrets.
 *
 * Before this module existed, `getJwtSecret()` was copy-pasted into five files
 * and every copy fell back to a literal that is published in this repository
 * (`.env.example`, `apps/api/.env.example`) whenever `NODE_ENV !== 'production'`.
 * The packaged desktop build sets neither `JWT_SECRET` nor `NODE_ENV`, so it
 * signed real sessions with a public string — anyone could mint a token for any
 * user offline.
 *
 * The rules here are deliberately strict and have **no environment exemption**:
 * a missing, too-short, or known-published secret is a boot failure everywhere,
 * including local development and tests.
 */

const MIN_SECRET_LENGTH = 32;

/**
 * Values that have appeared in the public repository. These can never be
 * accepted, in any environment, even if someone sets them deliberately.
 */
const PUBLISHED_SECRETS = new Set([
  'openlinear-dev-secret-change-in-production',
  'openlinear-dev-token-encryption-key',
  'change-me',
  'changeme',
  'secret',
]);

export class SecretConfigurationError extends Error {
  constructor(name: string, reason: string) {
    super(
      `[config] ${name} ${reason}.\n` +
        `Generate one with:  openssl rand -base64 48\n` +
        `Then set ${name} in your environment (local: .env, cloud: Key Vault, desktop: the OS keychain).\n` +
        `There is no development fallback: a shared default would be a published credential.`,
    );
    this.name = 'SecretConfigurationError';
  }
}

function readSecret(name: string): string {
  const raw = process.env[name]?.trim();

  if (!raw) {
    throw new SecretConfigurationError(name, 'is not set');
  }
  if (PUBLISHED_SECRETS.has(raw)) {
    throw new SecretConfigurationError(
      name,
      'is set to a placeholder that is published in this repository and must be rotated',
    );
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new SecretConfigurationError(
      name,
      `must be at least ${MIN_SECRET_LENGTH} characters (got ${raw.length})`,
    );
  }
  return raw;
}

/** HMAC/JWT signing secret. Throws unless a strong, non-published value is set. */
export function getJwtSecret(): string {
  return readSecret('JWT_SECRET');
}

/**
 * AES-256-GCM key material for at-rest token encryption.
 * Never falls back to `JWT_SECRET` — reusing one secret for two purposes means a
 * JWT-secret rotation silently destroys every stored GitHub token.
 */
export function getTokenEncryptionKey(): Buffer {
  return createHash('sha256').update(readSecret('TOKEN_ENCRYPTION_KEY'), 'utf8').digest();
}

/** True when every required secret is present and acceptable. Used by readiness checks. */
export function secretsAreConfigured(): boolean {
  try {
    getJwtSecret();
    getTokenEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Convenience for setup scripts and tests that need a valid throwaway secret. */
export function generateSecret(): string {
  return randomBytes(48).toString('base64');
}
