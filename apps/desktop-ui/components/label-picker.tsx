"use client"

import { useState, useEffect } from "react"
import { X, ChevronDown, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

interface Label {
  id: string
  name: string
  color: string
  priority: number
}

interface LabelPickerProps {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  triggerClassName?: string
}

import { API_URL } from "@/lib/api/client"

const API_BASE_URL = `${API_URL}/api`

export function LabelPicker({ selectedIds, onChange, triggerClassName }: LabelPickerProps) {
  const [labels, setLabels] = useState<Label[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    fetchLabels()
  }, [])

  const fetchLabels = async () => {
    try {
      setLoading(true)
      const response = await fetch(`${API_BASE_URL}/labels`)
      if (!response.ok) {
        throw new Error(`Failed to fetch labels: ${response.statusText}`)
      }
      const data = await response.json()
      // Sort by priority
      const sortedLabels = data.sort((a: Label, b: Label) => a.priority - b.priority)
      setLabels(sortedLabels)
    } catch (err) {
      console.error("Error fetching labels:", err)
    } finally {
      setLoading(false)
    }
  }

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
              "w-full justify-between bg-linear-bg-tertiary border-linear-border hover:bg-linear-bg-tertiary hover:border-linear-border-hover",
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
            ) : labels.length === 0 ? (
              <div className="p-4 text-center text-sm text-linear-text-tertiary">
                No labels available
              </div>
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
