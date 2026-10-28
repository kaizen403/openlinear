import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireInteractiveSession, AuthRequest } from '../middleware/auth';
import { issueSession } from '../lib/auth-tokens';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import {
  configureSSOForWorkspace,
  getSSOConfigForWorkspace,
  deleteSSOConfigForWorkspace,
  getSSOConfigByDomain,
  handleOIDCCallback,
  provisionSSOUser,
  verifyWorkspaceDomain,
  ssoTxtRecord,
  startSsoLogin,
  consumeSsoState,
  SSO_BINDING_COOKIE,
  SSO_BINDING_COOKIE_PATH,
  SSO_STATE_TTL_MS,
} from '../services/sso';
import { logAudit } from '../services/audit';
import { logger } from '../logger';

const router: Router = Router();

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Invalid domain');

const ssoConfigBodySchema = z.object({
  issuerUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'issuerUrl must use https'),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
  allowedDomains: z.array(domainSchema).min(1).max(50),
  enforced: z.boolean().optional(),
});

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function ssoRedirectUri(): string {
  return `${getFrontendUrl()}/api/auth/sso/callback`;
}

function bindingCookieSecure(redirectUri: string): boolean {
  return process.env.NODE_ENV === 'production' || redirectUri.startsWith('https://');
}

/** Minimal cookie reader (the API does not mount cookie-parser). */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clearBindingCookie(res: Response): void {
  res.clearCookie(SSO_BINDING_COOKIE, { path: SSO_BINDING_COOKIE_PATH, httpOnly: true, sameSite: 'lax' });
}

async function verifyWorkspaceRole(userId: string, workspaceId: string, requiredRoles: string[]) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member || !requiredRoles.includes(member.role)) {
    return null;
  }
  return member;
}

router.post('/workspaces/:workspaceId/sso', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const member = await verifyWorkspaceRole(req.userId!, workspaceId, ['owner']);
    if (!member) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Only workspace owners can configure SSO'));
      return;
    }

    const parsed = ssoConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(buildErrorEnvelope(
        'VALIDATION_ERROR',
        'Missing or invalid fields: issuerUrl (https), clientId, clientSecret, allowedDomains',
        { details: parsed.error.flatten() },
      ));
      return;
    }

    const config = await configureSSOForWorkspace(workspaceId, parsed.data);

    await logAudit({
      workspaceId,
      actorId: req.userId!,
      action: 'sso.configured',
      resourceType: 'sso_config',
      resourceId: config.id,
      ipAddress: req.ip,
    });

    res.status(200).json({
      id: config.id,
      workspaceId: config.workspaceId,
      provider: config.provider,
      domainVerifiedAt: config.domainVerifiedAt,
      txtRecord: config.verificationToken ? ssoTxtRecord(config.verificationToken) : null,
    });
  } catch {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to configure SSO'));
  }
});

router.post('/workspaces/:workspaceId/sso/verify-domain', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const member = await verifyWorkspaceRole(req.userId!, workspaceId, ['owner']);
  if (!member) {
    res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Only workspace owners can verify SSO domains'));
    return;
  }
  const result = await verifyWorkspaceDomain(workspaceId);
  if (!result.verified) {
    res.status(400).json(buildErrorEnvelope('DOMAIN_NOT_VERIFIED', 'TXT record not found on every allowed domain', { extras: { record: result.record } }));
    return;
  }
  res.json({ verified: true, record: result.record });
});

router.get('/workspaces/:workspaceId/sso', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const member = await verifyWorkspaceRole(req.userId!, workspaceId, ['owner', 'admin']);
    if (!member) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Insufficient permissions'));
      return;
    }

    const config = await getSSOConfigForWorkspace(workspaceId);
    if (!config) {
      res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'No SSO configuration found'));
      return;
    }

    res.json({
      ...config,
      txtRecord: config.verificationToken ? ssoTxtRecord(config.verificationToken) : null,
    });
  } catch {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to get SSO config'));
  }
});

router.delete('/workspaces/:workspaceId/sso', requireInteractiveSession, async (req: AuthRequest, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const member = await verifyWorkspaceRole(req.userId!, workspaceId, ['owner']);
    if (!member) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Only workspace owners can delete SSO config'));
      return;
    }

    await deleteSSOConfigForWorkspace(workspaceId);
    await logAudit({
      workspaceId,
      actorId: req.userId!,
      action: 'sso.deleted',
      resourceType: 'sso_config',
      resourceId: workspaceId,
      ipAddress: req.ip,
    });
    res.status(204).send();
  } catch {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to delete SSO config'));
  }
});

/**
 * Start an SSO login. Must be called from the browser that will complete it,
 * on the same site as the callback (`credentials: 'include'` for fetch): the
 * response sets the HttpOnly binding cookie the callback requires.
 */
router.get('/auth/sso/check', async (req: AuthRequest, res: Response) => {
  try {
    const email = req.query.email as string;
    if (!email || !email.includes('@')) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Valid email required'));
      return;
    }

    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Valid email required'));
      return;
    }
    const config = await getSSOConfigByDomain(domain);

    if (!config) {
      res.json({ ssoEnabled: false });
      return;
    }

    const redirectUri = ssoRedirectUri();
    const started = await startSsoLogin(config, redirectUri);

    res.cookie(SSO_BINDING_COOKIE, started.bindingSecret, {
      httpOnly: true,
      secure: bindingCookieSecure(redirectUri),
      sameSite: 'lax',
      path: SSO_BINDING_COOKIE_PATH,
      maxAge: SSO_STATE_TTL_MS,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ssoEnabled: true, authUrl: started.authUrl, enforced: config.enforced });
  } catch {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to check SSO'));
  }
});

router.get('/auth/sso/callback', async (req: AuthRequest, res: Response) => {
  const code = req.query.code;
  const state = req.query.state;
  if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) {
    res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Missing code or state'));
    return;
  }

  const consumed = await consumeSsoState(state, readCookie(req, SSO_BINDING_COOKIE));
  if (!consumed.ok) {
    logger.warn({ reason: consumed.reason }, '[sso] callback refused');
    // A foreign browser keeps its own (possibly valid) binding cookie.
    if (consumed.reason !== 'browser-mismatch') clearBindingCookie(res);
    res.set('Cache-Control', 'no-store');
    res.status(400).json(buildErrorEnvelope(
      'SSO_STATE_INVALID',
      'This sign-in link is invalid, expired, already used, or was started in another browser.',
      { details: { reason: consumed.reason } },
    ));
    return;
  }
  clearBindingCookie(res);
  const login = consumed.login;

  try {
    const config = await prisma.sSOConfig.findUnique({ where: { workspaceId: login.workspaceId } });
    // The provider must still be the one the flow started with.
    if (
      !config?.domainVerifiedAt
      || config.id !== login.ssoConfigId
      || config.issuerUrl !== login.issuerUrl
      || config.clientId !== login.clientId
    ) {
      res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'SSO config not found, changed, or domain is unverified'));
      return;
    }

    const currentUrl = new URL(login.redirectUri);
    currentUrl.search = new URL(req.originalUrl, 'http://localhost').search;

    const userInfo = await handleOIDCCallback(config, currentUrl, {
      expectedState: state,
      expectedNonce: login.nonce,
      pkceCodeVerifier: login.codeVerifier,
    });

    if (!userInfo.email || !userInfo.sub) {
      res.status(400).json(buildErrorEnvelope('SSO_ERROR', 'Identity provider did not return email and subject'));
      return;
    }

    const emailDomain = userInfo.email.split('@')[1]?.toLowerCase();
    if (!emailDomain || !config.allowedDomains.some((allowed) => allowed.toLowerCase() === emailDomain)) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Email domain not allowed for this SSO configuration'));
      return;
    }

    const user = await provisionSSOUser({
      issuer: userInfo.issuer,
      subject: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      workspaceId: login.workspaceId,
    });

    const issued = await issueSession(
      { id: user.id, username: user.username },
      req,
    );

    res.set('Cache-Control', 'no-store');
    res.redirect(`${getFrontendUrl()}/auth/session?token=${encodeURIComponent(issued.accessToken)}`);
  } catch {
    res.redirect(`${getFrontendUrl()}/auth/error?reason=sso_failed`);
  }
});

export default router;
