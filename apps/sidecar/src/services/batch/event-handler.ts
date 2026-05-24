import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  extractBackgroundTaskId,
  isBackgroundTaskLaunch,
  isBackgroundTaskCancellation,
  isBackgroundTaskCompletion,
  isBackgroundTaskFailure,
} from '../../utils/background-task';
import { getOrCreateBuffer, appendTextDelta, appendReasoningDelta, flushDeltaBuffer, markThinking } from '../delta-buffer';
import {
  emitBatchLog,
  emitBatchLogs,
  broadcastBatchProgress,
  flushTaskBuffers,
  cleanupTaskBuffers,
} from './shared';

const BATCH_EVENT_TIMEOUT_MS = 30_000;
const BATCH_BACKGROUND_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const BATCH_BACKGROUND_BUFFER_LIMIT = 4_000;
const BATCH_EVENT_TIMEOUT_REASON = 'Event stream timed out';
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
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | null = null;
  let backgroundTaskRunning = false;
  let backgroundTaskFailure: string | null = null;
  let backgroundTaskResultBuffer = '';
  const primaryTaskId = taskIds[0] ?? batchId;

  const clearEventTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const resetEventTimeout = (
    timeoutMs = BATCH_EVENT_TIMEOUT_MS,
    timeoutReason = BATCH_EVENT_TIMEOUT_REASON,
  ) => {
    clearEventTimeout();
    const waitingForBackgroundTask =
      backgroundTaskRunning
      && timeoutMs === BATCH_EVENT_TIMEOUT_MS
      && timeoutReason === BATCH_EVENT_TIMEOUT_REASON;
    const effectiveTimeoutMs = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_MS : timeoutMs;
    const effectiveTimeoutReason = waitingForBackgroundTask ? BATCH_BACKGROUND_TASK_TIMEOUT_REASON : timeoutReason;

    timeoutId = setTimeout(() => {
      timedOut = true;
      flushTaskBuffers(taskIds);
      cleanupTaskBuffers(taskIds);
      emitBatchLogs(taskIds, 'error', 'Execution timed out waiting for agent events', effectiveTimeoutReason);
      void onComplete(false, effectiveTimeoutReason).catch((error: unknown) => {
        console.error(`[Batch] Failed to complete timed out session for task ${primaryTaskId.slice(0, 8)}:`, error);
      });
    }, effectiveTimeoutMs);
    timeoutId.unref();
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
    resetEventTimeout();
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
      resetEventTimeout();

      for await (const event of events.stream) {
        if (timedOut) break;
        resetEventTimeout();
        const type = event.type as string;
        const props = (event.properties || {}) as Record<string, unknown>;

        if (type === 'server.heartbeat') continue;

        if (type === 'session.completed' || type === 'session.idle') {
          if (!promptSent) continue;
          if (backgroundTaskFailure) {
            clearEventTimeout();
            flushTaskBuffers(taskIds);
            cleanupTaskBuffers(taskIds);
            await onComplete(false, `Background subtask failed: ${backgroundTaskFailure}`);
            break;
          }
          if (backgroundTaskRunning) {
            emitBatchLogs(taskIds, 'info', 'Agent is waiting on a background subtask');
            broadcastBatchProgress(taskIds, 'executing', 'Waiting for background subtask to finish...');
            resetEventTimeout(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
            continue;
          }
          clearEventTimeout();
          flushTaskBuffers(taskIds);
          cleanupTaskBuffers(taskIds);
          emitBatchLogs(taskIds, 'success', 'Agent completed work');
          await onComplete(true);
          break;
        }

        if (type === 'session.error') {
          clearEventTimeout();
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
                resetEventTimeout(BATCH_BACKGROUND_TASK_TIMEOUT_MS, BATCH_BACKGROUND_TASK_TIMEOUT_REASON);
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
          } else if (part?.type === 'reasoning') {
            if (delta && delta.length > 0) {
              for (const taskId of taskIds) {
                appendReasoningDelta(taskId, delta);
              }
            }
          }
          continue;
        }

        if (type === 'tool.execute.before') {
          flushTaskBuffers(taskIds);
          const tool = props.tool as string | undefined;
          if (tool) {
            emitBatchLogs(taskIds, 'tool', `Starting: ${tool}`);
            broadcastBatchProgress(taskIds, 'executing', `Starting: ${tool}`);
          }
          continue;
        }

        if (type === 'tool.execute.after') {
          const tool = props.tool as string | undefined;
          const output = props.output as string | undefined;
          if (tool) {
            if (isBackgroundTaskCancellation(tool, output || '')) {
              clearBackgroundTaskWait('cancelled', output?.slice(-1_000));
            } else {
              observeBackgroundTaskText(output || '');
            }
            emitBatchLogs(taskIds, 'success', `Finished: ${tool}`, output?.slice(0, 100));
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
      clearEventTimeout();
      console.error(`[Batch] Event subscription error for session ${sessionId.slice(0, 8)}:`, error);
      await onComplete(false, 'Event subscription failed');
    } finally {
      clearEventTimeout();
    }
  })();
}
