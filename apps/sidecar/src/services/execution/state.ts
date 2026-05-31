import { prisma } from '@openlinear/db';
import { broadcastToTask, broadcastToTaskById } from '@openlinear/api/sse';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { cleanupDeltaBuffer, flushDeltaBuffer } from '../delta-buffer';
import { assertPathInsideReposDir, buildReposPath, REPOS_DIR } from '../repo-storage';

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface TaskLabelRelation {
  taskId: string;
  labelId: string;
  label: Label;
}

export { assertPathInsideReposDir, buildReposPath, REPOS_DIR };
export const TASK_TIMEOUT_MS = 30 * 60 * 1000;

const BROADCAST_RETRY_DELAY_MS = 1_000;
const BROADCAST_MAX_ATTEMPTS = 3;
const criticalProgressStatuses = new Set(['done', 'error', 'cancelled']);

export interface ExecutionState {
  taskId: string;
  projectId: string;
  sessionId: string;
  repoPath: string;
  branchName: string;
  userId: string | null;
  accessToken: string | null;
  timeoutId: NodeJS.Timeout;
  streamTimeoutId: NodeJS.Timeout | null;
  eventStreamCleanup?: () => Promise<void> | void;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
  logs: ExecutionLogEntry[];
  client: OpencodeClient;
  startedAt: Date;
  filesChanged: number;
  toolsExecuted: number;
  promptSent: boolean;
  backgroundTaskRunning: boolean;
  backgroundTaskFailure: string | null;
  backgroundTaskIds: string[];
  backgroundTaskResultBuffer: string;
  completedToolKeys: Set<string>;
  cancelled: boolean;
  // T11: SDK `message.updated` reports per-message TOTALS (not deltas). Keep
  // the latest snapshot per assistant messageId; sum at finalize time.
  agentRunId: string | null;
  cost: { input: number; output: number; total: number };
  tokens: { input: number; output: number };
  messageUsage: Map<string, { cost: number; inputTokens: number; outputTokens: number }>;
}

export interface ExecutionLogEntry {
  timestamp: string;
  type: 'info' | 'agent' | 'tool' | 'error' | 'success';
  message: string;
  details?: string;
}

export interface ExecuteTaskParams {
  taskId: string;
  userId?: string;
}

export interface PullRequestResult {
  url: string;
  type: 'pr' | 'compare';
}

// --- ExecutionStateStore: encapsulates global execution state ---

export class ExecutionStateStore {
  private executions = new Map<string, ExecutionState>();
  private sessionToTaskMap = new Map<string, string>();

  get(taskId: string): ExecutionState | undefined {
    return this.executions.get(taskId);
  }

  has(taskId: string): boolean {
    return this.executions.has(taskId);
  }

  set(taskId: string, state: ExecutionState): void {
    this.executions.set(taskId, state);
    this.sessionToTaskMap.set(state.sessionId, taskId);
  }

  getBySession(sessionId: string): ExecutionState | undefined {
    const taskId = this.sessionToTaskMap.get(sessionId);
    if (taskId) return this.executions.get(taskId);
    /* v8 ignore start -- fallback scan: unreachable via public API. */
    for (const [tid, execution] of this.executions.entries()) {
      if (execution.sessionId === sessionId) {
        this.sessionToTaskMap.set(sessionId, tid);
        return execution;
      }
    }
    /* v8 ignore stop */
    return undefined;
  }

  getTaskIdBySession(sessionId: string): string | undefined {
    const taskId = this.sessionToTaskMap.get(sessionId);
    if (taskId) return taskId;
    /* v8 ignore start -- fallback scan: unreachable via public API. */
    for (const [tid, execution] of this.executions.entries()) {
      if (execution.sessionId === sessionId) {
        this.sessionToTaskMap.set(sessionId, tid);
        return tid;
      }
    }
    /* v8 ignore stop */
    return undefined;
  }

  remove(taskId: string): void {
    const execution = this.executions.get(taskId);
    if (execution) {
      this.sessionToTaskMap.delete(execution.sessionId);
    }
    this.executions.delete(taskId);
  }

  count(): number {
    return this.executions.size;
  }

  reset(): void {
    this.executions.clear();
    this.sessionToTaskMap.clear();
  }

  setSessionMapping(sessionId: string, taskId: string): void {
    this.sessionToTaskMap.set(sessionId, taskId);
  }

  entries(): IterableIterator<[string, ExecutionState]> {
    return this.executions.entries();
  }

  values(): IterableIterator<ExecutionState> {
    return this.executions.values();
  }

  sessionEntries(): IterableIterator<[string, string]> {
    return this.sessionToTaskMap.entries();
  }
}

/** Singleton store instance — import this instead of raw Maps */
export const executionStore = new ExecutionStateStore();

// --- Backward-compatible exports (delegate to store) ---

/**
 * @deprecated Use executionStore directly.
 * Proxy that delegates Map operations to the ExecutionStateStore singleton.
 */
export const activeExecutions: Map<string, ExecutionState> = new Proxy(new Map<string, ExecutionState>(), {
  get(_target, prop: string | symbol) {
    switch (prop) {
      case 'get': return (key: string) => executionStore.get(key);
      case 'has': return (key: string) => executionStore.has(key);
      case 'set': return (key: string, value: ExecutionState) => { executionStore.set(key, value); return activeExecutions; };
      case 'delete': return (key: string) => { executionStore.remove(key); return true; };
      case 'size': return executionStore.count();
      case 'entries': return () => executionStore.entries();
      case 'values': return () => executionStore.values();
      case 'keys': return () => {
        const keys: string[] = [];
        for (const [k] of executionStore.entries()) keys.push(k);
        return keys[Symbol.iterator]();
      };
      case 'forEach': return (fn: (value: ExecutionState, key: string, map: Map<string, ExecutionState>) => void) => {
        for (const [k, v] of executionStore.entries()) fn(v, k, activeExecutions);
      };
      case 'clear': return () => executionStore.reset();
      case Symbol.iterator: return () => executionStore.entries();
      case Symbol.toStringTag: return 'Map';
      default: return undefined;
    }
  },
}) as unknown as Map<string, ExecutionState>;

/**
 * @deprecated Use executionStore directly.
 * Proxy that delegates to ExecutionStateStore for session→task lookups.
 */
export const sessionToTask: Map<string, string> = new Proxy(new Map<string, string>(), {
  get(_target, prop: string | symbol) {
    switch (prop) {
      case 'get': return (sessionId: string) => executionStore.getTaskIdBySession(sessionId);
      case 'set': return (sessionId: string, taskId: string) => {
        executionStore.setSessionMapping(sessionId, taskId);
        return sessionToTask;
      };
      case 'delete': return (_sessionId: string) => {
        // no-op: managed by executionStore.remove()
        return true;
      };
      case 'has': return (sessionId: string) => executionStore.getTaskIdBySession(sessionId) !== undefined;
      case 'clear': return () => executionStore.reset();
      case Symbol.iterator: return () => executionStore.sessionEntries();
      case Symbol.toStringTag: return 'Map';
      default: return undefined;
    }
  },
}) as unknown as Map<string, string>;

export function getRunningTaskCount(): number {
  return executionStore.count();
}

export function isTaskRunning(taskId: string): boolean {
  return executionStore.has(taskId);
}

export function getExecutionStatus(taskId: string): ExecutionState | undefined {
  return executionStore.get(taskId);
}

function scheduleTaskBroadcast(
  taskId: string,
  event: string,
  payload: unknown,
  critical = false,
  attempt = 1,
): void {
  broadcastToTaskById(taskId, event, payload).catch((error: unknown) => {
    console.error(
      `[Execution] Failed to broadcast ${event} for task ${taskId.slice(0, 8)} (attempt ${attempt}):`,
      error,
    );

    if (!critical || attempt >= BROADCAST_MAX_ATTEMPTS) {
      return;
    }

    setTimeout(() => {
      scheduleTaskBroadcast(taskId, event, payload, critical, attempt + 1);
    }, BROADCAST_RETRY_DELAY_MS).unref();
  });
}

export function broadcastProgress(taskId: string, status: string, message: string, data?: Record<string, unknown>) {
  console.log(`[Execution] ${taskId.slice(0, 8)} → ${status}: ${message}`);
  scheduleTaskBroadcast(
    taskId,
    'execution:progress',
    { taskId, status, message, ...data },
    criticalProgressStatuses.has(status),
  );
}

export function addLogEntry(taskId: string, type: ExecutionLogEntry['type'], message: string, details?: string) {
  const execution = executionStore.get(taskId);
  if (!execution) {
    console.log(`[Execution] Warning: No execution found for task ${taskId.slice(0, 8)} when adding log`);
    return;
  }

  const entry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    details,
  };

  execution.logs.push(entry);

  const emoji = type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'tool' ? '🔧' : type === 'agent' ? '🤖' : '→';
  const detailStr = typeof details === 'string' ? details : details ? JSON.stringify(details) : undefined;
  console.log(`[Execution] ${taskId.slice(0, 8)} ${emoji} ${message}${detailStr ? ` (${detailStr.slice(0, 50)})` : ''}`);

  scheduleTaskBroadcast(taskId, 'execution:log', { taskId, entry });
}

export function getExecutionLogs(taskId: string): ExecutionLogEntry[] {
  const execution = executionStore.get(taskId);
  return execution?.logs || [];
}

export async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'done' | 'cancelled',
  sessionId: string | null,
  executionData?: {
    executionStartedAt?: Date;
    executionPausedAt?: Date | null;
    executionElapsedMs?: number;
    executionProgress?: number | null;
    prUrl?: string | null;
    outcome?: string | null;
  }
): Promise<void> {
  try {
    const task = await prisma.task.update({
      where: { id: taskId },
      data: { 
        status, 
        sessionId,
        ...executionData,
      },
      include: { labels: { include: { label: true } } },
    });
    
    const flatTask = {
      ...task,
      labels: task.labels.map((tl: TaskLabelRelation) => tl.label),
    };
    
    broadcastToTask('task:updated', flatTask);
  } catch (error) {
    console.error(`[Execution] Failed to update task ${taskId}:`, error);
  }
}

export function estimateProgress(execution: ExecutionState): number {
  const baseProgress = Math.min(execution.toolsExecuted * 5, 40);
  const fileProgress = Math.min(execution.filesChanged * 10, 30);
  const elapsedMinutes = (Date.now() - execution.startedAt.getTime()) / 60000;
  const timeProgress = Math.min(elapsedMinutes * 3, 20);
  return Math.min(Math.round(baseProgress + fileProgress + timeProgress), 95);
}

export async function persistLogs(taskId: string): Promise<void> {
  const execution = executionStore.get(taskId);
  if (!execution || execution.logs.length === 0) return;
  try {
    await prisma.$executeRaw`
      UPDATE tasks SET "executionLogs" = ${JSON.stringify(execution.logs)}::jsonb WHERE id = ${taskId}
    `;
  } catch (error) {
    console.error(`[Execution] Failed to persist logs for task ${taskId.slice(0, 8)}:`, error);
  }
}

export async function cleanupExecution(taskId: string): Promise<void> {
  const execution = executionStore.get(taskId);
  if (execution) {
    flushDeltaBuffer(taskId);
    cleanupDeltaBuffer(taskId);
    clearTimeout(execution.timeoutId);
    if (execution.streamTimeoutId) {
      clearTimeout(execution.streamTimeoutId);
      execution.streamTimeoutId = null;
    }
    if (execution.eventStreamCleanup) {
      try {
        await execution.eventStreamCleanup();
      } catch (error) {
        console.error(`[Execution] Failed to clean up event stream for task ${taskId.slice(0, 8)}:`, error);
      }
      execution.eventStreamCleanup = undefined;
    }
    executionStore.remove(taskId);
    console.log(`[Execution] Cleaned up task ${taskId.slice(0, 8)}, remaining: ${executionStore.count()}`);
  }
}

export async function getTaskTitle(taskId: string): Promise<string> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  return task?.title || 'Task';
}

export function findTaskBySessionId(sessionId: string): string | undefined {
  return executionStore.getTaskIdBySession(sessionId);
}
