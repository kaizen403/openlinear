/**
 * Bench credentials. Minted locally against a throwaway secret that is written
 * only to the (0600) fixture manifest outside the repository.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const JWT_ISSUER = 'openlinear';
const JWT_AUDIENCE = 'openlinear-api';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function generateBenchSecret(): string {
  return randomBytes(48).toString('base64');
}

/** HS256 access token with the claims the API requires in production. */
export function mintAccessToken(input: {
  secret: string;
  userId: string;
  username: string;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      userId: input.userId,
      username: input.username,
      typ: 'access',
      iat: now,
      exp: now + input.ttlSeconds,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      jti: randomBytes(16).toString('hex'),
    }),
  );
  const signature = createHmac('sha256', input.secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Same hash the API uses for sessions and PATs. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generatePat(): { token: string; prefix: string } {
  const token = `ol_pat_${randomBytes(16).toString('hex')}`;
  return { token, prefix: token.slice(0, 'ol_pat_'.length + 8) };
}
