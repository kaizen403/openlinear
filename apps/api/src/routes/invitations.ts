import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateBody, ValidatedRequest } from '../middleware/validate';
import {
  createInvitation,
  listPendingInvitationsForWorkspace,
  acceptInvitation,
  revokeInvitation,
  listMyPendingInvitations,
} from '../services/invitations';
import {
  createInvitationBodySchema,
  acceptInvitationBodySchema,
  CreateInvitationBody,
  AcceptInvitationBody,
} from '../schemas/invitations';
import { prisma } from '@openlinear/db';
import { HttpError } from '../errors';

const router: Router = Router();

router.get('/pending', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { email: true },
  });

  if (!user?.email) {
    throw new HttpError(400, 'NO_EMAIL', 'User has no email address');
  }

  const invitations = await listMyPendingInvitations({ userEmail: user.email });
  res.json(invitations);
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;
  if (!workspaceId) {
    throw new HttpError(400, 'MISSING_WORKSPACE_ID', 'workspaceId query parameter is required');
  }

  const invitations = await listPendingInvitationsForWorkspace({ workspaceId, userId: req.userId! });
  res.json(invitations);
});

router.post('/', requireAuth, validateBody(createInvitationBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateInvitationBody>, res: Response) => {
    const { email, workspaceId, role } = req.validBody!;
    const invitation = await createInvitation({
      email,
      workspaceId,
      role: role as 'admin' | 'member' | 'viewer',
      invitedById: req.userId!,
    });
    res.status(201).json(invitation);
  },
);

router.post('/:id/accept', requireAuth, validateBody(acceptInvitationBodySchema),
  async (req: AuthRequest & ValidatedRequest<AcceptInvitationBody>, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { email: true },
    });

    if (!user?.email) {
      throw new HttpError(400, 'NO_EMAIL', 'User has no email address');
    }

    const result = await acceptInvitation({
      invitationId: req.params.id as string,
      token: req.validBody!.token,
      userId: req.userId!,
      userEmail: user.email,
    });
    res.json(result);
  },
);

router.post('/:id/revoke', requireAuth, async (req: AuthRequest, res: Response) => {
  const invitation = await revokeInvitation({
    invitationId: req.params.id as string,
    userId: req.userId!,
  });
  res.json(invitation);
});

export default router;
