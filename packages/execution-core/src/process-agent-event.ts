import type { AgentEvent } from './agent';

export interface EventProcessorState {
  taskId: string;
  sessionId: string;
  promptSent: boolean;
  cancelled: boolean;
  status: string;
  backgroundTaskRunning: boolean;
  backgroundTaskFailure: string | null;
  completedToolKeys: Set<string>;
  toolsExecuted: number;
  filesChanged: number;
  suspendWatchdogs: boolean;
}

export type AgentAction =
  | { type: 'ignore' }
  | { type: 'log'; level: 'info' | 'agent' | 'tool' | 'error' | 'success'; message: string; details?: string }
  | { type: 'broadcastProgress'; status: string; message: string; data?: Record<string, unknown> }
  | { type: 'flushDeltaBuffer' }
  | { type: 'appendTextDelta'; delta: string }
  | { type: 'appendReasoningDelta'; delta: string }
  | { type: 'markThinking' }
  | { type: 'setPromptSent' }
  | { type: 'incrementFilesChanged' }
  | { type: 'noteToolCompleted'; toolName: string; output?: string }
  | { type: 'resetEventStreamTimeout'; timeoutMs?: number; timeoutMessage?: string }
  | { type: 'handleSessionComplete' }
  | { type: 'failExecution'; message: string; details?: string }
  | { type: 'sessionError'; headline: string; errorDetail: string; isAuthError: boolean; isRateLimit: boolean }
  | { type: 'replyPermission'; permissionId: string; reply: 'once' | 'always' | 'reject' }
  | { type: 'suspendWatchdog' }
  | { type: 'resumeWatchdog' }
  | {
      type: 'recordUsage';
      messageId: string;
      cost: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { type: 'checkpointThenStop'; reason: string }
  | { type: 'touchHeartbeat' };

/**
 * Pure reducer over the normalized AgentEvent vocabulary.
 * OpenCode-specific decoding happens in the runner adapter.
 */
export function processAgentEvent(event: AgentEvent, state: EventProcessorState): AgentAction[] {
  if (state.cancelled && event.t !== 'turn.finished' && event.t !== 'error') {
    return [{ type: 'ignore' }];
  }

  switch (event.t) {
    case 'heartbeat':
      return [{ type: 'touchHeartbeat' }];
    case 'session.started':
      return [
        { type: 'setPromptSent' },
        { type: 'log', level: 'info', message: `Session ${event.externalId} started` },
        { type: 'broadcastProgress', status: 'executing', message: 'Agent session started' },
      ];
    case 'turn.started':
      return [
        { type: 'markThinking' },
        { type: 'broadcastProgress', status: 'executing', message: `Turn ${event.turn}` },
      ];
    case 'message.delta':
      return event.text ? [{ type: 'appendTextDelta', delta: event.text }] : [{ type: 'ignore' }];
    case 'reasoning.delta':
      return event.text ? [{ type: 'appendReasoningDelta', delta: event.text }] : [{ type: 'ignore' }];
    case 'tool.started':
      return [
        { type: 'log', level: 'tool', message: event.name, details: event.callId },
        { type: 'broadcastProgress', status: 'executing', message: `Running ${event.name}` },
      ];
    case 'tool.output':
      return [{ type: 'log', level: 'tool', message: event.callId, details: event.chunk }];
    case 'tool.finished': {
      const actions: AgentAction[] = [
        { type: 'noteToolCompleted', toolName: event.name, output: event.summary },
      ];
      if (!event.ok) {
        actions.push({ type: 'log', level: 'error', message: `${event.name} failed`, details: event.summary });
      }
      return actions;
    }
    case 'file.changed':
      return [{ type: 'incrementFilesChanged' }];
    case 'permission.requested':
      return [
        { type: 'suspendWatchdog' },
        { type: 'log', level: 'info', message: `Permission requested: ${event.tool}`, details: event.detail },
        { type: 'broadcastProgress', status: 'executing', message: 'Waiting for approval' },
      ];
    case 'compaction':
      if (event.phase === 'start') {
        return [
          { type: 'suspendWatchdog' },
          { type: 'log', level: 'info', message: 'Compaction started' },
        ];
      }
      return [
        { type: 'resumeWatchdog' },
        { type: 'log', level: 'info', message: 'Compaction finished' },
      ];
    case 'usage':
      return [
        {
          type: 'recordUsage',
          messageId: event.messageId ?? 'turn',
          cost: event.cost?.usd ?? 0,
          inputTokens: event.usage.input,
          outputTokens: event.usage.output,
          reasoningTokens: event.usage.reasoning,
          cacheReadTokens: event.usage.cacheRead,
          cacheWriteTokens: event.usage.cacheWrite,
        },
      ];
    case 'turn.finished': {
      if (!state.promptSent || state.cancelled) return [{ type: 'ignore' }];
      if (event.reason === 'error') {
        return [{ type: 'failExecution', message: 'Turn ended with error' }];
      }
      if (event.reason === 'interrupted') {
        return [{ type: 'failExecution', message: 'Run interrupted' }];
      }
      return [
        { type: 'flushDeltaBuffer' },
        { type: 'log', level: 'success', message: 'Agent completed work' },
        { type: 'handleSessionComplete' },
      ];
    }
    case 'error': {
      const isRateLimit = event.code === 'rate_limit' || event.retryable;
      return [
        {
          type: 'sessionError',
          headline: event.message,
          errorDetail: event.code,
          isAuthError: event.code === 'auth',
          isRateLimit,
        },
      ];
    }
    default:
      return [{ type: 'ignore' }];
  }
}
