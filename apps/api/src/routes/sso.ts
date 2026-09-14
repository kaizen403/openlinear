import { Router, Response } from 'express';
import * as oidc from 'openid-client';
import { requireInteractiveSession, AuthRequest } from '../middleware/auth';
import { issueSession } from '../lib/auth-tokens';
import { prisma } from '@openlinear/db';
import { buildErrorEnvelope } from '../lib/http';
import {
  configureSSOForWorkspace,
  getSSOConfigForWorkspace,
  deleteSSOConfigForWorkspace,
  getSSOConfigByDomain,
  buildOIDCAuthUrl,
  handleOIDCCallback,
  provisionSSOUser,
  verifyWorkspaceDomain,
  ssoTxtRecord,
  signSsoState,
  verifySsoState,
} from '../services/sso';
import { logAudit } from '../services/audit';

const router: Router = Router();

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
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

    const { issuerUrl, clientId, clientSecret, allowedDomains, enforced } = req.body;
    if (!issuerUrl || !clientId || !clientSecret || !allowedDomains?.length) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Missing required fields: issuerUrl, clientId, clientSecret, allowedDomains'));
      return;
    }

    const config = await configureSSOForWorkspace(workspaceId, {
      issuerUrl,
      clientId,
      clientSecret,
      allowedDomains,
      enforced,
    });

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
    res.status(400).json(buildErrorEnvelope('DOMAIN_NOT_VERIFIED', 'TXT record not found', { extras: { record: result.record } }));
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

router.get('/auth/sso/check', async (req: AuthRequest, res: Response) => {
  try {
    const email = req.query.email as string;
    if (!email || !email.includes('@')) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Valid email required'));
      return;
    }

    const domain = email.split('@')[1];
    if (!domain) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Valid email required'));
      return;
    }
    const config = await getSSOConfigByDomain(domain);

    if (!config) {
      res.json({ ssoEnabled: false });
      return;
    }

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const nonce = oidc.randomNonce();
    const state = signSsoState({
      workspaceId: config.workspaceId,
      codeVerifier,
      nonce,
      ts: Date.now(),
    });

    const redirectUri = `${getFrontendUrl()}/api/auth/sso/callback`;
    const authUrl = await buildOIDCAuthUrl(config, state, redirectUri, { codeChallenge, nonce });

    res.json({ ssoEnabled: true, authUrl, enforced: config.enforced });
  } catch {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to check SSO'));
  }
});

router.get('/auth/sso/callback', async (req: AuthRequest, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || typeof state !== 'string') {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Missing code or state'));
      return;
    }

    const payload = verifySsoState(state);
    if (!payload) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Malformed or expired SSO state'));
      return;
    }

    const config = await prisma.sSOConfig.findUnique({ where: { workspaceId: payload.workspaceId } });
    if (!config?.domainVerifiedAt) {
      res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'SSO config not found or domain is unverified'));
      return;
    }

    const redirectUri = `${getFrontendUrl()}/api/auth/sso/callback`;
    const currentUrl = new URL(redirectUri);
    currentUrl.search = new URL(req.originalUrl, 'http://localhost').search;

    const userInfo = await handleOIDCCallback(config, currentUrl, {
      expectedState: state,
      expectedNonce: payload.nonce,
      pkceCodeVerifier: payload.codeVerifier,
    });

    if (!userInfo.email || !userInfo.sub) {
      res.status(400).json(buildErrorEnvelope('SSO_ERROR', 'Identity provider did not return email and subject'));
      return;
    }

    const emailDomain = userInfo.email.split('@')[1];
    if (!emailDomain || !config.allowedDomains.includes(emailDomain)) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Email domain not allowed for this SSO configuration'));
      return;
    }

    const user = await provisionSSOUser({
      issuer: userInfo.issuer,
      subject: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      workspaceId: payload.workspaceId,
    });

    const issued = await issueSession(
      { id: user.id, username: user.username },
      req,
    );

    res.redirect(`${getFrontendUrl()}/auth/session?token=${encodeURIComponent(issued.accessToken)}`);
  } catch {
    res.redirect(`${getFrontendUrl()}/auth/error?reason=sso_failed`);
  }
});

export default router;
