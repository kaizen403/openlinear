import crypto from 'node:crypto';
import * as client from 'openid-client';
import { prisma } from '@openlinear/db';

// --- Encryption helpers (AES-256-GCM, key derived from JWT_SECRET) ---

function getDerivedKey(): Buffer {
  const secret = process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';
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
    },
    update: {
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEncrypted,
      allowedDomains: input.allowedDomains,
      enforced: input.enforced ?? false,
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
    where: { allowedDomains: { has: emailDomain } },
  });
}

// --- OIDC Flow ---

export async function buildOIDCAuthUrl(
  config: { issuerUrl: string; clientId: string; clientSecretEncrypted: string },
  state: string,
  redirectUri: string,
): Promise<string> {
  const issuerUrl = new URL(config.issuerUrl);
  const serverConfig = await client.discovery(issuerUrl, config.clientId, decryptSecret(config.clientSecretEncrypted));
  const authUrl = client.buildAuthorizationUrl(serverConfig, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
  });
  return authUrl.href;
}

export interface OIDCUserInfo {
  email: string;
  name: string;
  sub: string;
}

export async function handleOIDCCallback(
  config: { issuerUrl: string; clientId: string; clientSecretEncrypted: string },
  code: string,
  redirectUri: string,
  expectedState: string,
): Promise<OIDCUserInfo> {
  const issuerUrl = new URL(config.issuerUrl);
  const clientSecret = decryptSecret(config.clientSecretEncrypted);
  const serverConfig = await client.discovery(issuerUrl, config.clientId, clientSecret);

  const currentUrl = new URL(`${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(expectedState)}`);
  const tokens = await client.authorizationCodeGrant(serverConfig, currentUrl, {
    expectedState,
  });

  const claims = tokens.claims();
  const email = (claims?.email as string) || '';
  const name = (claims?.name as string) || (claims?.preferred_username as string) || email.split('@')[0];
  const sub = (claims?.sub as string) || '';

  if (!email) {
    // Try userinfo endpoint
    const userinfo = await client.fetchUserInfo(serverConfig, tokens.access_token!, claims?.sub as string);
    return {
      email: (userinfo.email as string) || '',
      name: (userinfo.name as string) || '',
      sub: (userinfo.sub as string) || '',
    };
  }

  return { email, name, sub };
}

// --- User Provisioning ---

export async function provisionSSOUser(email: string, name: string, workspaceId: string) {
  // Find or create user by email
  let user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        displayName: name,
        username: email.split('@')[0] + '-' + crypto.randomBytes(3).toString('hex'),
      },
    });
  }

  // Ensure workspace membership
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (!existing) {
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: 'member', joinedAt: new Date() },
    });
  }

  return user;
}
