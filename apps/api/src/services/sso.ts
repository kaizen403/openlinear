import crypto from 'node:crypto';
import * as client from 'openid-client';
import { decryptToken, encryptToken, isEncryptedToken, prisma } from '@openlinear/db';
import { getJwtSecret } from '../lib/secrets';
import { logger } from '../logger';

// --- Encryption helpers (AES-256-GCM, key derived from JWT_SECRET) ---

function getDerivedKey(): Buffer {
  const secret = getJwtSecret();
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(ciphertext: string): string {
  const key = getDerivedKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// --- SSO Configuration CRUD ---

export interface SSOConfigInput {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  enforced?: boolean;
}

export async function configureSSOForWorkspace(workspaceId: string, input: SSOConfigInput) {
  const clientSecretEncrypted = encryptSecret(input.clientSecret);
  const verificationToken = crypto.randomBytes(24).toString('hex');
  const existing = await prisma.sSOConfig.findUnique({ where: { workspaceId } });
  const domainsChanged = existing
    ? JSON.stringify([...existing.allowedDomains].sort()) !== JSON.stringify([...input.allowedDomains].sort())
    : true;

  return prisma.sSOConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      provider: 'oidc',
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEncrypted,
      allowedDomains: input.allowedDomains,
      enforced: input.enforced ?? false,
      verificationToken,
      domainVerifiedAt: null,
    },
    update: {
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEncrypted,
      allowedDomains: input.allowedDomains,
      enforced: input.enforced ?? false,
      ...(domainsChanged
        ? { verificationToken, domainVerifiedAt: null }
        : {}),
    },
  });
}

export async function getSSOConfigForWorkspace(workspaceId: string) {
  const config = await prisma.sSOConfig.findUnique({ where: { workspaceId } });
  if (!config) return null;
  // Mask the secret
  return {
    ...config,
    clientSecretEncrypted: undefined,
    clientSecretMasked: '••••••••',
  };
}

export async function deleteSSOConfigForWorkspace(workspaceId: string) {
  return prisma.sSOConfig.delete({ where: { workspaceId } });
}

export async function getSSOConfigByDomain(emailDomain: string) {
  return prisma.sSOConfig.findFirst({
    where: {
      allowedDomains: { has: emailDomain },
      domainVerifiedAt: { not: null },
    },
  });
}

export function ssoTxtRecord(token: string): string {
  return `openlinear-sso=${token}`;
}

function dnsVerificationSkipped(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  // Never in production: the bypass would let any owner claim any domain.
  return process.env.OPENLINEAR_SSO_SKIP_DNS === '1' && process.env.NODE_ENV !== 'production';
}

/**
 * Domain ownership check for SSO. Every allowed domain must publish the TXT
 * record: one verified domain used to mark the whole configuration (all its
 * domains) as verified.
 */
export async function verifyWorkspaceDomain(workspaceId: string): Promise<{ verified: boolean; record: string }> {
  const config = await prisma.sSOConfig.findUnique({ where: { workspaceId } });
  if (!config?.verificationToken || config.allowedDomains.length === 0) {
    return { verified: false, record: '' };
  }
  const record = ssoTxtRecord(config.verificationToken);
  if (dnsVerificationSkipped()) {
    await prisma.sSOConfig.update({
      where: { workspaceId },
      data: { domainVerifiedAt: new Date() },
    });
    return { verified: true, record };
  }

  const { resolveTxt } = await import('node:dns/promises');
  for (const domain of config.allowedDomains) {
    try {
      const chunks = await resolveTxt(domain);
      const values = chunks.map((row) => row.join(''));
      if (!values.includes(record)) return { verified: false, record };
    } catch {
      return { verified: false, record };
    }
  }
  await prisma.sSOConfig.update({
    where: { workspaceId },
    data: { domainVerifiedAt: new Date() },
  });
  return { verified: true, record };
}

// --- Login state (W02b) ---
//
// The previous implementation put `{ workspaceId, codeVerifier, nonce, ts }`
// into the OAuth `state` as base64url JSON plus an HMAC: signed, not
// encrypted. The PKCE verifier therefore travelled in the authorization URL
// and the redirect back (defeating PKCE: anyone who saw the URL also had the
// verifier), the state was not bound to the browser that started the flow,
// and it could be replayed for ten minutes.
//
// Now the browser carries only an opaque random `state`. The verifier
// (encrypted at rest), the nonce, the workspace and the redirect URI are
// stored server-side, keyed by the state's hash; the row is single-use and
// expires after ten minutes. Starting a flow also sets an HttpOnly,
// SameSite=Lax cookie with a random binding secret whose hash is stored on
// the row: the callback is honoured only in the browser that started it.

export const SSO_STATE_TTL_MS = 10 * 60 * 1000;
/** Cookie carrying the browser-binding secret of an SSO flow in progress. */
export const SSO_BINDING_COOKIE = 'ol_sso_binding';
/** Cookie path: sent to `/api/auth/sso/*` only. */
export const SSO_BINDING_COOKIE_PATH = '/api/auth/sso';
const SSO_STATE_RETENTION_MS = 60 * 60 * 1000;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export interface SsoConfigForLogin {
  id: string;
  workspaceId: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
}

export interface StartedSsoLogin {
  authUrl: string;
  /** Value for the HttpOnly binding cookie. Never put it in a URL. */
  bindingSecret: string;
  expiresAt: Date;
}

export async function startSsoLogin(config: SsoConfigForLogin, redirectUri: string): Promise<StartedSsoLogin> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const nonce = client.randomNonce();
  const state = crypto.randomBytes(32).toString('base64url');
  const bindingSecret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SSO_STATE_TTL_MS);

  // Discovery first: no row is written for a provider that cannot be reached.
  const authUrl = await buildOIDCAuthUrl(config, state, redirectUri, { codeChallenge, nonce });

  await prisma.ssoAuthState.create({
    data: {
      stateHash: sha256Hex(state),
      browserBindingHash: sha256Hex(bindingSecret),
      workspaceId: config.workspaceId,
      ssoConfigId: config.id,
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      codeVerifierEncrypted: encryptToken(codeVerifier),
      nonce,
      redirectUri,
      expiresAt,
    },
  });

  void prisma.ssoAuthState
    .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - SSO_STATE_RETENTION_MS) } } })
    .catch((err: unknown) => {
      logger.warn({ err }, '[sso] failed to prune expired login states');
    });

  return { authUrl, bindingSecret, expiresAt };
}

export type SsoStateRejection = 'missing' | 'unknown' | 'replayed' | 'expired' | 'browser-mismatch';

export interface SsoLoginState {
  workspaceId: string;
  ssoConfigId: string;
  issuerUrl: string;
  clientId: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export type ConsumedSsoState =
  | { ok: true; login: SsoLoginState }
  | { ok: false; reason: SsoStateRejection };

/**
 * Claim an SSO login state exactly once, from the browser that started it.
 *
 * A foreign browser (no or another binding cookie) is refused without
 * consuming the state, so observing a callback URL is not enough to burn or
 * use someone else's login. Of concurrent callbacks with the right cookie,
 * exactly one claims the row (conditional UPDATE).
 */
export async function consumeSsoState(
  state: string | undefined,
  bindingSecret: string | undefined,
): Promise<ConsumedSsoState> {
  if (!state) return { ok: false, reason: 'missing' };
  const row = await prisma.ssoAuthState.findUnique({ where: { stateHash: sha256Hex(state) } });
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumedAt) return { ok: false, reason: 'replayed' };
  const now = new Date();
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (!bindingSecret || !hashesEqual(sha256Hex(bindingSecret), row.browserBindingHash)) {
    return { ok: false, reason: 'browser-mismatch' };
  }

  const claimed = await prisma.ssoAuthState.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'replayed' };

  // Refuse anything that is not our ciphertext (no plaintext fallback).
  if (!isEncryptedToken(row.codeVerifierEncrypted)) return { ok: false, reason: 'unknown' };
  const codeVerifier = decryptToken(row.codeVerifierEncrypted);
  if (!codeVerifier) return { ok: false, reason: 'unknown' };

  return {
    ok: true,
    login: {
      workspaceId: row.workspaceId,
      ssoConfigId: row.ssoConfigId,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      codeVerifier,
      nonce: row.nonce,
      redirectUri: row.redirectUri,
    },
  };
}

// --- OIDC Flow ---

export async function buildOIDCAuthUrl(
  config: { issuerUrl: string; clientId: string; clientSecretEncrypted: string },
  state: string,
  redirectUri: string,
  extras: { codeChallenge: string; nonce: string },
): Promise<string> {
  const issuerUrl = new URL(config.issuerUrl);
  const serverConfig = await client.discovery(issuerUrl, config.clientId, decryptSecret(config.clientSecretEncrypted));
  const authUrl = client.buildAuthorizationUrl(serverConfig, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
    nonce: extras.nonce,
    code_challenge: extras.codeChallenge,
    code_challenge_method: 'S256',
  });
  return authUrl.href;
}

export interface OIDCUserInfo {
  email: string;
  name: string;
  sub: string;
  issuer: string;
}

export async function handleOIDCCallback(
  config: { issuerUrl: string; clientId: string; clientSecretEncrypted: string },
  currentUrl: URL,
  checks: { expectedState: string; expectedNonce: string; pkceCodeVerifier: string },
): Promise<OIDCUserInfo> {
  const issuerUrl = new URL(config.issuerUrl);
  const clientSecret = decryptSecret(config.clientSecretEncrypted);
  const serverConfig = await client.discovery(issuerUrl, config.clientId, clientSecret);

  const tokens = await client.authorizationCodeGrant(serverConfig, currentUrl, {
    pkceCodeVerifier: checks.pkceCodeVerifier,
    expectedNonce: checks.expectedNonce,
    expectedState: checks.expectedState,
  });

  const claims = tokens.claims();
  let email = (claims?.email as string) || '';
  let name = (claims?.name as string) || (claims?.preferred_username as string) || '';
  let sub = (claims?.sub as string) || '';

  if (!email || !sub) {
    const userinfo = await client.fetchUserInfo(serverConfig, tokens.access_token!, claims?.sub as string);
    email = email || (userinfo.email as string) || '';
    name = name || (userinfo.name as string) || '';
    sub = sub || (userinfo.sub as string) || '';
  }

  return { email, name: name || email.split('@')[0] || 'user', sub, issuer: config.issuerUrl };
}

export async function provisionSSOUser(input: {
  issuer: string;
  subject: string;
  email: string;
  name: string;
  workspaceId: string;
}) {
  const existingIdentity = await prisma.identity.findUnique({
    where: { issuer_subject: { issuer: input.issuer, subject: input.subject } },
    include: { user: true },
  });

  let user = existingIdentity?.user ?? null;
  if (!user) {
    user = await prisma.user.create({
      data: {
        displayName: input.name,
        username: `${(input.email.split('@')[0] || 'user').slice(0, 24)}-${crypto.randomBytes(3).toString('hex')}`,
        identities: {
          create: {
            provider: 'oidc',
            issuer: input.issuer,
            subject: input.subject,
            email: input.email,
          },
        },
      },
    });
  }

  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
  });
  if (!existing) {
    await prisma.workspaceMember.create({
      data: { workspaceId: input.workspaceId, userId: user.id, role: 'member', joinedAt: new Date() },
    });
  }

  return user;
}
