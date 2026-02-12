"use client"

import { Button } from "@/components/ui/button"
import { Play, ListOrdered, ArrowRight, X } from "lucide-react"

type BatchMode = 'execute' | 'move' | 'mixed' | 'view'

interface BatchControlsProps {
  selectedCount: number
  mode: BatchMode
  onExecuteParallel: () => void
  onExecuteQueue: () => void
  onMoveToInProgress: () => void
  onClearSelection: () => void
  disabled?: boolean
}

export function BatchControls({ selectedCount, mode, onExecuteParallel, onExecuteQueue, onMoveToInProgress, onClearSelection, disabled }: BatchControlsProps) {
  if (selectedCount === 0) return null

  return (
    <div className="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 bg-linear-bg-secondary border border-linear-border rounded-xl shadow-2xl backdrop-blur-sm max-w-[calc(100vw-2rem)]">
      <span className="text-sm text-linear-text-secondary whitespace-nowrap">
        {selectedCount} task{selectedCount !== 1 ? 's' : ''} selected
      </span>
      <div className="w-px h-6 bg-linear-border" />
      {(mode === 'execute' || mode === 'mixed') && (
        <>
          <Button
            size="sm"
            onClick={onExecuteParallel}
            disabled={disabled}
            className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-1.5"
          >
            <Play className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Execute Parallel</span>
          </Button>
          <Button
            size="sm"
            onClick={onExecuteQueue}
            disabled={disabled}
            variant="outline"
            className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5"
          >
            <ListOrdered className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Execute Queue</span>
          </Button>
        </>
      )}
      {(mode === 'move' || mode === 'mixed') && (
        <Button
          size="sm"
          onClick={onMoveToInProgress}
          disabled={disabled}
          variant="outline"
          className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-1.5"
        >
          <ArrowRight className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Move to In-Progress</span>
        </Button>
      )}
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
