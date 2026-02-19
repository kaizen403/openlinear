"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Plus } from "lucide-react"
import { DroppableProvidedProps } from "@hello-pangea/dnd"

interface ColumnProps {
  id: string
  title: string
  taskCount: number
  children: React.ReactNode
  onAddTask?: () => void
  selectionActive?: boolean
  onToggleSelection?: () => void
  onSelectAll?: () => void
  innerRef?: (element: HTMLElement | null) => void
  droppableProps?: DroppableProvidedProps
  isDraggingOver?: boolean
}

export function Column({ id, title, taskCount, children, onAddTask, selectionActive, onToggleSelection, onSelectAll, innerRef, droppableProps, isDraggingOver }: ColumnProps) {
  return (
    <div className="flex flex-col h-full border-r border-white/[0.06] last:border-r-0 w-[90vw] sm:w-[72vw] flex-none md:w-full md:flex-auto snap-start bg-gradient-to-b from-white/[0.02] to-transparent">
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 backdrop-blur-sm bg-white/[0.02] border-b border-white/[0.04] gap-2 flex-nowrap min-h-11 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
          <h3 className="text-zinc-400 text-xs font-medium uppercase tracking-wider truncate">{title}</h3>
          <Badge
            variant="secondary"
            className="bg-white/[0.06] text-zinc-400 text-xs px-2 py-0 h-5 backdrop-blur-sm border border-white/[0.08] flex-shrink-0"
          >
            {taskCount}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onToggleSelection && (
            <button
              type="button"
              onClick={onToggleSelection}
              className="h-6 px-2 rounded-md text-[11px] uppercase tracking-wider text-linear-text-secondary bg-linear-bg-tertiary border border-white/[0.12] hover:bg-linear-bg-secondary hover:text-linear-text transition-colors flex-shrink-0 whitespace-nowrap"
            >
              {selectionActive ? 'Cancel' : 'Select'}
            </button>
          )}
          {selectionActive && onSelectAll && (
            <button
              type="button"
              onClick={onSelectAll}
              className="h-6 px-2 rounded-md text-[11px] uppercase tracking-wider text-linear-text-secondary bg-linear-bg-tertiary border border-white/[0.12] hover:bg-linear-bg-secondary hover:text-linear-text transition-colors flex-shrink-0 whitespace-nowrap"
            >
              All
            </button>
          )}
          {onAddTask && (
            <button
              type="button"
              onClick={onAddTask}
              className="w-6 h-6 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors flex-shrink-0"
              aria-label={`Add task to ${title}`}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div 
        ref={innerRef}
        {...droppableProps}
        className={cn(
          "flex-1 p-2.5 sm:p-3 overflow-y-auto",
          "space-y-3",
          isDraggingOver && "bg-white/[0.02] border border-dashed border-white/[0.1] rounded-xl backdrop-blur-sm"
        )}
      >
        {children}
      </div>
    </div>
  )
}
