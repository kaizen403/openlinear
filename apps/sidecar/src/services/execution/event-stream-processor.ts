/**
 * EventStreamProcessor — Pure function mapping OpenCode events to typed Actions.
 *
 * The processor inspects an event + execution state and returns an array of
 * Action objects describing what should happen. The orchestrator (events.ts)
 * interprets and executes these actions. This separation makes event handling
 * fully unit-testable without mocking external systems.
 */

import {
  extractBackgroundTaskId,
  isBackgroundTaskLaunch,
  isBackgroundTaskCancellation,
  isBackgroundTaskCompletion,
  isBackgroundTaskFailure,
} from '../../utils/background-task';

// --- Types ---

export type OpenCodeEvent = { type: string; properties?: Record<string, unknown> };

export type ToolPart = {
  id?: string;
  callID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: { status?: string; title?: string; output?: string };
};

/** Minimal execution snapshot needed for pure event processing */
export interface EventProcessorState {
  taskId: string;
  sessionId: string;
  promptSent: boolean;
  cancelled: boolean;
  status: string;
  backgroundTaskRunning: boolean;
  backgroundTaskFailure: string | null;
  backgroundTaskIds: string[];
  backgroundTaskResultBuffer: string;
  completedToolKeys: Set<string>;
  toolsExecuted: number;
  filesChanged: number;
}

// --- Action types ---

export type Action =
  | { type: 'ignore' }
  | { type: 'log'; level: 'info' | 'agent' | 'tool' | 'error' | 'success'; message: string; details?: string }
  | { type: 'broadcastProgress'; status: string; message: string; data?: Record<string, unknown> }
  | { type: 'flushDeltaBuffer' }
  | { type: 'appendTextDelta'; delta: string }
  | { type: 'appendReasoningDelta'; delta: string }
  | { type: 'markThinking' }
  | { type: 'setPromptSent' }
  | { type: 'incrementFilesChanged' }
  | { type: 'noteToolCompleted'; toolName: string; output?: string; part?: ToolPart }
  | { type: 'observeBackgroundTaskText'; text: string }
  | { type: 'launchBackgroundTask'; output: string; backgroundTaskId: string | null }
  | { type: 'clearBackgroundTaskWait'; status: 'completed' | 'cancelled' | 'failed'; details: string }
  | { type: 'resetEventStreamTimeout'; timeoutMs?: number; timeoutMessage?: string }
  | { type: 'handleSessionComplete' }
  | { type: 'failExecution'; message: string; details?: string }
  | { type: 'sessionError'; headline: string; errorDetail: string; isAuthError: boolean; isRateLimit: boolean };

const BACKGROUND_TASK_BUFFER_LIMIT = 4_000;

// --- Pure processor ---

/**
 * Given an OpenCode event and the current execution state snapshot,
 * returns an ordered list of actions to execute.
 */
export function processEvent(event: OpenCodeEvent, state: EventProcessorState): Action[] {
  if (event.type === 'server.heartbeat') return [{ type: 'ignore' }];

  const actions: Action[] = [];

  switch (event.type) {
    case 'session.idle':
    case 'session.completed': {
      if (!state.promptSent || state.cancelled) {
        return [{ type: 'ignore' }];
      }
      actions.push({ type: 'flushDeltaBuffer' });
      if (state.backgroundTaskFailure) {
        actions.push({ type: 'failExecution', message: 'Background subtask failed', details: state.backgroundTaskFailure });
        return actions;
      }
      if (state.backgroundTaskRunning) {
        actions.push({ type: 'log', level: 'info', message: 'Agent is waiting on a background subtask' });
        actions.push({ type: 'broadcastProgress', status: 'executing', message: 'Waiting for background subtask to finish...' });
        actions.push({ type: 'resetEventStreamTimeout', timeoutMs: 10 * 60 * 1000, timeoutMessage: 'Background subtask timed out' });
        return actions;
      }
      actions.push({ type: 'log', level: 'success', message: 'Agent completed work' });
      actions.push({ type: 'handleSessionComplete' });
      return actions;
    }

    case 'session.error': {
      if (state.status === 'committing' || state.status === 'creating_pr' || state.status === 'done') {
        return [{ type: 'ignore' }];
      }
      const rawError = event.properties?.error;
      const { message: errorDetail, isAuthError, isRateLimit } = extractCleanError(rawError);
      const headline = isAuthError
        ? 'Invalid API key — update it in Settings → AI Providers'
        : isRateLimit
          ? 'Rate limit exceeded — try again later'
          : 'Execution failed';
      actions.push({ type: 'sessionError', headline, errorDetail, isAuthError, isRateLimit });
      return actions;
    }

    case 'session.status': {
      const status = event.properties?.status as { type?: string; message?: string } | undefined;
      if (status?.type === 'busy') {
        actions.push({ type: 'setPromptSent' });
        actions.push({ type: 'markThinking' });
        actions.push({ type: 'broadcastProgress', status: 'executing', message: 'Agent is thinking...' });
      } else if (status?.type === 'retry') {
        actions.push({ type: 'log', level: 'info', message: `Retrying: ${status.message || 'unknown reason'}` });
      }
      return actions;
    }

    case 'message.part.updated': {
      const part = event.properties?.part as ToolPart | undefined;
      const delta = event.properties?.delta as string;

      if (part?.type === 'text' && delta) {
        actions.push({ type: 'appendTextDelta', delta });
        actions.push({ type: 'observeBackgroundTaskText', text: delta });
      } else if (part?.type === 'tool') {
        actions.push({ type: 'flushDeltaBuffer' });
        const toolName = part.tool || 'unknown tool';
        const toolState = part.state;
        if (toolState?.status === 'running') {
          actions.push({ type: 'log', level: 'tool', message: `Running: ${toolState.title || toolName}` });
          actions.push({ type: 'broadcastProgress', status: 'executing', message: `Running: ${toolState.title || toolName}` });
        } else if (toolState?.status === 'completed') {
          const rawOutput = toolState.output || '';
          const output = rawOutput.slice(0, 100);
          actions.push({ type: 'noteToolCompleted', toolName, output: rawOutput, part });
          if (isBackgroundTaskLaunch(toolName, rawOutput)) {
            const backgroundTaskId = extractBackgroundTaskId(rawOutput);
            actions.push({ type: 'launchBackgroundTask', output: rawOutput.slice(-BACKGROUND_TASK_BUFFER_LIMIT), backgroundTaskId });
            actions.push({ type: 'log', level: 'info', message: 'Background subtask launched; waiting for it to finish', details: output });
            actions.push({ type: 'broadcastProgress', status: 'executing', message: 'Waiting for background subtask to finish...' });
          } else if (isBackgroundTaskCancellation(toolName, rawOutput)) {
            actions.push({ type: 'clearBackgroundTaskWait', status: 'cancelled', details: rawOutput.slice(-1_000) });
            actions.push({ type: 'log', level: 'success', message: `Completed: ${toolName}`, details: output });
          } else {
            actions.push({ type: 'observeBackgroundTaskText', text: rawOutput });
            actions.push({ type: 'log', level: 'success', message: `Completed: ${toolName}`, details: output });
          }
        } else if (toolState?.status === 'error') {
          actions.push({ type: 'log', level: 'error', message: `Failed: ${toolName}`, details: toolState.output });
        }
      } else if (part?.type === 'reasoning') {
        if (delta && delta.length > 0) {
          actions.push({ type: 'appendReasoningDelta', delta });
        }
      }
      return actions;
    }

    case 'tool.execute.before': {
      actions.push({ type: 'flushDeltaBuffer' });
      const tool = event.properties?.tool as string;
      if (tool) {
        actions.push({ type: 'log', level: 'tool', message: `Starting: ${tool}` });
      }
      return actions;
    }

    case 'tool.execute.after': {
      const tool = event.properties?.tool as string;
      const output = event.properties?.output as string;
      if (tool) {
        actions.push({ type: 'noteToolCompleted', toolName: tool, output });
        if (isBackgroundTaskCancellation(tool, output || '')) {
          actions.push({ type: 'clearBackgroundTaskWait', status: 'cancelled', details: output?.slice(-1_000) || '' });
        } else {
          actions.push({ type: 'observeBackgroundTaskText', text: output || '' });
        }
        actions.push({ type: 'log', level: 'success', message: `Finished: ${tool}`, details: output?.slice(0, 100) });
      }
      return actions;
    }

    case 'file.edited': {
      const file = event.properties?.file as string;
      if (file) {
        actions.push({ type: 'incrementFilesChanged' });
        actions.push({ type: 'log', level: 'success', message: `Edited file: ${file}` });
      }
      return actions;
    }

    default:
      return [];
  }
}

// --- Helper: extractCleanError (pure, no side effects) ---

export function extractCleanError(rawError: unknown): { message: string; isAuthError: boolean; isRateLimit: boolean } {
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

// --- Helper: observeBackgroundTaskBuffer (pure state computation) ---

export function computeBackgroundTaskObservation(
  currentBuffer: string,
  newText: string,
): { newBuffer: string; action: 'cancelled' | 'failed' | 'completed' | null; details: string } {
  if (!newText) return { newBuffer: currentBuffer, action: null, details: '' };

  const newBuffer = (currentBuffer + newText).slice(-BACKGROUND_TASK_BUFFER_LIMIT);

  if (isBackgroundTaskCancellation('text', newBuffer)) {
    return { newBuffer, action: 'cancelled', details: newBuffer.slice(-1_000) };
  }
  if (isBackgroundTaskFailure(newBuffer)) {
    return { newBuffer, action: 'failed', details: newBuffer.slice(-1_000) };
  }
  if (isBackgroundTaskCompletion(newBuffer)) {
    return { newBuffer, action: 'completed', details: newBuffer.slice(-1_000) };
  }

  return { newBuffer, action: null, details: '' };
}
