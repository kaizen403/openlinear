"use client"

import { useEffect, useRef } from "react"
import { X, Bot, Wrench, CheckCircle, AlertCircle, Info, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn, openExternal } from "@/lib/utils"

export interface ExecutionLogEntry {
  timestamp: string
  type: 'info' | 'agent' | 'tool' | 'error' | 'success'
  message: string
  details?: string
}

export interface ExecutionProgress {
  taskId: string
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'cancelled' | 'error'
  message: string
  prUrl?: string
}

interface Task {
  id: string
  title: string
  description: string | null
  priority: 'low' | 'medium' | 'high'
  status: 'todo' | 'in_progress' | 'done' | 'cancelled'
  sessionId: string | null
  createdAt: string
  updatedAt: string
  labels: Array<{ id: string; name: string; color: string; priority: number }>
}

interface ExecutionDrawerProps {
  task: Task | null
  logs: ExecutionLogEntry[]
  progress?: ExecutionProgress
  open: boolean
  onClose: () => void
}

const statusConfig = {
  cloning: { label: 'Cloning Repository', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  executing: { label: 'Executing', color: 'text-linear-accent', bg: 'bg-linear-accent/10' },
  committing: { label: 'Committing Changes', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  creating_pr: { label: 'Creating Pull Request', color: 'text-purple-400', bg: 'bg-purple-500/10' },
  done: { label: 'Completed', color: 'text-green-400', bg: 'bg-green-500/10' },
  cancelled: { label: 'Cancelled', color: 'text-gray-400', bg: 'bg-gray-500/10' },
  error: { label: 'Error', color: 'text-red-400', bg: 'bg-red-500/10' },
}

const logIcons = {
  info: Info,
  agent: Bot,
  tool: Wrench,
  error: AlertCircle,
  success: CheckCircle,
}

const logColors = {
  info: 'text-linear-text-secondary',
  agent: 'text-linear-accent',
  tool: 'text-yellow-400',
  error: 'text-red-400',
  success: 'text-green-400',
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function ExecutionDrawer({ task, logs, progress, open, onClose }: ExecutionDrawerProps) {
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logsEndRef.current && open) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, open])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, onClose])

  const currentStatus = progress?.status

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      <div
        className={cn(
          "fixed right-0 top-0 h-full w-[420px] z-50 bg-linear-bg border-l border-linear-border shadow-xl transition-transform duration-200 ease-out flex flex-col",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-start justify-between p-4 border-b border-linear-border">
          <div className="flex-1 min-w-0 pr-4">
            <h2 className="text-sm font-semibold text-linear-text truncate">
              {task?.title || 'Execution Details'}
            </h2>
            {task && (
              <p className="text-xs text-linear-text-tertiary mt-1">
                Task {task.id.slice(0, 8)}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-linear-text-secondary hover:text-linear-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {currentStatus && (
          <div className={cn("px-4 py-3 border-b border-linear-border", statusConfig[currentStatus].bg)}>
            <div className="flex items-center gap-2">
              {['cloning', 'executing', 'committing', 'creating_pr'].includes(currentStatus) && (
                <div className="w-2 h-2 rounded-full bg-current animate-pulse" style={{ color: statusConfig[currentStatus].color.replace('text-', '') }} />
              )}
              <span className={cn("text-sm font-medium", statusConfig[currentStatus].color)}>
                {statusConfig[currentStatus].label}
              </span>
            </div>
            {progress?.message && (
              <p className="text-xs text-linear-text-secondary mt-1 truncate">
                {progress.message}
              </p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-linear-text-tertiary">
              <Clock className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">No execution logs yet</p>
              <p className="text-xs mt-1">Logs will appear here when execution starts</p>
            </div>
          ) : (
            logs.map((log, index) => {
              const Icon = logIcons[log.type]
              return (
                <div
                  key={`${log.timestamp}-${index}`}
                  className="flex gap-2 text-sm"
                >
                  <div className="flex-shrink-0 mt-0.5">
                    <Icon className={cn("w-4 h-4", logColors[log.type])} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-linear-text-tertiary text-xs font-mono">
                        {formatTime(log.timestamp)}
                      </span>
                    </div>
                    <p className={cn(
                      "mt-0.5 break-words",
                      log.type === 'error' ? 'text-red-400' : 'text-linear-text-secondary'
                    )}>
                      {log.message}
                    </p>
                    {log.details && (
                      <p className="text-xs text-linear-text-tertiary mt-1 font-mono truncate">
                        {log.details}
                      </p>
                    )}
                  </div>
                </div>
              )
            })
          )}
          <div ref={logsEndRef} />
        </div>

        {progress?.prUrl && (
          <div className="p-4 border-t border-linear-border">
            <button
              onClick={() => openExternal(progress.prUrl!)}
              className="flex items-center justify-center gap-2 w-full py-2 px-4 bg-linear-accent hover:bg-linear-accent-hover text-white text-sm font-medium rounded-md transition-colors"
            >
              View Pull Request
            </button>
          </div>
        )}
      </div>
    </>
  )
}
