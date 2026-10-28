"use client"

import { memo, useEffect, useState, useCallback, useMemo, useRef } from "react"
import { createPortal } from "react-dom"
import { DragDropContext, Droppable, Draggable, DropResult } from "@hello-pangea/dnd"
import { Column } from "./column"
import { TaskCard } from "./task-card"
import { blockedTaskIdsOf, blockerSummary, readyToRun } from "./blocked"
import { UnifiedSelectionBar, bucketSelection } from "./unified-selection-bar"
import { BatchProgress } from "./batch-progress"
import { DashboardLoading } from "./dashboard-loading"
import { TaskFormDialog } from "@/components/task-form"
import { TaskDetailView } from "@/components/task-detail-view"
import { ProviderSetupDialog } from "@/components/provider-setup-dialog"
import { EmptyState } from "@/components/empty-state"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Plus, Settings2, GitBranch, CircleDot, Layers, Play, Pencil, Inbox } from "lucide-react"
import { Task } from "@/types/task"
import { Project, Repository } from "@/lib/api"
import { useKanbanBoard, COLUMNS, KanbanBoardProps, isTaskActivelyExecuting, type ActiveBatch } from "./use-kanban-board"
import { getExecutionProgress } from "@/lib/execution-state-store"
import { InProgressBatchGroup } from "./in-progress-batch-group"
import { DoneColumnContent } from "./done-column-content"
import { ModelSelector } from "./model-selector"
import { formatBatchExecutionMode } from "./batch-mode"
import { useRouter } from "next/navigation"
import { BoardFilters, matchesDependencyFilter, useBoardFilters, type BoardFiltersState } from "./board-filters"
import { useTeamMembers } from "@/hooks/use-team-members"
import { isEditableTarget, isInsideOverlay } from "./keyboard-guards"
import { stabilizeBuckets, type TaskBuckets } from "./board-state"
import { useQuery } from "@tanstack/react-query"
import { maxBatchSizeOf, settingsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { isTerminalBatchStatus } from "./batch-state"
import { isReadyToPublishTask } from "./execution-outcome"
import { useStableCallback } from "./use-stable-callback"

interface ProjectConfigPanelProps {
  selectedProject: Project | undefined
  activeRepository: Repository | null
  totalIssues: number
  /** More issues exist than are loaded (keyset paging). */
  moreIssues: boolean
  selectedCount: number
  activeBatchMode: string | null
}

const ProjectConfigPanel = memo(function ProjectConfigPanel({ selectedProject, activeRepository, totalIssues, moreIssues, selectedCount, activeBatchMode }: ProjectConfigPanelProps) {
  const router = useRouter()

  const sourceFromRepoUrl = (() => {
    const repoUrl = selectedProject?.repoUrl
    if (!repoUrl) return null
    return repoUrl
      .replace(/^https?:\/\/(www\.)?github\.com\//, "")
      .replace(/\.git$/, "")
  })()

  const sourceValue =
    selectedProject?.repository?.fullName ||
    sourceFromRepoUrl ||
    selectedProject?.localPath ||
    activeRepository?.fullName ||
    null

  const canEditSource = !!(selectedProject || activeRepository)
  const baseBranch = selectedProject?.repository?.defaultBranch || activeRepository?.defaultBranch || null

  const items = [
    {
      icon: Settings2,
      label: 'Source',
      value: sourceValue || 'No source connected',
      status: selectedProject ? 'active' : 'inactive',
    },
    {
      icon: GitBranch,
      label: 'Branch',
      value: baseBranch || 'Not configured',
      status: baseBranch ? 'active' : 'inactive',
    },
    {
      icon: CircleDot,
      label: 'Scope',
      value: `${totalIssues}${moreIssues ? '+' : ''} issues`,
      status: 'neutral',
    },
    {
      icon: Play,
      label: 'Workflow',
      value: activeBatchMode ? formatBatchExecutionMode(activeBatchMode) : 'Idle',
      status: activeBatchMode ? 'active' : 'neutral',
    },
    {
      icon: Layers,
      label: 'Selection',
      value: selectedCount > 0 ? `${selectedCount} selected` : 'None',
      status: selectedCount > 0 ? 'active' : 'neutral',
    },
  ]

  return (
    <div className="w-full border-b border-linear-border bg-linear-bg flex-shrink-0">
      <div className="px-0 py-1">
        <div className="rounded-none border-y border-linear-border bg-linear-bg-secondary overflow-hidden">
          <div className="flex items-stretch divide-x divide-linear-border overflow-x-auto snap-x snap-mandatory">
            {items.map((item) => {
              const Icon = item.icon
              const tones: Record<string, { icon: string; value: string }> = {
                active: { icon: 'text-linear-text-secondary', value: 'text-linear-text' },
                neutral: { icon: 'text-linear-text-tertiary', value: 'text-linear-text' },
                inactive: { icon: 'text-linear-text-tertiary', value: 'text-linear-text-tertiary' },
              }
              const tone = tones[item.status] || tones.neutral

              return (
                <div
                  key={item.label}
                  className="flex-1 min-w-[132px] sm:min-w-0 px-2 py-1 flex items-center gap-1.5 snap-start"
                >
                  <Icon className={`w-3 h-3 flex-shrink-0 ${tone.icon}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight">
                      {item.label}
                    </div>
                    <div className={`text-[12px] font-medium truncate leading-tight ${tone.value}`}>
                      {item.value}
                    </div>
                  </div>

                  {item.label === 'Source' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedProject) {
                          router.push(`/projects?editProjectId=${selectedProject.id}`)
                          return
                        }
                        router.push('/projects')
                      }}
                      disabled={!canEditSource}
                      className="ml-auto p-1 rounded-sm text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors disabled:opacity-40 disabled:pointer-events-none"
                      aria-label="Edit source"
                      title="Edit source"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
            <ModelSelector />
          </div>
        </div>
      </div>
    </div>
  )
})

interface TaskHandlers {
  onMoveToInProgress: (taskId: string) => void
  onExecute: (taskId: string) => void
  onCancel: (taskId: string) => Promise<boolean>
  onDelete: (taskId: string) => void
  onTaskClick: (taskId: string) => void
  onToggleSelect: (taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
}

interface BoardTaskItemProps extends TaskHandlers {
  task: Task
  index: number
  selected: boolean
  selectionMode: boolean
  /** Whole-board selection disables dragging. */
  dragLocked: boolean
  isBatchTask: boolean
  isStarting: boolean
  canExecute: boolean
  deletionMode: "archive" | "delete"
  isCompletedBatch?: boolean
  /** W17a: an open task blocks this one. */
  isBlocked: boolean
  /** W17a: "ENG-1, ENG-3" for the chip's tooltip. */
  blockedBy: string | null
}

/**
 * One draggable card. Memoized so an SSE update re-renders only the card
 * whose task object changed, not every Draggable on the board.
 */
const BoardTaskItem = memo(function BoardTaskItem({
  task,
  index,
  selected,
  selectionMode,
  dragLocked,
  isBatchTask,
  isStarting,
  canExecute,
  deletionMode,
  isCompletedBatch,
  isBlocked,
  blockedBy,
  onMoveToInProgress,
  onExecute,
  onCancel,
  onDelete,
  onTaskClick,
  onToggleSelect,
}: BoardTaskItemProps) {
  const dragDisabled =
    dragLocked ||
    task.id.startsWith('temp-') ||
    isBatchTask ||
    isStarting ||
    isTaskActivelyExecuting(task, getExecutionProgress(task.id))

  return (
    <Draggable
      draggableId={task.id}
      index={index}
      isDragDisabled={dragDisabled}
    >
      {(provided, snapshot) => {
        const child = (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            style={provided.draggableProps.style}
            data-board-task={task.id}
          >
            <TaskCard
              task={task}
              onMoveToInProgress={task.status === 'todo' ? onMoveToInProgress : undefined}
              onExecute={onExecute}
              canExecute={canExecute}
              onCancel={task.status === 'in_progress' ? onCancel : undefined}
              onDelete={onDelete}
              onTaskClick={onTaskClick}
              selected={selected}
              onToggleSelect={onToggleSelect}
              selectionMode={selectionMode}
              isBatchTask={isBatchTask}
              isCompletedBatchTask={isCompletedBatch}
              isDragging={snapshot.isDragging}
              deletionMode={deletionMode}
              blocked={isBlocked}
              blockedBy={blockedBy}
            />
          </div>
        )
        if (snapshot.isDragging) {
          return createPortal(child, document.body)
        }
        return child
      }}
    </Draggable>
  )
})

interface BoardColumnProps extends TaskHandlers {
  column: (typeof COLUMNS)[number]
  tasks: Task[]
  selectedTaskIds: ReadonlySet<string>
  selectionActive: boolean
  columnSelecting: boolean
  batchTaskIdSet: ReadonlySet<string>
  blockedTaskIds: ReadonlySet<string>
  /** Tooltip text per blocked task id. */
  blockerLabels: ReadonlyMap<string, string>
  startingExecuteIds: ReadonlySet<string>
  canExecute: boolean
  deletionMode: "archive" | "delete"
  isAnyDragging: boolean
  /** Only passed to the In Progress column. */
  activeBatch: ActiveBatch | null
  /** Keyset paging: more tasks of this column exist on the server. */
  hasMore: boolean
  loadingMore: boolean
  onAddTask: (status: Task['status']) => void
  onToggleColumnSelection: (columnId: string) => void
  onToggleColumnSelectAll: (status: Task['status']) => void
  onLoadMore: (status: Task['status']) => void
}

/**
 * A status column. Memoized with per-column task arrays that keep their
 * identity while unchanged (see stabilizeBuckets), so an update to one task
 * leaves the other three columns untouched.
 */
const BoardColumn = memo(function BoardColumn({
  column,
  tasks,
  selectedTaskIds,
  selectionActive,
  columnSelecting,
  batchTaskIdSet,
  blockedTaskIds,
  blockerLabels,
  startingExecuteIds,
  canExecute,
  deletionMode,
  isAnyDragging,
  activeBatch,
  hasMore,
  loadingMore,
  onAddTask,
  onToggleColumnSelection,
  onToggleColumnSelectAll,
  onLoadMore,
  ...handlers
}: BoardColumnProps) {
  const hasParallelGroup = column.status === 'in_progress' && batchTaskIdSet.size > 0
  const columnSelectionActive = !hasParallelGroup && columnSelecting
  const selectionMode = selectionActive || columnSelecting

  const renderItem = (task: Task, index: number, isCompletedBatch?: boolean) => (
    <BoardTaskItem
      key={task.id}
      task={task}
      index={index}
      selected={selectedTaskIds.has(task.id)}
      selectionMode={selectionMode}
      dragLocked={selectionActive}
      isBatchTask={batchTaskIdSet.has(task.id)}
      isStarting={startingExecuteIds.has(task.id)}
      canExecute={canExecute}
      deletionMode={deletionMode}
      isCompletedBatch={isCompletedBatch}
      isBlocked={blockedTaskIds.has(task.id)}
      blockedBy={blockerLabels.get(task.id) ?? null}
      {...handlers}
    />
  )

  return (
    <Droppable droppableId={column.id}>
      {(provided, snapshot) => (
        <Column
          id={column.id}
          title={column.title}
          taskCount={tasks.length}
          onAddTask={() => onAddTask(column.status)}
          selectionActive={columnSelectionActive}
          onToggleSelection={!hasParallelGroup ? () => onToggleColumnSelection(column.id) : undefined}
          onSelectAll={columnSelectionActive ? () => onToggleColumnSelectAll(column.status) : undefined}
          innerRef={provided.innerRef}
          droppableProps={provided.droppableProps}
          isDraggingOver={snapshot.isDraggingOver}
          isAnyDragging={isAnyDragging}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => onLoadMore(column.status)}
        >
          {tasks.length === 0 && hasMore ? null : tasks.length === 0 && !snapshot.isDraggingOver ? (
            <EmptyState
              size="compact"
              icon={Inbox}
              title={`No ${column.title.toLowerCase()} tasks`}
              action={
                <button
                  type="button"
                  onClick={() => onAddTask(column.status)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sm text-xs font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add task
                </button>
              }
            />
          ) : (() => {
            if (hasParallelGroup) {
              const batch = tasks.filter(t => batchTaskIdSet.has(t.id))
              const rest = tasks.filter(t => !batchTaskIdSet.has(t.id))
              const batchGroupCount = batch.length > 0 && activeBatch ? 1 : 0
              return (
                <>
                  {batch.length > 0 && activeBatch && (
                    <InProgressBatchGroup
                      batch={batch}
                      activeBatch={activeBatch}
                      canExecute={canExecute}
                      selectedTaskIds={selectedTaskIds}
                      onExecute={handlers.onExecute}
                      onCancel={handlers.onCancel}
                      onDelete={handlers.onDelete}
                      deletionMode={deletionMode}
                      onTaskClick={handlers.onTaskClick}
                      onToggleSelect={handlers.onToggleSelect}
                    />
                  )}
                  {rest.map((task, i) => renderItem(task, batchGroupCount + i))}
                </>
              )
            }

            if (column.status === 'done') {
              return <DoneColumnContent columnTasks={tasks} renderTask={renderItem} />
            }

            return tasks.map((task, index) => renderItem(task, index))
          })()}
          {provided.placeholder}
        </Column>
      )}
    </Droppable>
  )
})

/** Keeps the previous Set when its members didn't change. */
/** Keep the previous map while its entries are unchanged (columns stay memoized). */
function useStableStringMap(map: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const ref = useRef(map)
  const previous = ref.current
  if (previous !== map && (previous.size !== map.size || [...map].some(([key, value]) => previous.get(key) !== value))) {
    ref.current = map
  }
  return ref.current
}

function useStableIdSet(ids: ReadonlySet<string>): ReadonlySet<string> {
  const ref = useRef(ids)
  const previous = ref.current
  if (previous !== ids && (previous.size !== ids.size || [...ids].some((id) => !previous.has(id)))) {
    ref.current = ids
  }
  return ref.current
}

export function KanbanBoard(props: KanbanBoardProps) {
  const {
    tasks,
    tasksByStatus,
    tasksById,
    loading,
    error,
    columnPaging,
    hasMoreTasks,
    loadMoreTasks,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId,
    selectedTaskIds,
    selectionActive,
    selectingColumns,
    activeBatch,
    displayedBatch,
    dismissBatch,
    canExecute,
    activeRepository,
    selectedProject,
    batchTaskIdSet: rawBatchTaskIdSet,
    selectedTask,
    startingExecuteIds,
    isSelectedTaskExecuting,
    handleAddTask,
    handleDragEnd,
    handleExecute,
    handleCancel,
    handleTaskClick,
    handleDrawerClose,
    handleDelete,
    handleUpdateTask,
    handleMoveToInProgress,
    handleBatchMoveToInProgress,
    handleBatchExecute,
    handleRunWithBlockers,
    handleRunReady,
    handleCancelBatch,
    handleApproveNextBatchTask,
    handleCheckPullRequest,
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    selectAllVisible,
    clearSelection,
    handleTaskCreated,
    handleBulkDelete,
    handleBulkChangeStatus,
    fetchTasks,
    showProviderSetup,
    setShowProviderSetup,
    handleProviderSetupComplete,
    taskDeletionMode,
  } = useKanbanBoard(props)

  const boardRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Confirmation gate for the 'd'/Backspace board shortcut — deleting (or
  // archiving) a task is destructive and, unlike the trash-icon button, has
  // no visible affordance before it fires, so it needs an explicit "are you
  // sure" step.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'single'; taskId: string } | { kind: 'bulk'; count: number } | null
  >(null)

  const filters = useBoardFilters()
  const { members } = useTeamMembers()
  const batchTaskIdSet = useStableIdSet(rawBatchTaskIdSet)
  const blockedTaskIds = useStableIdSet(useMemo(() => blockedTaskIdsOf(tasks, tasksById), [tasks, tasksById]))
  const blockerLabels = useStableStringMap(useMemo(() => {
    const labels = new Map<string, string>()
    for (const id of blockedTaskIds) {
      const task = tasksById.get(id)
      const summary = task ? blockerSummary(task, tasksById) : null
      if (summary) labels.set(id, summary)
    }
    return labels
  }, [blockedTaskIds, tasksById]))

  // Column task lists after the assignee and dependency filters, still identity-stable per column.
  const assigneeKey = filters.assigneeIds.join(',')
  const dependencyFilter = filters.dependency ?? null
  const filteredBucketsRef = useRef<TaskBuckets | null>(null)
  const columnTasks = useMemo(() => {
    if (!assigneeKey && !dependencyFilter) {
      filteredBucketsRef.current = null
      return tasksByStatus
    }
    const allowed = assigneeKey ? new Set(assigneeKey.split(',')) : null
    const keep = (t: Task) => (!allowed || allowed.has(t.assigneeId || "")) && matchesDependencyFilter(t, dependencyFilter, blockedTaskIds)
    const filtered: TaskBuckets = {
      todo: tasksByStatus.todo.filter(keep),
      in_progress: tasksByStatus.in_progress.filter(keep),
      done: tasksByStatus.done.filter(keep),
      cancelled: tasksByStatus.cancelled.filter(keep),
    }
    const next = stabilizeBuckets(filteredBucketsRef.current, filtered)
    filteredBucketsRef.current = next
    return next
  }, [tasksByStatus, assigneeKey, dependencyFilter, blockedTaskIds])

  const totalIssues = tasks.length
  // "Run ready": what the Ready filter shows (assignee filter included), within the batch size.
  const settingsClient = useAppQueryClient()
  const { data: boardSettings } = useQuery(settingsQuery(), settingsClient)
  const readyTasks = useMemo(() => {
    if (filters.dependency !== "ready") return []
    const visible = [...columnTasks.todo, ...columnTasks.in_progress]
    return readyToRun(visible, blockedTaskIds, maxBatchSizeOf(boardSettings))
  }, [filters.dependency, columnTasks, blockedTaskIds, boardSettings])
  const readyTaskIds = useMemo(() => {
    const ready = new Set<string>()
    if (!displayedBatch) return ready
    for (const task of tasks) {
      if (task.batchId === displayedBatch.id && isReadyToPublishTask(task)) ready.add(task.id)
    }
    return ready
  }, [tasks, displayedBatch])

  const handleFiltersChange = useCallback((state: BoardFiltersState) => {
    filters.setFilters(state)
  }, [filters.setFilters])

  const handleDragStart = useCallback(() => {
    setIsDragging(true)
    if (boardRef.current) {
      boardRef.current.style.overflow = 'visible'
    }
  }, [])

  const handleDragEndWithState = useCallback((result: DropResult) => {
    setIsDragging(false)
    if (boardRef.current) {
      boardRef.current.style.overflow = 'hidden'
    }
    handleDragEnd(result)
  }, [handleDragEnd])

  // Stable identities for memoized columns (useTaskSelection's handlers
  // change with the filtered task list).
  const onToggleColumnSelection = useStableCallback(toggleColumnSelection)
  const onToggleColumnSelectAll = useStableCallback(toggleColumnSelectAll)
  const onMoveToInProgress = useStableCallback((taskId: string) => { void handleMoveToInProgress(taskId) })
  const onExecute = useStableCallback((taskId: string) => { void handleExecute(taskId) })
  const onDelete = useStableCallback((taskId: string) => { void handleDelete(taskId) })
  const onTaskClick = useStableCallback((taskId: string) => { void handleTaskClick(taskId) })
  const onLoadMore = useStableCallback((status: Task['status']) => { void loadMoreTasks(status) })

  useEffect(() => {
    const handler = () => setIsTaskFormOpen(true)
    window.addEventListener("openlinear:new-issue", handler)
    return () => window.removeEventListener("openlinear:new-issue", handler)
  }, [setIsTaskFormOpen])

  // Registered once; always runs against the latest board state.
  const onKeyDown = useStableCallback((e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAllVisible()
      return
    }
    if (e.key === 'Escape' && selectionActive) {
      clearSelection()
      return
    }
    if (e.key === 'Escape' && selectedTaskId) {
      handleDrawerClose()
      return
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()

    const statusShortcut = ({ '1': 'todo', '2': 'in_progress', '3': 'done', '4': 'cancelled' } as const)[k as '1' | '2' | '3' | '4']
    if (statusShortcut) {
      e.preventDefault()
      if (selectionActive) void handleBulkChangeStatus(statusShortcut)
      else if (selectedTaskId) void handleBulkChangeStatus(statusShortcut, [selectedTaskId])
      return
    }

    if (k === 'j' || k === 'k') {
      e.preventDefault()
      const allTasks = COLUMNS.flatMap(col => tasksByStatus[col.status])
      if (allTasks.length === 0) return
      const currentIdx = selectedTaskId ? allTasks.findIndex(t => t.id === selectedTaskId) : -1
      const nextIdx = k === 'j'
        ? (currentIdx < allTasks.length - 1 ? currentIdx + 1 : 0)
        : (currentIdx > 0 ? currentIdx - 1 : allTasks.length - 1)
      const target = allTasks[nextIdx]
      if (target) void handleTaskClick(target.id)
      return
    }
    if (k === 'x') {
      e.preventDefault()
      if (selectedTaskId) toggleTaskSelect(selectedTaskId)
      return
    }
    if (k === 'e') {
      e.preventDefault()
      if (selectedTaskId && canExecute) void handleExecute(selectedTaskId)
      return
    }
    if (k === 'd' || k === 'backspace') {
      // Focus can legitimately be inside an open dialog/sheet/popover on a
      // non-input element (e.g. a button) — the overlay owns keyboard input
      // at that point, so the board's destructive shortcut must not fire.
      if (isInsideOverlay(e.target)) return
      e.preventDefault()
      if (selectionActive) {
        if (selectedTaskIds.size > 0) setPendingDelete({ kind: 'bulk', count: selectedTaskIds.size })
      } else if (selectedTaskId) {
        setPendingDelete({ kind: 'single', taskId: selectedTaskId })
      }
      return
    }
    if (k === 'l') {
      e.preventDefault()
      if (selectedTaskId) void handleMoveToInProgress(selectedTaskId)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  if (loading) {
    return <DashboardLoading />
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-danger mb-4">{error}</p>
          <button
            type="button"
            onClick={() => { fetchTasks({ showLoading: true, clearError: true }) }}
            className="px-4 py-2 bg-linear-accent text-white rounded-sm hover:bg-linear-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const handlers: TaskHandlers = {
    onMoveToInProgress,
    onExecute,
    onCancel: handleCancel,
    onDelete,
    onTaskClick,
    onToggleSelect: toggleTaskSelect,
  }

  return (
    <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEndWithState}>
      <div ref={boardRef} className="flex-1 min-h-0 relative bg-linear-bg flex flex-col overflow-hidden">
        {displayedBatch && (
          <BatchProgress
            batchId={displayedBatch.id}
            status={displayedBatch.status}
            mode={displayedBatch.mode}
            tasks={displayedBatch.tasks}
            prUrl={displayedBatch.prUrl}
            publication={displayedBatch.publication ?? null}
            readyTaskIds={readyTaskIds}
            onCancel={handleCancelBatch}
            onDismiss={isTerminalBatchStatus(displayedBatch.status) ? dismissBatch : undefined}
            onViewActivity={onTaskClick}
            onApproveNext={handleApproveNextBatchTask}
          />
        )}
        <ProjectConfigPanel
          selectedProject={selectedProject}
          activeRepository={activeRepository}
          totalIssues={totalIssues}
          moreIssues={hasMoreTasks}
          selectedCount={selectedTaskIds.size}
          activeBatchMode={activeBatch ? activeBatch.mode : null}
        />
        <BoardFilters
          value={{ assigneeIds: filters.assigneeIds, groupByAssignee: filters.groupByAssignee, dependency: filters.dependency }}
          readyCount={canExecute ? readyTasks.length : 0}
          onRunReady={() => { void handleRunReady(readyTasks.map((task) => task.id)) }}
          onChange={handleFiltersChange}
        />
        {filters.groupByAssignee ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {(() => {
              const assigneesToShow = filters.assigneeIds.length > 0
                ? members.filter((m) => filters.assigneeIds.includes(m.id))
                : [...members, { id: "__unassigned__", username: "Unassigned", displayName: "Unassigned", avatarUrl: null }]

              return assigneesToShow.map((member) => {
                const isUnassigned = member.id === "__unassigned__"
                const laneTasks = tasks.filter((t) => {
                  if (isUnassigned) return !t.assigneeId
                  return t.assigneeId === member.id
                })
                if (laneTasks.length === 0 && isUnassigned) return null
                return (
                  <div key={member.id} className="border-b border-linear-border last:border-b-0">
                    <div className="flex items-center gap-2 px-4 py-2 bg-linear-bg-secondary">
                      {member.avatarUrl ? (
                        <img src={member.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-linear-bg-tertiary flex items-center justify-center">
                          <span className="text-[10px] text-linear-text-tertiary uppercase">
                            {member.username?.charAt(0) || "?"}
                          </span>
                        </div>
                      )}
                      <span className="text-sm font-medium text-linear-text">
                        {member.displayName || member.username}
                      </span>
                      <span className="text-xs text-linear-text-tertiary">
                        {laneTasks.length} {laneTasks.length === 1 ? "issue" : "issues"}
                      </span>
                    </div>
                    <div className="flex md:grid md:grid-cols-2 lg:grid-cols-4 overflow-x-auto overflow-y-hidden snap-x snap-mandatory md:overflow-x-visible md:snap-none">
                      {COLUMNS.map((column) => {
                        const laneColumnTasks = laneTasks.filter((t) => t.status === column.status)
                        return (
                          <div key={column.id} className="min-w-[280px] md:min-w-0 snap-start border-r border-linear-border last:border-r-0 p-2">
                            <div className="text-[10px] uppercase tracking-wider text-linear-text-tertiary mb-1 px-1">
                              {column.title} ({laneColumnTasks.length})
                            </div>
                            <div className="space-y-1.5">
                              {laneColumnTasks.map((task) => (
                                <TaskCard
                                  key={task.id}
                                  task={task}
                                  onMoveToInProgress={task.status === 'todo' ? onMoveToInProgress : undefined}
                                  onExecute={onExecute}
                                  canExecute={canExecute}
                                  onCancel={task.status === 'in_progress' ? handleCancel : undefined}
                                  onDelete={onDelete}
                                  onTaskClick={onTaskClick}
                                  selected={selectedTaskIds.has(task.id)}
                                  onToggleSelect={toggleTaskSelect}
                                  selectionMode={selectionActive}
                                  isBatchTask={batchTaskIdSet.has(task.id)}
                                  isDragging={false}
                                  deletionMode={taskDeletionMode}
                                  blocked={blockedTaskIds.has(task.id)}
                                  blockedBy={blockerLabels.get(task.id) ?? null}
                                />
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        ) : (
        <div className="flex md:grid md:grid-cols-2 lg:grid-cols-4 flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory md:overflow-x-visible md:snap-none">
          {COLUMNS.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              tasks={columnTasks[column.status]}
              selectedTaskIds={selectedTaskIds}
              selectionActive={selectionActive}
              columnSelecting={selectingColumns.has(column.id)}
              batchTaskIdSet={batchTaskIdSet}
              blockedTaskIds={blockedTaskIds}
              blockerLabels={blockerLabels}
              startingExecuteIds={startingExecuteIds}
              canExecute={canExecute}
              deletionMode={taskDeletionMode}
              isAnyDragging={isDragging}
              activeBatch={column.status === 'in_progress' ? activeBatch : null}
              hasMore={columnPaging[column.status].hasMore}
              loadingMore={columnPaging[column.status].loading}
              onAddTask={handleAddTask}
              onToggleColumnSelection={onToggleColumnSelection}
              onToggleColumnSelectAll={onToggleColumnSelectAll}
              onLoadMore={onLoadMore}
              {...handlers}
            />
          ))}
        </div>
        )}
        <TaskFormDialog
          open={isTaskFormOpen}
          onOpenChange={setIsTaskFormOpen}
          onSuccess={handleTaskCreated}
          defaultStatus={defaultStatus}
          defaultProjectId={props.projectId}
          projects={props.projects}
        />

        <TaskDetailView
          task={selectedTask}
          open={!!selectedTaskId}
          onClose={handleDrawerClose}
          onDelete={onDelete}
          onCancel={handleCancel}
          onExecute={selectedTaskId && batchTaskIdSet.has(selectedTaskId) ? undefined : onExecute}
          onRunWithBlockers={canExecute && !(selectedTaskId && batchTaskIdSet.has(selectedTaskId)) ? handleRunWithBlockers : undefined}
          onUpdate={handleUpdateTask}
          onCheckPullRequest={handleCheckPullRequest}
          isExecuting={isSelectedTaskExecuting}
          project={selectedProject ? { id: selectedProject.id, name: selectedProject.name, defaultAgent: selectedProject.defaultAgent ?? null } : null}
          deletionMode={taskDeletionMode}
        />

        <ProviderSetupDialog
          open={showProviderSetup}
          onOpenChange={setShowProviderSetup}
          onSetupComplete={handleProviderSetupComplete}
        />

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {taskDeletionMode === 'delete' ? 'Delete' : 'Archive'}{' '}
                {pendingDelete?.kind === 'bulk' ? `${pendingDelete.count} tasks` : 'task'}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {taskDeletionMode === 'delete'
                  ? 'This permanently deletes the task and cannot be undone.'
                  : 'This moves the task to Archived. You can restore it later.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  if (pendingDelete?.kind === 'bulk') void handleBulkDelete()
                  else if (pendingDelete?.kind === 'single') void handleDelete(pendingDelete.taskId)
                  setPendingDelete(null)
                }}
                className={cn(buttonVariants({ variant: "destructive" }))}
              >
                {taskDeletionMode === 'delete' ? 'Delete' : 'Archive'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {(() => {
          if (selectedTaskIds.size === 0) return null
          const buckets = bucketSelection(selectedTaskIds, tasksById)
          const executeDisabledReason = !canExecute
            ? 'Connect a repository in Project Settings to enable execution'
            : null
          return (
            <UnifiedSelectionBar
              selectedCount={selectedTaskIds.size}
              buckets={buckets}
              canExecute={canExecute}
              executeDisabledReason={executeDisabledReason}
              onExecuteParallel={() => handleBatchExecute('parallel')}
              onExecuteQueue={() => handleBatchExecute('queue')}
              onExecuteCombined={() => handleBatchExecute('combined')}
              onMoveToInProgress={handleBatchMoveToInProgress}
              onChangeStatus={(status) => { void handleBulkChangeStatus(status) }}
              onArchive={handleBulkDelete}
              onClear={clearSelection}
              deletionMode={taskDeletionMode}
            />
          )
        })()}
      </div>
    </DragDropContext>
  )
}
