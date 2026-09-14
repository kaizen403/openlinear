import { useState, useCallback, useEffect, useRef } from "react"
import type { Task } from "@/types/task"
import { COLUMNS } from "@/components/board/use-kanban-board"

export interface UseTaskSelectionProps {
  tasks: Task[]
  filteredTasks: Task[]
  batchTaskIds: string[]
}

export interface UseTaskSelectionReturn {
  selectedTaskId: string | null
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | null>>
  selectedTaskIds: Set<string>
  setSelectedTaskIds: React.Dispatch<React.SetStateAction<Set<string>>>
  selectionActive: boolean
  selectingColumns: Set<string>
  lastSelectedIdRef: React.MutableRefObject<string | null>
  toggleTaskSelect: (taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => void
  toggleColumnSelection: (columnId: string) => void
  toggleColumnSelectAll: (status: Task['status']) => void
  selectAllVisible: () => void
  clearSelection: () => void
}

export function useTaskSelection({ tasks, filteredTasks, batchTaskIds }: UseTaskSelectionProps): UseTaskSelectionReturn {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [selectingColumns, setSelectingColumns] = useState<Set<string>>(new Set())
  const lastSelectedIdRef = useRef<string | null>(null)
  const tasksRef = useRef(tasks)
  const batchTaskIdsRef = useRef(batchTaskIds)
  tasksRef.current = tasks
  batchTaskIdsRef.current = batchTaskIds

  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set())
    setSelectingColumns(new Set())
    lastSelectedIdRef.current = null
  }, [])

  const clearColumnSelection = useCallback((status: Task['status']) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      filteredTasks
        .filter(task => task.status === status)
        .forEach(task => next.delete(task.id))
      return next
    })
  }, [filteredTasks])

  const toggleColumnSelection = useCallback((columnId: string) => {
    setSelectedTaskId(null)
    setSelectingColumns(prev => {
      const next = new Set(prev)
      if (next.has(columnId)) {
        next.delete(columnId)
        const columnStatus = COLUMNS.find((c: { id: string; status: string }) => c.id === columnId)?.status
        if (columnStatus) {
          clearColumnSelection(columnStatus)
        }
      } else {
        next.add(columnId)
      }
      return next
    })
  }, [clearColumnSelection])

  const toggleTaskSelect = useCallback((taskId: string, modifiers?: { shift?: boolean; meta?: boolean }) => {
    const currentBatchTaskIds = batchTaskIdsRef.current
    const currentTasks = tasksRef.current

    if (currentBatchTaskIds.includes(taskId)) return
    setSelectedTaskId(null)

    if (modifiers?.shift && lastSelectedIdRef.current) {
      const orderedIds: string[] = []
      for (const col of COLUMNS) {
        for (const t of currentTasks) {
          if (t.status === col.status) orderedIds.push(t.id)
        }
      }
      const anchorIdx = orderedIds.indexOf(lastSelectedIdRef.current)
      const targetIdx = orderedIds.indexOf(taskId)
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
        setSelectedTaskIds(prev => {
          const next = new Set(prev)
          for (let i = from; i <= to; i++) {
            const id = orderedIds[i]
            if (id && !currentBatchTaskIds.includes(id)) next.add(id)
          }
          return next
        })
        lastSelectedIdRef.current = taskId
        return
      }
    }

    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
    lastSelectedIdRef.current = taskId
  }, [])

  const toggleColumnSelectAll = useCallback((status: Task['status']) => {
    setSelectedTaskId(null)
    const columnTasks = filteredTasks.filter(task => task.status === status)
    const columnTaskIds = columnTasks.map(task => task.id)
    const allSelected = columnTaskIds.every(id => selectedTaskIds.has(id))

    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (allSelected) {
        columnTaskIds.forEach(id => next.delete(id))
      } else {
        columnTaskIds.forEach(id => {
          if (!batchTaskIds.includes(id)) {
            next.add(id)
          }
        })
      }
      return next
    })
  }, [filteredTasks, selectedTaskIds, batchTaskIds])

  const selectAllVisible = useCallback(() => {
    const ids = filteredTasks
      .filter(t => !batchTaskIds.includes(t.id))
      .map(t => t.id)
    if (ids.length === 0) return
    setSelectedTaskId(null)
    setSelectedTaskIds(new Set(ids))
  }, [filteredTasks, batchTaskIds])

  const selectionActive = selectedTaskIds.size > 0

  // Clear in_progress column selection when batch starts
  useEffect(() => {
    setSelectingColumns(prev => {
      const next = new Set(prev)
      let changed = false
      if (batchTaskIds.length > 0 && next.has('in_progress')) {
        next.delete('in_progress')
        clearColumnSelection('in_progress')
        changed = true
      }
      return changed ? next : prev
    })
  }, [batchTaskIds.length, clearColumnSelection])

  return {
    selectedTaskId,
    setSelectedTaskId,
    selectedTaskIds,
    setSelectedTaskIds,
    selectionActive,
    selectingColumns,
    lastSelectedIdRef,
    toggleTaskSelect,
    toggleColumnSelection,
    toggleColumnSelectAll,
    selectAllVisible,
    clearSelection,
  }
}
