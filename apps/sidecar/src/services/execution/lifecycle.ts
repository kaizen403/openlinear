import { logger } from '@openlinear/api/logger';
import { HttpError, isHttpError } from '@openlinear/api/errors';
import { assertTaskOwned } from '@openlinear/api/ownership';
import { parseModelOverride, type ModelOverride } from '@openlinear/execution-core';
import { getClientForUser } from '../opencode';
import { ensureModelConfigured } from '../opencode-model';
import { getOrCreateBuffer } from '../delta-buffer';
import { getExecutionSettings } from '../execution-settings';
import { requireLegacyRunner } from '../../engine/resolve-agent';
import { getSidecarStore } from '../../persistence/store';
import { pendingBatchTasks } from '../batch/shared';
import { taskHasActiveBatch } from '../batch/admission';
import { releaseLocalWorktree, type WorkspaceHandle } from '../../workspace/local-worktree';

import { cloneRepository, createBranch } from './git';
import { subscribeToSessionEvents, failExecutionFromEventStream, claimFinalize } from './events';
import { createAgentRun, finalizeAgentRun } from './agent-run';
import {
  activeExecutions,
  pendingExecutions,
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
    project: { id: string; localPath: string | null; defaultAgent?: string | null; repository: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null } | null;
    labels: Array<{ taskId: string; labelId: string; label: { id: string; name: string; color: string } }>;
    agent?: string | null;
  };
  branchName: string;
  repoPath: string;
  workspace?: WorkspaceHandle;
  promptDispatched?: boolean;
}

async function gatherExecutionInputs({ taskId, userId }: ExecuteTaskParams): Promise<{ inputs?: ExecutionInputs; error?: string }> {
  if (!userId) return { error: 'userId is required for execution' };
  const settings = await getExecutionSettings(userId);
  const parallelLimit = settings.parallelLimit;

  // A starting task remains reserved until its prompt acknowledgement settles.
  const admittedTaskIds = new Set([...activeExecutions.keys(), ...pendingExecutions]);
  if (admittedTaskIds.size > parallelLimit) {
    return { error: `Parallel limit reached (${parallelLimit} tasks max)` };
  }

  const store = await getSidecarStore();
  let accessToken: string | null = null;

  if (userId) {
    try {
      accessToken = await store.getScmToken(userId);
    } catch (err) {
      logger.error({ err, userId }, `[Execution] Failed to decrypt access token for user ${userId}`);
      return { error: 'Failed to decrypt access token' };
    }
  }

  const authority = await assertTaskOwned(taskId, userId);
  if (authority.archived) throw new HttpError(409, 'TASK_ARCHIVED', 'Archived tasks cannot execute');
  if (authority.status === 'in_progress') throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already executing');
  const taskWithProject = await store.getTask(taskId);

  if (!taskWithProject) {
    return { error: 'Task not found' };
  }
  if (authority.id !== taskWithProject.id
    || authority.projectId !== (taskWithProject.projectId ?? taskWithProject.project?.id ?? null)
    || authority.teamId !== taskWithProject.teamId || authority.creatorId !== taskWithProject.creatorId) {
    throw new HttpError(409, 'TASK_SELECTION_CHANGED', 'Task access scope changed while execution was checked');
  }
  requireLegacyRunner({ taskAgent: taskWithProject.agent, projectDefaultAgent: taskWithProject.project?.defaultAgent });

  let useLocalPath: string | null = null;
  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

  if (taskWithProject.project?.localPath) {
    useLocalPath = taskWithProject.project.localPath;
  } else if (taskWithProject.project?.repository) {
    project = taskWithProject.project.repository;
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
    const workspace = await cloneRepository(repository.cloneUrl, repoPath, accessToken, repository.defaultBranch);
    // The provider owns checkout placement. Persist its handle before the
    // next operation so a failed branch/session setup can release it.
    inputs.workspace = workspace;
    inputs.repoPath = workspace.worktreePath;
    inputs.branchName = workspace.branch;
    await createBranch(inputs.repoPath, inputs.branchName);
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
    taskProjectId: taskRecord.project?.id ?? null,
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
  const assertStarting = () => {
    if (executionState.cancelled || executionState.finalized || activeExecutions.get(taskId) !== executionState) {
      throw new HttpError(409, 'EXECUTION_STOPPED', 'Execution stopped before the prompt was accepted');
    }
  };

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
  }, executionState);
  assertStarting();

  const store = await getSidecarStore();
  assertStarting();
  await store.updateTask(taskId, { batchId: null });
  assertStarting();

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
  assertStarting();

  try {
    // T5 (R1 P1-5) — `session.prompt` blocks until the full assistant turn
    // completes, so its `.then()/.catch()` raced the event-driven completion
    // path (whichever finished first "won", and both could fire). `session.
    // promptAsync` (confirmed present in the pinned @opencode-ai/sdk@1.2.5 —
    // POST /session/{id}/prompt_async, 204 "prompt accepted") returns as soon
    // as OpenCode has accepted the turn; all real completion/error signal
    // from here on arrives only through the event stream, which is the one
    // path that already carries the double-finalize guard (claimFinalize).
    inputs.promptDispatched = true;
    executionState.promptDispatched = true;
    const promptResult = await client.session.promptAsync({
      signal: AbortSignal.timeout(30_000),
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(resolvedOverride?.override ? { model: resolvedOverride.override } : {}),
      },
    });

    if (promptResult.error) {
      throw new Error(extractPromptErrorMessage(promptResult.error));
    }

    if (executionState.cancelled || activeExecutions.get(taskId) !== executionState) {
      // A request already dispatched can be accepted after cancellation.
      // Keep this attempt reserved until the late acceptance is reconciled.
      executionState.cancelUnconfirmed = true;
      try {
        const stopped = await client.session.abort({ path: { id: sessionId }, signal: AbortSignal.timeout(5_000) });
        if (stopped.error || stopped.data !== true) throw new Error('Provider did not confirm abort');
        executionState.cancelUnconfirmed = false;
      } catch {
        executionState.cancelUnconfirmed = true;
        activeExecutions.set(taskId, executionState);
        throw new HttpError(503, 'CANCEL_INCOMPLETE', 'Late prompt acceptance could not be stopped; work retained');
      }
      throw new HttpError(409, 'EXECUTION_STOPPED', 'Execution was cancelled during prompt submission');
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
    if (!executionState.cancelled) {
      await failExecutionFromEventStream(taskId, headline, msg);
      executionState.finalized = true;
    }
    throw err instanceof Error ? err : new Error(msg);
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
  // Reserve before the first await. A duplicate caller never owns or releases
  // the original attempt's reservation.
  if (activeExecutions.has(taskId) || pendingExecutions.has(taskId) || pendingBatchTasks.has(taskId) || taskHasActiveBatch(taskId)) {
    return { success: false, error: 'Task is already running', code: 'TASK_ALREADY_RUNNING' };
  }
  pendingExecutions.add(taskId);
  let inputs: ExecutionInputs | undefined;
  let executionState: ExecutionState | undefined;
  try {
    const result = await gatherExecutionInputs({ taskId, userId });
    if (result.error || !result.inputs) return { success: false, error: result.error };
    inputs = result.inputs;

    if (!inputs.taskRecord.model) {
      try {
        const preflight = await ensureModelConfigured(inputs.userId);
        if (!preflight.model) {
          const error = preflight.hasProvider
            ? 'A provider is connected but no model is selected. Choose a model in Settings → AI Providers.'
            : 'No AI provider is configured. Connect one in Settings → AI Providers before running tasks.';
          return { success: false, error, code: 'MODEL_NOT_CONFIGURED' };
        }
      } catch (err) {
        logger.warn({ err, taskId }, '[Execution] Model preflight check failed; continuing without it');
      }
    }

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
      throw new Error('Failed to create OpenCode session');
    }

    logger.info(`[Execution] Session ${sessionId} created for task ${taskId.slice(0, 8)}`);

    // T9 (M-01) — resolved exactly once; passed down to both the AgentRun
    // label and the actual prompt body instead of calling `config.get()`
    // (and re-parsing the model string) a second time.
    const modelInfo = await getModelOverride(inputs.taskRecord, client);
    const modelLabel = modelInfo?.label || 'unknown';

    const runnerId = requireLegacyRunner({
      taskAgent: inputs.taskRecord.agent,
      projectDefaultAgent: inputs.taskRecord.project?.defaultAgent,
    });
    const agentRunId = await createAgentRun({
      taskId,
      userId: inputs.userId,
      agent: runnerId,
      model: modelLabel,
    });

    executionState = initializeExecution(inputs, client, sessionId, agentRunId);
    await startAgentSession(inputs, executionState, modelInfo);

    logger.info(`[Execution] Started for task ${taskId} in ${inputs.repoPath}`);
    return { success: true };
  } catch (error) {
    if (executionState && !executionState.cancelled && !executionState.finalized && activeExecutions.get(taskId) === executionState) {
      try {
        await failExecutionFromEventStream(
          taskId,
          'Failed to initialize agent execution',
          error instanceof Error ? error.message : String(error),
        );
      } catch (finalizeError) {
        logger.error({ err: finalizeError, taskId }, '[Execution] Failed to finalize execution setup failure');
      }
    }
    // The finalizer must release active execution state before its checkout
    // can be reclaimed. A dispatched prompt may already have written work
    // when its acknowledgement is lost, so its checkout is retained. Local
    // projects have no owned handle and must never be removed here.
    if (inputs?.workspace && !inputs.promptDispatched && (!executionState || activeExecutions.get(taskId) !== executionState)) {
      try {
        await releaseLocalWorktree(inputs.workspace);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, taskId }, '[Execution] Failed to release worktree after setup failure');
      }
    }
    logger.error({ err: error, taskId }, `[Execution] Failed to execute task ${taskId}`);
    broadcastProgress(taskId, 'error', error instanceof Error ? error.message : 'Execution failed');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error', ...(isHttpError(error) ? { code: error.code } : {}) };
  } finally {
    pendingExecutions.delete(taskId);
  }
}

type CancellationResult = { success: boolean; error?: string };
const cancellationOperations = new WeakMap<ExecutionState, Promise<CancellationResult>>();

async function cancelExecution(taskId: string, execution: ExecutionState): Promise<CancellationResult> {
  if (execution.finalizationPending || activeExecutions.get(taskId) !== execution) {
    return { success: false, error: 'Task is already finalizing' };
  }

  // T5 — share the same finalize claim as the event-driven paths. Without
  // this, a cancel racing a same-tick `session.idle`/`session.error` could
  // both run to completion and finalize the AgentRun/task status twice.
  if (!execution.cancelUnconfirmed && !claimFinalize(taskId)) {
    return { success: false, error: 'Task is already finalizing' };
  }

  execution.cancelled = true;
  execution.cancelUnconfirmed = true;
  execution.finalizationPending = true;

  const now = new Date();
  const elapsedMs = now.getTime() - execution.startedAt.getTime();
  const estimatedProgress = estimateProgress(execution);

  addLogEntry(taskId, 'info', 'Execution cancelled by user');
  broadcastProgress(taskId, 'cancelled', 'Execution cancelled', {
    elapsedMs,
    estimatedProgress,
  });

  try {
    let persistenceError: unknown;
    try {
      await updateTaskStatus(taskId, 'cancelled', null, {
        executionPausedAt: now,
        executionElapsedMs: elapsedMs,
        executionProgress: estimatedProgress,
      }, execution);
    } catch (error) { persistenceError = error; }
    try {
      const result = await execution.client.session.abort({ path: { id: execution.sessionId }, signal: AbortSignal.timeout(5_000) });
      if (result.error || result.data !== true) throw new Error('Provider did not confirm abort');
      if (persistenceError) throw persistenceError;
      await finalizeAgentRun(execution, 'cancelled', { errorMessage: 'cancelled by user' });
      await persistLogs(taskId, execution);
    } catch (error) {
      logger.error({ err: error, taskId }, `[Execution] Cancellation could not finish for task ${taskId}`);
      return { success: false, error: 'Cancellation could not be confirmed; execution remains reserved' };
    }
    execution.cancelUnconfirmed = false;
    await cleanupExecution(taskId, execution);
    return { success: true };
  } finally {
    execution.finalizationPending = false;
  }
}

export async function cancelTask(taskId: string): Promise<CancellationResult> {
  const execution = activeExecutions.get(taskId);
  if (!execution) return { success: false, error: 'Task is not running' };
  const existing = cancellationOperations.get(execution);
  if (existing) return existing;

  const operation = cancelExecution(taskId, execution);
  cancellationOperations.set(execution, operation);
  try { return await operation; }
  finally {
    if (cancellationOperations.get(execution) === operation) cancellationOperations.delete(execution);
  }
}
