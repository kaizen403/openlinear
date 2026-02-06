import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { prisma } from '@openlinear/db';
import { broadcast } from '../sse';

const execAsync = promisify(exec);

const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';
const OPENCODE_BASE_URL = process.env.OPENCODE_URL || 'http://localhost:4096';
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

const client = createOpencodeClient({
  baseUrl: OPENCODE_BASE_URL,
});

interface ExecutionState {
  taskId: string;
  projectId: string;
  sessionId: string;
  repoPath: string;
  branchName: string;
  userId: string;
  accessToken: string;
  timeoutId: NodeJS.Timeout;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
}

const activeExecutions = new Map<string, ExecutionState>();
let eventSubscriptionActive = false;

export function getRunningTaskCount(): number {
  return activeExecutions.size;
}

export function isTaskRunning(taskId: string): boolean {
  return activeExecutions.has(taskId);
}

export function getExecutionStatus(taskId: string): ExecutionState | undefined {
  return activeExecutions.get(taskId);
}

function broadcastProgress(taskId: string, status: string, message: string, data?: Record<string, unknown>) {
  broadcast('execution:progress', { taskId, status, message, ...data });
}

async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'done' | 'cancelled',
  sessionId: string | null
): Promise<void> {
  try {
    const task = await prisma.task.update({
      where: { id: taskId },
      data: { status, sessionId },
      include: { labels: { include: { label: true } } },
    });
    
    const flatTask = {
      ...task,
      labels: task.labels.map(tl => tl.label),
    };
    
    broadcast('task:updated', flatTask);
  } catch (error) {
    console.error(`[Execution] Failed to update task ${taskId}:`, error);
  }
}

async function cleanupExecution(taskId: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (execution) {
    clearTimeout(execution.timeoutId);
    activeExecutions.delete(taskId);
  }
}

async function cloneRepository(
  cloneUrl: string,
  repoPath: string,
  accessToken: string,
  defaultBranch: string
): Promise<void> {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
  }

  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }

  const authUrl = cloneUrl.replace('https://', `https://oauth2:${accessToken}@`);
  await execAsync(`git clone --depth 1 --branch ${defaultBranch} ${authUrl} ${repoPath}`);
}

async function createBranch(repoPath: string, branchName: string): Promise<void> {
  await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
}

async function commitAndPush(
  repoPath: string,
  branchName: string,
  taskTitle: string
): Promise<boolean> {
  try {
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
    
    if (!status.trim()) {
      return false;
    }

    await execAsync('git add -A', { cwd: repoPath });
    const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
    await execAsync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
    await execAsync(`git push -u origin ${branchName}`, { cwd: repoPath });
    
    return true;
  } catch (error) {
    console.error('[Execution] Commit/push failed:', error);
    return false;
  }
}

async function createPullRequest(
  fullName: string,
  branchName: string,
  defaultBranch: string,
  taskTitle: string,
  taskDescription: string | null,
  accessToken: string
): Promise<{ url: string } | null> {
  const [owner, repo] = fullName.split('/');
  
  const body = {
    title: taskTitle,
    head: branchName,
    base: defaultBranch,
    body: taskDescription || `Automated PR created by OpenLinear\n\n## Task\n${taskTitle}`,
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Execution] PR creation failed:', error);
      return null;
    }

    const pr = (await response.json()) as { html_url: string };
    return { url: pr.html_url };
  } catch (error) {
    console.error('[Execution] PR creation error:', error);
    return null;
  }
}

function findTaskBySessionId(sessionId: string): string | undefined {
  for (const [taskId, execution] of activeExecutions.entries()) {
    if (execution.sessionId === sessionId) {
      return taskId;
    }
  }
  return undefined;
}

async function handleSessionComplete(taskId: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;

  try {
    execution.status = 'committing';
    broadcastProgress(taskId, 'committing', 'Committing changes...');

    const hasChanges = await commitAndPush(
      execution.repoPath,
      execution.branchName,
      await getTaskTitle(taskId)
    );

    if (hasChanges) {
      execution.status = 'creating_pr';
      broadcastProgress(taskId, 'creating_pr', 'Creating pull request...');

      const project = await prisma.project.findUnique({
        where: { id: execution.projectId },
      });

      if (project) {
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        const pr = await createPullRequest(
          project.fullName,
          execution.branchName,
          project.defaultBranch,
          task?.title || 'Task',
          task?.description || null,
          execution.accessToken
        );

        if (pr) {
          broadcastProgress(taskId, 'done', 'Pull request created', { prUrl: pr.url });
        } else {
          broadcastProgress(taskId, 'done', 'Changes pushed, but PR creation failed');
        }
      }
    } else {
      broadcastProgress(taskId, 'done', 'Completed with no changes');
    }

    await updateTaskStatus(taskId, 'done', null);
  } catch (error) {
    console.error('[Execution] Post-execution error:', error);
    broadcastProgress(taskId, 'error', 'Post-execution failed');
  } finally {
    await cleanupExecution(taskId);
  }
}

async function getTaskTitle(taskId: string): Promise<string> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  return task?.title || 'Task';
}

async function handleOpenCodeEvent(event: { type: string; properties: Record<string, unknown> }): Promise<void> {
  const sessionId = (event.properties?.id as string) || (event.properties?.sessionID as string);
  const taskId = findTaskBySessionId(sessionId);

  if (!taskId) return;

  switch (event.type) {
    case 'session.idle':
    case 'session.completed':
      console.log(`[Execution] Session completed for task ${taskId}`);
      await handleSessionComplete(taskId);
      break;

    case 'session.error':
      console.error(`[Execution] Session error for task ${taskId}:`, event.properties);
      broadcastProgress(taskId, 'error', 'Execution failed');
      await updateTaskStatus(taskId, 'cancelled', null);
      await cleanupExecution(taskId);
      break;
  }
}

export async function initEventSubscription(): Promise<void> {
  if (eventSubscriptionActive) return;

  try {
    const events = await client.event.subscribe();
    eventSubscriptionActive = true;
    console.log('[Execution] Event subscription initialized');

    (async () => {
      try {
        for await (const event of events.stream) {
          await handleOpenCodeEvent(event);
        }
      } catch (error) {
        console.error('[Execution] Event stream error:', error);
        eventSubscriptionActive = false;
        setTimeout(() => initEventSubscription(), 5000);
      }
    })();
  } catch (error) {
    console.error('[Execution] Failed to initialize event subscription:', error);
    eventSubscriptionActive = false;
  }
}

interface ExecuteTaskParams {
  taskId: string;
  userId: string;
}

export async function executeTask({ taskId, userId }: ExecuteTaskParams): Promise<{ success: boolean; error?: string }> {
  if (activeExecutions.has(taskId)) {
    return { success: false, error: 'Task is already running' };
  }

  const settings = await prisma.settings.findFirst({ where: { id: 'default' } });
  const parallelLimit = settings?.parallelLimit ?? 3;

  if (activeExecutions.size >= parallelLimit) {
    return { success: false, error: `Parallel limit reached (${parallelLimit} tasks max)` };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessToken: true },
  });

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  const project = await prisma.project.findFirst({
    where: { userId, isActive: true },
  });

  if (!project) {
    return { success: false, error: 'No active project selected' };
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { labels: { include: { label: true } } },
  });

  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  const branchName = `openlinear/${taskId.slice(0, 8)}`;
  const repoPath = join(REPOS_DIR, project.name, taskId.slice(0, 8));

  try {
    broadcastProgress(taskId, 'cloning', 'Cloning repository...');
    await cloneRepository(project.cloneUrl, repoPath, user.accessToken, project.defaultBranch);
    await createBranch(repoPath, branchName);

    broadcastProgress(taskId, 'executing', 'Starting OpenCode agent...');

    const sessionResponse = await client.session.create({
      body: { 
        title: task.title,
      },
      query: {
        directory: repoPath,
      },
    });

    const sessionId = sessionResponse.data?.id;
    if (!sessionId) {
      return { success: false, error: 'Failed to create OpenCode session' };
    }

    const timeoutId = setTimeout(async () => {
      console.log(`[Execution] Task ${taskId} timed out`);
      await cancelTask(taskId);
    }, TASK_TIMEOUT_MS);

    activeExecutions.set(taskId, {
      taskId,
      projectId: project.id,
      sessionId,
      repoPath,
      branchName,
      userId,
      accessToken: user.accessToken,
      timeoutId,
      status: 'executing',
    });

    await updateTaskStatus(taskId, 'in_progress', sessionId);

    let prompt = task.title;
    if (task.description) {
      prompt += `\n\n${task.description}`;
    }
    if (task.labels.length > 0) {
      const labelNames = task.labels.map(tl => tl.label.name).join(', ');
      prompt += `\n\nLabels: ${labelNames}`;
    }

    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    }).catch((error) => {
      console.error(`[Execution] Prompt error for task ${taskId}:`, error);
    });

    console.log(`[Execution] Started for task ${taskId} in ${repoPath}`);
    return { success: true };
  } catch (error) {
    console.error(`[Execution] Failed to execute task ${taskId}:`, error);
    broadcastProgress(taskId, 'error', error instanceof Error ? error.message : 'Execution failed');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function cancelTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const execution = activeExecutions.get(taskId);

  if (!execution) {
    return { success: false, error: 'Task is not running' };
  }

  try {
    await client.session.abort({ path: { id: execution.sessionId } });
    broadcastProgress(taskId, 'cancelled', 'Execution cancelled');
    await updateTaskStatus(taskId, 'cancelled', null);
    await cleanupExecution(taskId);
    return { success: true };
  } catch (error) {
    console.error(`[Execution] Failed to cancel task ${taskId}:`, error);
    await cleanupExecution(taskId);
    return { success: true, error: error instanceof Error ? error.message : 'Abort may have failed' };
  }
}

initEventSubscription();
