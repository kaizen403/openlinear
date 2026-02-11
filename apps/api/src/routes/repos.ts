import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
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
const JWT_SECRET = process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';

interface AuthUser {
  id: string;
  accessToken: string | null;
}

async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, accessToken: true },
    });
    return user;
  } catch {
    return null;
  }
}

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
    
    const project = await prisma.repository.update({
      where: { id: req.params.id },
      data: { isActive: true },
    });
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to activate public project:', err);
    res.status(500).json({ error: 'Failed to activate project' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const projects = await getUserRepositories(user.id);
    res.json(projects);
  } catch (err) {
    console.error('[Repos] Failed to get projects:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

router.get('/github', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!user.accessToken) {
    res.status(403).json({ error: 'GitHub account not linked. Please sign in with GitHub first.' });
    return;
  }

  try {
    const repos = await getGitHubRepos(user.accessToken);
    res.json(repos);
  } catch (err) {
    console.error('[Repos] Failed to fetch GitHub repos:', err);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

router.post('/import', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { repo } = req.body as { repo: GitHubRepo };
  if (!repo?.id || !repo?.full_name) {
    res.status(400).json({ error: 'Invalid repository data' });
    return;
  }

  try {
    const project = await addRepository(user.id, repo, true);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to import repo:', err);
    res.status(500).json({ error: 'Failed to import repository' });
  }
});

router.post('/:id/activate', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const project = await setActiveRepository(user.id, req.params.id);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to activate project:', err);
    res.status(500).json({ error: 'Failed to activate project' });
  }
});

router.get('/active', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const project = await getActiveRepository(user.id);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to get active project:', err);
    res.status(500).json({ error: 'Failed to get active project' });
  }
});

export default router;
