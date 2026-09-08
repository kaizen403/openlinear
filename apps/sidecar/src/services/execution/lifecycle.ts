import { prisma, decryptToken } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';
import { parseModelOverride, type ModelOverride } from '@openlinear/execution-core';
import { getClientForUser } from '../opencode';
import { ensureModelConfigured } from '../opencode-model';
import { getOrCreateBuffer } from '../delta-buffer';
import { getExecutionSettings } from '../execution-settings';

import { cloneRepository, createBranch } from './git';
import { subscribeToSessionEvents, failExecutionFromEventStream, claimFinalize } from './events';
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
    teamId: string | null;
    creatorId: string | null;
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
    // T7 (H-02) — cached once here; every log line / progress broadcast for
    // this run reuses it instead of a fresh Postgres lookup.
    teamId: taskRecord.teamId,
    creatorId: taskRecord.creatorId,
    timeoutId,
    streamTimeoutId: null,
    progressTimeoutId: null,
    watchdogSuspended: false,
    finalized: false,
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
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    messageUsage: new Map(),
  };
}

async function startAgentSession(
  inputs: ExecutionInputs,
  executionState: ExecutionState,
  resolvedOverride: { override: ModelOverride; label: string } | undefined,
): Promise<void> {
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

  if (resolvedOverride) {
    addLogEntry(taskId, 'info', `Using model: ${resolvedOverride.label}`);
  }

  // T5 (R1 P0-4/H-01) — await the subscription before sending the prompt.
  // `subscribeToSessionEvents` resolves once `client.event.subscribe()` has
  // completed (the consuming loop then runs detached in the background), so
  // by the time we prompt, a fast `session.error` (bad API key, rejected
  // model) can no longer land in the gap and get silently swallowed until a
  // watchdog fires.
  await subscribeToSessionEvents(taskId, client, sessionId);

  try {
    // T5 (R1 P1-5) — `session.prompt` blocks until the full assistant turn
    // completes, so its `.then()/.catch()` raced the event-driven completion
    // path (whichever finished first "won", and both could fire). `session.
    // promptAsync` (confirmed present in the pinned @opencode-ai/sdk@1.2.5 —
    // POST /session/{id}/prompt_async, 204 "prompt accepted") returns as soon
    // as OpenCode has accepted the turn; all real completion/error signal
    // from here on arrives only through the event stream, which is the one
    // path that already carries the double-finalize guard (claimFinalize).
    const promptResult = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(resolvedOverride?.override ? { model: resolvedOverride.override } : {}),
      },
    });

    if (promptResult.error) {
      throw new Error(extractPromptErrorMessage(promptResult.error));
    }

    logger.info(`[Execution] Prompt accepted for session ${sessionId}`);
    addLogEntry(taskId, 'info', 'Task prompt sent to agent');
    // `promptSent` is set from the event stream (`session.status: busy`),
    // not optimistically here — see event-stream-processor.ts.
  } catch (err) {
    logger.error({ err, taskId }, `[Execution] Prompt error for task ${taskId}`);
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('401');
    const headline = isAuth
      ? 'Invalid API key — update it in Settings → AI Providers'
      : 'Failed to send prompt to agent';
    // Reuses the one finalize path shared with the event stream (idempotency
    // guard included) rather than duplicating finalize/update/persist/cleanup
    // here.
    await failExecutionFromEventStream(taskId, headline, msg);
  }
}

function extractPromptErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
    if (err.data && typeof err.data === 'object') {
      const data = err.data as Record<string, unknown>;
      if (typeof data.message === 'string') return data.message;
    }
  }
  return 'Prompt request was rejected';
}

/**
 * T9 (H-04/M-01) — resolves the model exactly once per run and no longer
 * ties the resolution (and therefore whether the user's selection is
 * honored at all) to whether the `AgentRun` DB row happened to insert
 * successfully. Falls back to OpenCode's global `config.get()` default only
 * when the task has no per-task override.
 */
async function getModelOverride(
  taskRecord: ExecutionInputs['taskRecord'],
  client: OpencodeClient,
): Promise<{ override: ModelOverride; label: string } | undefined> {
  let modelStr: string | null | undefined = taskRecord.model;
  if (!modelStr) {
    try {
      const config = await client.config.get();
      modelStr = config.data?.model;
    } catch (err) {
      logger.debug({ err, taskId: taskRecord.id }, `[Execution] Could not read model config for task ${taskRecord.id}`);
    }
  }
  const override = parseModelOverride(modelStr);
  if (!override) return undefined;
  return { override, label: modelStr as string };
}

export async function executeTask({ taskId, userId }: ExecuteTaskParams): Promise<{ success: boolean; error?: string; code?: string }> {
  const result = await gatherExecutionInputs({ taskId, userId });
  if (result.error || !result.inputs) {
    pendingExecutions.delete(taskId);
    return { success: false, error: result.error };
  }

  const inputs = result.inputs;

  // T9 (H-23) — restored preflight: fail fast, before the expensive clone,
  // when no model can be resolved at all. Only runs when the task has no
  // per-task override — an explicit `Task.model` is trusted as-is.
  if (!inputs.taskRecord.model) {
    try {
      const preflight = await ensureModelConfigured(inputs.userId);
      if (!preflight.model) {
        pendingExecutions.delete(taskId);
        const error = preflight.hasProvider
          ? 'A provider is connected but no model is selected. Choose a model in Settings → AI Providers.'
          : 'No AI provider is configured. Connect one in Settings → AI Providers before running tasks.';
        return { success: false, error, code: 'MODEL_NOT_CONFIGURED' };
      }
    } catch (err) {
      // Best-effort: a transient OpenCode hiccup during the *check* should
      // not itself block a run that might otherwise succeed.
      logger.warn({ err, taskId }, '[Execution] Model preflight check failed; continuing without it');
    }
  }

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

    // T9 (M-01) — resolved exactly once; passed down to both the AgentRun
    // label and the actual prompt body instead of calling `config.get()`
    // (and re-parsing the model string) a second time.
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

    await startAgentSession(inputs, executionState, modelInfo);

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

  // T5 — share the same finalize claim as the event-driven paths. Without
  // this, a cancel racing a same-tick `session.idle`/`session.error` could
  // both run to completion and finalize the AgentRun/task status twice.
  if (!claimFinalize(taskId)) {
    return { success: false, error: 'Task is already finalizing' };
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
