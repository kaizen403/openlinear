import * as OTPAuth from 'otpauth';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { decryptToken, prisma } from '@openlinear/db';

const ISSUER = 'OpenLinear';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const PERIOD_SECONDS = 30;

function buildTotp(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function generateTOTPSecret(username: string): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  };
}

export function resolveTotpSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return decryptToken(stored);
}

/**
 * The time step a code belongs to (±1 step of clock drift), or `null` when
 * the code is wrong. Pure; does not consume the code.
 */
export function matchTotpStep(secret: string, token: string, timestamp: number = Date.now()): number | null {
  const totp = buildTotp(secret);
  const delta = totp.validate({ token, timestamp, window: 1 });
  if (delta === null) return null;
  return totp.counter({ timestamp }) + delta;
}

/** Stateless check. Prefer `consumeTotpCode`, which also rejects replays. */
export function verifyTOTP(secret: string, token: string): boolean {
  return matchTotpStep(secret, token) !== null;
}

export type TotpConsumeResult = 'accepted' | 'invalid' | 'replayed';

/**
 * Accept a TOTP code at most once (W02b).
 *
 * A code is valid for its 30 s step plus one step of drift either side, so
 * before this a code observed by someone else (shoulder surfing, phishing
 * relay, logs) could be replayed for up to ~90 s. The highest accepted step
 * is now stored per user and advanced with a conditional UPDATE: a code is
 * accepted only for a step strictly later than the last accepted one. Of N
 * concurrent requests with the same code exactly one is accepted.
 */
export async function consumeTotpCode(
  userId: string,
  secret: string,
  token: string,
  timestamp: number = Date.now(),
): Promise<TotpConsumeResult> {
  const step = matchTotpStep(secret, token, timestamp);
  if (step === null) return 'invalid';
  const claimed = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
    },
    data: { totpLastUsedStep: step },
  });
  return claimed.count === 1 ? 'accepted' : 'replayed';
}

export function generateBackupCodes(): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];

  for (let i = 0; i < 8; i++) {
    const code = randomBytes(4).toString('hex');
    plain.push(code);
    hashed.push(hashBackupCode(code));
  }

  return { plain, hashed };
}

function hashBackupCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code.toLowerCase(), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function scryptMatch(stored: string, code: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(code.toLowerCase(), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function verifyBackupCode(storedHashes: string[], code: string): number {
  const legacy = createHash('sha256').update(code).digest('hex');
  for (let i = 0; i < storedHashes.length; i += 1) {
    const stored = storedHashes[i];
    if (!stored) continue;
    if (stored.startsWith('scrypt:') && scryptMatch(stored, code)) return i;
    if (stored === legacy) return i;
  }
  return -1;
}

/**
 * Spend a backup code exactly once (W02b).
 *
 * Previously the route rewrote the whole `backupCodes` array from the value it
 * had read, so two concurrent logins with the same code both succeeded, and
 * two concurrent logins with *different* codes could each restore the other's
 * code (lost update). The matched hash is now removed in place with
 * `array_remove`, guarded by `= ANY(...)`: only the request that actually
 * removed it may proceed.
 */
export async function consumeBackupCode(
  userId: string,
  storedHashes: string[],
  code: string,
): Promise<boolean> {
  const index = verifyBackupCode(storedHashes, code);
  if (index < 0) return false;
  const hash = storedHashes[index];
  if (!hash) return false;
  const removed = await prisma.$executeRaw`
    UPDATE "users"
    SET "backupCodes" = array_remove("backupCodes", ${hash})
    WHERE "id" = ${userId} AND ${hash} = ANY("backupCodes")
  `;
  return removed === 1;
}
