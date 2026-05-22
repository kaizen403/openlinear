"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Play, ListOrdered, ArrowRight, X, Archive, ChevronDown, MoveRight, Layers, Trash2 } from "lucide-react"
import { Task } from "@/types/task"

export interface SelectionBuckets {
  todo: string[]
  in_progress: string[]
  done: string[]
  cancelled: string[]
}

interface UnifiedSelectionBarProps {
  selectedCount: number
  buckets: SelectionBuckets
  canExecute: boolean
  executeDisabledReason?: string | null
  onExecuteParallel: () => void
  onExecuteQueue: () => void
  onExecuteCombined: () => void
  onMoveToInProgress: () => void
  onChangeStatus: (status: Task['status']) => void
  onArchive: () => void
  onClear: () => void
  deletionMode?: "archive" | "delete"
}

const STATUS_LABELS: Record<Task['status'], string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function UnifiedSelectionBar({
  selectedCount,
  buckets,
  canExecute,
  executeDisabledReason,
  onExecuteParallel,
  onExecuteQueue,
  onExecuteCombined,
  onMoveToInProgress,
  onChangeStatus,
  onArchive,
  onClear,
  deletionMode = "archive",
}: UnifiedSelectionBarProps) {
  if (selectedCount === 0) return null

  const hasTodo = buckets.todo.length > 0
  const hasInProgress = buckets.in_progress.length > 0
  const executeDisabled = !canExecute || !hasInProgress
  const executeTitle = !hasInProgress
    ? 'Select at least one In Progress task to execute'
    : !canExecute
      ? (executeDisabledReason || 'Connect a repository before executing')
      : undefined
  const combinedDisabled = executeDisabled || buckets.in_progress.length < 2
  const combinedTitle = buckets.in_progress.length < 2
    ? 'Select at least two In Progress tasks to execute together'
    : executeTitle

  const summary = (() => {
    const parts: string[] = []
    if (hasTodo) parts.push(`${buckets.todo.length} todo`)
    if (hasInProgress) parts.push(`${buckets.in_progress.length} in progress`)
    if (buckets.done.length > 0) parts.push(`${buckets.done.length} done`)
    if (buckets.cancelled.length > 0) parts.push(`${buckets.cancelled.length} cancelled`)
    if (parts.length === 0) return `${selectedCount} selected`
    return parts.join(' · ')
  })()

  return (
    <div
      role="toolbar"
      aria-label="Selected tasks actions"
      className="fixed bottom-3 sm:bottom-6 left-3 right-3 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-50 flex flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 bg-linear-bg-secondary border border-linear-border rounded-sm shadow-2xl backdrop-blur-sm sm:max-w-[calc(100vw-2rem)]"
    >
      <span className="text-xs sm:text-sm text-linear-text-secondary whitespace-nowrap">
        {summary}
      </span>
      <div className="w-px h-6 bg-linear-border" />

      {hasTodo && (
        <Button
          size="sm"
          onClick={onMoveToInProgress}
          variant="outline"
          className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5"
          title={`Move ${buckets.todo.length} todo task${buckets.todo.length !== 1 ? 's' : ''} to In Progress`}
        >
          <ArrowRight className="w-3.5 h-3.5" />
          <span className="sm:hidden">Move</span>
          <span className="hidden sm:inline">
            Move {buckets.todo.length} Todo{buckets.todo.length !== 1 ? 's' : ''}
          </span>
        </Button>
      )}

      <Button
        size="sm"
        onClick={onExecuteParallel}
        disabled={executeDisabled}
        title={executeTitle}
        className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-1.5 disabled:opacity-50"
      >
        <Play className="w-3.5 h-3.5" />
        <span className="sm:hidden">Parallel</span>
        <span className="hidden sm:inline">
          {hasInProgress ? `Parallel (${buckets.in_progress.length})` : 'Execute Parallel'}
        </span>
      </Button>
      <Button
        size="sm"
        onClick={onExecuteQueue}
        disabled={executeDisabled}
        title={executeTitle}
        variant="outline"
        className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5 disabled:opacity-50"
      >
        <ListOrdered className="w-3.5 h-3.5" />
        <span className="sm:hidden">Queue</span>
        <span className="hidden sm:inline">
          {hasInProgress ? `Queue (${buckets.in_progress.length})` : 'Execute Queue'}
        </span>
      </Button>
      <Button
        size="sm"
        onClick={onExecuteCombined}
        disabled={combinedDisabled}
        title={combinedTitle}
        variant="outline"
        className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5 disabled:opacity-50"
      >
        <Layers className="w-3.5 h-3.5" />
        <span className="sm:hidden">Combined</span>
        <span className="hidden sm:inline">
          {hasInProgress ? `Combined (${buckets.in_progress.length})` : 'Execute Combined'}
        </span>
      </Button>

      <div className="w-px h-6 bg-linear-border hidden sm:block" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5"
          >
            <MoveRight className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Status</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="bg-linear-bg-secondary border-linear-border">
          {(Object.keys(STATUS_LABELS) as Task['status'][]).map(status => (
            <DropdownMenuItem
              key={status}
              onClick={() => onChangeStatus(status)}
              className="text-linear-text hover:bg-linear-bg-tertiary cursor-pointer"
            >
              {STATUS_LABELS[status]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="outline"
        onClick={onArchive}
        className="h-8 border-linear-border text-linear-text hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/30 gap-1.5"
      >
        {deletionMode === "delete" ? (
          <Trash2 className="w-3.5 h-3.5" />
        ) : (
          <Archive className="w-3.5 h-3.5" />
        )}
        <span className="hidden sm:inline">
          {deletionMode === "delete" ? "Delete" : "Archive"}
        </span>
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={onClear}
        className="text-linear-text-tertiary hover:text-linear-text h-8 w-8 p-0"
        aria-label="Clear selection"
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  )
}

export function bucketSelection(
  selectedTaskIds: Set<string>,
  tasks: Pick<Task, 'id' | 'status'>[],
): SelectionBuckets {
  const buckets: SelectionBuckets = { todo: [], in_progress: [], done: [], cancelled: [] }
  for (const id of selectedTaskIds) {
    const status = tasks.find(t => t.id === id)?.status
    if (!status) continue
    buckets[status].push(id)
  }
  return buckets
}
