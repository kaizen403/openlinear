import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { broadcastToUser } from '../sse';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { updateSettingsBodySchema, UpdateSettingsBody } from '../schemas/settings';

const router: Router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {

  const userId = req.userId!;
  let settings = await prisma.settings.findUnique({ where: { userId } });

  if (!settings) {
    settings = await prisma.settings.create({ data: { userId } });
  }

  res.json(settings);
  
});

router.patch(
  '/',
  requireAuth,
  validateBody(updateSettingsBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateSettingsBody>, res: Response) => {

    const userId = req.userId!;
    const data = req.validBody!;
    const settings = await prisma.settings.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    broadcastToUser(userId, 'settings:updated', settings);
    res.json(settings);
    
  },
);

export default router;
