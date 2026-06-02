import { prisma, decryptToken } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';
import { getClientForUser } from '../opencode';
import { getOrCreateBuffer } from '../delta-buffer';
import { getExecutionSettings } from '../execution-settings';

import { cloneRepository, createBranch } from './git';
import { subscribeToSessionEvents } from './events';
import { createAgentRun, finalizeAgentRun } from './agent-run';
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
  TASK_TIMEOUT_MS,
  buildReposPath,
} from './state';

import type { OpencodeClient } from '@opencode-ai/sdk';

const pendingExecutions = new Set<string>();

interface ExecutionInputs {
  taskId: string;
  userId: string;
  accessToken: string | null;
  project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null;
  useLocalPath: string | null;
  taskRecord: {
    id: string;
    title: string;
    description: string | null;
    model: string | null;
    project: { id: string; localPath: string | null; repository: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null } | null;
    labels: Array<{ taskId: string; labelId: string; label: { id: string; name: string; color: string } }>;
  };
  branchName: string;
  repoPath: string;
}

async function gatherExecutionInputs({ taskId, userId }: ExecuteTaskParams): Promise<{ inputs?: ExecutionInputs; error?: string }> {
  if (activeExecutions.has(taskId) || pendingExecutions.has(taskId)) {
    return { error: 'Task is already running' };
  }

  pendingExecutions.add(taskId);

  const settings = await getExecutionSettings(userId);
  const parallelLimit = settings.parallelLimit;

  if (activeExecutions.size >= parallelLimit) {
    return { error: `Parallel limit reached (${parallelLimit} tasks max)` };
  }

  let accessToken: string | null = null;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accessToken: true },
    });
    try {
      accessToken = decryptToken(user?.accessToken ?? null);
    } catch (err) {
      logger.error({ err, userId }, `[Execution] Failed to decrypt access token for user ${userId}`);
      return { error: 'Failed to decrypt access token' };
    }
  }

  const taskWithProject = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      project: { include: { repository: true } },
      labels: { include: { label: true } },
    },
  });

  if (!taskWithProject) {
    return { error: 'Task not found' };
  }

  let useLocalPath: string | null = null;
  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

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
    return { error: 'No active project selected' };
  }

  if (!userId) {
    return { error: 'userId is required for execution' };
  }

  const branchName = `openlinear/${taskId.slice(0, 8)}`;
  const repoPath = useLocalPath ?? buildReposPath(project!.name, taskId.slice(0, 8));

  return {
    inputs: {
      taskId,
      userId,
      accessToken,
      project,
      useLocalPath,
      taskRecord: taskWithProject as unknown as ExecutionInputs['taskRecord'],
      branchName,
      repoPath,
    },
  };
}

async function setupRepository(inputs: ExecutionInputs): Promise<void> {
  const { taskId, useLocalPath, project, repoPath, branchName, accessToken } = inputs;

  if (useLocalPath) {
    broadcastProgress(taskId, 'cloning', 'Preparing local repository...');
    await createBranch(repoPath, branchName);
  } else {
    const repository = project!;
    broadcastProgress(taskId, 'cloning', 'Cloning repository...');
    await cloneRepository(repository.cloneUrl, repoPath, accessToken, repository.defaultBranch);
    await createBranch(repoPath, branchName);
  }
}

function initializeExecution(
  inputs: ExecutionInputs,
  client: OpencodeClient,
  sessionId: string,
  agentRunId: string | null,
): ExecutionState {
  const { taskId, project, useLocalPath, repoPath, branchName, userId, accessToken, taskRecord } = inputs;

  const timeoutId = setTimeout(async () => {
    logger.info(`[Execution] Task ${taskId} timed out`);
    await cancelTask(taskId);
  }, TASK_TIMEOUT_MS);

  return {
    taskId,
    projectId: project?.id || taskRecord.project?.id || 'local',
    sessionId,
    repoPath,
    branchName,
    userId,
    accessToken,
    timeoutId,
    streamTimeoutId: null,
    status: 'executing',
    logs: [],
    client,
    startedAt: new Date(),
    filesChanged: 0,
    toolsExecuted: 0,
    promptSent: false,
    backgroundTaskRunning: false,
    backgroundTaskFailure: null,
    backgroundTaskIds: [],
    backgroundTaskResultBuffer: '',
    completedToolKeys: new Set(),
    cancelled: false,
    agentRunId,
    cost: { input: 0, output: 0, total: 0 },
    tokens: { input: 0, output: 0 },
    messageUsage: new Map(),
  };
}

async function startAgentSession(inputs: ExecutionInputs, executionState: ExecutionState): Promise<void> {
  const { taskId, useLocalPath, repoPath, branchName, taskRecord } = inputs;
  const { client, sessionId } = executionState;

  activeExecutions.set(taskId, executionState);
  sessionToTask.set(sessionId, taskId);
  getOrCreateBuffer(taskId, (msg) => addLogEntry(taskId, 'agent', msg));

  if (useLocalPath) {
    addLogEntry(taskId, 'info', `Using local repository: ${repoPath}`);
    addLogEntry(taskId, 'info', `Branch created: ${branchName}`);
  } else {
    addLogEntry(taskId, 'info', 'Repository cloned successfully');
    addLogEntry(taskId, 'info', `Branch created: ${branchName}`);
  }
  addLogEntry(taskId, 'info', 'OpenCode agent started');

  await updateTaskStatus(taskId, 'in_progress', sessionId, {
    executionStartedAt: executionState.startedAt,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: 0,
  });

  await prisma.task.update({
    where: { id: taskId },
    data: { batchId: null },
  });

  let prompt = taskRecord.title;
  if (taskRecord.description) {
    prompt += `\n\n${taskRecord.description}`;
  }
  if (taskRecord.labels.length > 0) {
    const labelNames = taskRecord.labels.map((tl: { label: { name: string } }) => tl.label.name).join(', ');
    prompt += `\n\nLabels: ${labelNames}`;
  }
  prompt += [
    '',
    '',
    'Execution contract:',
    '- Make the requested code changes directly in this repository before finishing.',
    '- If you use a background subtask, wait for its result and apply any required changes before completing.',
    '- Do not mark the task complete unless the repository contains the requested changes or you can explain why no code change is valid.',
  ].join('\n');

  subscribeToSessionEvents(taskId, client, sessionId);

  /* v8 ignore start -- agentRunId is always present after createAgentRun. */
  const modelOverride = executionState.agentRunId
    ? getModelOverride(taskRecord, client)
    : undefined;
  /* v8 ignore stop */
  const resolvedOverride = await modelOverride;

  if (resolvedOverride) {
    addLogEntry(taskId, 'info', `Using model: ${resolvedOverride.label}`);
  }

  client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: prompt }],
      ...(resolvedOverride?.override ? { model: resolvedOverride.override } : {}),
    },
  }).then(() => {
    logger.info(`[Execution] Prompt sent to session ${sessionId}`);
    executionState.promptSent = true;
    addLogEntry(taskId, 'info', 'Task prompt sent to agent');
  }).catch(async (err: Error) => {
    logger.error({ err, taskId }, `[Execution] Prompt error for task ${taskId}`);
    const msg = err.message || 'Unknown error';
    const isAuth = msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('401');
    const headline = isAuth
      ? 'Invalid API key — update it in Settings → AI Providers'
      : 'Failed to send prompt to agent';
    addLogEntry(taskId, 'error', headline, msg);
    broadcastProgress(taskId, 'error', headline);
    await finalizeAgentRun(executionState, 'failed', { errorMessage: msg });
    await updateTaskStatus(taskId, 'cancelled', null);
    await persistLogs(taskId);
    await cleanupExecution(taskId);
  });
}

async function getModelOverride(
  taskRecord: ExecutionInputs['taskRecord'],
  client: OpencodeClient,
): Promise<{ override: { providerID: string; modelID: string }; label: string } | undefined> {
  let modelStr: string | null | undefined = taskRecord.model;
  if (!modelStr) {
    try {
      const config = await client.config.get();
      modelStr = config.data?.model;
    } catch (err) {
      logger.debug({ err, taskId: taskRecord.id }, `[Execution] Could not read model config for task ${taskRecord.id}`);
    }
  }
  if (modelStr && modelStr.includes('/')) {
    const slashIdx = modelStr.indexOf('/');
    return {
      override: {
        providerID: modelStr.slice(0, slashIdx),
        modelID: modelStr.slice(slashIdx + 1),
      },
      label: modelStr,
    };
  }
  return undefined;
}

export async function executeTask({ taskId, userId }: ExecuteTaskParams): Promise<{ success: boolean; error?: string }> {
  const result = await gatherExecutionInputs({ taskId, userId });
  if (result.error || !result.inputs) {
    pendingExecutions.delete(taskId);
    return { success: false, error: result.error };
  }

  const inputs = result.inputs;

  try {
    await setupRepository(inputs);

    broadcastProgress(taskId, 'executing', 'Starting OpenCode agent...');

    const client = await getClientForUser(inputs.userId, inputs.repoPath);

    const sessionResponse = await client.session.create({
      body: { title: inputs.taskRecord.title },
      query: { directory: inputs.repoPath },
    });

    const sessionId = sessionResponse.data?.id;
    if (!sessionId) {
      logger.error(`[Execution] Failed to create session for task ${taskId.slice(0, 8)}`);
      pendingExecutions.delete(taskId);
      return { success: false, error: 'Failed to create OpenCode session' };
    }

    logger.info(`[Execution] Session ${sessionId} created for task ${taskId.slice(0, 8)}`);

    const modelInfo = await getModelOverride(inputs.taskRecord, client);
    const modelLabel = modelInfo?.label || 'unknown';

    const agentRunId = await createAgentRun({
      taskId,
      userId: inputs.userId,
      agent: 'opencode',
      model: modelLabel,
    });

    const executionState = initializeExecution(inputs, client, sessionId, agentRunId);
    pendingExecutions.delete(taskId);

    await startAgentSession(inputs, executionState);

    logger.info(`[Execution] Started for task ${taskId} in ${inputs.repoPath}`);
    return { success: true };
  } catch (error) {
    pendingExecutions.delete(taskId);
    logger.error({ err: error, taskId }, `[Execution] Failed to execute task ${taskId}`);
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
    logger.error({ err: error, taskId }, `[Execution] Abort call failed for task ${taskId}`);
  }

  await finalizeAgentRun(execution, 'cancelled', { errorMessage: 'cancelled by user' });
  await persistLogs(taskId);
  await cleanupExecution(taskId);
  return { success: true };
}
