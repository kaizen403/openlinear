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
    <div className="flex flex-col h-full border-r border-white/[0.06] last:border-r-0 min-w-0 bg-gradient-to-b from-white/[0.02] to-transparent">
      <div className="flex items-center justify-between px-4 py-3 backdrop-blur-sm bg-white/[0.02] border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <h3 className="text-zinc-400 text-xs font-medium uppercase tracking-wider">{title}</h3>
          <Badge 
            variant="secondary" 
            className="bg-white/[0.06] text-zinc-400 text-xs px-2 py-0 h-5 backdrop-blur-sm border border-white/[0.08]"
          >
            {taskCount}
          </Badge>
        </div>
        {onAddTask && (
          <button
            onClick={onAddTask}
            className="w-6 h-6 rounded-md flex items-center justify-center text-zinc-500"
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
          isDraggingOver && "bg-white/[0.02] border border-dashed border-white/[0.1] rounded-xl backdrop-blur-sm"
        )}
      >
        {children}
      </div>
    </div>
  )
}
