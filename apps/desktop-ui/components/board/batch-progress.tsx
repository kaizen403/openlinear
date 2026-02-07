"use client"

import { Button } from "@/components/ui/button"
import { X, Zap, Loader2 } from "lucide-react"

interface BatchProgressTask {
  taskId: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
}

interface BatchProgressProps {
  batchId: string
  status: string
  mode: string
  tasks: BatchProgressTask[]
  onCancel: (batchId: string) => void
}

const statusColors: Record<string, string> = {
  queued: 'bg-linear-text-tertiary',
  running: 'bg-linear-accent',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-yellow-500',
  cancelled: 'bg-gray-500',
}

export function BatchProgress({ batchId, status, mode, tasks, onCancel }: BatchProgressProps) {
  const total = tasks.length
  const completed = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const done = tasks.filter(t => !['queued', 'running'].includes(t.status)).length
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0
  const isRunning = status === 'running' || status === 'merging'

  return (
    <div className="mx-6 mt-4 mb-0 p-3 bg-linear-bg-secondary border border-linear-border rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="w-4 h-4 animate-spin text-linear-accent" />
          ) : (
            <Zap className="w-4 h-4 text-linear-text-secondary" />
          )}
          <span className="text-sm text-linear-text">
            Batch {mode === 'parallel' ? 'parallel' : 'queue'}: {completed}/{total} complete
            {failed > 0 && <span className="text-red-400 ml-1">({failed} failed)</span>}
          </span>
        </div>
        {isRunning && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCancel(batchId)}
            className="h-7 text-xs text-linear-text-tertiary hover:text-red-400"
          >
            <X className="w-3 h-3 mr-1" />
            Cancel
          </Button>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-linear-bg-tertiary rounded-full overflow-hidden">
        <div
          className="h-full bg-linear-accent rounded-full transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Task status dots */}
      <div className="flex gap-1 mt-2">
        {tasks.map(task => (
          <div
            key={task.taskId}
            className={`h-1.5 flex-1 rounded-full ${statusColors[task.status] || 'bg-gray-500'}`}
            title={`${task.title}: ${task.status}`}
          />
        ))}
      </div>
    </div>
  )
}
