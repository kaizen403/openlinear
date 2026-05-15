"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Archive, ChevronDown, X, MoveRight } from "lucide-react"
import { Task } from "@/types/task"

interface BulkSelectionToolbarProps {
  selectedCount: number
  onChangeStatus: (status: Task['status']) => void
  onDelete: () => void
  onClear: () => void
}

const STATUS_LABELS: Record<Task['status'], string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function BulkSelectionToolbar({
  selectedCount,
  onChangeStatus,
  onDelete,
  onClear,
}: BulkSelectionToolbarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="fixed bottom-3 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-2 bg-linear-bg-secondary border border-linear-border rounded-sm shadow-2xl backdrop-blur-md">
      <span className="text-xs sm:text-sm text-linear-text-secondary whitespace-nowrap pl-1">
        {selectedCount} selected
      </span>
      <div className="w-px h-6 bg-linear-border" />

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
        onClick={onDelete}
        className="h-8 border-linear-border text-linear-text hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/30 gap-1.5"
      >
        <Archive className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Archive</span>
      </Button>

      <div className="w-px h-6 bg-linear-border" />

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
