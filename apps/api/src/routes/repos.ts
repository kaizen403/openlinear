import { Router, Request, Response } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  getGitHubRepos,
  addRepository,
  setActiveRepository,
  getActiveRepository,
  getUserRepositories,
  GitHubRepo,
  addRepositoryByUrl,
} from '../services/github';

const router: Router = Router();

// --- Public routes (no auth) ---

router.post('/url', async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  
  if (!url) {
    res.status(400).json({ error: 'URL is required' });
    return;
  }

  try {
    const project = await addRepositoryByUrl(url);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to add repo by URL:', err);
    const message = err instanceof Error ? err.message : 'Failed to add repository';
    res.status(400).json({ error: message });
  }
});

router.get('/active/public', async (_req: Request, res: Response) => {
  try {
    const project = await prisma.repository.findFirst({
      where: { userId: null, isActive: true },
    });
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to get active public project:', err);
    res.status(500).json({ error: 'Failed to get active project' });
  }
});

router.get('/public', async (_req: Request, res: Response) => {
  try {
    const projects = await prisma.repository.findMany({
      where: { userId: null },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(projects);
  } catch (err) {
    console.error('[Repos] Failed to get public projects:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

router.post('/:id/activate/public', async (req: Request, res: Response) => {
  try {
    await prisma.repository.updateMany({
      where: { userId: null },
      data: { isActive: false },
    });
    
    const id = req.params.id as string;
    const project = await prisma.repository.update({
      where: { id },
      data: { isActive: true },
    });
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to activate public project:', err);
    res.status(500).json({ error: 'Failed to activate project' });
  }
});

// --- Authenticated routes (use shared requireAuth middleware) ---

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const projects = await getUserRepositories(req.userId!);
    res.json(projects);
  } catch (err) {
    console.error('[Repos] Failed to get projects:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

router.get('/github', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { accessToken: true },
    });

    if (!user?.accessToken) {
      res.status(403).json({ error: 'GitHub account not linked. Please sign in with GitHub first.' });
      return;
    }

    const repos = await getGitHubRepos(user.accessToken);
    res.json(repos);
  } catch (err) {
    console.error('[Repos] Failed to fetch GitHub repos:', err);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

router.post('/import', requireAuth, async (req: AuthRequest, res: Response) => {
  const { repo } = req.body as { repo: GitHubRepo };
  if (!repo?.id || !repo?.full_name) {
    res.status(400).json({ error: 'Invalid repository data' });
    return;
  }

  try {
    const project = await addRepository(req.userId!, repo, true);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to import repo:', err);
    res.status(500).json({ error: 'Failed to import repository' });
  }
});

router.post('/:id/activate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const project = await setActiveRepository(req.userId!, id);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to activate project:', err);
    res.status(500).json({ error: 'Failed to activate project' });
  }
});

router.get('/active', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const project = await getActiveRepository(req.userId!);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to get active project:', err);
    res.status(500).json({ error: 'Failed to get active project' });
  }
});

export default router;
