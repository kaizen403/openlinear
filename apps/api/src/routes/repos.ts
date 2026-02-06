import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import {
  getGitHubRepos,
  addProject,
  setActiveProject,
  getActiveProject,
  getUserProjects,
  GitHubRepo,
} from '../services/github';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'openlinear-dev-secret-change-in-production';

interface AuthUser {
  id: string;
  accessToken: string;
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

router.get('/', async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const projects = await getUserProjects(user.id);
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
    const project = await addProject(user.id, repo, true);
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
    const project = await setActiveProject(user.id, req.params.id);
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
    const project = await getActiveProject(user.id);
    res.json(project);
  } catch (err) {
    console.error('[Repos] Failed to get active project:', err);
    res.status(500).json({ error: 'Failed to get active project' });
  }
});

export default router;
