"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

interface ColumnProps {
  id: string
  title: string
  taskCount: number
  children: React.ReactNode
}

export function Column({ id, title, taskCount, children }: ColumnProps) {
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
      </div>

      <div className={cn(
        "flex-1 p-3 overflow-y-auto",
        "space-y-3"
      )}>
        {children}
      </div>
    </div>
  )
}
