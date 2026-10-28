import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AuthedRequest, credentialOf, type PrincipalCredential, requireSidecarAuth } from '../auth/principal';
import { createPrincipalClient, toSidecarError } from '../config/cloud-api';
import {
  type ContextCitation,
  type ContextEngine,
  type ContextReceipt,
  defaultContextEngine,
  REPO_CONTEXT_ENV,
  type RepositoryContextSettings,
  repositoryContextSettings,
  repositoryKeyFor,
} from '../context';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { assertSafeRefName, execGit } from '../services/git-credentials';
import { isRealDirectory } from '../services/review/workspace-resolver';
import { appReposDir } from '../workspace/local-worktree';

/**
 * FE-11 / W16b: `GET /api/tasks/:id/related-files` — files of the task's
 * project repository, on this device, that look related to the task (the
 * same ranking a run's prompt uses), as citations: path, line range, score
 * and why it matched. No file content is returned.
 *
 * - Authorization: the task and its project are read from the control plane
 *   under the caller's own credential (view access; 401/403/404 pass
 *   through, an unreachable API is 503).
 * - Repository: the project's local folder at its HEAD, else the sidecar's
 *   mirror of the linked repository at its default branch — the commits runs
 *   start from. Nothing is cloned or fetched here.
 * - Always 200 when the caller may read the task: `status` says whether the
 *   list is `ready`, still `indexing` (try again after `retryAfterMs`),
 *   `unavailable` (no repository on this device; `reason` says why) or
 *   `disabled` (OPENLINEAR_REPO_CONTEXT=0).
 *
 * Authentication is registered on the route itself, so mounting this router
 * under `/api/tasks` never touches other task paths.
 */

export const RELATED_FILES_LIMIT = 8;
const RELATED_FILES_WAIT_MS = 8_000;
const RETRY_AFTER_MS = 3_000;

export type RelatedFilesResponseStatus = 'ready' | 'indexing' | 'unavailable' | 'disabled';

export interface RelatedFilesResponse {
  status: RelatedFilesResponseStatus;
  /** Why the list is empty or not ready (null when it has entries). */
  reason: string | null;
  repository: { source: 'local-folder' | 'mirror'; commit: string | null } | null;
  files: ContextCitation[];
  receipt: ContextReceipt | null;
  /** With `indexing`: when to ask again. */
  retryAfterMs?: number;
}

const taskIdSchema = z.string().trim().min(1).max(200).refine((id) => !id.includes('\0'), 'Task IDs cannot contain NUL');

const taskSchema = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() }).passthrough()).optional(),
}).passthrough();

const projectSchema = z.object({
  localPath: z.string().nullable().optional(),
  repository: z.object({
    fullName: z.string(),
    cloneUrl: z.string(),
    defaultBranch: z.string(),
  }).passthrough().nullable().optional(),
}).passthrough();

export interface TaskContextSource {
  title: string;
  description: string | null;
  labels: string[];
  project: {
    localPath: string | null;
    repository: { fullName: string; cloneUrl: string; defaultBranch: string } | null;
  } | null;
}

/** The task and its project's repository settings, read as the caller. */
export async function loadTaskContextSource(credential: PrincipalCredential, taskId: string): Promise<TaskContextSource> {
  const client = createPrincipalClient(credential.token);
  let rawTask: unknown;
  try {
    rawTask = await client.getTask(taskId);
  } catch (error) {
    throw toSidecarError(error, 'task lookup');
  }
  const task = taskSchema.safeParse(rawTask);
  if (!task.success) throw new HttpError(502, 'CLOUD_API_INVALID_RESPONSE', 'The OpenLinear API returned an unexpected task');
  let project: TaskContextSource['project'] = null;
  if (task.data.projectId) {
    let rawProject: unknown;
    try {
      rawProject = await client.getProject(task.data.projectId);
    } catch (error) {
      throw toSidecarError(error, 'project lookup');
    }
    const parsed = projectSchema.safeParse(rawProject);
    if (!parsed.success) throw new HttpError(502, 'CLOUD_API_INVALID_RESPONSE', 'The OpenLinear API returned an unexpected project');
    const repository = parsed.data.repository;
    project = {
      localPath: parsed.data.localPath ?? null,
      repository: repository ? { fullName: repository.fullName, cloneUrl: repository.cloneUrl, defaultBranch: repository.defaultBranch } : null,
    };
  }
  return {
    title: task.data.title,
    description: task.data.description ?? null,
    labels: (task.data.labels ?? []).map((label) => label.name),
    project,
  };
}

export type ResolvedRepository =
  | { ok: true; dir: string; ref: string; source: 'local-folder' | 'mirror'; key: string | null }
  | { ok: false; reason: string };

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Owner/name of the sidecar's mirror for a clone URL. MUST stay in sync with
 * `repositoryIdentity()` in run/workspace.ts (not exported there) and the
 * segment rules of workspace/local-worktree.ts.
 */
export function mirrorIdentity(cloneUrl: string): { owner: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl.startsWith('/') ? `file://${cloneUrl}` : cloneUrl);
  } catch {
    return null;
  }
  const parts = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const name = parts.pop() ?? 'repo';
  const owner = parts.pop() ?? 'local';
  const ownerOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(owner) && !owner.includes('..');
  const nameOk = /^[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
  return ownerOk && nameOk ? { owner, name } : null;
}

/** Where the project's repository lives on this device (never clones or fetches). */
export async function resolveProjectRepository(project: TaskContextSource['project'], reposRoot: string): Promise<ResolvedRepository> {
  if (!project) return { ok: false, reason: 'The task is not in a project' };
  const key = repositoryKeyFor(project);
  if (project.localPath) {
    if (!isAbsolute(project.localPath)) return { ok: false, reason: 'The project folder path is not absolute' };
    let source: string;
    try {
      source = realpathSync(project.localPath);
    } catch {
      return { ok: false, reason: 'The project folder is not on this device' };
    }
    if (!(await isRealDirectory(source))) return { ok: false, reason: 'The project folder is not on this device' };
    let root = reposRoot;
    try {
      root = realpathSync(reposRoot);
    } catch {
      // no repository storage yet
    }
    if (isInside(root, source)) return { ok: false, reason: 'The project folder lies inside OpenLinear storage' };
    try {
      const { stdout } = await execGit(['-C', source, 'rev-parse', '--show-toplevel']);
      if (realpathSync(stdout.trim()) !== source) return { ok: false, reason: 'The project folder is not the root of a git repository' };
    } catch {
      return { ok: false, reason: 'The project folder is not a git repository this device can read' };
    }
    return { ok: true, dir: source, ref: 'HEAD', source: 'local-folder', key };
  }
  const repository = project.repository;
  if (!repository) return { ok: false, reason: 'The project has no repository' };
  const identity = mirrorIdentity(repository.cloneUrl);
  if (!identity) return { ok: false, reason: 'The repository address is not supported' };
  let branch: string;
  try {
    branch = assertSafeRefName(repository.defaultBranch, 'default branch');
  } catch {
    return { ok: false, reason: 'The repository default branch is not supported' };
  }
  const mirror = join(reposRoot, identity.owner, `${identity.name}.git`);
  if (!isInside(reposRoot, mirror) || !(await isRealDirectory(mirror))) {
    return { ok: false, reason: 'The repository has not been cloned on this device yet; related files appear after its first run here' };
  }
  return { ok: true, dir: mirror, ref: `refs/remotes/origin/${branch}`, source: 'mirror', key };
}

export interface RepoContextRouterDeps {
  loadTask?: (credential: PrincipalCredential, taskId: string) => Promise<TaskContextSource>;
  engine?: () => ContextEngine;
  reposRoot?: () => string;
  settings?: () => RepositoryContextSettings;
  waitMs?: number;
}

export function createRepoContextRouter(deps: RepoContextRouterDeps = {}): Router {
  const loadTask = deps.loadTask ?? loadTaskContextSource;
  const engine = deps.engine ?? defaultContextEngine;
  const reposRoot = deps.reposRoot ?? appReposDir;
  const settings = deps.settings ?? (() => repositoryContextSettings());
  const waitMs = deps.waitMs ?? RELATED_FILES_WAIT_MS;
  const router = Router();

  router.get('/:id/related-files', requireSidecarAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = taskIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new HttpError(400, 'INVALID_TASK_ID', 'Invalid task id');
      const credential = credentialOf(req);
      // Read (and so authorize) the task before saying anything about this device.
      const task = await loadTask(credential, parsed.data);
      res.setHeader('Cache-Control', 'no-store');
      const respond = (body: RelatedFilesResponse) => res.json(body);
      if (!settings().enabled) {
        respond({ status: 'disabled', reason: `Repository context is turned off on this device (${REPO_CONTEXT_ENV}=0)`, repository: null, files: [], receipt: null });
        return;
      }
      const repository = await resolveProjectRepository(task.project, reposRoot());
      if (!repository.ok) {
        respond({ status: 'unavailable', reason: repository.reason, repository: null, files: [], receipt: null });
        return;
      }
      const result = await engine().findRelated({
        dir: repository.dir,
        ref: repository.ref,
        repositoryKey: repository.key,
        query: { title: task.title, description: task.description, labels: task.labels },
        limit: RELATED_FILES_LIMIT,
        timeoutMs: waitMs,
      }).catch((error: unknown) => {
        logger.warn({ err: error }, '[context] related files failed');
        return null;
      });
      if (!result) {
        respond({ status: 'unavailable', reason: 'The repository could not be searched', repository: { source: repository.source, commit: null }, files: [], receipt: null });
        return;
      }
      respond({
        status: result.status,
        reason: result.reason,
        repository: { source: repository.source, commit: result.receipt.sha },
        files: result.citations,
        receipt: result.receipt,
        ...(result.status === 'indexing' ? { retryAfterMs: RETRY_AFTER_MS } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
