"use client"

import { Button } from "@/components/ui/button"
import { Play, ListOrdered, X } from "lucide-react"

interface BatchControlsProps {
  selectedCount: number
  onExecuteParallel: () => void
  onExecuteQueue: () => void
  onClearSelection: () => void
  disabled?: boolean
}

export function BatchControls({ selectedCount, onExecuteParallel, onExecuteQueue, onClearSelection, disabled }: BatchControlsProps) {
  if (selectedCount === 0) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 bg-linear-bg-secondary border border-linear-border rounded-xl shadow-2xl backdrop-blur-sm">
      <span className="text-sm text-linear-text-secondary">
        {selectedCount} task{selectedCount !== 1 ? 's' : ''} selected
      </span>
      <div className="w-px h-6 bg-linear-border" />
      <Button
        size="sm"
        onClick={onExecuteParallel}
        disabled={disabled}
        className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-1.5"
      >
        <Play className="w-3.5 h-3.5" />
        Execute Parallel
      </Button>
      <Button
        size="sm"
        onClick={onExecuteQueue}
        disabled={disabled}
        variant="outline"
        className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5"
      >
        <ListOrdered className="w-3.5 h-3.5" />
        Execute Queue
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onClearSelection}
        className="text-linear-text-tertiary hover:text-linear-text h-8 w-8 p-0"
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  )
}
