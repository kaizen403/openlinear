import crypto from 'node:crypto';
import * as client from 'openid-client';
import { prisma } from '@openlinear/db';
import { getJwtSecret } from '../lib/secrets';

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

export async function verifyWorkspaceDomain(workspaceId: string): Promise<{ verified: boolean; record: string }> {
  const config = await prisma.sSOConfig.findUnique({ where: { workspaceId } });
  if (!config?.verificationToken || config.allowedDomains.length === 0) {
    return { verified: false, record: '' };
  }
  const record = ssoTxtRecord(config.verificationToken);
  if (process.env.OPENLINEAR_SSO_SKIP_DNS === '1' || process.env.NODE_ENV === 'test') {
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
      if (values.includes(record)) {
        await prisma.sSOConfig.update({
          where: { workspaceId },
          data: { domainVerifiedAt: new Date() },
        });
        return { verified: true, record };
      }
    } catch {
      // try next domain
    }
  }
  return { verified: false, record };
}

export interface SsoStatePayload {
  workspaceId: string;
  codeVerifier: string;
  nonce: string;
  ts: number;
}

export function signSsoState(payload: SsoStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySsoState(state: string): SsoStatePayload | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getJwtSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SsoStatePayload;
    if (!payload.workspaceId || !payload.codeVerifier || !payload.nonce || !payload.ts) return null;
    if (Date.now() - payload.ts > 10 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
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

