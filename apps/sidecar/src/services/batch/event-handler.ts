import type { OpencodeClient } from '@opencode-ai/sdk';
import { logger } from '@openlinear/api/logger';
import {
  extractBackgroundTaskId,
  isBackgroundTaskLaunch,
  isBackgroundTaskCancellation,
  isBackgroundTaskCompletion,
  isBackgroundTaskFailure,
} from '../../utils/background-task';
import { extractSessionId } from '../execution/events';
import { getOrCreateBuffer, appendTextDelta, appendReasoningDelta, flushDeltaBuffer, markThinking } from '../delta-buffer';
import {
  emitBatchLog,
  emitBatchLogs,
  broadcastBatchProgress,
  flushTaskBuffers,
  cleanupTaskBuffers,
} from './shared';

// T4 (C-07 / R1 P0-3): liveness vs. progress are two different questions.
// - Transport watchdog: any event at all (including `server.heartbeat`, which
//   carries no sessionID) proves the connection is alive. 60s, not 30s — a
//   single bash/test/install call can legitimately run well past 30s.
// - No-progress watchdog: only events that belong to *this* session and
//   represent real activity reset it. Defaults to 20 minutes, configurable.
const TRANSPORT_WATCHDOG_MS = 60_000;
const NO_PROGRESS_WATCHDOG_MS = (() => {
  const raw = parseInt(process.env.OPENLINEAR_NO_PROGRESS_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60 * 1000;
})();
const BATCH_BACKGROUND_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const BATCH_BACKGROUND_BUFFER_LIMIT = 4_000;
const BATCH_TRANSPORT_TIMEOUT_REASON = 'Event stream connection was lost';
const BATCH_NO_PROGRESS_TIMEOUT_REASON = 'Agent made no progress within the configured budget';
const BATCH_BACKGROUND_TASK_TIMEOUT_REASON = 'Background subtask timed out';

export interface SessionEventSubscription {
  client: OpencodeClient;
  sessionId: string;
  batchId: string;
  taskIds: string[];
  onComplete: (success: boolean, error?: string) => Promise<void>;
}

export function subscribeToTaskEvents(
  client: OpencodeClient,
  sessionId: string,
  batchId: string,
  taskId: string,
  onComplete: (success: boolean, error?: string) => Promise<void>,
): void {
  subscribeToSessionEvents({
    client,
    sessionId,
    batchId,
    taskIds: [taskId],
    onComplete,
  });
}

export function subscribeToSessionEvents({
  client,
  sessionId,
  batchId,
  taskIds,
  onComplete,
}: SessionEventSubscription): void {
  let promptSent = false;
  let finished = false;
  let backgroundTaskRunning = false;
  let backgroundTaskFailure: string | null = null;
  let backgroundTaskResultBuffer = '';
  let watchdogSuspended = false;
  let transportTimeoutId: NodeJS.Timeout | null = null;
  let progressTimeoutId: NodeJS.Timeout | null = null;
  const primaryTaskId = taskIds[0] ?? batchId;

  const clearTransportWatchdog = () => {
    if (transportTimeoutId) {
      clearTimeout(transportTimeoutId);
      transportTimeoutId = null;
    }
  };
  const clearProgressWatchdog = () => {
    if (progressTimeoutId) {
      clearTimeout(progressTimeoutId);
      progressTimeoutId = null;
    }
  };

  const finish = (reason: string, effectiveTimeoutReason: string) => {
    if (finished) return;
    finished = true;
    clearTransportWatchdog();
    clearProgressWatchdog();
    flushTaskBuffers(taskIds);
    cleanupTaskBuffers(taskIds);
    emitBatchLogs(taskIds, 'error', reason, effectiveTimeoutReason);
    void onComplete(false, effectiveTimeoutReason).catch((error: unknown) => {
      logger.error({ err: error, taskId: primaryTaskId }, `[Batch] Failed to complete timed out session for task ${primaryTaskId.slice(0, 8)}`);
    });
  };

  const resetTransportWatchdog = () => {
    clearTransportWatchdog();
    if (watchdogSuspended || finished) return;
    transportTimeoutId = setTimeout(() => {
      finish('Execution timed out — event stream connection was lost', BATCH_TRANSPORT_TIMEOUT_REASON);
    }, TRANSPORT_WATCHDOG_MS);
    transportTimeoutId.unref();
  };

  const resetProgressWatchdog = (
    timeoutMs = NO_PROGRESS_WATCHDOG_MS,
    timeoutReason = BATCH_NO_PROGRESS_TIMEOUT_REASON,
  ) => {
    clearProgressWatchdog();
    if (watchdogSuspended || finished) return;
    const waitingForBackgroundTask =
      backgroundTaskRunning
      && timeoutMs === NO_PROGRESS_WATCHDOG_MS
      && timeoutReason === BATCH_NO_PROGRESS_TIMEOUT_REASON;
    const effectiveTimeoutMs = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_MS : timeoutMs;
    const effectiveTimeoutReason = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_REASON : timeoutReason;

    progressTimeoutId = setTimeout(() => {
      finish('Execution timed out waiting for agent progress', effectiveTimeoutReason);
    }, effectiveTimeoutMs);
    progressTimeoutId.unref();
  };

  const suspendWatchdogs = () => {
    watchdogSuspended = true;
    clearTransportWatchdog();
    clearProgressWatchdog();
  };

  const resumeWatchdogs = () => {
    watchdogSuspended = false;
    resetTransportWatchdog();
    resetProgressWatchdog();
  };

  const replyToPermission = (permissionId: string) => {
    // Fail-closed fallback: our injected config denies doom_loop/external_directory/
    // *.env reads outright (T3), so a real `ask` should be rare. If OpenCode asks
    // for something else we did not anticipate, reject rather than hang forever —
    // an unattended batch run has no human to approve it.
    client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response: 'reject' },
    }).catch((error: unknown) => {
      logger.error({ err: error, sessionId }, `[Batch] Failed to reply to permission request for session ${sessionId.slice(0, 8)}`);
    });
  };

  const clearBackgroundTaskWait = (
    status: 'completed' | 'cancelled' | 'failed',
    details?: string,
  ) => {
    if (!backgroundTaskRunning) return;

    backgroundTaskRunning = false;
    backgroundTaskFailure = status === 'failed' ? (details || 'Background subtask failed') : null;

    if (status === 'failed') {
      emitBatchLogs(taskIds, 'error', 'Background subtask failed', backgroundTaskFailure ?? undefined);
      return;
    }

    emitBatchLogs(
      taskIds,
      'info',
      status === 'cancelled'
        ? 'Background subtask cancelled; continuing execution'
        : 'Background subtask completed; waiting for final agent response',
      details,
    );
    broadcastBatchProgress(
      taskIds,
      'executing',
      status === 'cancelled'
        ? 'Background subtask cancelled; continuing execution'
        : 'Background subtask completed; waiting for final agent response',
    );
    resetProgressWatchdog();
  };

  const observeBackgroundTaskText = (text: string) => {
    if (!text) return;
    backgroundTaskResultBuffer = (backgroundTaskResultBuffer + text).slice(-BATCH_BACKGROUND_BUFFER_LIMIT);
    if (isBackgroundTaskCancellation('text', backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('cancelled', backgroundTaskResultBuffer.slice(-1_000));
      return;
    }
    if (isBackgroundTaskFailure(backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('failed', backgroundTaskResultBuffer.slice(-1_000));
      return;
    }
    if (isBackgroundTaskCompletion(backgroundTaskResultBuffer)) {
      clearBackgroundTaskWait('completed', backgroundTaskResultBuffer.slice(-1_000));
    }
  };

  for (const taskId of taskIds) {
    getOrCreateBuffer(taskId, (msg) => emitBatchLog(taskId, 'agent', msg));
  }

  (async () => {
    try {
      const events = await client.event.subscribe();
      resetTransportWatchdog();
      resetProgressWatchdog();

      for await (const event of events.stream) {
        if (finished) break;

        // Liveness: ANY frame — including a heartbeat with no sessionID — proves
        // the transport is alive. Do this before the session filter below.
        resetTransportWatchdog();

        const type = event.type as string;
        const props = (event.properties || {}) as Record<string, unknown>;

        if (type === 'server.heartbeat') continue;

        // C-01 fix: this subscription is scoped to exactly one OpenCode session
        // (a single task's session, or the shared session for a combined batch).
        // `client.event.subscribe()` returns the server-wide stream, so without
        // this filter the first `session.idle` from ANY session — including an
        // unrelated single-task execution or another batch's task — completes
        // every task on this handler.
        const eventSessionId = extractSessionId({ type, properties: props });
        if (eventSessionId !== sessionId) continue;

        // From here on the event definitely belongs to our session: it's progress.
        resetProgressWatchdog();

        if (type === 'permission.updated') {
          const permission = props as { id?: string; type?: string; title?: string };
          emitBatchLogs(
            taskIds,
            'info',
            `Permission requested: ${permission.type || 'unknown'} — ${permission.title || permission.type || 'unknown'}`,
          );
          suspendWatchdogs();
          if (permission.id) replyToPermission(permission.id);
          continue;
        }

        if (type === 'permission.replied') {
          resumeWatchdogs();
          continue;
        }

        if (type === 'session.compacted') {
          emitBatchLogs(taskIds, 'info', 'Session context was compacted');
          continue;
        }

        if (type === 'session.idle') {
          if (!promptSent) continue;
          if (backgroundTaskFailure) {
            finished = true;
            clearTransportWatchdog();
            clearProgressWatchdog();
            flushTaskBuffers(taskIds);
            cleanupTaskBuffers(taskIds);
            await onComplete(false, `Background subtask failed: ${backgroundTaskFailure}`);
            break;
          }
          if (backgroundTaskRunning) {
            emitBatchLogs(taskIds, 'info', 'Agent is waiting on a background subtask');
            broadcastBatchProgress(taskIds, 'executing', 'Waiting for background subtask to finish...');
            resetProgressWatchdog(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
            continue;
          }
          finished = true;
          clearTransportWatchdog();
          clearProgressWatchdog();
          flushTaskBuffers(taskIds);
          cleanupTaskBuffers(taskIds);
          emitBatchLogs(taskIds, 'success', 'Agent completed work');
          await onComplete(true);
          break;
        }

        if (type === 'session.error') {
          finished = true;
          clearTransportWatchdog();
          clearProgressWatchdog();
          flushTaskBuffers(taskIds);
          cleanupTaskBuffers(taskIds);
          const errorMsg = String(props.error || 'Session error');
          emitBatchLogs(taskIds, 'error', 'Execution failed', errorMsg);
          await onComplete(false, errorMsg);
          break;
        }

        if (type === 'session.status') {
          const status = props.status as { type?: string; message?: string } | undefined;
          if (status?.type === 'busy') {
            promptSent = true;
            for (const taskId of taskIds) {
              if (markThinking(taskId)) {
                emitBatchLog(taskId, 'agent', 'Agent is thinking...');
                broadcastBatchProgress([taskId], 'executing', 'Agent is thinking...');
              }
            }
          } else if (status?.type === 'retry') {
            emitBatchLogs(taskIds, 'info', `Retrying: ${status.message || 'unknown reason'}`);
          }
          continue;
        }

        if (type === 'message.part.updated') {
          const part = props.part as { type?: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } } | undefined;
          const delta = props.delta as string | undefined;

          if (part?.type === 'text' && delta) {
            for (const taskId of taskIds) {
              appendTextDelta(taskId, delta);
            }
            observeBackgroundTaskText(delta);
          } else if (part?.type === 'tool') {
            flushTaskBuffers(taskIds);
            const toolName = part.tool || 'unknown tool';
            const state = part.state;
            if (state?.status === 'running') {
              emitBatchLogs(taskIds, 'tool', `Running: ${state.title || toolName}`);
              broadcastBatchProgress(taskIds, 'executing', `Running: ${state.title || toolName}`);
            } else if (state?.status === 'completed') {
              const rawOutput = state.output || '';
              if (isBackgroundTaskLaunch(toolName, rawOutput)) {
                backgroundTaskRunning = true;
                backgroundTaskFailure = null;
                backgroundTaskResultBuffer = rawOutput.slice(-BATCH_BACKGROUND_BUFFER_LIMIT);
                const backgroundTaskId = extractBackgroundTaskId(rawOutput);
                resetProgressWatchdog(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
                emitBatchLogs(
                  taskIds,
                  'info',
                  'Background subtask launched; waiting for it to finish',
                  backgroundTaskId ? `Task ID: ${backgroundTaskId}` : rawOutput.slice(0, 100),
                );
              } else if (isBackgroundTaskCancellation(toolName, rawOutput)) {
                clearBackgroundTaskWait('cancelled', rawOutput.slice(-1_000));
                emitBatchLogs(taskIds, 'success', `Completed: ${toolName}`, rawOutput.slice(0, 100));
              } else {
                observeBackgroundTaskText(rawOutput);
                emitBatchLogs(taskIds, 'success', `Completed: ${toolName}`, rawOutput.slice(0, 100));
              }
            } else if (state?.status === 'error') {
              emitBatchLogs(taskIds, 'error', `Failed: ${toolName}`, state.output);
            }
          } else if (part?.type === 'compaction') {
            emitBatchLogs(taskIds, 'info', 'Session compaction started');
          } else if (part?.type === 'reasoning') {
            if (delta && delta.length > 0) {
              for (const taskId of taskIds) {
                appendReasoningDelta(taskId, delta);
              }
            }
          }
          continue;
        }

        if (type === 'file.edited') {
          const file = props.file as string | undefined;
          if (file) {
            emitBatchLogs(taskIds, 'success', `Edited file: ${file}`);
          }
          continue;
        }
      }
    } catch (error) {
      cleanupTaskBuffers(taskIds);
      clearTransportWatchdog();
      clearProgressWatchdog();
      logger.error({ err: error, sessionId }, `[Batch] Event subscription error for session ${sessionId.slice(0, 8)}`);
      if (!finished) {
        finished = true;
        await onComplete(false, 'Event subscription failed');
      }
    } finally {
      clearTransportWatchdog();
      clearProgressWatchdog();
    }
  })();
}
