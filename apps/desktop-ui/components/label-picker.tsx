"use client"

import { useState, useEffect, useCallback } from "react"
import { X, ChevronDown, Tag } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/empty-state"
import { apiFetch, ApiError } from "@/lib/api/fetch"

interface Label {
  id: string
  name: string
  color: string
  priority: number
}

interface LabelPickerProps {
  projectId: string
  selectedIds: string[]
  onChange: (ids: string[]) => void
  triggerClassName?: string
}

const labelsCacheMap = new Map<string, Label[]>()

async function loadLabels(projectId: string): Promise<Label[]> {
  const cached = labelsCacheMap.get(projectId)
  if (cached) return cached
  const data = await apiFetch<Label[]>(`/api/labels?projectId=${projectId}`)
  const sorted = [...data].sort((a, b) => a.priority - b.priority)
  labelsCacheMap.set(projectId, sorted)
  return sorted
}

export function invalidateLabelCache(projectId: string) {
  labelsCacheMap.delete(projectId)
}

export function LabelPicker({ projectId, selectedIds, onChange, triggerClassName }: LabelPickerProps) {
  const [labels, setLabels] = useState<Label[]>(labelsCacheMap.get(projectId) ?? [])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchLabels = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      setLabels(await loadLabels(projectId))
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not reach OpenLinear server.'
      setLoadError(msg)
      toast.error(`Failed to load labels: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open && !labelsCacheMap.has(projectId) && labels.length === 0 && !loading && !loadError) {
      void fetchLabels()
    }
  }, [fetchLabels, labels.length, loadError, loading, open, projectId])

  useEffect(() => {
    const cached = labelsCacheMap.get(projectId)
    if (cached) setLabels(cached)
    else setLabels([])
  }, [projectId])

  const toggleLabel = (labelId: string) => {
    if (selectedIds.includes(labelId)) {
      onChange(selectedIds.filter((id) => id !== labelId))
    } else {
      onChange([...selectedIds, labelId])
    }
  }

  const removeLabel = (labelId: string) => {
    onChange(selectedIds.filter((id) => id !== labelId))
  }

  const selectedLabels = labels.filter((label) => selectedIds.includes(label.id))

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "w-full justify-between bg-linear-bg-tertiary border-linear-border hover:bg-linear-bg-tertiary",
              triggerClassName
            )}
          >
            <div className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-linear-text-tertiary" />
              <span className="text-linear-text-secondary">
                {selectedIds.length === 0
                  ? "Select labels..."
                  : `${selectedIds.length} label${selectedIds.length > 1 ? "s" : ""} selected`}
              </span>
            </div>
            <ChevronDown className="w-4 h-4 text-linear-text-tertiary" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[300px] p-0 bg-linear-bg-secondary border-linear-border"
          align="start"
        >
          <div className="p-2 border-b border-linear-border">
            <span className="text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
              Labels
            </span>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-sm text-linear-text-tertiary">
                Loading labels...
              </div>
            ) : loadError ? (
              <div className="p-3 flex flex-col items-center gap-2">
                <div className="text-xs text-red-400 text-center">{loadError}</div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={fetchLabels}
                  className="text-xs h-7"
                >
                  Retry
                </Button>
              </div>
            ) : labels.length === 0 ? (
              <EmptyState
                size="compact"
                icon={Tag}
                title="No labels yet"
                description="Create labels in project settings"
              />
            ) : (
              labels.map((label) => (
                <div
                  key={label.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-linear-bg-tertiary cursor-pointer transition-colors"
                  onClick={() => toggleLabel(label.id)}
                >
                  <Checkbox
                    checked={selectedIds.includes(label.id)}
                    className="border-linear-border"
                  />
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  <span className="flex-1 text-sm text-linear-text">
                    {label.name}
                  </span>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {selectedLabels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedLabels.map((label) => (
            <Badge
              key={label.id}
              variant="secondary"
              className={cn(
                "text-xs px-2 py-0.5 cursor-pointer hover:opacity-80 transition-opacity",
                "bg-linear-bg-tertiary text-linear-text border border-linear-border"
              )}
              style={{
                backgroundColor: `${label.color}20`,
                borderColor: `${label.color}40`,
                color: label.color,
              }}
              onClick={() => removeLabel(label.id)}
            >
              {label.name}
              <X className="w-3 h-3 ml-1" />
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
