export interface Label {
  id: string
  name: string
  color: string
  priority: number
}

export interface Task {
  id: string
  title: string
  description: string | null
  priority: 'low' | 'medium' | 'high'
  status: 'todo' | 'in_progress' | 'done' | 'cancelled'
  sessionId: string | null
  createdAt: string
  updatedAt: string
  labels: Label[]
  executionStartedAt: string | null
  executionPausedAt: string | null
  executionElapsedMs: number
  executionProgress: number | null
  prUrl: string | null
  outcome: string | null
  batchId: string | null
  inboxRead: boolean
  identifier: string | null
  number: number | null
  dueDate: string | null
  assigneeId?: string | null
  creatorId?: string | null
  assignee?: { id: string; username: string; avatarUrl: string | null } | null
  creator?: { id: string; username: string; avatarUrl: string | null } | null
  teamId?: string | null
  projectId?: string | null
  model?: string | null
  /** FE-02: agent runner for this task (null = the project's default, else OpenCode). */
  agent?: string | null
  archived?: boolean
  /** W17a: ids of the tasks this one is blocked by (any status). */
  blockedByIds?: string[]
  /** W17a: blockers that are not done yet. */
  openBlockerCount?: number
}

export interface ExecutionProgress {
  taskId: string
  status: 'queued' | 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'cancelled' | 'error'
  message: string
  prUrl?: string
  isCompareLink?: boolean
  /** v2 run engine: the run and its journal sequence (dedupe across reconnects). */
  runId?: string
  runSeq?: number
  /** v2 run engine state (queued … verifying … recovery_required); see lib/run-model RunStateWire. */
  runState?: string
}

/** In flight: queued (accepted by the v2 engine, waiting for a slot) through publishing. */
const ACTIVE_PROGRESS_STATUSES: ReadonlySet<string> = new Set(['queued', 'cloning', 'executing', 'committing', 'creating_pr'])

export function isActiveProgressStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && ACTIVE_PROGRESS_STATUSES.has(status)
}

export interface ExecutionLogEntry {
  timestamp: string
  type: 'info' | 'agent' | 'tool' | 'error' | 'success'
  message: string
  details?: string
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}
