import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { describeProjectGitHubApp } from '../services/github-app-credentials';

/**
 * W10a installation discovery (API only; the desktop UI hook is a follow-up).
 *
 * GET /api/github-app/projects/:projectId/installation — for workspace
 * owners/admins: whether the OpenLinear GitHub App is configured, whether it
 * is installed on the project's repository (suspended, missing permissions),
 * the install / manage URLs, the git-credential fallback policy and the
 * per-effect permission table.
 */
const router: Router = Router();

router.get('/projects/:projectId/installation', requireAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await describeProjectGitHubApp({ projectId: req.params.projectId as string, userId: req.userId! }));
});

export default router;
