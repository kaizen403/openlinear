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
  innerRef?: (element: HTMLElement | null) => void
  droppableProps?: DroppableProvidedProps
  isDraggingOver?: boolean
}

export function Column({ id, title, taskCount, children, onAddTask, innerRef, droppableProps, isDraggingOver }: ColumnProps) {
  return (
    <div className="flex flex-col min-w-[300px] w-[300px] h-full bg-linear-bg-secondary rounded-lg border border-linear-border">
      <div className="flex items-center justify-between px-4 py-3 border-b border-linear-border">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{title}</h3>
          <Badge 
            variant="secondary" 
            className="bg-linear-bg-tertiary text-linear-text-secondary text-xs px-2 py-0 h-5"
          >
            {taskCount}
          </Badge>
        </div>
        {onAddTask && taskCount === 0 && (
          <button
            onClick={onAddTask}
            className="w-6 h-6 rounded flex items-center justify-center text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
            aria-label={`Add task to ${title}`}
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      <div 
        ref={innerRef}
        {...droppableProps}
        className={cn(
          "flex-1 p-3 overflow-y-auto",
          "space-y-3",
          isDraggingOver && "bg-linear-bg-tertiary/30"
        )}
      >
        {children}
      </div>
    </div>
  )
}
