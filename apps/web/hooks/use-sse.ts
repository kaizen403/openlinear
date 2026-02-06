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
