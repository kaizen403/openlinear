import { Router, Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { requireAuth, AuthRequest } from '../middleware/auth';
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
} from '../services/sso';

const router: Router = Router();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Auth] JWT_SECRET is required in production');
    }
    return 'openlinear-dev-secret-change-in-production';
  }
  return secret;
}

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

// POST /api/workspaces/:workspaceId/sso — configure SSO (owner only)
router.post('/workspaces/:workspaceId/sso', requireAuth, async (req: AuthRequest, res: Response) => {
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

    res.status(200).json({ id: config.id, workspaceId: config.workspaceId, provider: config.provider });
  } catch (err) {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to configure SSO'));
  }
});

// GET /api/workspaces/:workspaceId/sso — get config (admin/owner)
router.get('/workspaces/:workspaceId/sso', requireAuth, async (req: AuthRequest, res: Response) => {
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

    res.json(config);
  } catch (err) {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to get SSO config'));
  }
});

// DELETE /api/workspaces/:workspaceId/sso — delete config (owner only)
router.delete('/workspaces/:workspaceId/sso', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const member = await verifyWorkspaceRole(req.userId!, workspaceId, ['owner']);
    if (!member) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Only workspace owners can delete SSO config'));
      return;
    }

    await deleteSSOConfigForWorkspace(workspaceId);
    res.status(204).send();
  } catch (err) {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to delete SSO config'));
  }
});

// GET /api/auth/sso/check?email= — public, check if email domain has SSO
router.get('/auth/sso/check', async (req: AuthRequest, res: Response) => {
  try {
    const email = req.query.email as string;
    if (!email || !email.includes('@')) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Valid email required'));
      return;
    }

    const domain = email.split('@')[1];
    const config = await getSSOConfigByDomain(domain);

    if (!config) {
      res.json({ ssoEnabled: false });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    const statePayload = JSON.stringify({ workspaceId: config.workspaceId, email, ts: Date.now() });
    const stateToken = Buffer.from(statePayload).toString('base64url');

    const redirectUri = `${getFrontendUrl()}/api/auth/sso/callback`;
    const authUrl = await buildOIDCAuthUrl(config, stateToken, redirectUri);

    res.json({ ssoEnabled: true, authUrl, enforced: config.enforced });
  } catch (err) {
    res.status(500).json(buildErrorEnvelope('INTERNAL_ERROR', 'Failed to check SSO'));
  }
});

// GET /api/auth/sso/callback?code=&state= — OIDC callback
router.get('/auth/sso/callback', async (req: AuthRequest, res: Response) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Missing code or state'));
      return;
    }

    let statePayload: { workspaceId?: string; ts?: number };
    try {
      statePayload = JSON.parse(Buffer.from(state as string, 'base64url').toString());
    } catch {
      res.status(400).json(buildErrorEnvelope('VALIDATION_ERROR', 'Malformed SSO state parameter'));
      return;
    }
    const { workspaceId, ts } = statePayload;

    if (!workspaceId || !ts || Date.now() - ts > 10 * 60 * 1000) {
      res.status(400).json(buildErrorEnvelope('EXPIRED', 'SSO state expired'));
      return;
    }

    const config = await prisma.sSOConfig.findUnique({ where: { workspaceId } });
    if (!config) {
      res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'SSO config not found'));
      return;
    }

    const redirectUri = `${getFrontendUrl()}/api/auth/sso/callback`;
    const userInfo = await handleOIDCCallback(config, code as string, redirectUri);

    if (!userInfo.email) {
      res.status(400).json(buildErrorEnvelope('SSO_ERROR', 'No email returned from identity provider'));
      return;
    }

    const emailDomain = userInfo.email.split('@')[1];
    if (!config.allowedDomains.includes(emailDomain)) {
      res.status(403).json(buildErrorEnvelope('FORBIDDEN', 'Email domain not allowed for this SSO configuration'));
      return;
    }

    const user = await provisionSSOUser(userInfo.email, userInfo.name, workspaceId);

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: '7d' },
    );

    res.redirect(`${getFrontendUrl()}/auth/callback?token=${token}`);
  } catch (err) {
    res.redirect(`${getFrontendUrl()}/auth/error?reason=sso_failed`);
  }
});

export default router;
