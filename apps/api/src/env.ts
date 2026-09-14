const REQUIRED_PRODUCTION_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
] as const;

// GitHub OAuth client credentials are not required: the leaked apps were
// removed and `/api/auth/github` stays 503 until replacement apps exist.

export function validateStartupEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OPENLINEAR_TRUST_PROXY_AUTH !== undefined) {
    throw new Error(
      '[API] OPENLINEAR_TRUST_PROXY_AUTH is no longer supported — remove it from your environment',
    );
  }

  if (env.NODE_ENV !== 'production') {
    return;
  }

  const missing = REQUIRED_PRODUCTION_ENV.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `[API] Missing required production environment variables: ${missing.join(', ')}`,
    );
  }
}
