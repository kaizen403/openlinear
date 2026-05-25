import { Router, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import { updateUserBodySchema, UpdateUserBody } from '../schemas/users';

const router: Router = Router();

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

router.patch('/me', requireAuth, validateBody(updateUserBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateUserBody>, res: Response) => {
    const { displayName, email, avatarUrl } = req.validBody!;

    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      },
      select: userProfileSelect,
    });

    res.json(user);
  },
);

export default router;
