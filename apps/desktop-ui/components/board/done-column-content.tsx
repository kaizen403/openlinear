"use client"

import type { ReactNode } from "react"
import { Task } from "@/types/task"

interface DoneColumnContentProps {
  columnTasks: Task[]
  renderTask: (task: Task, index: number) => ReactNode
}

export function DoneColumnContent({
  columnTasks,
  renderTask,
}: DoneColumnContentProps) {
  return columnTasks.map((task, index) => renderTask(task, index))
}
