import { prisma } from '@openlinear/db';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { appendTextDelta, appendReasoningDelta, flushDeltaBuffer, markThinking } from '../delta-buffer';

import { commitAndPush, createPullRequest, hasCommittableChanges } from './git';
import { finalizeAgentRun, recordMessageUsage } from './agent-run';
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
          console.error(`[Execution] Abort before recovered commit failed for task ${taskId.slice(0, 8)}:`, error);
        }
        await handleSessionComplete(taskId);
        return;
      }
    } catch (error) {
      console.error(`[Execution] Failed to inspect worktree after stream failure for task ${taskId.slice(0, 8)}:`, error);
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
    console.error(`[Execution] Abort after event stream failure failed for task ${taskId.slice(0, 8)}:`, error);
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
    void failExecutionFromEventStream(taskId, effectiveTimeoutMessage).catch((error: unknown) => {
      console.error(`[Execution] Failed to handle event stream timeout for task ${taskId.slice(0, 8)}:`, error);
    });
  }, effectiveTimeoutMs);
  execution.streamTimeoutId.unref();
}

function isTerminalSessionEvent(eventType: string): boolean {
  return eventType === 'session.idle' || eventType === 'session.completed' || eventType === 'session.error';
}

function extractBackgroundTaskId(output: string): string | null {
  return output.match(/(?:task_id|Background Task ID):\s*([A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

function isBackgroundTaskLaunch(toolName: string, output: string): boolean {
  if (toolName !== 'task') return false;
  const lower = output.toLowerCase();
  return lower.includes('background task started')
    || lower.includes('background task launched')
    || (lower.includes('state: running') && lower.includes('task_status'));
}

function isBackgroundTaskCancellation(toolName: string, output: string): boolean {
  const lower = `${toolName}\n${output}`.toLowerCase();
  return toolName === 'background_cancel'
    || lower.includes('task cancelled successfully')
    || lower.includes('task canceled successfully')
    || lower.includes('background task cancelled')
    || lower.includes('background task canceled');
}

function isBackgroundTaskCompletion(output: string): boolean {
  return /Background task completed:/i.test(output) || /\bTask Completed\b/i.test(output);
}

function isBackgroundTaskFailure(output: string): boolean {
  return /Background task failed:/i.test(output) || /\bTask Failed\b/i.test(output);
}

function clearBackgroundTaskWait(
  taskId: string,
  status: 'completed' | 'cancelled' | 'failed',
  details?: string,
): void {
  const execution = activeExecutions.get(taskId);
  if (!execution || !execution.backgroundTaskRunning) return;

  execution.backgroundTaskRunning = false;
  execution.backgroundTaskFailure = status === 'failed' ? (details || 'Background subtask failed') : null;

  if (status === 'failed') {
    addLogEntry(taskId, 'error', 'Background subtask failed', execution.backgroundTaskFailure ?? undefined);
    return;
  }

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
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled) return;

  if (execution.backgroundTaskRunning) {
    addLogEntry(taskId, 'info', 'Waiting for background subtask before finishing execution');
    broadcastProgress(taskId, 'executing', 'Waiting for background subtask to finish...');
    resetEventStreamTimeout(
      taskId,
      execution.sessionId,
      BACKGROUND_TASK_WAIT_TIMEOUT_MS,
      BACKGROUND_TASK_TIMEOUT_MESSAGE,
    );
    return;
  }

  if (execution.backgroundTaskFailure) {
    await failExecutionFromEventStream(taskId, 'Background subtask failed', execution.backgroundTaskFailure);
    return;
  }

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
    console.error('[Execution] Post-execution error:', error);
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

function extractCleanError(rawError: unknown): { message: string; isAuthError: boolean; isRateLimit: boolean } {
  if (typeof rawError === 'string') {
    const lower = rawError.toLowerCase();
    return {
      message: rawError,
      isAuthError: lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication'),
      isRateLimit: lower.includes('rate limit') || lower.includes('429') || lower.includes('quota'),
    };
  }

  if (rawError && typeof rawError === 'object') {
    const err = rawError as Record<string, unknown>;

    // Shape: { name: "APIError", data: { message: "...", statusCode: 401, ... } }
    if (err.data && typeof err.data === 'object') {
      const data = err.data as Record<string, unknown>;
      const msg = typeof data.message === 'string' ? data.message : undefined;
      const statusCode = typeof data.statusCode === 'number' ? data.statusCode : undefined;
      if (msg) {
        return {
          message: msg,
          isAuthError: statusCode === 401 || statusCode === 403 || msg.toLowerCase().includes('api key'),
          isRateLimit: statusCode === 429 || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota'),
        };
      }
    }

    // Shape: { message: "..." }
    if (typeof err.message === 'string') {
      const lower = err.message.toLowerCase();
      return {
        message: err.message,
        isAuthError: lower.includes('api key') || lower.includes('unauthorized'),
        isRateLimit: lower.includes('rate limit') || lower.includes('429'),
      };
    }

    // Shape: { error: { message: "..." } }
    if (err.error && typeof err.error === 'object') {
      const inner = err.error as Record<string, unknown>;
      if (typeof inner.message === 'string') {
        return {
          message: inner.message,
          isAuthError: inner.message.toLowerCase().includes('api key'),
          isRateLimit: inner.message.toLowerCase().includes('rate limit'),
        };
      }
    }
  }

  return {
    message: rawError ? JSON.stringify(rawError).slice(0, 200) : 'Unknown error',
    isAuthError: false,
    isRateLimit: false,
  };
}

async function handleOpenCodeEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
  if (event.type === 'server.heartbeat') return;
  
  const sessionId = extractSessionId(event);
  const taskId = sessionId ? findTaskBySessionId(sessionId) : undefined;

  switch (event.type) {
    case 'session.idle':
    case 'session.completed':
      if (taskId) {
        const execution = activeExecutions.get(taskId);
        if (!execution?.promptSent || execution.cancelled) {
          console.log(`[Execution] Ignoring ${event.type} for task ${taskId.slice(0, 8)} (${!execution?.promptSent ? 'prompt not yet sent' : 'cancelled'})`);
          break;
        }
        flushDeltaBuffer(taskId);
        if (execution.backgroundTaskFailure) {
          await failExecutionFromEventStream(taskId, 'Background subtask failed', execution.backgroundTaskFailure);
          break;
        }
        if (execution.backgroundTaskRunning) {
          addLogEntry(taskId, 'info', 'Agent is waiting on a background subtask');
          broadcastProgress(taskId, 'executing', 'Waiting for background subtask to finish...');
          resetEventStreamTimeout(
            taskId,
            execution.sessionId,
            BACKGROUND_TASK_WAIT_TIMEOUT_MS,
            BACKGROUND_TASK_TIMEOUT_MESSAGE,
          );
          break;
        }
        addLogEntry(taskId, 'success', 'Agent completed work');
        await handleSessionComplete(taskId);
      }
      break;

    case 'session.error':
      if (taskId) {
        const execution = activeExecutions.get(taskId);
        if (execution?.status === 'committing' || execution?.status === 'creating_pr' || execution?.status === 'done') {
          break;
        }
        const rawError = event.properties?.error;
        const { message: errorDetail, isAuthError, isRateLimit } = extractCleanError(rawError);
        const headline = isAuthError
          ? 'Invalid API key — update it in Settings → AI Providers'
          : isRateLimit
            ? 'Rate limit exceeded — try again later'
            : 'Execution failed';
        addLogEntry(taskId, 'error', headline, errorDetail);
        broadcastProgress(taskId, 'error', headline);
    if (execution) {
      await finalizeAgentRun(execution, 'failed', { errorMessage: errorDetail });
    }
    const elapsedMs = execution ? Date.now() - execution.startedAt.getTime() : 0;
    await updateTaskStatus(taskId, 'cancelled', null, {
      executionElapsedMs: elapsedMs,
      executionPausedAt: new Date(),
    });
    await persistLogs(taskId);
    await cleanupExecution(taskId);
      }
      break;

    case 'session.status': {
      if (!taskId) break;
      const status = event.properties?.status as { type?: string; message?: string };
      if (status?.type === 'busy') {
        const execution = activeExecutions.get(taskId);
        if (execution) execution.promptSent = true;
        if (markThinking(taskId)) {
          addLogEntry(taskId, 'agent', 'Agent is thinking...');
        }
        broadcastProgress(taskId, 'executing', 'Agent is thinking...');
      } else if (status?.type === 'retry') {
        addLogEntry(taskId, 'info', `Retrying: ${status.message || 'unknown reason'}`);
      }
      break;
    }

    case 'message.part.updated': {
      if (!taskId) break;
      const part = event.properties?.part as ToolPart | undefined;
      const delta = event.properties?.delta as string;

      if (part?.type === 'text' && delta) {
        appendTextDelta(taskId, delta);
        observeBackgroundTaskText(taskId, delta);
      } else if (part?.type === 'tool') {
        flushDeltaBuffer(taskId);
        const toolName = part.tool || 'unknown tool';
        const state = part.state;
        if (state?.status === 'running') {
          addLogEntry(taskId, 'tool', `Running: ${state.title || toolName}`);
          broadcastProgress(taskId, 'executing', `Running: ${state.title || toolName}`);
        } else if (state?.status === 'completed') {
          const rawOutput = state.output || '';
          const output = rawOutput.slice(0, 100);
          noteToolCompleted(taskId, toolName, rawOutput, part);
          if (isBackgroundTaskLaunch(toolName, rawOutput)) {
            const launchExecution = activeExecutions.get(taskId);
            if (launchExecution) {
              launchExecution.backgroundTaskRunning = true;
              launchExecution.backgroundTaskFailure = null;
              launchExecution.backgroundTaskResultBuffer = rawOutput.slice(-BACKGROUND_TASK_BUFFER_LIMIT);
              const backgroundTaskId = extractBackgroundTaskId(rawOutput);
              if (backgroundTaskId && !launchExecution.backgroundTaskIds.includes(backgroundTaskId)) {
                launchExecution.backgroundTaskIds.push(backgroundTaskId);
              }
              resetEventStreamTimeout(
                taskId,
                launchExecution.sessionId,
                BACKGROUND_TASK_WAIT_TIMEOUT_MS,
                BACKGROUND_TASK_TIMEOUT_MESSAGE,
              );
            }
            addLogEntry(taskId, 'info', 'Background subtask launched; waiting for it to finish', output);
            broadcastProgress(taskId, 'executing', 'Waiting for background subtask to finish...');
          } else if (isBackgroundTaskCancellation(toolName, rawOutput)) {
            clearBackgroundTaskWait(taskId, 'cancelled', rawOutput.slice(-1_000));
            addLogEntry(taskId, 'success', `Completed: ${toolName}`, output);
          } else {
            observeBackgroundTaskText(taskId, rawOutput);
            addLogEntry(taskId, 'success', `Completed: ${toolName}`, output);
          }
        } else if (state?.status === 'error') {
          addLogEntry(taskId, 'error', `Failed: ${toolName}`, state.output);
        }
      } else if (part?.type === 'reasoning') {
        if (delta && delta.length > 0) {
          appendReasoningDelta(taskId, delta);
        }
      }
      break;
    }

    case 'tool.execute.before': {
      if (!taskId) break;
      flushDeltaBuffer(taskId);
      const tool = event.properties?.tool as string;
      if (tool) {
        addLogEntry(taskId, 'tool', `Starting: ${tool}`);
      }
      break;
    }

    case 'tool.execute.after': {
      if (!taskId) break;
      const tool = event.properties?.tool as string;
      const output = event.properties?.output as string;
      if (tool) {
        noteToolCompleted(taskId, tool, output);
        if (isBackgroundTaskCancellation(tool, output || '')) {
          clearBackgroundTaskWait(taskId, 'cancelled', output?.slice(-1_000));
        } else {
          observeBackgroundTaskText(taskId, output || '');
        }
        addLogEntry(taskId, 'success', `Finished: ${tool}`, output?.slice(0, 100));
      }
      break;
    }

    case 'file.edited': {
      if (!taskId) break;
      const file = event.properties?.file as string;
      if (file) {
        const execution = activeExecutions.get(taskId);
        if (execution) execution.filesChanged++;
        addLogEntry(taskId, 'success', `Edited file: ${file}`);
      }
      break;
    }

    default:
      break;
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
        console.error(`[Execution] Event stream error for task ${taskId.slice(0, 8)}:`, error);
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
    console.error(`[Execution] Failed to subscribe to events for task ${taskId.slice(0, 8)}:`, error);
    addLogEntry(taskId, 'error', 'Failed to subscribe to agent events');
    await failExecutionFromEventStream(
      taskId,
      'Failed to subscribe to agent events',
      error instanceof Error ? error.message : String(error),
    );
  }
}
