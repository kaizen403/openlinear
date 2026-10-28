import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { hashToken, type SessionDb } from './sessions';

/**
 * One-time codes that hand a finished GitHub sign-in to the desktop app.
 *
 * Properties (see `schemas/auth.ts` for the wire contract):
 * - **No token in a URL.** The deep link carries only this code; tokens are
 *   returned in the body of POST /api/auth/desktop/token.
 * - **Bound to the app instance.** Each code stores the PKCE S256 challenge
 *   from POST /api/auth/desktop/authorize. Redemption must present the
 *   matching verifier, which never leaves the app, so another program that
 *   receives the deep link (custom schemes can be claimed by any local app)
 *   cannot redeem it.
 * - **Short-lived and single use.** Redemption is one conditional UPDATE
 *   (`consumedAt IS NULL AND expiresAt > now AND codeChallenge = S256(verifier)`),
 *   so concurrent or replayed redemptions cannot both succeed.
 * - **Only the SHA-256 of the code is stored.**
 *
 * A wrong verifier does not consume the code: only the holder of the verifier
 * can spend it, so an interceptor cannot burn the legitimate app's sign-in.
 */

export const DESKTOP_AUTH_CODE_TTL_MS = 2 * 60 * 1000;

/** Expired rows are kept this long (for investigation), then swept. */
const DESKTOP_AUTH_CODE_RETENTION_MS = 60 * 60 * 1000;

/** RFC 7636 S256: base64url(SHA-256(ASCII(code_verifier))), no padding. */
export function computeS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

export interface IssuedDesktopAuthCode {
  code: string;
  expiresAt: Date;
}

export async function issueDesktopAuthCode(
  input: { userId: string; codeChallenge: string },
  now: Date = new Date(),
): Promise<IssuedDesktopAuthCode> {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_CODE_TTL_MS);

  await prisma.desktopAuthCode.create({
    data: {
      userId: input.userId,
      codeHash: hashToken(code),
      codeChallenge: input.codeChallenge,
      expiresAt,
    },
  });

  // Bounded retention, best effort: a failed sweep must not fail a sign-in.
  await prisma.desktopAuthCode
    .deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - DESKTOP_AUTH_CODE_RETENTION_MS) } },
    })
    .catch(() => undefined);

  return { code, expiresAt };
}

/**
 * Atomically consume a code. Returns the user it was issued to, or `null` when
 * the code is unknown, expired, already used, or the verifier does not match.
 * The caller learns nothing about which of those applied.
 *
 * Run it inside the transaction that mints the session: if minting fails the
 * consumption rolls back and the app can retry within the code's lifetime.
 */
export async function redeemDesktopAuthCode(
  db: SessionDb,
  input: { code: string; codeVerifier: string },
  now: Date = new Date(),
): Promise<{ userId: string } | null> {
  const codeHash = hashToken(input.code);
  const consumed = await db.desktopAuthCode.updateMany({
    where: {
      codeHash,
      codeChallenge: computeS256Challenge(input.codeVerifier),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return null;

  const row = await db.desktopAuthCode.findUnique({
    where: { codeHash },
    select: { userId: true },
  });
  return row ? { userId: row.userId } : null;
}
