import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@openlinear/db';
import { AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { HttpError } from '../errors';
import {
  generatePersonalAccessToken,
  getPersonalAccessTokenPrefix,
  hashPersonalAccessToken,
} from '../services/pats';

const createPatBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().trim().min(1)).optional().default(['*']),
  expiresAt: z.string().datetime().optional(),
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

    const { name, scopes, expiresAt } = req.validBody!;
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresAtDate && expiresAtDate <= new Date()) {
      throw new HttpError(400, 'INVALID_EXPIRY', 'expiresAt must be in the future');
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
  const updated = await prisma.personalAccessToken.updateMany({
    where: {
      id,
      userId: req.userId!,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  if (updated.count === 0) {
    throw new HttpError(404, 'PAT_NOT_FOUND', 'Personal access token not found');
  }

  res.status(204).send();
  
});

export default router;
