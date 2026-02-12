"use client"

import { useEffect, useRef, useCallback } from "react"

export interface SSEEventData {
  type?: string
  clientId?: string
  id?: string
  title?: string
  description?: string | null
  priority?: 'low' | 'medium' | 'high'
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled'
  sessionId?: string | null
  createdAt?: string
  updatedAt?: string
  labels?: Array<{
    id: string
    name: string
    color: string
    priority: number
  }>
  executionStartedAt?: string | null
  executionPausedAt?: string | null
  executionElapsedMs?: number
  executionProgress?: number | null
  prUrl?: string | null
  outcome?: string | null
  batchId?: string | null
  inboxRead?: boolean
  identifier?: string | null
  number?: number | null
  dueDate?: string | null
  taskId?: string
  mode?: string
  tasks?: Array<{
    taskId: string
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  }>
}

export type SSEEventType =
  | 'connected'
  | 'task:created'
  | 'task:updated'
  | 'task:deleted'
  | 'label:created'
  | 'label:updated'
  | 'label:deleted'
  | 'settings:updated'
  | 'execution:progress'
  | 'execution:log'
  | 'batch:created'
  | 'batch:started'
  | 'batch:task:started'
  | 'batch:task:completed'
  | 'batch:task:failed'
  | 'batch:task:skipped'
  | 'batch:task:cancelled'
  | 'batch:merging'
  | 'batch:completed'
  | 'batch:failed'
  | 'batch:cancelled'
  | 'team:created'
  | 'team:updated'
  | 'team:deleted'
  | 'project:created'
  | 'project:updated'
  | 'project:deleted'

const SSE_RECONNECT_DELAY = 3000

export function useSSE(
  url: string,
  onEvent: (eventType: SSEEventType, data: SSEEventData) => void,
  enabled: boolean = true
) {
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  const connect = useCallback(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    const eventSource = new EventSource(url)
    eventSourceRef.current = eventSource

    eventSource.onopen = () => {
      console.log("[SSE] Connected to", url)
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEventData
        if (data.type === 'connected') {
          onEventRef.current('connected', data)
        }
      } catch (err) {
        console.error("[SSE] Failed to parse message:", err)
      }
    }

    eventSource.addEventListener("task:created", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('task:created', data)
      } catch (err) {
        console.error("[SSE] Failed to parse task:created:", err)
      }
    })

    eventSource.addEventListener("task:updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('task:updated', data)
      } catch (err) {
        console.error("[SSE] Failed to parse task:updated:", err)
      }
    })

    eventSource.addEventListener("task:deleted", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('task:deleted', data)
      } catch (err) {
        console.error("[SSE] Failed to parse task:deleted:", err)
      }
    })

    eventSource.addEventListener("label:created", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('label:created', data)
      } catch (err) {
        console.error("[SSE] Failed to parse label:created:", err)
      }
    })

    eventSource.addEventListener("label:updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('label:updated', data)
      } catch (err) {
        console.error("[SSE] Failed to parse label:updated:", err)
      }
    })

    eventSource.addEventListener("label:deleted", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('label:deleted', data)
      } catch (err) {
        console.error("[SSE] Failed to parse label:deleted:", err)
      }
    })

    eventSource.addEventListener("settings:updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('settings:updated', data)
      } catch (err) {
        console.error("[SSE] Failed to parse settings:updated:", err)
      }
    })

    eventSource.addEventListener("execution:progress", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('execution:progress', data)
      } catch (err) {
        console.error("[SSE] Failed to parse execution:progress:", err)
      }
    })

    eventSource.addEventListener("execution:log", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('execution:log', data)
      } catch (err) {
        console.error("[SSE] Failed to parse execution:log:", err)
      }
    })

    eventSource.addEventListener("batch:created", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:created', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:created:", err)
      }
    })

    eventSource.addEventListener("batch:started", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:started', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:started:", err)
      }
    })

    eventSource.addEventListener("batch:task:started", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:task:started', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:task:started:", err)
      }
    })

    eventSource.addEventListener("batch:task:completed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:task:completed', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:task:completed:", err)
      }
    })

    eventSource.addEventListener("batch:task:failed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:task:failed', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:task:failed:", err)
      }
    })

    eventSource.addEventListener("batch:task:skipped", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:task:skipped', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:task:skipped:", err)
      }
    })

    eventSource.addEventListener("batch:task:cancelled", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:task:cancelled', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:task:cancelled:", err)
      }
    })

    eventSource.addEventListener("batch:merging", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:merging', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:merging:", err)
      }
    })

    eventSource.addEventListener("batch:completed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:completed', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:completed:", err)
      }
    })

    eventSource.addEventListener("batch:failed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:failed', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:failed:", err)
      }
    })

    eventSource.addEventListener("batch:cancelled", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('batch:cancelled', data)
      } catch (err) {
        console.error("[SSE] Failed to parse batch:cancelled:", err)
      }
    })

    eventSource.addEventListener("team:created", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('team:created', data)
      } catch (err) {
        console.error("[SSE] Failed to parse team:created:", err)
      }
    })

    eventSource.addEventListener("team:updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('team:updated', data)
      } catch (err) {
        console.error("[SSE] Failed to parse team:updated:", err)
      }
    })

    eventSource.addEventListener("team:deleted", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('team:deleted', data)
      } catch (err) {
        console.error("[SSE] Failed to parse team:deleted:", err)
      }
    })

    eventSource.addEventListener("project:created", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('project:created', data)
      } catch (err) {
        console.error("[SSE] Failed to parse project:created:", err)
      }
    })

    eventSource.addEventListener("project:updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('project:updated', data)
      } catch (err) {
        console.error("[SSE] Failed to parse project:updated:", err)
      }
    })

    eventSource.addEventListener("project:deleted", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onEventRef.current('project:deleted', data)
      } catch (err) {
        console.error("[SSE] Failed to parse project:deleted:", err)
      }
    })

    eventSource.onerror = () => {
      console.log("[SSE] Connection error, reconnecting in", SSE_RECONNECT_DELAY, "ms")
      eventSource.close()
      eventSourceRef.current = null

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }

      reconnectTimeoutRef.current = setTimeout(() => {
        connect()
      }, SSE_RECONNECT_DELAY)
    }
  }, [url, enabled])

  useEffect(() => {
    connect()

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
    }
  }, [connect])

  return {
    isConnected: typeof window !== 'undefined' && eventSourceRef.current?.readyState === EventSource.OPEN,
  }
}
