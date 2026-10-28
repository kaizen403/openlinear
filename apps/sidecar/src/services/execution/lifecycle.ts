import { logger } from '../../lib/logger';
import { HttpError, isHttpError } from '../../lib/errors';
import { isCloudUnavailable } from '../../config/cloud-api';
import { parseModelOverride, type ModelOverride } from '@openlinear/execution-core';
import { getClientForUser } from '../opencode';
import { ensureModelConfigured } from '../opencode-model';
import { getOrCreateBuffer } from '../delta-buffer';
import { requireLegacyRunner } from '../../engine/resolve-agent';
import { getSidecarStore, type AttemptContext } from '../../persistence/store';
import { pendingBatchTasks, taskHasActiveBatch } from '../batch/registry';
import { releaseLocalWorktree, type WorkspaceHandle } from '../../workspace/local-worktree';
import { attachAttemptRelay, detachAttemptRelay, publishTaskEvent } from '../../events/publisher';
import { AttemptEventRelay } from '../../events/relay';

import { cloneRepository, createBranch } from './git';
import { subscribeToSessionEvents, failExecutionFromEventStream, claimFinalize } from './events';
import { finalizeAgentRun } from './agent-run';
import {
  activeExecutions,
  pendingExecutions,
  pendingExecutionOwners,
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

/** Interval of the attempt heartbeat (lease liveness + cloud cancellation). */
export const ATTEMPT_HEARTBEAT_MS = 30_000;

/** `OPENLINEAR_ATTEMPT_HEARTBEAT_MS`, bounded to [1 s, 5 min]. */
export function attemptHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.OPENLINEAR_ATTEMPT_HEARTBEAT_MS ?? '', 10);
  if (!Number.isFinite(raw)) return ATTEMPT_HEARTBEAT_MS;
  return Math.min(Math.max(raw, 1_000), 300_000);
}

interface ExecutionInputs {
  taskId: string;
  userId: string;
  /** W03a: the control-plane attempt (capability in API mode). */
  attempt: AttemptContext;
  runnerId?: string;
  modelLabel?: string;
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

/**
 * Authorization and availability failures during admission keep their HTTP
 * status (401/403/404 from the control plane, 503 when it is unreachable or
 * unconfigured) instead of becoming the legacy 400 setup error.
 */
function isAdmissionDenial(error: unknown): boolean {
  return isHttpError(error)
    && (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404 || isCloudUnavailable(error)
      // W17a: keeps its 409 and the blocker list so the UI can offer "run anyway".
      || error.code === 'TASK_BLOCKED');
}

async function closeQuietly(attempt: AttemptContext, reason: string): Promise<void> {
  try {
    const store = await getSidecarStore();
    await store.closeAttempt(attempt, reason);
  } catch (error) {
    logger.warn({ err: error, taskId: attempt.taskId }, '[Execution] attempt release failed; capability expires on its own');
  }
}

async function gatherExecutionInputs({ taskId, userId, credential, allowBlocked }: ExecuteTaskParams): Promise<{ inputs?: ExecutionInputs; error?: string; code?: string }> {
  if (!userId) return { error: 'userId is required for execution' };
  const store = await getSidecarStore();
  // Authorization (execute permission), the immutable snapshot and the
  // attempt come from the store: server-side in API mode.
  const started = await store.startAttempt({
    taskId,
    userId,
    credential: credential ?? null,
    allowBlocked: allowBlocked === true,
    // A starting task remains reserved until its prompt acknowledgement settles.
    admit: (settings) => {
      const admittedTaskIds = new Set([...activeExecutions.keys(), ...pendingExecutions]);
      return admittedTaskIds.size > settings.parallelLimit
        ? `Parallel limit reached (${settings.parallelLimit} tasks max)`
        : null;
    },
  });
  if (!started.ok) return { error: started.error, ...(started.code ? { code: started.code } : {}) };
  const { attempt, task: taskWithProject } = started;

  try {
    requireLegacyRunner({ taskAgent: taskWithProject.agent, projectDefaultAgent: taskWithProject.project?.defaultAgent });
  } catch (error) {
    await closeQuietly(attempt, 'runner_not_supported');
    throw error;
  }

  let accessToken: string | null = null;
  try {
    accessToken = await store.getGitCredential(attempt, 'clone');
  } catch (err) {
    await closeQuietly(attempt, 'git_credential_unavailable');
    if (isAdmissionDenial(err)) throw err;
    logger.error({ err, userId }, `[Execution] Failed to decrypt access token for user ${userId}`);
    return { error: 'Failed to decrypt access token' };
  }

  let useLocalPath: string | null = null;
  let project: { id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null = null;

  if (taskWithProject.project?.localPath) {
    useLocalPath = taskWithProject.project.localPath;
  } else if (taskWithProject.project?.repository) {
    project = taskWithProject.project.repository;
  }

  if (!project && !useLocalPath) {
    await closeQuietly(attempt, 'no_repository');
    return { error: 'No active project selected' };
  }

  const branchName = `openlinear/${taskId.slice(0, 8)}`;
  const repoPath = useLocalPath ?? buildReposPath(project!.name, taskId.slice(0, 8));

  return {
    inputs: {
      taskId,
      userId,
      attempt,
      accessToken,
      project,
      useLocalPath,
      taskRecord: taskWithProject as unknown as ExecutionInputs['taskRecord'],
      branchName,
      repoPath,
    },
  };
}

/** API mode: relay this attempt's progress/log events to the control plane. */
function attachRelay(attempt: AttemptContext): AttemptEventRelay | undefined {
  const client = attempt.client;
  if (!client) return undefined;
  const relay = new AttemptEventRelay({
    send: (events) => client.sendEvents(events),
    onCancelRequested: () => requestCancellationFromControlPlane(attempt.taskId),
  });
  attachAttemptRelay(attempt.taskId, relay);
  return relay;
}

/** A cancellation requested through the control plane runs the local cancel path. */
function requestCancellationFromControlPlane(taskId: string): void {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled || execution.finalizationPending) return;
  logger.info(`[Execution] Cancellation requested by the control plane for task ${taskId.slice(0, 8)}`);
  void cancelTask(taskId).catch((error: unknown) => {
    logger.error({ err: error, taskId }, '[Execution] control-plane cancellation failed');
  });
}

function startHeartbeat(executionState: ExecutionState): void {
  const attempt = executionState.attempt;
  if (!attempt?.client) return;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const store = await getSidecarStore();
        const beat = await store.heartbeat(attempt);
        if (beat.cancelRequested) requestCancellationFromControlPlane(attempt.taskId);
      } catch (error) {
        logger.debug({ err: error, taskId: attempt.taskId }, '[Execution] attempt heartbeat failed');
      }
    })();
  }, attemptHeartbeatMs());
  timer.unref?.();
  executionState.heartbeatTimer = timer;
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
    attempt: inputs.attempt,
    taskTitle: taskRecord.title,
    taskDescription: taskRecord.description,
    publishRepository: taskRecord.project?.repository
      ? { fullName: taskRecord.project.repository.fullName, defaultBranch: taskRecord.project.repository.defaultBranch }
      : null,
    heartbeatTimer: null,
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

  // W03a claim: the fenced in_progress transition (not archived, not already
  // running, unchanged project/team/creator), bound to this provider session,
  // with the legacy batch link cleared and the AgentRun created — atomically
  // server-side in API mode. A rejected claim never owned the task row.
  const store = await getSidecarStore();
  let claim: Awaited<ReturnType<typeof store.claimAttempt>>;
  try {
    claim = await store.claimAttempt(inputs.attempt, {
      sessionId,
      runner: inputs.runnerId ?? 'opencode',
      model: inputs.modelLabel ?? 'unknown',
      executionStartedAt: executionState.startedAt,
    });
  } catch (error) {
    executionState.claimRejected = true;
    throw error;
  }
  executionState.agentRunId = claim.agentRunId;
  executionState.claimed = true;
  if (claim.task) {
    publishTaskEvent(taskId, 'task:updated', claim.task, { ownerUserId: executionState.userId });
  }
  startHeartbeat(executionState);
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

export async function executeTask({ taskId, userId, credential, allowBlocked }: ExecuteTaskParams): Promise<{ success: boolean; error?: string; code?: string }> {
  // Reserve before the first await. A duplicate caller never owns or releases
  // the original attempt's reservation.
  if (activeExecutions.has(taskId) || pendingExecutions.has(taskId) || pendingBatchTasks.has(taskId) || taskHasActiveBatch(taskId)) {
    return { success: false, error: 'Task is already running', code: 'TASK_ALREADY_RUNNING' };
  }
  pendingExecutions.add(taskId);
  if (userId) pendingExecutionOwners.set(taskId, userId);
  let inputs: ExecutionInputs | undefined;
  let executionState: ExecutionState | undefined;
  let relay: AttemptEventRelay | undefined;
  try {
    const result = await gatherExecutionInputs({ taskId, userId, credential, allowBlocked });
    if (result.error || !result.inputs) {
      return { success: false, error: result.error, ...(result.code ? { code: result.code } : {}) };
    }
    inputs = result.inputs;
    relay = attachRelay(inputs.attempt);

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

    inputs.runnerId = requireLegacyRunner({
      taskAgent: inputs.taskRecord.agent,
      projectDefaultAgent: inputs.taskRecord.project?.defaultAgent,
    });
    inputs.modelLabel = modelLabel;

    executionState = initializeExecution(inputs, client, sessionId, null);
    executionState.relay = relay;
    await startAgentSession(inputs, executionState, modelInfo);

    logger.info(`[Execution] Started for task ${taskId} in ${inputs.repoPath}`);
    return { success: true };
  } catch (error) {
    if (executionState?.claimRejected) {
      // The claim was refused (another attempt owns the task, it was archived
      // or its scope changed): nothing was written for this attempt, so there
      // is no terminal projection to make. Stop the provider session and
      // release local state.
      try {
        await executionState.client.session.abort({ path: { id: executionState.sessionId }, signal: AbortSignal.timeout(5_000) });
      } catch (abortError) {
        logger.warn({ err: abortError, taskId }, '[Execution] Abort after a rejected claim failed');
      }
      await cleanupExecution(taskId, executionState);
    } else if (executionState && !executionState.cancelled && !executionState.finalized && activeExecutions.get(taskId) === executionState) {
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
    // Authorization and control-plane availability failures before the
    // claim keep their status (401/403/404/503) for the route.
    if (!executionState?.claimed && isAdmissionDenial(error)) throw error;
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error', ...(isHttpError(error) ? { code: error.code } : {}) };
  } finally {
    pendingExecutions.delete(taskId);
    pendingExecutionOwners.delete(taskId);
    // Until a successful claim hands the attempt to the execution (whose
    // cleanup closes it), this call owns it: release it and its relay.
    if (inputs && !executionState?.claimed) {
      if (relay) {
        await relay.close(1_000).catch(() => undefined);
        detachAttemptRelay(taskId, relay);
        if (executionState && executionState.relay === relay) executionState.relay = undefined;
      }
      if (!inputs.attempt.closed) await closeQuietly(inputs.attempt, 'setup_failed');
    }
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
      // Positive stop receipt to the control plane before the run may be
      // finalized as cancelled (W03a cancellation acknowledgement).
      if (execution.attempt) await (await getSidecarStore()).acknowledgeCancellation(execution.attempt);
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
