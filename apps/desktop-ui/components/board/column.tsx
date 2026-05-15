"use client"

import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Plus, Loader2 } from "lucide-react"
import { DroppableProvidedProps } from "@hello-pangea/dnd"

interface ColumnProps {
  id: string
  title: string
  taskCount: number
  children: React.ReactNode
  onAddTask?: () => void
  onInlineCreate?: (title: string) => Promise<void> | void
  selectionActive?: boolean
  onToggleSelection?: () => void
  onSelectAll?: () => void
  innerRef?: (element: HTMLElement | null) => void
  droppableProps?: DroppableProvidedProps
  isDraggingOver?: boolean
}

export function Column({
  id,
  title,
  taskCount,
  children,
  onAddTask,
  onInlineCreate,
  selectionActive,
  onToggleSelection,
  onSelectAll,
  innerRef,
  droppableProps,
  isDraggingOver,
}: ColumnProps) {
  return (
    <div className="flex flex-col h-full border-r border-linear-border last:border-r-0 w-[90vw] sm:w-[72vw] flex-none md:w-full md:flex-auto snap-start bg-gradient-to-b from-linear-bg-secondary to-transparent">
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 backdrop-blur-sm bg-linear-bg-secondary border-b border-linear-border gap-2 flex-nowrap min-h-11 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
          <h3 className="text-linear-text-tertiary text-xs font-medium uppercase tracking-wider truncate">{title}</h3>
          <Badge
            variant="secondary"
            className="bg-linear-bg-tertiary text-linear-text-tertiary text-xs px-2 py-0 h-5 backdrop-blur-sm border border-linear-border flex-shrink-0"
          >
            {taskCount}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onToggleSelection && (
            <button
              type="button"
              onClick={onToggleSelection}
              className="h-6 px-2 rounded-sm text-[11px] uppercase tracking-wider text-linear-text-secondary bg-linear-bg-tertiary border border-linear-border hover:bg-linear-bg-secondary hover:text-linear-text transition-colors flex-shrink-0 whitespace-nowrap"
            >
              {selectionActive ? 'Cancel' : 'Select'}
            </button>
          )}
          {selectionActive && onSelectAll && (
            <button
              type="button"
              onClick={onSelectAll}
              className="h-6 px-2 rounded-sm text-[11px] uppercase tracking-wider text-linear-text-secondary bg-linear-bg-tertiary border border-linear-border hover:bg-linear-bg-secondary hover:text-linear-text transition-colors flex-shrink-0 whitespace-nowrap"
            >
              All
            </button>
          )}
          {onAddTask && (
            <button
              type="button"
              onClick={onAddTask}
              className="w-6 h-6 rounded-sm flex items-center justify-center text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary transition-colors flex-shrink-0"
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
          isDraggingOver && "bg-linear-bg-secondary border border-dashed border-linear-border rounded-sm backdrop-blur-sm"
        )}
      >
        {children}
        {onInlineCreate && <InlineAddTask columnId={id} columnTitle={title} onCreate={onInlineCreate} />}
      </div>
    </div>
  )
}

interface InlineAddTaskProps {
  columnId: string
  columnTitle: string
  onCreate: (title: string) => Promise<void> | void
}

function InlineAddTask({ columnTitle, onCreate }: InlineAddTaskProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
    }
  }, [editing])

  const cancel = () => {
    setValue("")
    setEditing(false)
  }

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate(trimmed)
      setValue("")
      // Keep input open for fast successive entry (Linear-style)
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-sm text-[12px] text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors group"
      >
        <Plus className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />
        <span>Add task</span>
      </button>
    )
  }

  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-secondary backdrop-blur-sm focus-within:border-linear-accent/50 focus-within:bg-linear-bg-tertiary transition-colors">
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={submitting}
        placeholder={`New task in ${columnTitle.toLowerCase()}…`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            void submit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={() => {
          // Cancel on blur only if empty — preserve in-flight typing on accidental clicks
          if (!value.trim() && !submitting) cancel()
        }}
        className="w-full bg-transparent px-3 py-2.5 text-sm text-linear-text placeholder:text-linear-text-tertiary outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between px-3 pb-2 pt-0.5 text-[10px] uppercase tracking-wider text-linear-text-tertiary">
        <span>Enter to save · Esc to cancel</span>
        {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
      </div>
    </div>
  )
}
