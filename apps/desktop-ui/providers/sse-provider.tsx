"use client"

import { createContext, useContext, useEffect, useRef, useCallback, useState, type ReactNode } from "react"
import type { SSEEventType, SSEEventData } from "@/hooks/use-sse"
import { useAuth } from "@/hooks/use-auth"
import { API_URL } from "@/lib/api/client"

const SSE_URL = `${API_URL}/api/events`
const SSE_RECONNECT_DELAY = 3000
const SSE_MAX_RETRIES = 10

type SSEListener = (eventType: SSEEventType, data: SSEEventData) => void

interface SSEContextType {
  subscribe: (listener: SSEListener) => () => void
  isConnected: boolean
}

const SSEContext = createContext<SSEContextType | null>(null)

const ALL_EVENT_TYPES: SSEEventType[] = [
  'task:created',
  'task:updated',
  'task:deleted',
  'label:created',
  'label:updated',
  'label:deleted',
  'settings:updated',
  'execution:progress',
  'execution:log',
  'batch:created',
  'batch:started',
  'batch:task:started',
  'batch:task:completed',
  'batch:task:failed',
  'batch:task:skipped',
  'batch:task:cancelled',
  'batch:merging',
  'batch:completed',
  'batch:failed',
  'batch:cancelled',
  'team:created',
  'team:updated',
  'team:deleted',
  'project:created',
  'project:updated',
  'project:deleted',
]

export function SSEProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const listenersRef = useRef<Set<SSEListener>>(new Set())
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const retryCountRef = useRef(0)
  const [isConnected, setIsConnected] = useState(false)

  const broadcast = useCallback((eventType: SSEEventType, data: SSEEventData) => {
    listenersRef.current.forEach((listener) => {
      try {
        listener(eventType, data)
      } catch (err) {
        console.error("[SSE Provider] Listener error:", err)
      }
    })
  }, [])

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return
    if (!isAuthenticated) return

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    const eventSource = new EventSource(SSE_URL)
    eventSourceRef.current = eventSource

    eventSource.onopen = () => {
      console.log("[SSE Provider] Connected to", SSE_URL)
      setIsConnected(true)
      retryCountRef.current = 0
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEventData
        if (data.type === 'connected') {
          broadcast('connected', data)
        }
      } catch (err) {
        console.error("[SSE Provider] Failed to parse message:", err)
      }
    }

    for (const eventType of ALL_EVENT_TYPES) {
      eventSource.addEventListener(eventType, (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data)
          broadcast(eventType, data)
        } catch (err) {
          console.error(`[SSE Provider] Failed to parse ${eventType}:`, err)
        }
      })
    }

    eventSource.onerror = () => {
      eventSource.close()
      eventSourceRef.current = null
      setIsConnected(false)

      if (retryCountRef.current >= SSE_MAX_RETRIES) {
        console.warn("[SSE Provider] Max retries reached, stopping reconnect")
        return
      }

      retryCountRef.current++
      console.log(`[SSE Provider] Connection error, retry ${retryCountRef.current}/${SSE_MAX_RETRIES} in ${SSE_RECONNECT_DELAY}ms`)

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }

      reconnectTimeoutRef.current = setTimeout(() => {
        connect()
      }, SSE_RECONNECT_DELAY)
    }
  }, [broadcast, isAuthenticated])

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
      retryCountRef.current = 0
    }
  }, [connect])

  const subscribe = useCallback((listener: SSEListener) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  return (
    <SSEContext.Provider value={{ subscribe, isConnected }}>
      {children}
    </SSEContext.Provider>
  )
}

export function useSSESubscription(
  onEvent: (eventType: SSEEventType, data: SSEEventData) => void
) {
  const context = useContext(SSEContext)
  if (!context) {
    throw new Error("useSSESubscription must be used within an SSEProvider")
  }
  const { subscribe } = context
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    return subscribe((eventType, data) => onEventRef.current(eventType, data))
  }, [subscribe])
}
