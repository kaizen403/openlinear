import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, userTarget } from '../events/targets';
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
    // W04b: the settings row and `settings:updated` commit together.
    const settings = await transactionWithEvents(async (tx) => {
      const row = await tx.settings.upsert({
        where: { userId },
        update: data,
        create: { userId, ...data },
      });
      await appendToTarget(tx, userTarget(userId), 'settings:updated', row, userId);
      return row;
    });
    res.json(settings);
    
  },
);

export default router;
