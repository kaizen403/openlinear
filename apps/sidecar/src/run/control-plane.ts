import type {
  ExecutionEvent,
  ExecutionLogEntry,
  ExecutionRunInput,
  ExecutionSnapshot,
  ExecutionTaskSnapshot,
  ExecutionTerminalInput,
  ExecutionVerificationInput,
} from '@openlinear/api-client';
import type { ControlAttemptStatus } from '@openlinear/execution-core';
import type { PrincipalCredential } from '../auth/principal';
import {
  CLOUD_API_START_TIMEOUT_MS,
  createAttemptClient,
  createPrincipalClient,
  toSidecarError,
} from '../config/cloud-api';
import { HttpError, isHttpError } from '../lib/errors';
import { acquireGitCredential, type GitCredentialEffect } from '../services/git-credentials';
import type { RunSnapshot } from './types';

/**
 * The control-plane side of a run (W03a `/api/executions`), as the run
 * service needs it. `ApiControlPlane` is production; tests substitute an
 * in-memory implementation that applies the same fences.
 *
 * Every method maps failures to sidecar `HttpError`s with the API's status
 * and code (`toSidecarError`); an unreachable API is 503
 * `CLOUD_API_UNREACHABLE`.
 */

export interface StartedRun {
  attemptId: string;
  capability: { token: string; expiresAt: number };
  snapshot: RunSnapshot;
  parallelLimit: number;
}

export interface AttemptHeartbeat {
  status: ControlAttemptStatus;
  cancelRequested: boolean;
  capabilityExpiresAt: number;
}

export interface AttemptChannel {
  claim(input: { sessionId: string; runner: string; model: string }): Promise<{ agentRunId: string | null; task: Record<string, unknown> | null }>;
  sendEvents(events: ExecutionEvent[]): Promise<{ lastSeq: number; cancelRequested: boolean }>;
  heartbeat(): Promise<AttemptHeartbeat>;
  renew(): Promise<{ token: string; expiresAt: number }>;
  /** W10a: the credential for ONE git effect, requested right before the network operation. */
  gitCredential(effect: GitCredentialEffect): Promise<string | null>;
  writeTerminal(input: ExecutionTerminalInput): Promise<{ repeated: boolean; task: Record<string, unknown> | null }>;
  finalizeRun(input: ExecutionRunInput): Promise<{ finalized: boolean }>;
  acknowledgeCancellation(): Promise<void>;
  persistLogs(logs: ExecutionLogEntry[]): Promise<void>;
  close(reason?: string): Promise<{ status: string; closeReason: string | null }>;
  /** W11a: verification evidence (idempotent per attempt + commit + checks hash). */
  recordVerification(input: ExecutionVerificationInput): Promise<{ id: string; repeated: boolean }>;
}

export interface ControlPlane {
  /**
   * Authorize execute with the request principal; returns the attempt,
   * capability and snapshot. `allowBlocked` (W17a) starts a task whose
   * blockers are open; otherwise the control plane answers 409 TASK_BLOCKED.
   */
  start(credential: PrincipalCredential, taskId: string, options?: { allowBlocked?: boolean }): Promise<StartedRun>;
  /** W17a: "blocked by" edges among these tasks (batch ordering). */
  dependencyEdges?(credential: PrincipalCredential, taskIds: readonly string[]): Promise<Array<{ taskId: string; dependsOnTaskId: string }>>;
  /** A channel authenticated only by the attempt's capability (survives restarts via the journal). */
  channel(attemptId: string, capability: string): AttemptChannel;
}

const CONTROL_STATUSES: readonly ControlAttemptStatus[] = ['preparing', 'running', 'finishing', 'closed', 'released'];

function toControlStatus(value: string): ControlAttemptStatus {
  const found = CONTROL_STATUSES.find((status) => status === value);
  if (!found) throw new HttpError(503, 'CLOUD_API_UNREACHABLE', `Unexpected attempt status ${value}`);
  return found;
}

function detailStatus(details: unknown): string | null {
  if (details && typeof details === 'object' && 'status' in details) {
    const status = details.status;
    return typeof status === 'string' ? status : null;
  }
  return null;
}

/** The control plane no longer accepts this attempt's capability: the run is fenced. */
export function isAuthorityLost(error: unknown): boolean {
  if (!isHttpError(error)) return false;
  if (error.statusCode === 401) return true;
  if (error.statusCode === 404 && error.code === 'ATTEMPT_NOT_FOUND') return true;
  if (error.statusCode === 403 && error.code === 'CAPABILITY_ATTEMPT_MISMATCH') return true;
  if (error.statusCode === 409 && error.code === 'ATTEMPT_STATE_CONFLICT') {
    const status = detailStatus(error.details);
    return status === 'closed' || status === 'released';
  }
  return false;
}

/** Retry later: network failure, 5xx or rate limiting. */
export function isTransientControlError(error: unknown): boolean {
  if (!isHttpError(error)) return true;
  return error.code === 'CLOUD_API_UNREACHABLE' || error.code === 'CLOUD_API_NOT_CONFIGURED' || error.statusCode === 429;
}

export function snapshotFromTask(task: ExecutionTaskSnapshot, verification?: ExecutionSnapshot['verification'], settings?: ExecutionSnapshot['settings'], knowledge?: ExecutionSnapshot['knowledge']): RunSnapshot {
  const maxUsd = typeof settings?.maxRunCostUsd === 'number' && settings.maxRunCostUsd > 0 ? settings.maxRunCostUsd : undefined;
  const maxTokens = typeof settings?.maxRunTokens === 'number' && settings.maxRunTokens > 0 ? Math.floor(settings.maxRunTokens) : undefined;
  return {
    title: task.title,
    description: task.description,
    model: task.model,
    agent: task.agent ?? task.project?.defaultAgent ?? null,
    labels: task.labels.map((relation) => relation.label.name),
    projectId: task.projectId,
    teamId: task.teamId,
    creatorId: task.creatorId,
    localPath: task.project?.localPath ?? null,
    repository: task.project?.repository ?? null,
    // W11a: sealed with the run; null/absent = the project configures no verification.
    ...(verification !== undefined && verification !== null ? { verificationSettings: verification } : {}),
    ...(maxUsd !== undefined || maxTokens !== undefined ? { budgets: { ...(maxUsd !== undefined ? { maxUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) } } : {}),
    // FE-04: sealed with the run like the budgets.
    ...(settings?.approvalMode === 'ask' ? { approvalMode: 'ask' as const } : {}),
    // W19b: the project knowledge issued with the attempt (validated by the snapshot schema).
    ...(knowledge && knowledge.length > 0 ? { knowledge } : {}),
  };
}

async function mapped<T>(context: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSidecarError(error, context);
  }
}

export function createApiControlPlane(): ControlPlane {
  return {
    async start(credential, taskId, options) {
      const started = await mapped('execution start', () =>
        createPrincipalClient(credential.token, CLOUD_API_START_TIMEOUT_MS).startExecutionAttempt(taskId, { allowBlocked: options?.allowBlocked === true }));
      return {
        attemptId: started.attempt.id,
        capability: { token: started.capability.token, expiresAt: Date.parse(started.capability.expiresAt) },
        snapshot: snapshotFromTask(started.snapshot.task, started.snapshot.verification, started.snapshot.settings, started.snapshot.knowledge),
        parallelLimit: started.snapshot.settings.parallelLimit,
      };
    },
    async dependencyEdges(credential, taskIds) {
      const result = await mapped('task dependencies', () => createPrincipalClient(credential.token).listDependencyEdges(taskIds));
      return result.edges;
    },
    channel(attemptId, capability) {
      const client = createAttemptClient(attemptId, capability);
      return {
        claim: (input) => mapped('execution claim', async () => {
          const claimed = await client.claim(input);
          return { agentRunId: claimed.agentRunId, task: claimed.task };
        }),
        sendEvents: (events) => mapped('execution events', async () => {
          const result = await client.sendEvents(events);
          return { lastSeq: result.lastSeq, cancelRequested: result.cancelRequested };
        }),
        heartbeat: () => mapped('attempt heartbeat', async () => {
          const beat = await client.heartbeat();
          return {
            status: toControlStatus(beat.status),
            cancelRequested: beat.cancelRequested,
            capabilityExpiresAt: Date.parse(beat.capabilityExpiresAt),
          };
        }),
        renew: () => mapped('capability renewal', async () => {
          const renewed = await client.renew();
          return { token: renewed.capability.token, expiresAt: Date.parse(renewed.capability.expiresAt) };
        }),
        gitCredential: (effect) => mapped(`git credential (${effect})`, () => acquireGitCredential(client, effect, { attemptId })),
        writeTerminal: (input) => mapped('terminal status', async () => {
          const result = await client.writeTerminal(input);
          return { repeated: result.repeated, task: result.task };
        }),
        finalizeRun: (input) => mapped('run finalization', async () => {
          const result = await client.finalizeRun(input);
          return { finalized: result.finalized };
        }),
        acknowledgeCancellation: () => mapped('cancellation acknowledgement', async () => {
          await client.acknowledgeCancellation();
        }),
        persistLogs: (logs) => mapped('log persistence', async () => {
          await client.persistLogs(logs);
        }),
        close: (reason) => mapped('attempt close', async () => {
          const closed = await client.close(reason);
          return { status: closed.status, closeReason: closed.closeReason };
        }),
        recordVerification: (input) => mapped('verification evidence', async () => {
          const recorded = await client.recordVerification(input);
          return { id: recorded.id, repeated: recorded.repeated };
        }),
      };
    },
  };
}
