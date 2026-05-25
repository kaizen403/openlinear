"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { DragDropContext, Droppable, Draggable, DropResult } from "@hello-pangea/dnd"
import { Column } from "./column"
import { TaskCard } from "./task-card"
import { UnifiedSelectionBar, bucketSelection } from "./unified-selection-bar"
import { BatchProgress } from "./batch-progress"
import { DashboardLoading } from "./dashboard-loading"
import { TaskFormDialog } from "@/components/task-form"
import { TaskDetailView } from "@/components/task-detail-view"
import { ProviderSetupDialog } from "@/components/provider-setup-dialog"
import { EmptyState } from "@/components/empty-state"
import { Plus, Settings2, GitBranch, CircleDot, Layers, Play, Pencil, Inbox } from "lucide-react"
import { Task } from "@/types/task"
import { Project, Repository } from "@/lib/api"
import { useKanbanBoard, COLUMNS, KanbanBoardProps, isTaskActivelyExecuting } from "./use-kanban-board"
import { getExecutionProgress } from "@/lib/execution-state-store"
import { InProgressBatchGroup } from "./in-progress-batch-group"
import { DoneColumnContent } from "./done-column-content"
import { ModelSelector } from "./model-selector"
import { formatBatchExecutionMode } from "./batch-mode"
import { useRouter } from "next/navigation"
import { BoardFilters, useBoardFilters } from "./board-filters"
import { useTeamMembers } from "@/hooks/use-team-members"

interface ProjectConfigPanelProps {
  selectedProject: Project | undefined
  activeRepository: Repository | null
  tasks: Task[]
  selectedTaskIds: Set<string>
  activeBatch: { mode: string; status: string } | null
}

function ProjectConfigPanel({ selectedProject, activeRepository, tasks, selectedTaskIds, activeBatch }: ProjectConfigPanelProps) {
  const router = useRouter()
  const todoCount = tasks.filter(t => t.status === 'todo').length
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length
  const doneCount = tasks.filter(t => t.status === 'done').length
  const cancelledCount = tasks.filter(t => t.status === 'cancelled').length
  const totalIssues = todoCount + inProgressCount + doneCount + cancelledCount

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
      value: `${totalIssues} issues`,
      status: 'neutral',
    },
    {
      icon: Play,
      label: 'Workflow',
      value: activeBatch ? formatBatchExecutionMode(activeBatch.mode) : 'Idle',
      status: activeBatch ? 'active' : 'neutral',
    },
    {
      icon: Layers,
      label: 'Selection',
      value: selectedTaskIds.size > 0 ? `${selectedTaskIds.size} selected` : 'None',
      status: selectedTaskIds.size > 0 ? 'active' : 'neutral',
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
}

export function KanbanBoard(props: KanbanBoardProps) {
  const {
    tasks,
    loading,
    error,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId,
    selectedTaskIds,
    selectionActive,
    selectingColumns,
    activeBatch,
    setActiveBatch,
    canExecute,
    activeRepository,
    selectedProject,
    batchTaskIds,
    selectedTask,
    startingExecuteIds,
    isSelectedTaskExecuting,
    getTasksByStatus,
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
    handleCancelBatch,
    handleApproveNextBatchTask,
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    selectAllVisible,
    clearSelection,
    handleInlineCreateTask,
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

  const filters = useBoardFilters()
  const { members } = useTeamMembers()

  const getFilteredTasksByStatus = useCallback((status: Task['status']) => {
    const statusTasks = getTasksByStatus(status)
    if (filters.assigneeIds.length === 0) return statusTasks
    return statusTasks.filter((t) => filters.assigneeIds.includes(t.assigneeId || ""))
  }, [getTasksByStatus, filters.assigneeIds])

  const handleFiltersChange = useCallback((state: { assigneeIds: string[]; groupByAssignee: boolean }) => {
    filters.setAssigneeIds(state.assigneeIds)
    filters.setGroupByAssignee(state.groupByAssignee)
  }, [filters.setAssigneeIds, filters.setGroupByAssignee])

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

  useEffect(() => {
    const handler = () => setIsTaskFormOpen(true)
    window.addEventListener("openlinear:new-issue", handler)
    return () => window.removeEventListener("openlinear:new-issue", handler)
  }, [setIsTaskFormOpen])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isEditable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      if (isEditable) return

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

      const allTasks = COLUMNS.flatMap(col => getTasksByStatus(col.status))
      const currentIdx = selectedTaskId
        ? allTasks.findIndex(t => t.id === selectedTaskId)
        : -1

      if (k === 'j') {
        e.preventDefault()
        const nextIdx = currentIdx < allTasks.length - 1 ? currentIdx + 1 : 0
        if (allTasks[nextIdx]) handleTaskClick(allTasks[nextIdx].id)
        return
      }
      if (k === 'k') {
        e.preventDefault()
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : allTasks.length - 1
        if (allTasks[prevIdx]) handleTaskClick(allTasks[prevIdx].id)
        return
      }
      if (k === 'x') {
        e.preventDefault()
        if (selectedTaskId) toggleTaskSelect(selectedTaskId)
        return
      }
      if (k === 'e') {
        e.preventDefault()
        if (selectedTaskId && canExecute) handleExecute(selectedTaskId)
        return
      }
      if (k === 'd' || k === 'backspace') {
        e.preventDefault()
        if (selectionActive) {
          handleBulkDelete()
        } else if (selectedTaskId) {
          handleDelete(selectedTaskId)
        }
        return
      }
      if (k === 'l') {
        e.preventDefault()
        if (selectedTaskId) handleMoveToInProgress(selectedTaskId)
        return
      }
      if (k === '1') {
        e.preventDefault()
        if (selectionActive) handleBulkChangeStatus('todo')
        else if (selectedTaskId) handleBulkChangeStatus('todo')
        return
      }
      if (k === '2') {
        e.preventDefault()
        if (selectionActive) handleBulkChangeStatus('in_progress')
        else if (selectedTaskId) handleBulkChangeStatus('in_progress')
        return
      }
      if (k === '3') {
        e.preventDefault()
        if (selectionActive) handleBulkChangeStatus('done')
        else if (selectedTaskId) handleBulkChangeStatus('done')
        return
      }
      if (k === '4') {
        e.preventDefault()
        if (selectionActive) handleBulkChangeStatus('cancelled')
        else if (selectedTaskId) handleBulkChangeStatus('cancelled')
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectAllVisible, clearSelection, selectionActive, selectedTaskId, getTasksByStatus, handleTaskClick, toggleTaskSelect, canExecute, handleExecute, handleDelete, handleBulkDelete, handleMoveToInProgress, handleBulkChangeStatus, handleDrawerClose])

  const renderTask = (task: Task, index: number, isCompletedBatch?: boolean) => {
    const dragDisabled =
      selectionActive ||
      task.id.startsWith('temp-') ||
      batchTaskIds.includes(task.id) ||
      isTaskActivelyExecuting(task, getExecutionProgress(task.id), startingExecuteIds, task.id)

    return (
      <Draggable
        key={task.id}
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
            >
              <TaskCard
                task={task}
                onMoveToInProgress={task.status === 'todo' ? handleMoveToInProgress : undefined}
                onExecute={task.status === 'in_progress' && canExecute ? handleExecute : undefined}
                onCancel={task.status === 'in_progress' ? handleCancel : undefined}
                onDelete={handleDelete}
                onTaskClick={handleTaskClick}
                selected={selectedTaskIds.has(task.id)}
                onToggleSelect={toggleTaskSelect}
                selectionMode={selectionActive || selectingColumns.has(task.status)}
                isBatchTask={batchTaskIds.includes(task.id)}
                isCompletedBatchTask={isCompletedBatch}
                isDragging={snapshot.isDragging}
                deletionMode={taskDeletionMode}
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
  }

  if (loading) {
    return <DashboardLoading />
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
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

  return (
    <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEndWithState}>
      <div ref={boardRef} className="flex-1 min-h-0 relative bg-linear-bg flex flex-col overflow-hidden">
        {activeBatch && (
          <BatchProgress
            batchId={activeBatch.id}
            status={activeBatch.status}
            mode={activeBatch.mode}
            tasks={activeBatch.tasks}
            prUrl={activeBatch.prUrl}
            onCancel={handleCancelBatch}
            onDismiss={activeBatch.status === 'completed' ? () => setActiveBatch(null) : undefined}
            onViewActivity={handleTaskClick}
            onApproveNext={handleApproveNextBatchTask}
          />
        )}
        <ProjectConfigPanel
          selectedProject={selectedProject}
          activeRepository={activeRepository}
          tasks={tasks}
          selectedTaskIds={selectedTaskIds}
          activeBatch={activeBatch}
        />
        <BoardFilters
          value={{ assigneeIds: filters.assigneeIds, groupByAssignee: filters.groupByAssignee }}
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
                        const columnTasks = laneTasks.filter((t) => t.status === column.status)
                        return (
                          <div key={column.id} className="min-w-[280px] md:min-w-0 snap-start border-r border-linear-border last:border-r-0 p-2">
                            <div className="text-[10px] uppercase tracking-wider text-linear-text-tertiary mb-1 px-1">
                              {column.title} ({columnTasks.length})
                            </div>
                            <div className="space-y-1.5">
                              {columnTasks.map((task) => (
                                <TaskCard
                                  key={task.id}
                                  task={task}
                                  onMoveToInProgress={task.status === 'todo' ? handleMoveToInProgress : undefined}
                                  onExecute={task.status === 'in_progress' && canExecute ? handleExecute : undefined}
                                  onCancel={task.status === 'in_progress' ? handleCancel : undefined}
                                  onDelete={handleDelete}
                                  onTaskClick={handleTaskClick}
                                  selected={selectedTaskIds.has(task.id)}
                                  onToggleSelect={toggleTaskSelect}
                                  selectionMode={selectionActive}
                                  isBatchTask={batchTaskIds.includes(task.id)}
                                  isDragging={false}
                                  deletionMode={taskDeletionMode}
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
          {COLUMNS.map((column) => {
            const columnTasks = getFilteredTasksByStatus(column.status)
            const hasParallelGroup =
              column.status === 'in_progress' && batchTaskIds.length > 0
            const selectionActive = !hasParallelGroup && selectingColumns.has(column.id)
            return (
              <Droppable key={column.id} droppableId={column.id}>
                {(provided, snapshot) => (
                  <Column
                    id={column.id}
                    title={column.title}
                    taskCount={columnTasks.length}
                    onAddTask={() => handleAddTask(column.status)}
                    selectionActive={selectionActive}
                    onToggleSelection={!hasParallelGroup ? () => toggleColumnSelection(column.id) : undefined}
                    onSelectAll={selectionActive ? () => toggleColumnSelectAll(column.status) : undefined}
                    innerRef={provided.innerRef}
                    droppableProps={provided.droppableProps}
                    isDraggingOver={snapshot.isDraggingOver}
                    isAnyDragging={isDragging}
                  >
                    {columnTasks.length === 0 && !snapshot.isDraggingOver ? (
                      <EmptyState
                        size="compact"
                        icon={Inbox}
                        title={`No ${column.title.toLowerCase()} tasks`}
                        action={
                          <button
                            type="button"
                            onClick={() => handleAddTask(column.status)}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sm text-xs font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add task
                          </button>
                        }
                      />
                    ) : (() => {
                      if (column.status === 'in_progress' && batchTaskIds.length > 0) {
                        const batch = columnTasks.filter(t => batchTaskIds.includes(t.id))
                        const rest = columnTasks.filter(t => !batchTaskIds.includes(t.id))
                        const batchGroupCount = batch.length > 0 && activeBatch ? 1 : 0
                        return (
                          <>
                            {batch.length > 0 && activeBatch && (
                              <InProgressBatchGroup
                                batch={batch}
                                activeBatch={activeBatch}
                                canExecute={canExecute}
                                selectedTaskIds={selectedTaskIds}
                                onExecute={handleExecute}
                                onCancel={handleCancel}
                                onDelete={handleDelete}
                                deletionMode={taskDeletionMode}
                                onTaskClick={handleTaskClick}
                                onToggleSelect={toggleTaskSelect}
                              />
                            )}
                            {rest.map((task, i) => renderTask(task, batchGroupCount + i))}
                          </>
                        )
                      }

                      if (column.status === 'done') {
                        return (
                          <DoneColumnContent
                            columnTasks={columnTasks}
                            renderTask={renderTask}
                          />
                        )
                      }

                      return columnTasks.map((task, index) => renderTask(task, index))
                    })()}
                    {provided.placeholder}
                  </Column>
                )}
              </Droppable>
            )
          })}
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
          onDelete={handleDelete}
          onCancel={handleCancel}
          onExecute={selectedTaskId && batchTaskIds.includes(selectedTaskId) ? undefined : handleExecute}
          onUpdate={handleUpdateTask}
          isExecuting={isSelectedTaskExecuting}
          project={selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null}
          deletionMode={taskDeletionMode}
        />

        <ProviderSetupDialog
          open={showProviderSetup}
          onOpenChange={setShowProviderSetup}
          onSetupComplete={handleProviderSetupComplete}
        />

        {(() => {
          if (selectedTaskIds.size === 0) return null
          const buckets = bucketSelection(selectedTaskIds, tasks)
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
              onChangeStatus={handleBulkChangeStatus}
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
