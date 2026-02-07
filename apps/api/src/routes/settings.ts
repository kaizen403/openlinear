import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';
import { z } from 'zod';
import { broadcast } from '../sse';

const UpdateSettingsSchema = z.object({
  parallelLimit: z.number().int().min(1).max(5).optional(),
  maxBatchSize: z.number().int().min(1).max(10).optional(),
  queueAutoApprove: z.boolean().optional(),
  stopOnFailure: z.boolean().optional(),
  conflictBehavior: z.enum(['skip', 'fail']).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' });

const router: Router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    let settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    });

    if (!settings) {
      settings = await prisma.settings.create({
        data: { id: 'default' },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('[Settings] Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

router.patch('/', async (req: Request, res: Response) => {
  try {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const settings = await prisma.settings.upsert({
      where: { id: 'default' },
      update: parsed.data,
      create: { id: 'default', ...parsed.data },
    });

    broadcast('settings:updated', settings);
    res.json(settings);
  } catch (error) {
    console.error('[Settings] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
