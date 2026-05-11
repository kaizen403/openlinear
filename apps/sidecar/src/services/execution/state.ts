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

export const activeExecutions = new Map<string, ExecutionState>();
export const sessionToTask = new Map<string, string>();

export function getRunningTaskCount(): number {
  return activeExecutions.size;
}

export function isTaskRunning(taskId: string): boolean {
  return activeExecutions.has(taskId);
}

export function getExecutionStatus(taskId: string): ExecutionState | undefined {
  return activeExecutions.get(taskId);
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
  const execution = activeExecutions.get(taskId);
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
  const execution = activeExecutions.get(taskId);
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
  const execution = activeExecutions.get(taskId);
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
  const execution = activeExecutions.get(taskId);
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
    sessionToTask.delete(execution.sessionId);
    activeExecutions.delete(taskId);
    console.log(`[Execution] Cleaned up task ${taskId.slice(0, 8)}, remaining: ${activeExecutions.size}`);
  }
}

export async function getTaskTitle(taskId: string): Promise<string> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  return task?.title || 'Task';
}

export function findTaskBySessionId(sessionId: string): string | undefined {
  // Fast path: use the lookup map
  const taskId = sessionToTask.get(sessionId);
  if (taskId) return taskId;
  
  // Fallback: scan activeExecutions (shouldn't be needed)
  for (const [tid, execution] of activeExecutions.entries()) {
    if (execution.sessionId === sessionId) {
      // Update the lookup map
      sessionToTask.set(sessionId, tid);
      return tid;
    }
  }
  return undefined;
}
