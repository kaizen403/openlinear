"use client"

import { useEffect, useRef } from "react"
import { X, ArrowLeft, Bot, Wrench, CheckCircle, AlertCircle, Info, Clock, AlertTriangle, Flag, Tag, Folder, Square, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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

interface Label {
  id: string
  name: string
  color: string
  priority: number
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
  labels: Label[]
}

interface TaskDetailViewProps {
  task: Task | null
  logs: ExecutionLogEntry[]
  progress?: ExecutionProgress
  open: boolean
  onClose: () => void
  onDelete?: (taskId: string) => void
  onCancel?: (taskId: string) => void
  isExecuting?: boolean
}

const statusConfig = {
  todo: { label: 'Todo', color: 'bg-linear-text-tertiary' },
  in_progress: { label: 'In Progress', color: 'bg-yellow-500' },
  done: { label: 'Done', color: 'bg-green-500' },
  cancelled: { label: 'Cancelled', color: 'bg-gray-500' },
}

const priorityConfig = {
  low: { label: 'Low', color: 'text-emerald-400', icon: Flag },
  medium: { label: 'Medium', color: 'text-yellow-400', icon: Flag },
  high: { label: 'High', color: 'text-red-400', icon: AlertTriangle },
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

function formatDate(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function TaskDetailView({ task, logs, progress, open, onClose, onDelete, onCancel, isExecuting }: TaskDetailViewProps) {
  const logsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logsContainerRef.current && open && logs.length > 0) {
      logsContainerRef.current.scrollTop = 0
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

  if (!open || !task) {
    return null
  }

  const statusInfo = statusConfig[task.status]
  const priorityInfo = priorityConfig[task.priority]
  const PriorityIcon = priorityInfo.icon

  return (
    <div className="fixed inset-0 z-50 bg-linear-bg">
      <div className="flex flex-col h-full">
        <header className="flex items-center justify-between px-4 py-3 border-b border-linear-border">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-linear-text-secondary hover:text-linear-text"
              onClick={onClose}
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <span className="text-sm text-linear-text-tertiary font-mono">
              {task.id.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isExecuting && onCancel && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-linear-text-secondary hover:text-yellow-400 hover:bg-yellow-400/10"
                onClick={() => onCancel(task.id)}
              >
                <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
                Stop
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-linear-text-secondary hover:text-red-400 hover:bg-red-400/10"
                onClick={() => onDelete(task.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-linear-text-secondary hover:text-linear-text"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-hidden">
          <div className="flex h-full">
            <main className="flex-1 overflow-y-auto p-6">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-start gap-3 mb-6">
                  <div className={cn("w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0", priorityConfig[task.priority].color.replace('text-', 'bg-'))} />
                  <h1 className="text-2xl font-semibold text-linear-text leading-tight">
                    {task.title}
                  </h1>
                </div>

                <div className="mb-8">
                  {task.description ? (
                    <p className="text-sm text-linear-text-secondary leading-relaxed whitespace-pre-wrap">
                      {task.description}
                    </p>
                  ) : (
                    <button className="text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors">
                      Add description...
                    </button>
                  )}
                </div>

                <div className="border-t border-linear-border pt-6">
                  <h2 className="text-sm font-medium text-linear-text-secondary mb-4 flex items-center gap-2">
                    <span className="w-1 h-1 rounded-full bg-linear-text-secondary" />
                    Activity
                  </h2>

                  <div 
                    ref={logsContainerRef}
                    className="max-h-[400px] overflow-y-auto space-y-3 pr-2"
                  >
                    {logs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-linear-text-tertiary">
                        <Clock className="w-8 h-8 mb-2 opacity-50" />
                        <p className="text-sm">No activity yet</p>
                        <p className="text-xs mt-1">Execution logs will appear here when a task is run</p>
                      </div>
                    ) : (
                      [...logs].reverse().map((log, index) => {
                        const Icon = logIcons[log.type]
                        const isLast = index === logs.length - 1
                        
                        return (
                          <div
                            key={`${log.timestamp}-${index}`}
                            className="flex gap-3 relative"
                          >
                            <div className="flex flex-col items-center flex-shrink-0 w-6">
                              <div className={cn(
                                "w-6 h-6 rounded-full flex items-center justify-center border border-linear-border bg-linear-bg-secondary",
                                log.type === 'error' && "border-red-500/30 bg-red-500/10",
                                log.type === 'success' && "border-green-500/30 bg-green-500/10"
                              )}>
                                <Icon className={cn("w-3 h-3", logColors[log.type])} />
                              </div>
                              {!isLast && (
                                <div className="w-px flex-1 min-h-[24px] bg-linear-border mt-1" />
                              )}
                            </div>
                            
                            <div className={cn("flex-1 pb-4", isLast && "pb-0")}>
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs text-linear-text-tertiary font-mono">
                                  {formatTime(log.timestamp)}
                                </span>
                                <span className="text-xs text-linear-text-tertiary">
                                  {formatDate(log.timestamp)}
                                </span>
                              </div>
                              <p className={cn(
                                "text-sm",
                                log.type === 'error' ? 'text-red-400' : 'text-linear-text-secondary'
                              )}>
                                {log.message}
                              </p>
                              {log.details && (
                                <p className="text-xs text-linear-text-tertiary mt-1 font-mono">
                                  {log.details}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </main>

            <aside className="w-72 border-l border-linear-border bg-linear-bg-secondary overflow-y-auto">
              <div className="p-4 space-y-6">
                <div>
                  <h3 className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wider mb-3">
                    Properties
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between py-2 border-b border-linear-border">
                      <span className="text-sm text-linear-text-secondary">Status</span>
                      <div className="flex items-center gap-2">
                        <div className={cn("w-2 h-2 rounded-full", statusInfo.color)} />
                        <span className="text-sm text-linear-text">{statusInfo.label}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between py-2 border-b border-linear-border">
                      <span className="text-sm text-linear-text-secondary">Priority</span>
                      <div className="flex items-center gap-2">
                        <PriorityIcon className={cn("w-3.5 h-3.5", priorityInfo.color)} />
                        <span className="text-sm text-linear-text">{priorityInfo.label}</span>
                      </div>
                    </div>

                    <div className="py-2 border-b border-linear-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-linear-text-secondary">Labels</span>
                        <button className="text-linear-text-tertiary hover:text-linear-text transition-colors">
                          <Tag className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {task.labels.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {task.labels.map((label) => (
                            <span
                              key={label.id}
                              className="text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center backdrop-blur-sm border border-white/10"
                              style={{ 
                                backgroundColor: `${label.color}20`,
                                color: label.color
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-linear-text-tertiary">No labels</span>
                      )}
                    </div>

                    <div className="py-2 border-b border-linear-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-linear-text-secondary">Project</span>
                        <Folder className="w-3.5 h-3.5 text-linear-text-tertiary" />
                      </div>
                      <span className="text-sm text-linear-text">OpenLinear</span>
                    </div>

                    <div className="py-2">
                      <span className="text-sm text-linear-text-secondary block mb-1">Created</span>
                      <span className="text-xs text-linear-text-tertiary">
                        {formatDate(task.createdAt)} at {formatTime(task.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>

                {progress && (
                  <div className="pt-4 border-t border-linear-border">
                    <h3 className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wider mb-3">
                      Execution
                    </h3>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "w-2 h-2 rounded-full",
                          progress.status === 'error' ? 'bg-red-500' : 
                          progress.status === 'done' ? 'bg-green-500' : 
                          'bg-linear-accent animate-pulse'
                        )} />
                        <span className="text-sm text-linear-text">{progress.message}</span>
                      </div>
                      {progress.prUrl && (
                        <a
                          href={progress.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-linear-accent hover:underline mt-2"
                        >
                          View Pull Request →
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
