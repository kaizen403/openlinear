import type { ExecutionLogEntry, ExecutionTerminalInput, StartedExecutionAttempt } from '@openlinear/api-client';
import {
  CLOUD_API_START_TIMEOUT_MS,
  createAttemptClient,
  createPrincipalClient,
  toSidecarError,
} from '../config/cloud-api';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { acquireGitCredential } from '../services/git-credentials';
import type { AttemptContext, SidecarStore, TaskProjection, TaskSnapshot } from './store';

/**
 * Production persistence (W03a): every operation is an HTTPS call to the
 * control plane. `startAttempt` and the read surface use the request
 * principal's own credential; everything after start uses only the attempt's
 * run-scoped capability. Failures map to sidecar errors with the API's status
 * and code; an unreachable API is 503 CLOUD_API_UNREACHABLE (fail closed).
 */

const MAX_LOG_MESSAGE = 8_000;
const MAX_LOG_DETAILS = 16_000;
const MAX_LOG_ENTRIES = 2_000;

function attemptClient(attempt: AttemptContext | null) {
  if (!attempt?.client) {
    throw new HttpError(409, 'ATTEMPT_REQUIRED', 'This write requires an execution attempt capability');
  }
  return attempt.client;
}

export function boundLogEntries(logs: ExecutionLogEntry[]): ExecutionLogEntry[] {
  return logs.slice(-MAX_LOG_ENTRIES).map((entry) => ({
    timestamp: entry.timestamp,
    type: entry.type,
    message: entry.message.slice(0, MAX_LOG_MESSAGE),
    ...(typeof entry.details === 'string' ? { details: entry.details.slice(0, MAX_LOG_DETAILS) } : {}),
  }));
}

function iso(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : value.toISOString();
}

export function createApiStore(): SidecarStore {
  const store: SidecarStore = {
    mode: 'api',

    async startAttempt(input) {
      if (!input.credential) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
      let started: StartedExecutionAttempt;
      try {
        started = await createPrincipalClient(input.credential.token, CLOUD_API_START_TIMEOUT_MS)
          .startExecutionAttempt(input.taskId, { allowBlocked: input.allowBlocked === true });
      } catch (error) {
        throw toSidecarError(error, 'execution start');
      }
      const attempt: AttemptContext = {
        taskId: input.taskId,
        userId: input.userId,
        attemptId: started.attempt.id,
        client: createAttemptClient(started.attempt.id, started.capability.token),
        credential: null,
      };
      const rejected = input.admit(started.snapshot.settings);
      if (rejected) {
        await store.closeAttempt(attempt, 'admission_rejected');
        return { ok: false, error: rejected };
      }
      return {
        ok: true,
        attempt,
        task: started.snapshot.task as TaskSnapshot,
        authority: started.snapshot.authority,
        settings: started.snapshot.settings,
      };
    },

    async getGitCredential(attempt, purpose) {
      // W10a: the legacy engine uses one publish token for push and PR, so it
      // asks for `pull_request` (contents:write + pull_requests:write); clone
      // asks for `fetch` (contents:read).
      const effect = purpose === 'publish' ? 'pull_request' : 'fetch';
      try {
        return await acquireGitCredential(attemptClient(attempt), effect, { attemptId: attempt.attemptId });
      } catch (error) {
        throw toSidecarError(error, `git credential (${purpose})`);
      }
    },

    async claimAttempt(attempt, input) {
      try {
        const claimed = await attemptClient(attempt).claim({
          sessionId: input.sessionId,
          runner: input.runner,
          model: input.model,
        });
        return { agentRunId: claimed.agentRunId, task: claimed.task };
      } catch (error) {
        throw toSidecarError(error, 'execution claim');
      }
    },

    async writeTaskStatus(attempt, input) {
      if (input.status === 'in_progress') {
        throw new HttpError(409, 'CLAIM_REQUIRED', 'in_progress transitions go through the attempt claim');
      }
      const body: ExecutionTerminalInput = {
        status: input.status,
        ...(input.executionData?.executionElapsedMs !== undefined ? { executionElapsedMs: input.executionData.executionElapsedMs } : {}),
        ...(input.executionData?.executionProgress !== undefined ? { executionProgress: input.executionData.executionProgress } : {}),
        ...(input.executionData?.executionPausedAt !== undefined ? { executionPausedAt: iso(input.executionData.executionPausedAt) } : {}),
        ...(input.executionData?.prUrl !== undefined ? { prUrl: input.executionData.prUrl } : {}),
        ...(input.executionData?.outcome !== undefined ? { outcome: input.executionData.outcome?.slice(0, 4_000) ?? null } : {}),
      };
      try {
        const result = await attemptClient(attempt).writeTerminal(body);
        return result.task as TaskProjection | null;
      } catch (error) {
        throw toSidecarError(error, 'terminal status');
      }
    },

    async persistLogs(attempt, input) {
      if (!attempt?.client) return;
      try {
        await attempt.client.persistLogs(boundLogEntries(input.logs));
      } catch (error) {
        logger.error({ err: toSidecarError(error, 'log persistence'), taskId: input.taskId },
          `[Execution] Failed to persist logs for task ${input.taskId.slice(0, 8)}`);
      }
    },

    async finalizeRun(attempt, input) {
      await attemptClient(attempt).finalizeRun({
        status: input.status,
        usage: input.usage,
        ...(input.prUrl ? { prUrl: input.prUrl } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 1_000) } : {}),
      }).catch((error: unknown) => {
        throw toSidecarError(error, 'run finalization');
      });
    },

    async authorizePublication(attempt) {
      // Re-authorizes the initiator and requires the task to still be bound
      // to this attempt; returns a fresh publish credential.
      if (!attempt) throw new HttpError(409, 'ATTEMPT_REQUIRED', 'Publication requires an execution attempt capability');
      return store.getGitCredential(attempt, 'publish');
    },

    async acknowledgeCancellation(attempt) {
      try {
        await attemptClient(attempt).acknowledgeCancellation();
      } catch (error) {
        throw toSidecarError(error, 'cancellation acknowledgement');
      }
    },

    async relayEvents(attempt, events) {
      const result = await attemptClient(attempt).sendEvents(events);
      return { cancelRequested: result.cancelRequested };
    },

    async heartbeat(attempt) {
      const result = await attemptClient(attempt).heartbeat();
      return { cancelRequested: result.cancelRequested };
    },

    async closeAttempt(attempt, reason) {
      if (attempt.closed || !attempt.client) {
        attempt.closed = true;
        return;
      }
      attempt.closed = true;
      try {
        await attempt.client.close(reason);
      } catch (error) {
        // Best effort: a revoked capability already means closed; otherwise
        // the capability still expires after its bounded TTL.
        logger.warn({ err: toSidecarError(error, 'attempt close'), attemptId: attempt.attemptId },
          '[Execution] attempt close was not confirmed');
      }
    },

    async readPersistedLogs(credential, taskId) {
      if (!credential) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
      try {
        return (await createPrincipalClient(credential.token).getExecutionTaskLogs(taskId)).logs;
      } catch (error) {
        throw toSidecarError(error, 'persisted logs');
      }
    },

    async refreshPullRequest(credential, taskId) {
      if (!credential) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
      try {
        return await createPrincipalClient(credential.token).refreshExecutionPullRequest(taskId);
      } catch (error) {
        throw toSidecarError(error, 'pull request refresh');
      }
    },

    async recordRecoveryOutcome(run, outcome) {
      // Attempt capabilities live in memory only, so a restarted sidecar has
      // no authority over a previous process's attempt. The control plane
      // sees it through the attempt heartbeat instead (see the W03a ledger).
      logger.warn({ runId: run.id, taskId: run.taskId, outcome },
        '[Recovery] API-only mode cannot project journal recovery without an attempt capability');
    },
  };
  return store;
}
