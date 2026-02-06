"use client"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface Label {
  id: string
  name: string
  color: string
  priority: number
}

interface Task {
  id: string
  title: string
  description: string | null
  priority: 'low' | 'medium' | 'high'
  status: 'todo' | 'in_progress' | 'done' | 'cancelled'
  sessionId: string | null
  createdAt: string
  updatedAt: string
  labels: Label[]
}

interface TaskCardProps {
  task: Task
  onExecute?: (taskId: string) => void
  onCancel?: (taskId: string) => void
}

const priorityColors = {
  low: "bg-emerald-500",
  medium: "bg-yellow-500",
  high: "bg-red-500",
}

export function TaskCard({ task, onExecute, onCancel }: TaskCardProps) {
  const handleExecute = () => {
    if (onExecute) {
      onExecute(task.id)
    }
  }

  const handleCancel = () => {
    if (onCancel) {
      onCancel(task.id)
    }
  }

  return (
    <Card className="bg-linear-bg border-linear-border hover:border-linear-border-hover transition-colors cursor-pointer group">
      <CardHeader className="p-3 pb-0">
        <div className="flex items-start gap-2">
          <div className={cn("w-2 h-2 rounded-full mt-1.5 flex-shrink-0", priorityColors[task.priority])} />
          <h4 className="text-sm font-medium leading-tight line-clamp-2 flex-1">{task.title}</h4>
          {task.status === 'in_progress' && (
            <Loader2 className="w-3 h-3 animate-spin text-linear-accent flex-shrink-0 mt-0.5" />
          )}
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-2">
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {task.labels.map((label) => (
              <Badge
                key={label.id}
                variant="secondary"
                className="text-[10px] px-1.5 py-0 h-4 bg-linear-bg-tertiary"
                style={{ color: label.color }}
              >
                {label.name}
              </Badge>
            ))}
          </div>
        )}
        
        <div className="flex items-center justify-between">
          <span className="text-xs text-linear-text-tertiary">
            {task.id.slice(0, 8)}
          </span>
          
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {task.status === 'todo' && onExecute && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-linear-accent hover:text-linear-accent hover:bg-linear-accent/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleExecute()
                }}
              >
                Execute
              </Button>
            )}
            {task.status === 'in_progress' && onCancel && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-red-400 hover:text-red-400 hover:bg-red-500/10"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCancel()
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
