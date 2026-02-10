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
}

export interface ExecutionProgress {
  taskId: string
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'cancelled' | 'error'
  message: string
  prUrl?: string
  isCompareLink?: boolean
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
