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
import { finalizeAgentRun } from './agent-run';
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
} from './state';

const EVENT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const BACKGROUND_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const BACKGROUND_TASK_BUFFER_LIMIT = 4_000;
const EVENT_STREAM_TIMEOUT_MESSAGE = 'Agent event stream timed out';
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

function clearEventStreamTimeout(taskId: string): void {
  const execution = activeExecutions.get(taskId);
  if (execution?.streamTimeoutId) {
    clearTimeout(execution.streamTimeoutId);
    execution.streamTimeoutId = null;
  }
}

async function failExecutionFromEventStream(taskId: string, message: string, details?: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled) return;

  const recoverableStreamFailure =
    message === EVENT_STREAM_TIMEOUT_MESSAGE ||
    message === BACKGROUND_TASK_TIMEOUT_MESSAGE ||
    message === 'Agent event stream failed' ||
    message === 'Agent event stream ended unexpectedly';

  if (recoverableStreamFailure) {
    try {
      if (await hasCommittableChanges(execution.repoPath)) {
        clearEventStreamTimeout(taskId);
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
        await handleSessionComplete(taskId);
        return;
      }
    } catch (error) {
      logger.error({ err: error, taskId }, `[Execution] Failed to inspect worktree after stream failure for task ${taskId.slice(0, 8)}`);
    }
  }

  execution.status = 'error';
  execution.cancelled = true;
  clearEventStreamTimeout(taskId);

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

function resetEventStreamTimeout(
  taskId: string,
  sessionId: string,
  timeoutMs = EVENT_STREAM_IDLE_TIMEOUT_MS,
  timeoutMessage = EVENT_STREAM_TIMEOUT_MESSAGE,
): void {
  clearEventStreamTimeout(taskId);
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.sessionId !== sessionId || execution.cancelled) return;

  const waitingForBackgroundTask =
    execution.backgroundTaskRunning
    && timeoutMs === EVENT_STREAM_IDLE_TIMEOUT_MS
    && timeoutMessage === EVENT_STREAM_TIMEOUT_MESSAGE;
  const effectiveTimeoutMs = waitingForBackgroundTask ? BACKGROUND_TASK_WAIT_TIMEOUT_MS : timeoutMs;
  const effectiveTimeoutMessage = waitingForBackgroundTask ? BACKGROUND_TASK_TIMEOUT_MESSAGE : timeoutMessage;

  execution.streamTimeoutId = setTimeout(() => {
    /* v8 ignore start -- the catch callback only runs if timeout failure handling itself rejects. */
    void failExecutionFromEventStream(taskId, effectiveTimeoutMessage).catch((error: unknown) => {
      logger.error({ err: error, taskId }, `[Execution] Failed to handle event stream timeout for task ${taskId.slice(0, 8)}`);
    });
    /* v8 ignore stop */
  }, effectiveTimeoutMs);
  execution.streamTimeoutId.unref();
}

function isTerminalSessionEvent(eventType: string): boolean {
  return eventType === 'session.idle' || eventType === 'session.completed' || eventType === 'session.error';
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
  resetEventStreamTimeout(taskId, execution.sessionId);
}

function noteToolCompleted(taskId: string, toolName: string, output?: string, part?: ToolPart): void {
  const execution = activeExecutions.get(taskId);
  if (!execution) return;

  const keySource = (output || part?.callID || part?.id || `${toolName}:${Date.now()}`).slice(0, 1_000);
  const key = `${toolName}:${keySource}`;
  if (execution.completedToolKeys.has(key)) return;

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

async function handleSessionComplete(taskId: string): Promise<void> {
  const execution = activeExecutions.get(taskId)!;

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

// Extract session ID from various OpenCode event structures
function extractSessionId(event: { type: string; properties?: Record<string, unknown> }): string | undefined {
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
        resetEventStreamTimeout(taskId, execution.sessionId, BACKGROUND_TASK_WAIT_TIMEOUT_MS, BACKGROUND_TASK_TIMEOUT_MESSAGE);
        break;
      }
      case 'clearBackgroundTaskWait':
        clearBackgroundTaskWait(taskId, action.status, action.details);
        break;
      case 'resetEventStreamTimeout':
        resetEventStreamTimeout(taskId, execution.sessionId, action.timeoutMs, action.timeoutMessage);
        break;
      case 'handleSessionComplete':
        await handleSessionComplete(taskId);
        break;
      case 'failExecution':
        await failExecutionFromEventStream(taskId, action.message, action.details);
        break;
      case 'sessionError': {
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
    }
  }
}

export async function subscribeToSessionEvents(taskId: string, client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    const events = await client.event.subscribe();
    const stream = events.stream as unknown as ClosableEventStream;
    const execution = activeExecutions.get(taskId);
    if (execution) {
      execution.eventStreamCleanup = async () => {
        clearEventStreamTimeout(taskId);
        if (typeof stream.return === 'function') {
          await stream.return();
        }
      };
      resetEventStreamTimeout(taskId, sessionId);
    }
    
    (async () => {
      let failureHandled = false;
      try {
        for await (const event of stream) {
          const eventSessionId = extractSessionId(event);
          if (eventSessionId === sessionId) {
            if (isTerminalSessionEvent(event.type)) {
              clearEventStreamTimeout(taskId);
            } else {
              resetEventStreamTimeout(taskId, sessionId);
            }
            await handleOpenCodeEvent(event);
            if (!activeExecutions.has(taskId)) {
              break;
            }
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
        clearEventStreamTimeout(taskId);
        const current = activeExecutions.get(taskId);
        if (current && current.eventStreamCleanup === execution?.eventStreamCleanup) {
          current.eventStreamCleanup = undefined;
        }
        if (current && !current.cancelled && !failureHandled) {
          await failExecutionFromEventStream(taskId, 'Agent event stream ended unexpectedly');
        }
      }
    })();
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
