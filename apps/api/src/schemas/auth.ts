import { z } from 'zod';

/**
 * Desktop sign-in contract (RFC 8252 native-app flow with RFC 7636 PKCE).
 *
 * 1. The app generates a `code_verifier` and a `state`, then calls
 *    POST /api/auth/desktop/authorize with the S256 challenge and the state.
 *    The API returns the GitHub authorize URL; the app opens it in the
 *    system browser.
 * 2. The API finishes OAuth and redirects to
 *    `openlinear://callback?code=<one-time code>&state=<state>` — never a token.
 * 3. The app checks `state`, then calls POST /api/auth/desktop/token with the
 *    code and its verifier and receives tokens in the response body.
 */

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** base64url(SHA-256(verifier)) without padding is exactly 43 characters. */
export const PKCE_S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Opaque client correlation value, echoed back on the deep link. */
export const DESKTOP_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The one-time code is 32 random bytes, base64url-encoded (43 characters). */
export const DESKTOP_AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const desktopAuthorizeBodySchema = z.object({
  codeChallenge: z
    .string()
    .regex(PKCE_S256_CHALLENGE_PATTERN, 'must be a base64url SHA-256 digest (43 characters)'),
  codeChallengeMethod: z.literal('S256'),
  state: z
    .string()
    .regex(DESKTOP_STATE_PATTERN, 'must be 16-128 base64url characters'),
});

export type DesktopAuthorizeBody = z.infer<typeof desktopAuthorizeBodySchema>;

export const desktopTokenBodySchema = z.object({
  code: z.string().regex(DESKTOP_AUTH_CODE_PATTERN, 'is not a desktop sign-in code'),
  codeVerifier: z
    .string()
    .regex(PKCE_VERIFIER_PATTERN, 'must be 43-128 characters of A-Z a-z 0-9 - . _ ~'),
});

export type DesktopTokenBody = z.infer<typeof desktopTokenBodySchema>;
