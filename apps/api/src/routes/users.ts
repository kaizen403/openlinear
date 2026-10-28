import { Router, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { requireAuth, requireInteractiveSession, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { updateUserBodySchema, UpdateUserBody } from '../schemas/users';
import { z } from 'zod';
import { hashToken } from '../services/sessions';
import { logger } from '../logger';
import { buildErrorEnvelope } from '../lib/http';

const router: Router = Router();
const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;

const userProfileSelect = {
  id: true,
  githubId: true,
  username: true,
  displayName: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

const requestEmailChangeSchema = z.object({
  newEmail: z.string().email(),
});

const confirmEmailChangeSchema = z.object({
  token: z.string().min(16),
});

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: userProfileSelect,
  });

  if (!user) {
    res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    return;
  }

  res.json(user);
});

router.patch('/me', requireInteractiveSession, validateBody(updateUserBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateUserBody>, res: Response) => {
    const { displayName, avatarUrl } = req.validBody!;

    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      },
      select: userProfileSelect,
    });

    res.json(user);
  },
);

router.post(
  '/me/email-change',
  requireInteractiveSession,
  validateBody(requestEmailChangeSchema),
  async (req: AuthRequest & ValidatedRequest<{ newEmail: string }>, res: Response) => {
    const newEmail = req.validBody!.newEmail.toLowerCase();
    const taken = await prisma.user.findFirst({
      where: { email: newEmail, NOT: { id: req.userId! } },
      select: { id: true },
    });
    if (taken) {
      res.status(409).json({ error: 'Email is already in use', code: 'EMAIL_TAKEN' });
      return;
    }

    await prisma.emailChangeRequest.updateMany({
      where: { userId: req.userId!, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    await prisma.emailChangeRequest.create({
      data: {
        userId: req.userId!,
        newEmail,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
      },
    });

    logger.info({ userId: req.userId, newEmail }, '[email-change] confirmation issued');

    const body: { ok: true; expiresIn: number; token?: string } = {
      ok: true,
      expiresIn: EMAIL_CHANGE_TTL_MS / 1000,
    };
    if (process.env.NODE_ENV !== 'production') {
      body.token = token;
    }
    res.status(202).json(body);
  },
);

router.post(
  '/me/email-change/confirm',
  requireInteractiveSession,
  validateBody(confirmEmailChangeSchema),
  async (req: AuthRequest & ValidatedRequest<{ token: string }>, res: Response) => {
    const tokenHash = hashToken(req.validBody!.token);
    // Single use under concurrency (W02b): the request row is claimed with a
    // conditional UPDATE inside the transaction that changes the email, so
    // of N parallel confirmations exactly one applies.
    const user = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.emailChangeRequest.updateMany({
        where: { tokenHash, userId: req.userId!, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) return null;
      const row = await tx.emailChangeRequest.findUnique({
        where: { tokenHash },
        select: { newEmail: true },
      });
      if (!row) return null;
      return tx.user.update({
        where: { id: req.userId! },
        data: { email: row.newEmail },
        select: userProfileSelect,
      });
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired confirmation token', code: 'INVALID_TOKEN' });
      return;
    }

    res.json(user);
  },
);

// PAT policy (admin scope, refused for workspace-bound PATs) comes from the
// route registry; the check below is defence in depth.
router.get('/me/scm-token', requireAuth, async (req: AuthRequest, res: Response) => {
  // The GitHub token is account-wide. A PAT bound to one workspace must not
  // be able to exchange itself for a credential that reaches every repository.
  if (req.authSource === 'pat' && req.patWorkspaceId) {
    res.status(403).json(buildErrorEnvelope(
      'PAT_WORKSPACE_RESTRICTED',
      'Account-wide credentials are not available to a workspace-bound personal access token',
    ));
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { accessToken: true },
  });
  if (!user?.accessToken) {
    res.status(404).json({ error: 'GitHub is not linked', code: 'GITHUB_NOT_LINKED' });
    return;
  }
  const { decryptUserAccessToken } = await import('../services/github');
  const token = decryptUserAccessToken(user.accessToken);
  if (!token) {
    res.status(500).json({ error: 'Stored GitHub token could not be decrypted', code: 'GITHUB_TOKEN_DECRYPT_FAILED' });
    return;
  }
  res.json({ token });
});

export default router;
