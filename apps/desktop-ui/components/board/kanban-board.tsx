"use client"

import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd"
import { Column } from "./column"
import { TaskCard } from "./task-card"
import { BatchControls } from "./batch-controls"
import { BatchProgress } from "./batch-progress"
import { DashboardLoading } from "./dashboard-loading"
import { TaskFormDialog } from "@/components/task-form"
import { TaskDetailView } from "@/components/task-detail-view"
import { ProviderSetupDialog } from "@/components/provider-setup-dialog"
import { Plus, Settings2, GitBranch, CircleDot, Layers, CheckCircle2, XCircle, Play, Pencil } from "lucide-react"
import { Task } from "@/types/task"
import { Project, Repository } from "@/lib/api"
import { useKanbanBoard, COLUMNS, KanbanBoardProps } from "./use-kanban-board"
import { InProgressBatchGroup } from "./in-progress-batch-group"
import { DoneColumnContent } from "./done-column-content"
import { useRouter } from "next/navigation"

interface ProjectConfigPanelProps {
  selectedProject: Project | undefined
  activeRepository: Repository | null
  canExecute: boolean
  tasks: Task[]
  selectedTaskIds: Set<string>
  activeBatch: { mode: string; status: string } | null
}

function ProjectConfigPanel({ selectedProject, activeRepository, canExecute, tasks, selectedTaskIds, activeBatch }: ProjectConfigPanelProps) {
  const router = useRouter()
  const todoCount = tasks.filter(t => t.status === 'todo').length
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length
  const doneCount = tasks.filter(t => t.status === 'done').length
  const cancelledCount = tasks.filter(t => t.status === 'cancelled').length

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

  const items = [
    {
      icon: selectedProject ? GitBranch : Settings2,
      label: 'Source',
      value: sourceValue || 'No source connected',
      status: selectedProject ? 'active' : 'inactive',
    },
    {
      icon: canExecute ? CheckCircle2 : XCircle,
      label: 'Execution',
      value: canExecute ? 'Ready' : 'Setup required',
      status: canExecute ? 'ready' : 'blocked',
    },
    {
      icon: CircleDot,
      label: 'Scope',
      value: `${todoCount + inProgressCount + doneCount + cancelledCount} issues`,
      subValue: `${todoCount} todo · ${inProgressCount} in progress · ${doneCount} done`,
      status: 'neutral',
    },
    {
      icon: Play,
      label: 'Workflow',
      value: activeBatch ? `${activeBatch.mode} mode` : 'Idle',
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
      <div className="px-4 py-1.5">
        <div className="rounded-xl border border-linear-border bg-linear-bg-secondary overflow-hidden">
          <div className="flex items-stretch divide-x divide-linear-border overflow-x-auto">
            {items.map((item) => {
              const Icon = item.icon
              const tones: Record<string, { bg: string; icon: string; value: string }> = {
                ready: { bg: 'bg-emerald-500/10', icon: 'text-emerald-400', value: 'text-emerald-200' },
                blocked: { bg: 'bg-amber-500/10', icon: 'text-amber-400', value: 'text-amber-200' },
                active: { bg: 'bg-linear-accent/10', icon: 'text-linear-accent', value: 'text-linear-accent' },
                neutral: { bg: '', icon: 'text-linear-text-tertiary', value: 'text-linear-text' },
                inactive: { bg: '', icon: 'text-linear-text-tertiary', value: 'text-linear-text-tertiary' },
              }
              const tone = tones[item.status]

              return (
                <div
                  key={item.label}
                  className={`flex-1 min-w-[170px] sm:min-w-0 px-3 py-1.5 flex items-center gap-2 ${tone.bg} transition-colors`}
                >
                  <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${tone.icon}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary leading-tight">
                      {item.label}
                    </div>
                    <div className={`text-[13px] font-medium truncate leading-tight ${tone.value}`}>
                      {item.value}
                    </div>
                    {item.subValue && (
                      <div className="text-[11px] text-linear-text-tertiary truncate leading-tight mt-0.5">
                        {item.subValue}
                      </div>
                    )}
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
                      className="ml-auto p-1 rounded-md text-linear-text-tertiary hover:text-linear-text hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:pointer-events-none"
                      aria-label="Edit source"
                      title="Edit source"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
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
    executionProgress,
    isTaskFormOpen,
    setIsTaskFormOpen,
    defaultStatus,
    selectedTaskId,
    taskLogs,
    selectedTaskIds,
    selectingColumns,
    activeBatch,
    setActiveBatch,
    completedBatch,
    canExecute,
    activeRepository,
    selectedProject,
    batchTaskIds,
    completedBatchTaskIds,
    selectedTask,
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
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    clearSelection,
    fetchTasks,
    showProviderSetup,
    setShowProviderSetup,
    handleProviderSetupComplete,
  } = useKanbanBoard(props)

  const renderTask = (task: Task, index: number, isCompletedBatch?: boolean) => (
    <Draggable key={task.id} draggableId={task.id} index={index}>
      {(provided, snapshot) => (
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
            executionProgress={executionProgress[task.id]}
            selected={selectedTaskIds.has(task.id)}
            onToggleSelect={toggleTaskSelect}
            selectionMode={selectingColumns.has(task.status)}
            isBatchTask={batchTaskIds.includes(task.id)}
            isCompletedBatchTask={isCompletedBatch}
            isDragging={snapshot.isDragging}
          />
        </div>
      )}
    </Draggable>
  )

  if (loading) {
    return <DashboardLoading />
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => { fetchTasks({ showLoading: true, clearError: true }) }}
            className="px-4 py-2 bg-linear-accent text-white rounded-md hover:bg-linear-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex-1 overflow-hidden relative bg-[#111111] flex flex-col">
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
          />
        )}
        <ProjectConfigPanel
          selectedProject={selectedProject}
          activeRepository={activeRepository}
          canExecute={canExecute}
          tasks={tasks}
          selectedTaskIds={selectedTaskIds}
          activeBatch={activeBatch}
        />
        <div className="flex md:grid md:grid-cols-2 lg:grid-cols-4 flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory md:overflow-x-visible md:snap-none">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.status)
            const hasParallelGroup =
              (column.status === 'in_progress' && batchTaskIds.length > 0) ||
              (column.status === 'done' && completedBatchTaskIds.length > 0)
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
                  >
                    {columnTasks.length === 0 && !snapshot.isDraggingOver ? (
                      <button
                        onClick={() => handleAddTask(column.status)}
                        className="w-full flex flex-col items-center justify-center py-8 text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-white/[0.03] rounded-lg transition-all cursor-pointer group"
                      >
                        <div className="w-10 h-10 rounded-full bg-white/[0.04] flex items-center justify-center mb-3 group-hover:bg-white/[0.06] group-hover:scale-110 transition-all">
                          <Plus className="w-5 h-5" />
                        </div>
                        <span className="text-sm">Add task</span>
                      </button>
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
                                executionProgress={executionProgress}
                                selectedTaskIds={selectedTaskIds}
                                onExecute={handleExecute}
                                onCancel={handleCancel}
                                onDelete={handleDelete}
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
                            completedBatch={completedBatch}
                            executionProgress={executionProgress}
                            selectedTaskIds={selectedTaskIds}
                            onDelete={handleDelete}
                            onTaskClick={handleTaskClick}
                            onToggleSelect={toggleTaskSelect}
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

        <TaskFormDialog
          open={isTaskFormOpen}
          onOpenChange={setIsTaskFormOpen}
          defaultStatus={defaultStatus}
          defaultProjectId={props.projectId}
          projects={props.projects}
        />

        <TaskDetailView
          task={selectedTask}
          logs={selectedTaskId ? (taskLogs[selectedTaskId] || []) : []}
          progress={selectedTaskId ? executionProgress[selectedTaskId] : undefined}
          open={!!selectedTaskId}
          onClose={handleDrawerClose}
          onDelete={handleDelete}
          onCancel={handleCancel}
          onExecute={selectedTaskId && batchTaskIds.includes(selectedTaskId) ? undefined : handleExecute}
          onUpdate={handleUpdateTask}
          isExecuting={selectedTask?.status === 'in_progress'}
        />

        <ProviderSetupDialog
          open={showProviderSetup}
          onOpenChange={setShowProviderSetup}
          onSetupComplete={handleProviderSetupComplete}
        />

        {(() => {
          if (selectedTaskIds.size === 0) return null
          const selectedTodoIds = Array.from(selectedTaskIds).filter(
            id => tasks.find(t => t.id === id)?.status === 'todo'
          )
          const selectedInProgressIds = Array.from(selectedTaskIds).filter(
            id => tasks.find(t => t.id === id)?.status === 'in_progress'
          )
          const hasTodo = selectedTodoIds.length > 0
          const hasInProgress = selectedInProgressIds.length > 0
          const mode = hasTodo && hasInProgress ? 'mixed' as const : hasTodo ? 'move' as const : hasInProgress ? 'execute' as const : 'view' as const
          return (
            <BatchControls
              selectedCount={selectedTaskIds.size}
              mode={mode}
              onExecuteParallel={() => handleBatchExecute('parallel')}
              onExecuteQueue={() => handleBatchExecute('queue')}
              onMoveToInProgress={handleBatchMoveToInProgress}
              onClearSelection={clearSelection}
              disabled={!canExecute}
            />
          )
        })()}
      </div>
    </DragDropContext>
  )
}
