import { describe, expect, it } from 'vitest';
import { validateStartupEnv } from '../env';

describe('validateStartupEnv', () => {
  it('does not require production env in development', () => {
    expect(() => validateStartupEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('throws in production when required env vars are missing', () => {
    expect(() => validateStartupEnv({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL, JWT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('accepts complete production env', () => {
    expect(() =>
      validateStartupEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/openlinear',
        JWT_SECRET: 'secret',
        GITHUB_CLIENT_ID: 'client-id',
        GITHUB_CLIENT_SECRET: 'client-secret',
        TOKEN_ENCRYPTION_KEY: 'token-encryption-key-must-be-long-enough',
      }),
    ).not.toThrow();
  });

  it('refuses the removed OPENLINEAR_TRUST_PROXY_AUTH flag in any env', () => {
    expect(() =>
      validateStartupEnv({ NODE_ENV: 'development', OPENLINEAR_TRUST_PROXY_AUTH: '0' }),
    ).toThrow(/OPENLINEAR_TRUST_PROXY_AUTH is no longer supported/);
    expect(() =>
      validateStartupEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'x',
        JWT_SECRET: 'x',
        GITHUB_CLIENT_ID: 'x',
        GITHUB_CLIENT_SECRET: 'x',
        TOKEN_ENCRYPTION_KEY: 'x',
        OPENLINEAR_TRUST_PROXY_AUTH: '1',
      }),
    ).toThrow(/OPENLINEAR_TRUST_PROXY_AUTH is no longer supported/);
  });
});
