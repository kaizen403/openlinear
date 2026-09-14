import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@openlinear/db';
import { AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import { isPatScope, PAT_SCOPES } from '@openlinear/api-core';
import {
  generatePersonalAccessToken,
  getPersonalAccessTokenPrefix,
  hashPersonalAccessToken,
} from '../services/pats';
import { logAudit } from '../services/audit';

const createPatBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.string().trim().min(1))
    .min(1, 'At least one scope is required')
    .refine((scopes) => scopes.every(isPatScope), {
      message: `Scopes must be one of: ${PAT_SCOPES.join(', ')}`,
    }),
  expiresAt: z.string().datetime().optional(),
  workspaceId: z.string().uuid().optional(),
});

type CreatePatBody = z.infer<typeof createPatBodySchema>;

const router: Router = Router();

router.get('/', async (req: AuthRequest, res: Response) => {

  const tokens = await prisma.personalAccessToken.findMany({
    where: { userId: req.userId! },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(tokens.map((token) => ({
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    scopes: token.scopes,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    revokedAt: token.revokedAt,
  })));
  
});

router.post(
  '/',
  validateBody(createPatBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreatePatBody>, res: Response) => {

    const { name, scopes, expiresAt, workspaceId } = req.validBody!;
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresAtDate && expiresAtDate <= new Date()) {
      throw new HttpError(400, 'INVALID_EXPIRY', 'expiresAt must be in the future');
    }

    if (workspaceId) {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: req.userId! } },
        select: { id: true },
      });
      if (!member) {
        throw new HttpError(403, 'FORBIDDEN', 'Not a member of that workspace');
      }
    }

    const token = generatePersonalAccessToken();
    const created = await prisma.personalAccessToken.create({
      data: {
        userId: req.userId!,
        name,
        tokenHash: hashPersonalAccessToken(token),
        tokenPrefix: getPersonalAccessTokenPrefix(token),
        scopes,
        expiresAt: expiresAtDate,
        workspaceId: workspaceId ?? null,
      },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        scopes: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    if (workspaceId) {
      await logAudit({
        workspaceId,
        actorId: req.userId!,
        action: 'pat.created',
        resourceType: 'personal_access_token',
        resourceId: created.id,
        metadata: { scopes },
        ipAddress: req.ip,
      });
    }

    res.status(201).json({
      id: created.id,
      name: created.name,
      token,
      prefix: created.tokenPrefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    });
    
  },
);

router.delete('/:id', async (req: AuthRequest, res: Response) => {

  const id = req.params.id as string;
  const existing = await prisma.personalAccessToken.findFirst({
    where: {
      id,
      userId: req.userId!,
      revokedAt: null,
    },
    select: { id: true, workspaceId: true },
  });

  if (!existing) {
    throw new HttpError(404, 'PAT_NOT_FOUND', 'Personal access token not found');
  }

  await prisma.personalAccessToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  if (existing.workspaceId) {
    await logAudit({
      workspaceId: existing.workspaceId,
      actorId: req.userId!,
      action: 'pat.revoked',
      resourceType: 'personal_access_token',
      resourceId: existing.id,
      ipAddress: req.ip,
    });
  }

  res.status(204).send();
  
});

export default router;
