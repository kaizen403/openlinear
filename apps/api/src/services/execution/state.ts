import { exec } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@openlinear/db';
import { broadcast } from '../../sse';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { cleanupDeltaBuffer, flushDeltaBuffer } from '../delta-buffer';

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

export const execAsync = promisify(exec);

export const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';
export const TASK_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecutionState {
  taskId: string;
  projectId: string;
  sessionId: string;
  repoPath: string;
  branchName: string;
  userId: string | null;
  accessToken: string | null;
  timeoutId: NodeJS.Timeout;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
  logs: ExecutionLogEntry[];
  client: OpencodeClient;
  startedAt: Date;
  filesChanged: number;
  toolsExecuted: number;
  promptSent: boolean;
  cancelled: boolean;
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

export let eventSubscriptionActive = false;

export function setEventSubscriptionActive(value: boolean) {
  eventSubscriptionActive = value;
}

export function getRunningTaskCount(): number {
  return activeExecutions.size;
}

export function isTaskRunning(taskId: string): boolean {
  return activeExecutions.has(taskId);
}

export function getExecutionStatus(taskId: string): ExecutionState | undefined {
  return activeExecutions.get(taskId);
}

export function broadcastProgress(taskId: string, status: string, message: string, data?: Record<string, unknown>) {
  console.log(`[Execution] ${taskId.slice(0, 8)} → ${status}: ${message}`);
  broadcast('execution:progress', { taskId, status, message, ...data });
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
  console.log(`[Execution] ${taskId.slice(0, 8)} ${emoji} ${message}${details ? ` (${details.slice(0, 50)})` : ''}`);

  broadcast('execution:log', { taskId, entry });
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
    
    broadcast('task:updated', flatTask);
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
