"use client"

import { useState, useEffect, useRef } from "react"
import { X, ArrowLeft, Bot, Wrench, CheckCircle, AlertCircle, Info, Clock, AlertTriangle, Flag, Tag, Folder, Square, Archive, GitMerge, ExternalLink, Play, Check, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn, openExternal } from "@/lib/utils"
import { Task, ExecutionProgress, ExecutionLogEntry, formatDuration } from "@/types/task"

interface TaskDetailViewProps {
  task: Task | null
  logs: ExecutionLogEntry[]
  progress?: ExecutionProgress
  open: boolean
  onClose: () => void
  onDelete?: (taskId: string) => void
  onCancel?: (taskId: string) => void
  onExecute?: (taskId: string) => void
  onUpdate?: (taskId: string, data: { title?: string; description?: string | null }) => void
  isExecuting?: boolean
}

const statusConfig = {
  todo: { label: 'Todo', color: 'bg-slate-500' },
  in_progress: { label: 'In Progress', color: 'bg-blue-500' },
  done: { label: 'Done', color: 'bg-purple-500' },
  cancelled: { label: 'Cancelled', color: 'bg-zinc-500' },
}

const priorityConfig = {
  low: { label: 'Low', color: 'text-emerald-600', icon: Flag },
  medium: { label: 'Medium', color: 'text-yellow-600', icon: Flag },
  high: { label: 'High', color: 'text-red-600', icon: AlertTriangle },
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

export function TaskDetailView({ task, logs, progress, open, onClose, onDelete, onCancel, onExecute, onUpdate, isExecuting }: TaskDetailViewProps) {
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [descriptionDraft, setDescriptionDraft] = useState("")
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    if (logsContainerRef.current && open && logs.length > 0) {
      logsContainerRef.current.scrollTop = 0
    }
  }, [logs, open])

  useEffect(() => {
    if (!isExecuting) setCancelling(false)
  }, [isExecuting])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingTitle) {
          setEditingTitle(false)
          return
        }
        if (editingDescription) {
          setEditingDescription(false)
          return
        }
        if (open) {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, onClose, editingTitle, editingDescription])

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  useEffect(() => {
    if (editingDescription && descriptionRef.current) {
      descriptionRef.current.focus()
    }
  }, [editingDescription])

  useEffect(() => {
    setEditingTitle(false)
    setEditingDescription(false)
  }, [task?.id])

  const saveTitle = () => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== task?.title && onUpdate && task) {
      onUpdate(task.id, { title: trimmed })
    }
    setEditingTitle(false)
  }

  const saveDescription = () => {
    if (!task || !onUpdate) { setEditingDescription(false); return }
    const value = descriptionDraft.trim() || null
    if (value !== (task.description || null)) {
      onUpdate(task.id, { description: value })
    }
    setEditingDescription(false)
  }

  if (!open || !task) {
    return null
  }

  const statusInfo = statusConfig[task.status]
  const priorityInfo = priorityConfig[task.priority]
  const PriorityIcon = priorityInfo.icon

  return (
    <div className="absolute inset-0 z-40 bg-linear-bg">
      <div className="flex flex-col h-full">
        <header className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-linear-border">
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
              {task.identifier || task.id.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isExecuting ? (
              onCancel && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-3 text-linear-text-secondary hover:text-yellow-400 hover:bg-yellow-400/10"
                  disabled={cancelling}
                  onClick={() => { setCancelling(true); onCancel(task.id) }}
                >
                  {cancelling ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Stopping
                    </>
                  ) : (
                    <>
                      <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
                      Stop
                    </>
                  )}
                </Button>
              )
            ) : (
              task.status !== 'done' && onExecute && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-3 text-linear-text-secondary hover:text-green-400 hover:bg-green-400/10"
                  onClick={() => onExecute(task.id)}
                >
                  <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
                  Execute
                </Button>
              )
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-linear-text-secondary hover:text-linear-accent hover:bg-linear-accent/10"
                onClick={() => onDelete(task.id)}
              >
                <Archive className="h-3.5 w-3.5 mr-1.5" />
                Archive
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
            <div className="flex flex-col md:flex-row h-full">
            <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-start gap-3 mb-6">
                  <div className={cn("w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0", priorityConfig[task.priority].color.replace('text-', 'bg-'))} />
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      className="flex-1 text-2xl font-medium text-linear-text leading-tight bg-transparent border-b border-linear-accent outline-none"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={saveTitle}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveTitle()
                        if (e.key === 'Escape') setEditingTitle(false)
                      }}
                    />
                  ) : (
                    <h1
                      className="text-2xl font-medium text-linear-text leading-tight flex-1 cursor-text hover:text-linear-text-secondary"
                      onClick={() => {
                        setTitleDraft(task.title)
                        setEditingTitle(true)
                      }}
                    >
                      {task.title}
                    </h1>
                  )}
                </div>

                {task.status === 'done' && (
                  <div className="mb-6 p-4 bg-linear-bg-secondary border border-linear-border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center">
                        <Check className="w-4 h-4 text-green-400" />
                      </div>
                      <span className="text-sm font-medium text-linear-text">Task Completed</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-linear-text-secondary">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        Total time: {formatDuration(task.executionElapsedMs)}
                      </span>
                    </div>
                    {(task.prUrl || progress?.prUrl) && (
                      <button
                        onClick={() => openExternal((task.prUrl || progress?.prUrl)!)}
                        className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-[#8957e5] hover:bg-[#7c4dcc] transition-colors"
                      >
                        <GitMerge className="w-3.5 h-3.5" />
                        View Pull Request
                        <ExternalLink className="w-3 h-3 opacity-70" />
                      </button>
                    )}
                    {task.outcome && (
                      <div className="mt-3 pt-3 border-t border-linear-border">
                        <p className="text-sm text-linear-text-secondary">{task.outcome}</p>
                      </div>
                    )}
                    {(() => {
                      const agentLogs = logs.filter(l => l.type === 'agent' && l.message.trim())
                      const lastAgentMessage = agentLogs.length > 0 ? agentLogs[agentLogs.length - 1].message : null
                      if (!lastAgentMessage) return null
                      return (
                        <div className="mt-3 pt-3 border-t border-linear-border">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Bot className="w-3.5 h-3.5 text-linear-accent" />
                            <span className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wide">Conclusion</span>
                          </div>
                          <p className="text-sm text-linear-text-secondary leading-relaxed whitespace-pre-wrap">{lastAgentMessage}</p>
                        </div>
                      )
                    })()}
                  </div>
                )}

                <div className="mb-8">
                  {editingDescription ? (
                    <textarea
                      ref={descriptionRef}
                      className="w-full text-sm text-linear-text-secondary leading-relaxed bg-transparent border border-linear-border rounded-md p-2 outline-none focus:border-linear-accent resize-y min-h-[80px]"
                      value={descriptionDraft}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      onBlur={saveDescription}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingDescription(false)
                      }}
                      rows={4}
                    />
                  ) : task.description ? (
                    <p
                      className="text-sm text-linear-text-secondary leading-relaxed whitespace-pre-wrap cursor-text hover:text-linear-text-secondary/80"
                      onClick={() => {
                        setDescriptionDraft(task.description || "")
                        setEditingDescription(true)
                      }}
                    >
                      {task.description}
                    </p>
                  ) : (
                    <button
                      className="text-sm text-linear-text-tertiary hover:text-linear-text-secondary"
                      onClick={() => {
                        setDescriptionDraft("")
                        setEditingDescription(true)
                      }}
                    >
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

            <aside className="w-full md:w-72 flex-shrink-0 border-t md:border-t-0 md:border-l border-linear-border bg-linear-bg-secondary overflow-y-auto">
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
                      <span className="text-sm text-linear-text">KazCode</span>
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
                        <button
                          onClick={() => openExternal(progress.prUrl!)}
                          className="inline-flex items-center gap-1 text-xs text-linear-accent hover:underline mt-2"
                        >
                          {progress.isCompareLink ? 'Create Pull Request →' : 'View Pull Request →'}
                        </button>
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
