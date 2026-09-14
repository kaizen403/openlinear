/**
 * Throwaway secrets for the test suite.
 *
 * These are applied unconditionally, overriding anything dotenv loaded from the
 * repository `.env` — which currently contains the published placeholder
 * `openlinear-dev-secret-change-in-production` and a real token-encryption key.
 * Tests must never sign with, or encrypt under, a value that also exists in a
 * real environment.
 */

export const TEST_JWT_SECRET =
  'test-jwt-secret-do-not-use-outside-tests-0123456789abcdef';

export const TEST_TOKEN_ENCRYPTION_KEY =
  'test-token-encryption-key-do-not-use-outside-tests-0123456789';

export function applyTestEnv(): void {
  process.env.JWT_SECRET = process.env.TEST_JWT_SECRET ?? TEST_JWT_SECRET;
  process.env.TOKEN_ENCRYPTION_KEY =
    process.env.TEST_TOKEN_ENCRYPTION_KEY ?? TEST_TOKEN_ENCRYPTION_KEY;

  // Tokens minted directly by tests have no `Session` row, and session
  // revocation now fails closed. Tests that exercise revocation override this.
  process.env.OPENLINEAR_ALLOW_SESSIONLESS_JWT ??= '1';
}

/** The secret tests should sign with. Always read this, never a literal. */
export function testJwtSecret(): string {
  return process.env.JWT_SECRET ?? TEST_JWT_SECRET;
}
