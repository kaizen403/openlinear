import { describe, expect, it } from 'vitest';
import { validateStartupEnv } from '../env';

describe('validateStartupEnv', () => {
  it('does not require production env in development', () => {
    expect(() => validateStartupEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('throws in production when required env vars are missing', () => {
    expect(() => validateStartupEnv({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY/,
    );
  });

  it('accepts complete production env', () => {
    expect(() =>
      validateStartupEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/openlinear',
        JWT_SECRET: 'secret',
        TOKEN_ENCRYPTION_KEY: 'token-encryption-key-must-be-long-enough',
      }),
    ).not.toThrow();
  });

  it('does not require GitHub OAuth client credentials in production', () => {
    expect(() =>
      validateStartupEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/openlinear',
        JWT_SECRET: 'secret',
        TOKEN_ENCRYPTION_KEY: 'token-encryption-key-must-be-long-enough',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
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
        TOKEN_ENCRYPTION_KEY: 'x',
        OPENLINEAR_TRUST_PROXY_AUTH: '1',
      }),
    ).toThrow(/OPENLINEAR_TRUST_PROXY_AUTH is no longer supported/);
  });
});
