"use client"

import { useState, useEffect, useCallback } from "react"
import { Column } from "./column"
import { TaskCard } from "./task-card"
import { Loader2, Layers } from "lucide-react"
import { useSSE, SSEEventType, SSEEventData } from "@/hooks/use-sse"

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

const COLUMNS = [
  { id: 'todo', title: 'Todo', status: 'todo' as const },
  { id: 'in_progress', title: 'In Progress', status: 'in_progress' as const },
  { id: 'done', title: 'Done', status: 'done' as const },
  { id: 'cancelled', title: 'Cancelled', status: 'cancelled' as const },
]

const API_BASE_URL = "http://localhost:3001/api"
const SSE_URL = "http://localhost:3001/api/events"

export function KanbanBoard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleSSEEvent = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    switch (eventType) {
      case 'task:created':
        if (data.id && data.title && data.status) {
          const newTask: Task = {
            id: data.id,
            title: data.title,
            description: data.description ?? null,
            priority: data.priority ?? 'medium',
            status: data.status,
            sessionId: data.sessionId ?? null,
            createdAt: data.createdAt ?? new Date().toISOString(),
            updatedAt: data.updatedAt ?? new Date().toISOString(),
            labels: data.labels ?? [],
          }
          setTasks((prev) => [...prev, newTask])
        }
        break

      case 'task:updated':
        if (data.id) {
          setTasks((prev) =>
            prev.map((task) =>
              task.id === data.id
                ? {
                    ...task,
                    ...(data.title && { title: data.title }),
                    ...(data.description !== undefined && { description: data.description }),
                    ...(data.priority && { priority: data.priority }),
                    ...(data.status && { status: data.status }),
                    ...(data.sessionId !== undefined && { sessionId: data.sessionId }),
                    ...(data.updatedAt && { updatedAt: data.updatedAt }),
                    ...(data.labels && { labels: data.labels }),
                  }
                : task
            )
          )
        }
        break

      case 'task:deleted':
        if (data.id) {
          setTasks((prev) => prev.filter((task) => task.id !== data.id))
        }
        break

      case 'connected':
        console.log("[SSE] Connected with clientId:", data.clientId)
        break

      default:
        break
    }
  }, [])

  useSSE(SSE_URL, handleSSEEvent)

  useEffect(() => {
    fetchTasks()
  }, [])

  const fetchTasks = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch(`${API_BASE_URL}/tasks`)
      if (!response.ok) {
        throw new Error(`Failed to fetch tasks: ${response.statusText}`)
      }
      const data = await response.json()
      setTasks(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks")
    } finally {
      setLoading(false)
    }
  }

  const handleExecute = async (taskId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/tasks/${taskId}/execute`, {
        method: "POST",
      })
      if (!response.ok) {
        throw new Error(`Failed to execute task: ${response.statusText}`)
      }
      fetchTasks()
    } catch (err) {
      console.error("Error executing task:", err)
    }
  }

  const handleCancel = async (taskId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/tasks/${taskId}/cancel`, {
        method: "POST",
      })
      if (!response.ok) {
        throw new Error(`Failed to cancel task: ${response.statusText}`)
      }
      fetchTasks()
    } catch (err) {
      console.error("Error cancelling task:", err)
    }
  }

  const getTasksByStatus = (status: Task['status']) => {
    return tasks.filter((task) => task.status === status)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-linear-accent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={fetchTasks}
            className="px-4 py-2 bg-linear-accent text-white rounded-md hover:bg-linear-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden">
      <div className="flex gap-4 h-full p-6 min-w-max">
        {COLUMNS.map((column) => {
          const columnTasks = getTasksByStatus(column.status)
          return (
            <Column
              key={column.id}
              id={column.id}
              title={column.title}
              taskCount={columnTasks.length}
            >
              {columnTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-linear-text-tertiary">
                  <Layers className="w-8 h-8 mb-2 opacity-50" />
                  <span className="text-sm">No tasks</span>
                </div>
              ) : (
                columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onExecute={column.status === 'todo' ? handleExecute : undefined}
                    onCancel={column.status === 'in_progress' ? handleCancel : undefined}
                  />
                ))
              )}
            </Column>
          )
        })}
      </div>
    </div>
  )
}
