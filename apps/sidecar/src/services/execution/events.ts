import { prisma } from '@openlinear/db';
import { logger } from '@openlinear/api/logger';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { appendTextDelta, appendReasoningDelta, flushDeltaBuffer, markThinking } from '../delta-buffer';
import {
  isBackgroundTaskCancellation,
  isBackgroundTaskCompletion,
  isBackgroundTaskFailure,
} from '../../utils/background-task';

import { commitAndPush, createPullRequest, hasCommittableChanges } from './git';
import { finalizeAgentRun, recordMessageUsage } from './agent-run';
import { processEvent, type EventProcessorState } from './event-stream-processor';
import {
  activeExecutions,
  broadcastProgress,
  addLogEntry,
  updateTaskStatus,
  persistLogs,
  cleanupExecution,
  getTaskTitle,
  findTaskBySessionId,
  estimateProgress,
  MAX_COMPLETED_TOOL_KEYS,
  COMPLETED_TOOL_KEY_SOURCE_LIMIT,
} from './state';

// T4 (C-07 / R1 P0-3) — liveness vs. progress are two different questions.
// - Transport watchdog: ANY frame on the stream — including `server.heartbeat`
//   (which carries no sessionID) and other sessions' traffic — proves the
//   connection itself is alive. 60s, not 30s: a single bash/test/install call
//   can legitimately run well past 30s. On expiry we try to re-subscribe once
//   before failing, since a dropped connection is recoverable if the OpenCode
//   server itself is still up.
// - No-progress watchdog: only events that belong to *this* session and
//   represent real activity reset it. Defaults to 20 minutes, configurable —
//   a real compaction has been observed taking 145s, and provider
//   retry/backoff is unbounded, so 30s (the old single timer) misfired on
//   ordinary work.
// - Both are suspended while a permission reply is pending (see
//   event-stream-processor.ts's `permission.updated` handling) so an
//   unattended ask-then-reply round trip cannot itself trip either watchdog.
const TRANSPORT_WATCHDOG_MS = 60_000;
const NO_PROGRESS_WATCHDOG_MS = (() => {
  const raw = parseInt(process.env.OPENLINEAR_NO_PROGRESS_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60 * 1000;
})();
const BACKGROUND_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const BACKGROUND_TASK_BUFFER_LIMIT = 4_000;
const EVENT_STREAM_TIMEOUT_MESSAGE = 'Agent event stream timed out';
const NO_PROGRESS_TIMEOUT_MESSAGE = 'Agent made no progress within the configured budget';
const BACKGROUND_TASK_TIMEOUT_MESSAGE = 'Background subtask timed out';

type OpenCodeEvent = { type: string; properties?: Record<string, unknown> };
type ClosableEventStream = AsyncIterable<OpenCodeEvent> & {
  return?: (value?: unknown) => Promise<unknown> | unknown;
};
type ToolPart = {
  id?: string;
  callID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: { status?: string; title?: string; output?: string };
};

function clearTransportWatchdog(taskId: string): void {
  const execution = activeExecutions.get(taskId);
  if (execution?.streamTimeoutId) {
    clearTimeout(execution.streamTimeoutId);
    execution.streamTimeoutId = null;
  }
}

function clearNoProgressWatchdog(taskId: string): void {
  const execution = activeExecutions.get(taskId);
  if (execution?.progressTimeoutId) {
    clearTimeout(execution.progressTimeoutId);
    execution.progressTimeoutId = null;
  }
}

function clearAllWatchdogs(taskId: string): void {
  clearTransportWatchdog(taskId);
  clearNoProgressWatchdog(taskId);
}

/**
 * T5 — idempotency guard shared by every finalization path (event-driven
 * completion, stream-failure finalization, and lifecycle.ts's cancelTask).
 * `session.promptAsync` (used in lifecycle.ts) races the event stream by
 * design — errors and completion both arrive only as events now — so more
 * than one code path can independently decide "this run is over." Whichever
 * gets here first wins; everyone else is a no-op.
 */
export function claimFinalize(taskId: string): boolean {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.finalized) return false;
  execution.finalized = true;
  return true;
}

export async function failExecutionFromEventStream(taskId: string, message: string, details?: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled) return;

  const recoverableStreamFailure =
    message === EVENT_STREAM_TIMEOUT_MESSAGE ||
    message === NO_PROGRESS_TIMEOUT_MESSAGE ||
    message === BACKGROUND_TASK_TIMEOUT_MESSAGE ||
    message === 'Agent event stream failed' ||
    message === 'Agent event stream ended unexpectedly';

  if (recoverableStreamFailure) {
    try {
      if (await hasCommittableChanges(execution.repoPath)) {
        if (!claimFinalize(taskId)) return;
        clearAllWatchdogs(taskId);
        execution.backgroundTaskRunning = false;
        execution.backgroundTaskFailure = null;
        addLogEntry(
          taskId,
          'info',
          'Agent event stream stopped after code changes; creating PR from recovered worktree',
          details,
        );
        broadcastProgress(taskId, 'committing', 'Creating PR from recovered worktree...');
        try {
          await execution.client.session.abort({ path: { id: execution.sessionId } });
        } catch (error) {
          logger.error({ err: error, taskId }, `[Execution] Abort before recovered commit failed for task ${taskId.slice(0, 8)}`);
        }
        await handleSessionComplete(taskId, { alreadyClaimed: true });
        return;
      }
    } catch (error) {
      logger.error({ err: error, taskId }, `[Execution] Failed to inspect worktree after stream failure for task ${taskId.slice(0, 8)}`);
    }
  }

  if (!claimFinalize(taskId)) return;

  execution.status = 'error';
  execution.cancelled = true;
  clearAllWatchdogs(taskId);

  const elapsedMs = Date.now() - execution.startedAt.getTime();
  const estimatedProgress = estimateProgress(execution);
  const outcome = details ? `${message}: ${details}` : message;

  addLogEntry(taskId, 'error', message, details);
  broadcastProgress(taskId, 'error', message);

  try {
    await execution.client.session.abort({ path: { id: execution.sessionId } });
  } catch (error) {
    logger.error({ err: error, taskId }, `[Execution] Abort after event stream failure failed for task ${taskId.slice(0, 8)}`);
  }

  await finalizeAgentRun(execution, 'failed', { errorMessage: outcome });
  await updateTaskStatus(taskId, 'cancelled', null, {
    executionElapsedMs: elapsedMs,
    executionProgress: estimatedProgress,
    outcome,
  });
  await persistLogs(taskId);
  await cleanupExecution(taskId);
}

function resetTransportWatchdog(taskId: string, client: OpencodeClient, sessionId: string): void {
  clearTransportWatchdog(taskId);
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.sessionId !== sessionId || execution.cancelled) return;
  if (execution.watchdogSuspended) return;

  execution.streamTimeoutId = setTimeout(() => {
    void handleTransportTimeout(taskId, client, sessionId).catch((error: unknown) => {
      logger.error({ err: error, taskId }, `[Execution] Failed to handle transport watchdog expiry for task ${taskId.slice(0, 8)}`);
    });
  }, TRANSPORT_WATCHDOG_MS);
  execution.streamTimeoutId.unref();
}

/**
 * T4 — the transport watchdog fired: no frame at all (not even a heartbeat)
 * arrived for a full interval. Try re-subscribing once before treating the
 * run as dead; a dropped HTTP/SSE connection is recoverable if the OpenCode
 * server process is still alive.
 */
async function handleTransportTimeout(taskId: string, client: OpencodeClient, sessionId: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled) return;

  logger.warn(`[Execution] transport watchdog expired for task ${taskId.slice(0, 8)}; attempting to re-subscribe`);
  try {
    const events = await client.event.subscribe();
    addLogEntry(taskId, 'info', 'Reconnected to the agent event stream after a silent period');
    attachEventStream(taskId, client, sessionId, events.stream as unknown as ClosableEventStream);
  } catch (error) {
    await failExecutionFromEventStream(
      taskId,
      EVENT_STREAM_TIMEOUT_MESSAGE,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function resetNoProgressWatchdog(
  taskId: string,
  sessionId: string,
  timeoutMs = NO_PROGRESS_WATCHDOG_MS,
  timeoutMessage = NO_PROGRESS_TIMEOUT_MESSAGE,
): void {
  clearNoProgressWatchdog(taskId);
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.sessionId !== sessionId || execution.cancelled) return;
  if (execution.watchdogSuspended) return;

  const waitingForBackgroundTask =
    execution.backgroundTaskRunning
    && timeoutMs === NO_PROGRESS_WATCHDOG_MS
    && timeoutMessage === NO_PROGRESS_TIMEOUT_MESSAGE;
  const effectiveTimeoutMs = waitingForBackgroundTask ? BACKGROUND_TASK_WAIT_TIMEOUT_MS : timeoutMs;
  const effectiveTimeoutMessage = waitingForBackgroundTask ? BACKGROUND_TASK_TIMEOUT_MESSAGE : timeoutMessage;

  execution.progressTimeoutId = setTimeout(() => {
    /* v8 ignore start -- the catch callback only runs if timeout failure handling itself rejects. */
    void failExecutionFromEventStream(taskId, effectiveTimeoutMessage).catch((error: unknown) => {
      logger.error({ err: error, taskId }, `[Execution] Failed to handle no-progress watchdog expiry for task ${taskId.slice(0, 8)}`);
    });
    /* v8 ignore stop */
  }, effectiveTimeoutMs);
  execution.progressTimeoutId.unref();
}

function suspendWatchdogs(taskId: string): void {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;
  execution.watchdogSuspended = true;
  clearAllWatchdogs(taskId);
}

function resumeWatchdogs(taskId: string, client: OpencodeClient, sessionId: string): void {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;
  execution.watchdogSuspended = false;
  resetTransportWatchdog(taskId, client, sessionId);
  resetNoProgressWatchdog(taskId, sessionId);
}

function isTerminalSessionEvent(eventType: string): boolean {
  // T6 — `session.completed` removed: it is not in the installed SDK's
  // Event union and never fires. `session.idle` is the real signal.
  return eventType === 'session.idle' || eventType === 'session.error';
}


function clearBackgroundTaskWait(
  taskId: string,
  status: 'completed' | 'cancelled' | 'failed',
  details = 'Background subtask failed',
): void {
  const execution = activeExecutions.get(taskId);
  if (!execution || !execution.backgroundTaskRunning) return;

  execution.backgroundTaskRunning = false;

  if (status === 'failed') {
    execution.backgroundTaskFailure = details;
    addLogEntry(taskId, 'error', 'Background subtask failed', details);
    return;
  }

  execution.backgroundTaskFailure = null;
  const message = status === 'cancelled'
    ? 'Background subtask cancelled; continuing execution'
    : 'Background subtask completed; waiting for final agent response';
  addLogEntry(taskId, 'info', message, details);
  broadcastProgress(taskId, 'executing', message);
  resetNoProgressWatchdog(taskId, execution.sessionId);
}

function noteToolCompleted(taskId: string, toolName: string, output?: string, part?: ToolPart): void {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;

  // T11 (M-03) — prefer the callID when present (a stable, tiny identifier)
  // over raw tool output, and cap whatever we fall back to. Each key used to
  // be up to 1KB of tool output held for the run's full lifetime purely to
  // dedupe a counter.
  const keySource = (part?.callID || part?.id || output || `${toolName}:${Date.now()}`).slice(0, COMPLETED_TOOL_KEY_SOURCE_LIMIT);
  const key = `${toolName}:${keySource}`;
  if (execution.completedToolKeys.has(key)) return;

  if (execution.completedToolKeys.size >= MAX_COMPLETED_TOOL_KEYS) {
    // Sets iterate in insertion order — drop the oldest to bound memory
    // rather than let it grow forever on a long, tool-heavy run.
    const oldest = execution.completedToolKeys.values().next().value;
    if (oldest !== undefined) execution.completedToolKeys.delete(oldest);
  }

  execution.completedToolKeys.add(key);
  execution.toolsExecuted++;
}

function observeBackgroundTaskText(taskId: string, text: string): void {
  const execution = activeExecutions.get(taskId);
  if (!execution || !text) return;

  execution.backgroundTaskResultBuffer = (execution.backgroundTaskResultBuffer + text).slice(-BACKGROUND_TASK_BUFFER_LIMIT);
  const buffer = execution.backgroundTaskResultBuffer;

  if (isBackgroundTaskCancellation('text', buffer)) {
    clearBackgroundTaskWait(taskId, 'cancelled', buffer.slice(-1_000));
    return;
  }

  if (isBackgroundTaskFailure(buffer)) {
    clearBackgroundTaskWait(taskId, 'failed', buffer.slice(-1_000));
    return;
  }

  if (isBackgroundTaskCompletion(buffer)) {
    clearBackgroundTaskWait(taskId, 'completed', buffer.slice(-1_000));
  }
}

async function handleSessionComplete(taskId: string, opts: { alreadyClaimed?: boolean } = {}): Promise<void> {
  const execution = activeExecutions.get(taskId)!;
  if (!opts.alreadyClaimed && !claimFinalize(taskId)) return;
  clearAllWatchdogs(taskId);

  const elapsedMs = Date.now() - execution.startedAt.getTime();
  let prUrl: string | null = null;
  let outcome: string | null = null;

  try {
    execution.status = 'committing';
    broadcastProgress(taskId, 'committing', 'Committing changes...');
    addLogEntry(taskId, 'info', 'Agent finished, committing changes...');

    const commitResult = await commitAndPush(
      execution.repoPath,
      execution.branchName,
      await getTaskTitle(taskId),
      execution.accessToken
    );

    if (commitResult.status === 'pushed') {
      execution.status = 'creating_pr';
      broadcastProgress(taskId, 'creating_pr', 'Creating pull request...');
      addLogEntry(taskId, 'info', 'Creating pull request...');

      const repository = await prisma.repository.findUnique({
        where: { id: execution.projectId },
      });
      const task = await prisma.task.findUnique({ where: { id: taskId } });

      let repoInfo = repository
        ? { fullName: repository.fullName, defaultBranch: repository.defaultBranch }
        : null;

      if (!repoInfo && task?.projectId) {
        const project = await prisma.project.findUnique({
          where: { id: task.projectId },
          include: { repository: true },
        });
        if (project?.repository) {
          repoInfo = {
            fullName: project.repository.fullName,
            defaultBranch: project.repository.defaultBranch,
          };
        }
      }

      if (repoInfo) {
        const result = await createPullRequest(
          repoInfo.fullName,
          execution.branchName,
          repoInfo.defaultBranch,
          task?.title || 'Task',
          task?.description || null,
          execution.accessToken
        );

        prUrl = result.url;
        outcome = `${execution.filesChanged} file${execution.filesChanged !== 1 ? 's' : ''} changed, ${execution.toolsExecuted} tools executed`;

        if (result.type === 'pr') {
          addLogEntry(taskId, 'success', 'Pull request created', result.url);
          broadcastProgress(taskId, 'done', 'Pull request created', { prUrl: result.url, isCompareLink: false });
        } else {
          addLogEntry(taskId, 'success', 'Changes pushed! Create PR here:', result.url);
          broadcastProgress(taskId, 'done', 'Changes pushed successfully', { prUrl: result.url, isCompareLink: true });
        }
      } else {
        execution.status = 'error';
        outcome = 'Changes committed but no repository linked to create PR';
        addLogEntry(taskId, 'error', outcome);
        broadcastProgress(taskId, 'error', outcome);
        await finalizeAgentRun(execution, 'failed', { errorMessage: outcome });
        await updateTaskStatus(taskId, 'cancelled', null, {
          executionElapsedMs: elapsedMs,
          executionPausedAt: new Date(),
          executionProgress: 100,
          outcome,
        });
        return;
      }
    } else if (commitResult.status === 'no_changes') {
      execution.status = 'error';
      outcome = 'Agent finished without making code changes';
      addLogEntry(taskId, 'error', 'Agent finished without making code changes');
      broadcastProgress(taskId, 'error', 'No code changes were made');
      await finalizeAgentRun(execution, 'failed', { errorMessage: outcome });
      await updateTaskStatus(taskId, 'cancelled', null, {
        executionElapsedMs: elapsedMs,
        executionProgress: 100,
        outcome,
      });
      return;
    } else {
      execution.status = 'error';
      outcome = `Commit/push failed: ${commitResult.reason}`;
      addLogEntry(taskId, 'error', 'Failed to commit and push changes', commitResult.reason);
      broadcastProgress(taskId, 'error', 'Failed to commit and push changes');
      await finalizeAgentRun(execution, 'failed', { errorMessage: outcome });
      await updateTaskStatus(taskId, 'cancelled', null, {
        executionElapsedMs: elapsedMs,
        executionProgress: 100,
        outcome,
      });
      return;
    }

    await finalizeAgentRun(execution, 'succeeded', { prUrl });
    await updateTaskStatus(taskId, 'done', null, {
      executionElapsedMs: elapsedMs,
      executionProgress: 100,
      prUrl,
      outcome,
    });
  } catch (error) {
    logger.error({ err: error, taskId }, '[Execution] Post-execution error');
    addLogEntry(taskId, 'error', 'Post-execution failed');
    broadcastProgress(taskId, 'error', 'Post-execution failed');
    const errorMessage = error instanceof Error ? error.message : 'Post-execution failed';
    await finalizeAgentRun(execution, 'failed', {
      errorMessage,
    });
    await updateTaskStatus(taskId, 'cancelled', null, {
      executionElapsedMs: elapsedMs,
      executionPausedAt: new Date(),
      executionProgress: 100,
      outcome: errorMessage,
    });
  } finally {
    await persistLogs(taskId);
    await cleanupExecution(taskId);
  }
}

// Extract session ID from various OpenCode event structures.
// Exported so other event-stream consumers (e.g. services/batch/event-handler.ts)
// reuse this instead of hand-rolling a second, divergent parser (see C-01).
export function extractSessionId(event: { type: string; properties?: Record<string, unknown> }): string | undefined {
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

// extractCleanError moved to event-stream-processor.ts

async function handleOpenCodeEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
  if (event.type === 'server.heartbeat') return;

  const sessionId = extractSessionId(event);
  const taskId = findTaskBySessionId(String(sessionId));
  if (!taskId) return;

  const execution = activeExecutions.get(taskId);
  if (!execution) return;

  const state: EventProcessorState = {
    taskId,
    sessionId: execution.sessionId,
    promptSent: execution.promptSent,
    cancelled: execution.cancelled,
    status: execution.status,
    backgroundTaskRunning: execution.backgroundTaskRunning,
    backgroundTaskFailure: execution.backgroundTaskFailure,
    backgroundTaskIds: execution.backgroundTaskIds,
    backgroundTaskResultBuffer: execution.backgroundTaskResultBuffer,
    completedToolKeys: execution.completedToolKeys,
    toolsExecuted: execution.toolsExecuted,
    filesChanged: execution.filesChanged,
  };

  const actions = processEvent(event, state);

  for (const action of actions) {
    switch (action.type) {
      case 'ignore':
        return;
      case 'log':
        addLogEntry(taskId, action.level, action.message, action.details);
        break;
      case 'broadcastProgress':
        broadcastProgress(taskId, action.status, action.message, action.data);
        break;
      case 'flushDeltaBuffer':
        flushDeltaBuffer(taskId);
        break;
      case 'appendTextDelta':
        appendTextDelta(taskId, action.delta);
        break;
      case 'appendReasoningDelta':
        appendReasoningDelta(taskId, action.delta);
        break;
      case 'markThinking':
        if (markThinking(taskId)) {
          addLogEntry(taskId, 'agent', 'Agent is thinking...');
        }
        break;
      case 'setPromptSent':
        execution.promptSent = true;
        break;
      case 'incrementFilesChanged':
        execution.filesChanged++;
        break;
      case 'noteToolCompleted':
        noteToolCompleted(taskId, action.toolName, action.output, action.part);
        break;
      case 'observeBackgroundTaskText':
        observeBackgroundTaskText(taskId, action.text);
        break;
      case 'launchBackgroundTask': {
        execution.backgroundTaskRunning = true;
        execution.backgroundTaskFailure = null;
        execution.backgroundTaskResultBuffer = action.output;
        if (action.backgroundTaskId && !execution.backgroundTaskIds.includes(action.backgroundTaskId)) {
          execution.backgroundTaskIds.push(action.backgroundTaskId);
        }
        resetNoProgressWatchdog(taskId, execution.sessionId, BACKGROUND_TASK_WAIT_TIMEOUT_MS, BACKGROUND_TASK_TIMEOUT_MESSAGE);
        break;
      }
      case 'clearBackgroundTaskWait':
        clearBackgroundTaskWait(taskId, action.status, action.details);
        break;
      case 'resetEventStreamTimeout':
        resetNoProgressWatchdog(taskId, execution.sessionId, action.timeoutMs, action.timeoutMessage);
        break;
      case 'handleSessionComplete':
        await handleSessionComplete(taskId);
        break;
      case 'failExecution':
        await failExecutionFromEventStream(taskId, action.message, action.details);
        break;
      case 'sessionError': {
        if (!claimFinalize(taskId)) break;
        clearAllWatchdogs(taskId);
        addLogEntry(taskId, 'error', action.headline, action.errorDetail);
        broadcastProgress(taskId, 'error', action.headline);
        await finalizeAgentRun(execution, 'failed', { errorMessage: action.errorDetail });
        const elapsedMs = Date.now() - execution.startedAt.getTime();
        await updateTaskStatus(taskId, 'cancelled', null, {
          executionElapsedMs: elapsedMs,
          executionPausedAt: new Date(),
        });
        await persistLogs(taskId);
        await cleanupExecution(taskId);
        break;
      }
      case 'replyPermission':
        try {
          await execution.client.postSessionIdPermissionsPermissionId({
            path: { id: execution.sessionId, permissionID: action.permissionId },
            body: { response: action.reply },
          });
        } catch (error) {
          logger.error({ err: error, taskId }, `[Execution] Failed to reply to permission request for task ${taskId.slice(0, 8)}`);
        }
        break;
      case 'suspendWatchdog':
        suspendWatchdogs(taskId);
        break;
      case 'resumeWatchdog':
        resumeWatchdogs(taskId, execution.client, execution.sessionId);
        break;
      case 'recordUsage':
        recordMessageUsage(execution, action.messageId, {
          cost: action.cost,
          inputTokens: action.inputTokens,
          outputTokens: action.outputTokens,
          reasoningTokens: action.reasoningTokens,
          cacheReadTokens: action.cacheReadTokens,
          cacheWriteTokens: action.cacheWriteTokens,
        });
        break;
    }
  }
}

/**
 * Attaches a live consumer loop to an OpenCode event stream for one task's
 * session. Used both for the initial subscription and — T4 — to re-attach
 * after the transport watchdog fires and a re-subscribe succeeds.
 */
function attachEventStream(
  taskId: string,
  client: OpencodeClient,
  sessionId: string,
  stream: ClosableEventStream,
): void {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;

  const myCleanup = async () => {
    clearAllWatchdogs(taskId);
    if (typeof stream.return === 'function') {
      await stream.return();
    }
  };
  execution.eventStreamCleanup = myCleanup;
  resetTransportWatchdog(taskId, client, sessionId);
  resetNoProgressWatchdog(taskId, sessionId);

  (async () => {
    let failureHandled = false;
    try {
      for await (const event of stream) {
        // Liveness: ANY frame proves the transport is alive, whether or not
        // it belongs to this task's session — heartbeats carry no sessionID
        // at all, and another session's traffic on the same server-wide
        // stream still proves the connection itself is up.
        resetTransportWatchdog(taskId, client, sessionId);

        const eventSessionId = extractSessionId(event);
        if (eventSessionId !== sessionId) continue;

        if (event.type !== 'server.heartbeat') {
          const current = activeExecutions.get(taskId);
          if (current && !current.watchdogSuspended) {
            resetNoProgressWatchdog(taskId, sessionId);
          }
        }

        if (isTerminalSessionEvent(event.type)) {
          clearNoProgressWatchdog(taskId);
        }

        await handleOpenCodeEvent(event);
        if (!activeExecutions.has(taskId)) {
          break;
        }
      }
    } catch (error) {
      logger.error({ err: error, taskId }, `[Execution] Event stream error for task ${taskId.slice(0, 8)}`);
      failureHandled = true;
      await failExecutionFromEventStream(
        taskId,
        'Agent event stream failed',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      const current = activeExecutions.get(taskId);
      // Only the loop instance that is still "current" acts on its own end.
      // A transport-watchdog re-subscribe replaces `eventStreamCleanup` with
      // a new closure before this loop's underlying connection is abandoned,
      // so this stale loop finally erroring out afterward must not re-fail
      // an execution that already recovered onto the new stream.
      if (current && current.eventStreamCleanup === myCleanup) {
        clearAllWatchdogs(taskId);
        current.eventStreamCleanup = undefined;
        if (!current.cancelled && !failureHandled) {
          await failExecutionFromEventStream(taskId, 'Agent event stream ended unexpectedly');
        }
      }
    }
  })();
}

export async function subscribeToSessionEvents(taskId: string, client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    const events = await client.event.subscribe();
    attachEventStream(taskId, client, sessionId, events.stream as unknown as ClosableEventStream);
  } catch (error) {
    logger.error({ err: error, taskId }, `[Execution] Failed to subscribe to events for task ${taskId.slice(0, 8)}`);
    addLogEntry(taskId, 'error', 'Failed to subscribe to agent events');
    await failExecutionFromEventStream(
      taskId,
      'Failed to subscribe to agent events',
      error instanceof Error ? error.message : String(error),
    );
  }
}
