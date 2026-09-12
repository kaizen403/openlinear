import * as OTPAuth from 'otpauth';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { decryptToken } from '@openlinear/db';

const ISSUER = 'OpenLinear';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function generateTOTPSecret(username: string): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
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

export function verifyTOTP(secret: string, token: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
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
