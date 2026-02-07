import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { prisma } from '@openlinear/db';
import { broadcast } from '../sse';
import { getClient, getClientForDirectory } from './opencode';

import type { OpencodeClient } from '@opencode-ai/sdk';

interface Label {
  id: string;
  name: string;
  color: string;
}

interface TaskLabelRelation {
  taskId: string;
  labelId: string;
  label: Label;
}

const execAsync = promisify(exec);

const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

interface ExecutionState {
  taskId: string;
  projectId: string;
  sessionId: string;
  repoPath: string;
  branchName: string;
  userId: string | null;
  accessToken: string | null;
  timeoutId: NodeJS.Timeout;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
  logs: ExecutionLogEntry[];
  client: OpencodeClient;
}

interface ExecutionLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}

// Maps taskId -> ExecutionState
const activeExecutions = new Map<string, ExecutionState>();

// Maps sessionId -> taskId for fast lookup
const sessionToTask = new Map<string, string>();

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
  console.log(`[Execution] ${taskId.slice(0, 8)} → ${status}: ${message}`);
  broadcast('execution:progress', { taskId, status, message, ...data });
}

function addLogEntry(taskId: string, type: ExecutionLogEntry['type'], message: string, details?: string) {
  const execution = activeExecutions.get(taskId);
  if (!execution) {
    console.log(`[Execution] Warning: No execution found for task ${taskId.slice(0, 8)} when adding log`);
    return;
  }

  const entry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    details,
  };

  execution.logs.push(entry);

  const emoji = type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'tool' ? '🔧' : type === 'agent' ? '🤖' : '→';
  console.log(`[Execution] ${taskId.slice(0, 8)} ${emoji} ${message}${details ? ` (${details.slice(0, 50)})` : ''}`);

  broadcast('execution:log', { taskId, entry });
}

export function getExecutionLogs(taskId: string): ExecutionLogEntry[] {
  const execution = activeExecutions.get(taskId);
  return execution?.logs || [];
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
      labels: task.labels.map((tl: TaskLabelRelation) => tl.label),
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
    sessionToTask.delete(execution.sessionId);
    activeExecutions.delete(taskId);
    console.log(`[Execution] Cleaned up task ${taskId.slice(0, 8)}, remaining: ${activeExecutions.size}`);
  }
}

async function cloneRepository(
  cloneUrl: string,
  repoPath: string,
  accessToken: string | null,
  defaultBranch: string
): Promise<void> {
  console.log(`[Execution] Preparing to clone into ${repoPath}`);
  
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    console.log(`[Execution] Created repos directory: ${REPOS_DIR}`);
  }

  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
    console.log(`[Execution] Removed existing directory: ${repoPath}`);
  }

  const url = accessToken 
    ? cloneUrl.replace('https://', `https://oauth2:${accessToken}@`)
    : cloneUrl;
  
  console.log(`[Execution] Cloning ${cloneUrl} (branch: ${defaultBranch})...`);
  await execAsync(`git clone --depth 1 --branch ${defaultBranch} ${url} ${repoPath}`);
  console.log(`[Execution] Clone complete`);
}

async function createBranch(repoPath: string, branchName: string): Promise<void> {
  console.log(`[Execution] Creating branch: ${branchName}`);
  await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
  console.log(`[Execution] Branch created and checked out`);
}

async function commitAndPush(
  repoPath: string,
  branchName: string,
  taskTitle: string
): Promise<boolean> {
  try {
    console.log(`[Execution] Checking for changes in ${repoPath}`);
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
    
    if (!status.trim()) {
      console.log(`[Execution] No changes to commit`);
      return false;
    }

    console.log(`[Execution] Changes detected, staging files...`);
    await execAsync('git add -A', { cwd: repoPath });
    
    const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
    console.log(`[Execution] Committing: ${commitMessage}`);
    await execAsync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
    
    console.log(`[Execution] Pushing to origin/${branchName}...`);
    await execAsync(`git push -u origin ${branchName}`, { cwd: repoPath });
    console.log(`[Execution] Push complete`);
    
    return true;
  } catch (error) {
    console.error('[Execution] Commit/push failed:', error);
    return false;
  }
}

interface PullRequestResult {
  url: string;
  type: 'pr' | 'compare';
}

async function createPullRequest(
  fullName: string,
  branchName: string,
  defaultBranch: string,
  taskTitle: string,
  taskDescription: string | null,
  accessToken: string | null
): Promise<PullRequestResult> {
  const [owner, repo] = fullName.split('/');
  const compareUrl = `https://github.com/${owner}/${repo}/compare/${defaultBranch}...${branchName}`;

  if (!accessToken) {
    console.log('[Execution] No access token - returning compare URL for manual PR creation');
    return { url: compareUrl, type: 'compare' };
  }

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
      // Return compare URL as fallback when API fails
      return { url: compareUrl, type: 'compare' };
    }

    const pr = (await response.json()) as { html_url: string };
    return { url: pr.html_url, type: 'pr' };
  } catch (error) {
    console.error('[Execution] PR creation error:', error);
    // Return compare URL as fallback on error
    return { url: compareUrl, type: 'compare' };
  }
}

function findTaskBySessionId(sessionId: string): string | undefined {
  // Fast path: use the lookup map
  const taskId = sessionToTask.get(sessionId);
  if (taskId) return taskId;
  
  // Fallback: scan activeExecutions (shouldn't be needed)
  for (const [tid, execution] of activeExecutions.entries()) {
    if (execution.sessionId === sessionId) {
      // Update the lookup map
      sessionToTask.set(sessionId, tid);
      return tid;
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
    addLogEntry(taskId, 'info', 'Agent finished, committing changes...');

    const hasChanges = await commitAndPush(
      execution.repoPath,
      execution.branchName,
      await getTaskTitle(taskId)
    );

    if (hasChanges) {
      execution.status = 'creating_pr';
      broadcastProgress(taskId, 'creating_pr', 'Creating pull request...');
      addLogEntry(taskId, 'info', 'Creating pull request...');

      const project = await prisma.project.findUnique({
        where: { id: execution.projectId },
      });

      if (project) {
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        const result = await createPullRequest(
          project.fullName,
          execution.branchName,
          project.defaultBranch,
          task?.title || 'Task',
          task?.description || null,
          execution.accessToken
        );

        if (result.type === 'pr') {
          addLogEntry(taskId, 'success', 'Pull request created', result.url);
          broadcastProgress(taskId, 'done', 'Pull request created', { prUrl: result.url, isCompareLink: false });
        } else {
          addLogEntry(taskId, 'success', 'Changes pushed! Create PR here:', result.url);
          broadcastProgress(taskId, 'done', 'Changes pushed successfully', { prUrl: result.url, isCompareLink: true });
        }
      }
    } else {
      addLogEntry(taskId, 'info', 'Completed with no changes');
      broadcastProgress(taskId, 'done', 'Completed with no changes');
    }

    await updateTaskStatus(taskId, 'done', null);
  } catch (error) {
    console.error('[Execution] Post-execution error:', error);
    addLogEntry(taskId, 'error', 'Post-execution failed');
    broadcastProgress(taskId, 'error', 'Post-execution failed');
  } finally {
    await cleanupExecution(taskId);
  }
}

async function getTaskTitle(taskId: string): Promise<string> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  return task?.title || 'Task';
}

// Extract session ID from various OpenCode event structures
function extractSessionId(event: { type: string; properties?: Record<string, unknown> }): string | undefined {
  const props = event.properties || {};
  
  // Direct sessionID on properties
  if (typeof props.sessionID === 'string') return props.sessionID;
  
  // Direct id on properties (for session.* events)
  if (typeof props.id === 'string' && props.id.startsWith('ses_')) return props.id;
  
  // Nested in info object
  const info = props.info as { id?: string; sessionID?: string } | undefined;
  if (info?.sessionID) return info.sessionID;
  if (info?.id && typeof info.id === 'string' && info.id.startsWith('ses_')) return info.id;
  
  // Nested in part object
  const part = props.part as { sessionID?: string } | undefined;
  if (part?.sessionID) return part.sessionID;
  
  // Nested in session object
  const session = props.session as { id?: string } | undefined;
  if (session?.id) return session.id;
  
  return undefined;
}

async function handleOpenCodeEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
  if (event.type === 'server.heartbeat') return;
  
  const sessionId = extractSessionId(event);
  const taskId = sessionId ? findTaskBySessionId(sessionId) : undefined;

  switch (event.type) {
    case 'session.idle':
    case 'session.completed':
      if (taskId) {
        addLogEntry(taskId, 'success', 'Agent completed work');
        await handleSessionComplete(taskId);
      }
      break;

    case 'session.error':
      if (taskId) {
        const errorMsg = (event.properties?.error as string) || 'Unknown error';
        addLogEntry(taskId, 'error', 'Execution failed', errorMsg);
        broadcastProgress(taskId, 'error', 'Execution failed');
        await updateTaskStatus(taskId, 'cancelled', null);
        await cleanupExecution(taskId);
      }
      break;

    case 'session.status': {
      if (!taskId) break;
      const status = event.properties?.status as { type?: string; message?: string };
      if (status?.type === 'busy') {
        addLogEntry(taskId, 'agent', 'Agent is thinking...');
        broadcastProgress(taskId, 'executing', 'Agent is thinking...');
      } else if (status?.type === 'retry') {
        addLogEntry(taskId, 'info', `Retrying: ${status.message || 'unknown reason'}`);
      }
      break;
    }

    case 'message.part.updated': {
      if (!taskId) break;
      const part = event.properties?.part as { type?: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } };
      const delta = event.properties?.delta as string;

      if (part?.type === 'text' && delta) {
        const trimmed = delta.trim();
        if (trimmed.length > 0 && trimmed.length < 200) {
          addLogEntry(taskId, 'agent', trimmed);
        }
      } else if (part?.type === 'tool') {
        const toolName = part.tool || 'unknown tool';
        const state = part.state;
        if (state?.status === 'running') {
          addLogEntry(taskId, 'tool', `Running: ${state.title || toolName}`);
          broadcastProgress(taskId, 'executing', `Running: ${state.title || toolName}`);
        } else if (state?.status === 'completed') {
          const output = state.output?.slice(0, 100) || '';
          addLogEntry(taskId, 'success', `Completed: ${toolName}`, output);
        } else if (state?.status === 'error') {
          addLogEntry(taskId, 'error', `Failed: ${toolName}`, state.output);
        }
      } else if (part?.type === 'reasoning') {
        const reasoning = delta || part.text || '';
        if (reasoning.length > 10 && reasoning.length < 200) {
          addLogEntry(taskId, 'agent', `Thinking: ${reasoning.slice(0, 100)}`);
        }
      }
      break;
    }

    case 'tool.execute.before': {
      if (!taskId) break;
      const tool = event.properties?.tool as string;
      if (tool) {
        addLogEntry(taskId, 'tool', `Starting: ${tool}`);
      }
      break;
    }

    case 'tool.execute.after': {
      if (!taskId) break;
      const tool = event.properties?.tool as string;
      const output = event.properties?.output as string;
      if (tool) {
        addLogEntry(taskId, 'success', `Finished: ${tool}`, output?.slice(0, 100));
      }
      break;
    }

    case 'file.edited': {
      if (!taskId) break;
      const file = event.properties?.file as string;
      if (file) {
        addLogEntry(taskId, 'success', `Edited file: ${file}`);
      }
      break;
    }

    default:
      break;
  }
}

export async function initEventSubscription(): Promise<void> {
  if (eventSubscriptionActive) return;

  try {
    const events = await getClient().event.subscribe();
    eventSubscriptionActive = true;
    console.log('[Execution] Global event subscription initialized');

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

async function subscribeToSessionEvents(taskId: string, client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    const events = await client.event.subscribe();
    
    (async () => {
      try {
        for await (const event of events.stream) {
          const eventSessionId = extractSessionId(event);
          if (eventSessionId === sessionId) {
            await handleOpenCodeEvent(event);
          }
        }
      } catch (error) {
        console.error(`[Execution] Event stream error for task ${taskId.slice(0, 8)}:`, error);
      }
    })();
  } catch (error) {
    console.error(`[Execution] Failed to subscribe to events for task ${taskId.slice(0, 8)}:`, error);
    addLogEntry(taskId, 'error', 'Failed to subscribe to agent events');
  }
}

interface ExecuteTaskParams {
  taskId: string;
  userId?: string;
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

  let accessToken: string | null = null;
  let project;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accessToken: true },
    });
    accessToken = user?.accessToken ?? null;

    project = await prisma.project.findFirst({
      where: { userId, isActive: true },
    });
  } else {
    project = await prisma.project.findFirst({
      where: { userId: null, isActive: true },
    });
  }

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
    // Step 1: Clone
    broadcastProgress(taskId, 'cloning', 'Cloning repository...');
    await cloneRepository(project.cloneUrl, repoPath, accessToken, project.defaultBranch);
    await createBranch(repoPath, branchName);

    broadcastProgress(taskId, 'executing', 'Starting OpenCode agent...');

    const client = getClientForDirectory(repoPath);
    
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
      console.error(`[Execution] Failed to create session for task ${taskId.slice(0, 8)}`);
      return { success: false, error: 'Failed to create OpenCode session' };
    }

    console.log(`[Execution] Session ${sessionId} created for task ${taskId.slice(0, 8)}`);

    // Set up timeout
    const timeoutId = setTimeout(async () => {
      console.log(`[Execution] Task ${taskId} timed out`);
      await cancelTask(taskId);
    }, TASK_TIMEOUT_MS);

    // Register in both maps
    const executionState: ExecutionState = {
      taskId,
      projectId: project.id,
      sessionId,
      repoPath,
      branchName,
      userId: userId ?? null,
      accessToken,
      timeoutId,
      status: 'executing',
      logs: [],
      client,
    };

    activeExecutions.set(taskId, executionState);
    sessionToTask.set(sessionId, taskId);

    // Add initial log entries
    addLogEntry(taskId, 'info', 'Repository cloned successfully');
    addLogEntry(taskId, 'info', `Branch created: ${branchName}`);
    addLogEntry(taskId, 'info', 'OpenCode agent started');

    await updateTaskStatus(taskId, 'in_progress', sessionId);

    // Build prompt
    let prompt = task.title;
    if (task.description) {
      prompt += `\n\n${task.description}`;
    }
    if (task.labels.length > 0) {
      const labelNames = task.labels.map((tl: TaskLabelRelation) => tl.label.name).join(', ');
      prompt += `\n\nLabels: ${labelNames}`;
    }

    // Step 3: Send prompt and subscribe to events using the scoped client
    subscribeToSessionEvents(taskId, client, sessionId);
    
    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    }).then(() => {
      console.log(`[Execution] Prompt sent to session ${sessionId}`);
      addLogEntry(taskId, 'info', 'Task prompt sent to agent');
    }).catch((err: Error) => {
      console.error(`[Execution] Prompt error for task ${taskId}:`, err);
      addLogEntry(taskId, 'error', 'Failed to send prompt to agent', err.message);
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
    await execution.client.session.abort({ path: { id: execution.sessionId } });
    addLogEntry(taskId, 'info', 'Execution cancelled by user');
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
