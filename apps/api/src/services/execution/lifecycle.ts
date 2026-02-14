import { join } from 'path';
import { prisma } from '@openlinear/db';
import { getClientForUser, toContainerPath } from '../opencode';
import { getOrCreateBuffer } from '../delta-buffer';

import { cloneRepository, createBranch } from './git';
import { subscribeToSessionEvents } from './events';
import {
  activeExecutions,
  sessionToTask,
  broadcastProgress,
  addLogEntry,
  estimateProgress,
  persistLogs,
  cleanupExecution,
  updateTaskStatus,
  ExecutionState,
  ExecuteTaskParams,
  TaskLabelRelation,
  REPOS_DIR,
  TASK_TIMEOUT_MS,
} from './state';

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
  let useLocalPath: string | null = null;
  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accessToken: true },
    });
    accessToken = user?.accessToken ?? null;
  }

  const taskWithProject = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      project: { include: { repository: true } },
      labels: { include: { label: true } },
    },
  });

  if (!taskWithProject) {
    return { success: false, error: 'Task not found' };
  }

  if (taskWithProject.project?.localPath) {
    useLocalPath = taskWithProject.project.localPath;
  } else if (taskWithProject.project?.repository) {
    project = taskWithProject.project.repository;
  } else if (userId) {
    project = await prisma.repository.findFirst({
      where: { userId, isActive: true },
    });
  } else {
    project = await prisma.repository.findFirst({
      where: { userId: null, isActive: true },
    });
  }

  if (!project && !useLocalPath) {
    return { success: false, error: 'No active project selected' };
  }

  const branchName = `openlinear/${taskId.slice(0, 8)}`;
  let repoPath: string;

  if (useLocalPath) {
    repoPath = useLocalPath;
  } else if (project) {
    repoPath = join(REPOS_DIR, project.name, taskId.slice(0, 8));
  } else {
    return { success: false, error: 'No active project selected' };
  }

  try {
    // Step 1: Clone
    if (useLocalPath) {
      broadcastProgress(taskId, 'cloning', 'Using local repository...');
    } else if (project) {
      broadcastProgress(taskId, 'cloning', 'Cloning repository...');
      await cloneRepository(project.cloneUrl, repoPath, accessToken, project.defaultBranch);
      await createBranch(repoPath, branchName);
    }

    broadcastProgress(taskId, 'executing', 'Starting OpenCode agent...');

    if (!userId) {
      return { success: false, error: 'userId is required for container-per-user execution' };
    }

    const client = await getClientForUser(userId, repoPath);
    
    const containerPath = toContainerPath(repoPath);
    const sessionResponse = await client.session.create({
      body: { 
        title: taskWithProject.title,
      },
      query: {
        directory: containerPath,
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
      projectId: project?.id || taskWithProject?.project?.id || 'local',
      sessionId,
      repoPath,
      branchName,
      userId: userId ?? null,
      accessToken,
      timeoutId,
      status: 'executing',
      logs: [],
      client,
      startedAt: new Date(),
      filesChanged: 0,
      toolsExecuted: 0,
      promptSent: false,
      cancelled: false,
    };

    activeExecutions.set(taskId, executionState);
    sessionToTask.set(sessionId, taskId);
    getOrCreateBuffer(taskId, (msg) => addLogEntry(taskId, 'agent', msg));

    // Add initial log entries
    if (useLocalPath) {
      addLogEntry(taskId, 'info', `Using local repository: ${repoPath}`);
    } else {
      addLogEntry(taskId, 'info', 'Repository cloned successfully');
      addLogEntry(taskId, 'info', `Branch created: ${branchName}`);
    }
    addLogEntry(taskId, 'info', 'OpenCode agent started');

    await updateTaskStatus(taskId, 'in_progress', sessionId, {
      executionStartedAt: executionState.startedAt,
      executionPausedAt: null,
      executionProgress: 0,
    });

    await prisma.task.update({
      where: { id: taskId },
      data: { batchId: null },
    });

    // Build prompt
    let prompt = taskWithProject.title;
    if (taskWithProject.description) {
      prompt += `\n\n${taskWithProject.description}`;
    }
    if (taskWithProject.labels.length > 0) {
      const labelNames = taskWithProject.labels.map((tl: TaskLabelRelation) => tl.label.name).join(', ');
      prompt += `\n\nLabels: ${labelNames}`;
    }

    subscribeToSessionEvents(taskId, client, sessionId);

    let modelOverride: { providerID: string; modelID: string } | undefined;
    try {
      const config = await client.config.get();
      const modelStr = config.data?.model;
      if (modelStr && modelStr.includes('/')) {
        const slashIdx = modelStr.indexOf('/');
        modelOverride = {
          providerID: modelStr.slice(0, slashIdx),
          modelID: modelStr.slice(slashIdx + 1),
        };
        addLogEntry(taskId, 'info', `Using model: ${modelStr}`);
      }
    } catch (err) {
      console.debug(`[Execution] Could not read model config for task ${taskId.slice(0, 8)}:`, err);
    }

    client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(modelOverride ? { model: modelOverride } : {}),
      },
    }).then(() => {
      console.log(`[Execution] Prompt sent to session ${sessionId}`);
      executionState.promptSent = true;
      addLogEntry(taskId, 'info', 'Task prompt sent to agent');
    }).catch(async (err: Error) => {
      console.error(`[Execution] Prompt error for task ${taskId}:`, err);
      const msg = err.message || 'Unknown error';
      const isAuth = msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('401');
      const headline = isAuth
        ? 'Invalid API key — update it in Settings → AI Providers'
        : 'Failed to send prompt to agent';
      addLogEntry(taskId, 'error', headline, msg);
      broadcastProgress(taskId, 'error', headline);
      await updateTaskStatus(taskId, 'cancelled', null);
      await persistLogs(taskId);
      await cleanupExecution(taskId);
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

  execution.cancelled = true;

  const now = new Date();
  const elapsedMs = now.getTime() - execution.startedAt.getTime();
  const estimatedProgress = estimateProgress(execution);

  addLogEntry(taskId, 'info', 'Execution cancelled by user');
  broadcastProgress(taskId, 'cancelled', 'Execution cancelled', {
    elapsedMs,
    estimatedProgress,
  });

  await updateTaskStatus(taskId, 'cancelled', null, {
    executionPausedAt: now,
    executionElapsedMs: elapsedMs,
    executionProgress: estimatedProgress,
  });

  try {
    await execution.client.session.abort({ path: { id: execution.sessionId } });
  } catch (error) {
    console.error(`[Execution] Abort call failed for task ${taskId}:`, error);
  }

  await persistLogs(taskId);
  await cleanupExecution(taskId);
  return { success: true };
}
