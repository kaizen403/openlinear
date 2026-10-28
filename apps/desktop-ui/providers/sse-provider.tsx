"use client"

import { createContext, useContext, useEffect, useRef, useCallback, useState, type ReactNode } from "react"
import { useAuth } from "@/hooks/use-auth"
import { getAuthToken, getCloudApiUrl, resolveApiBaseUrl } from "@/lib/api/client"
import { apiFetch, refreshAccessToken } from "@/lib/api/fetch"
import { isDesktopRuntime } from "@/lib/api/runtime"
import {
  EventStreamConnection,
  RecentEventIds,
  type EventStreamName,
  type EventStreamRequest,
  type EventStreamState,
  type StreamMessage,
} from "@/lib/api/event-stream"

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
  teamId?: string | null
  projectId?: string | null
  assigneeId?: string | null
  creatorId?: string | null
  assignee?: { id: string; username: string; avatarUrl: string | null } | null
  creator?: { id: string; username: string; avatarUrl: string | null } | null
  model?: string | null
  archived?: boolean
  taskId?: string
  mode?: string
  tasks?: Array<{
    taskId: string
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
  }>
  /** Catch-all for workspace, project, team, member, access payloads. */
  [key: string]: unknown
}

const ALL_EVENT_TYPES = [
  'task:created',
  'task:updated',
  'task:deleted',
  'tasks:bulk-created',
  'tasks:bulk-updated',
  'tasks:bulk-deleted',
  'task:label:assigned',
  'task:label:removed',
  // W17a: a "blocked by" edge was added or removed.
  'task:dependencies',
  // FE-04: a run's approval requests changed (requested / decided / expired).
  'approval:changed',
  // W19a: an agent review of a task started or finished.
  'review:changed',
  // W17b: plans (project-scoped).
  'plan:created',
  'plan:revised',
  'plan:approved',
  'plan:archived',
  // W20: recurring issues (project-scoped; the created issues arrive as task:created).
  'schedule:created',
  'schedule:updated',
  'schedule:deleted',
  // W19b: project knowledge changed (created / edited / approved / retracted / restored).
  'knowledge:changed',
  // FE-14: a webhook endpoint was added, changed or removed.
  'webhook:created',
  'webhook:updated',
  'webhook:deleted',
  'label:created',
  'label:updated',
  'label:deleted',
  'comment:created',
  'comment:updated',
  'comment:deleted',
  'activity:created',
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
  'batch:progress',
  // Sidecar: events after the client's Last-Event-ID are gone (journal
  // retention or restart); the client must re-read state (W03a).
  'replay-gap',
  'batch:completed',
  'batch:failed',
  'batch:cancelled',
  'team:created',
  'team:updated',
  'team:deleted',
  'team:joined',
  'team:left',
  'team:member-added',
  'team:member-updated',
  'team:member-removed',
  'project:created',
  'project:updated',
  'project:deleted',
  'project:access-changed',
  'workspace:joined',
  'workspace:left',
  'workspace:updated',
  'workspace:deleted',
  'workspace:member-added',
  'workspace:member-updated',
  'workspace:member-removed',
  'notification:created',
  'chat:session:updated',
] as const

export type SSEEventType = 'connected' | (typeof ALL_EVENT_TYPES)[number]

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(ALL_EVENT_TYPES)

/** Where an event came from: the cloud domain stream or the local sidecar stream. */
export interface SSEEventMeta {
  stream: EventStreamName
  /** The event's SSE id, when the server sent one. */
  id: string | null
}

type SSEListener = (eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => void

interface SSEContextType {
  subscribe: (listener: SSEListener) => () => void
  isConnected: boolean
  isReconnecting: boolean
}

const SSEContext = createContext<SSEContextType | null>(null)

/** Cloud domain events resume from numeric outbox ids only. */
export function isCloudCursor(id: string): boolean {
  return /^\d+$/.test(id)
}

/**
 * Cloud domain events: `GET /api/events?ticket=…&lastEventId=…`.
 *
 * SECURITY: the stream is authenticated with a one-minute, single-use ticket
 * from `POST /api/events/ticket` (session auth, minted through `apiFetch` so
 * an expired access token is refreshed first). JWTs are never put in a URL.
 */
export async function prepareCloudStream(cursor: string | null): Promise<EventStreamRequest | null> {
  if (!getAuthToken()) return null
  let ticket: string | undefined
  try {
    ticket = (await apiFetch<{ ticket?: string }>('/api/events/ticket', { method: 'POST' }))?.ticket
  } catch {
    return null
  }
  if (!ticket) return null
  const url = new URL(`${getCloudApiUrl()}/api/events`)
  url.searchParams.set('ticket', ticket)
  if (cursor) url.searchParams.set('lastEventId', cursor)
  return { url: url.toString() }
}

/**
 * Local execution events from the sidecar: `GET /api/events` with the cloud
 * access token as a bearer header (the sidecar validates it) and the last
 * execution event id as `Last-Event-ID`.
 */
export async function prepareLocalStream(cursor: string | null): Promise<EventStreamRequest | null> {
  const token = getAuthToken()
  if (!token) return null
  const base = await resolveApiBaseUrl('sidecar')
  return {
    url: `${base}/api/events`,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(cursor ? { 'Last-Event-ID': cursor } : {}),
    },
  }
}

/**
 * Desktop always runs a sidecar. A web build talks to one only when it was
 * configured with NEXT_PUBLIC_SIDECAR_URL (local development); otherwise a
 * browser tab would keep probing 127.0.0.1 for a server that is not there.
 */
export function shouldOpenLocalStream(): boolean {
  return isDesktopRuntime() || Boolean(process.env.NEXT_PUBLIC_SIDECAR_URL)
}

/** Decode one stream message into a typed event, or null to ignore it. */
export function decodeStreamMessage(message: StreamMessage): { type: SSEEventType; data: SSEEventData } | null {
  let data: unknown
  try {
    data = JSON.parse(message.data)
  } catch {
    console.error(`[SSE Provider] Failed to parse ${message.type} from ${message.stream} stream`)
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const payload = data as SSEEventData
  if (message.type === 'connected' || (message.type === 'message' && payload.type === 'connected')) {
    return { type: 'connected', data: payload }
  }
  if (!KNOWN_EVENT_TYPES.has(message.type)) return null
  return { type: message.type as SSEEventType, data: payload }
}

export function SSEProvider({
  children,
  backoffMs,
}: {
  children: ReactNode
  /** Reconnect delay override (tests); defaults to capped exponential backoff with jitter. */
  backoffMs?: (attempt: number) => number
}) {
  const { isAuthenticated } = useAuth()
  const listenersRef = useRef<Set<SSEListener>>(new Set())
  const [streamStates, setStreamStates] = useState<Partial<Record<EventStreamName, EventStreamState>>>({})

  const broadcast = useCallback((eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => {
    listenersRef.current.forEach((listener) => {
      try {
        listener(eventType, data, meta)
      } catch (err) {
        console.error("[SSE Provider] Listener error:", err)
      }
    })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return

    const recentIds = new RecentEventIds()
    const onMessage = (message: StreamMessage) => {
      // A replay after reconnect can resend events; deliver each (stream, id) once.
      if (message.id && !recentIds.firstSighting(message.stream, message.id)) return
      const decoded = decodeStreamMessage(message)
      if (decoded) broadcast(decoded.type, decoded.data, { stream: message.stream, id: message.id })
    }
    const onStateChange = (stream: EventStreamName) => (state: EventStreamState) => {
      setStreamStates((prev) => (prev[stream] === state ? prev : { ...prev, [stream]: state }))
      if (process.env.NODE_ENV === 'development' && state === 'reconnecting') {
        console.log(`[SSE Provider] ${stream} stream reconnecting`)
      }
    }

    const connections = [
      new EventStreamConnection({
        name: 'cloud',
        prepare: prepareCloudStream,
        isCursor: isCloudCursor,
        onMessage,
        onStateChange: onStateChange('cloud'),
        backoffMs,
      }),
    ]
    if (shouldOpenLocalStream()) {
      connections.push(
        new EventStreamConnection({
          name: 'local',
          prepare: prepareLocalStream,
          onUnauthorized: refreshAccessToken,
          onMessage,
          onStateChange: onStateChange('local'),
          backoffMs,
        }),
      )
    }

    connections.forEach((connection) => connection.start())
    return () => {
      connections.forEach((connection) => connection.stop())
      setStreamStates({})
    }
  }, [isAuthenticated, broadcast, backoffMs])

  const subscribe = useCallback((listener: SSEListener) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const states = Object.values(streamStates)
  const connectedCount = states.filter((state) => state === 'open').length
  const reconnectingCount = states.filter((state) => state === 'reconnecting').length

  return (
    <SSEContext.Provider
      value={{
        subscribe,
        isConnected: connectedCount > 0,
        isReconnecting: connectedCount === 0 && reconnectingCount > 0,
      }}
    >
      {children}
    </SSEContext.Provider>
  )
}

export function useSSESubscription(
  onEvent: (eventType: SSEEventType, data: SSEEventData, meta: SSEEventMeta) => void
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
    return subscribe((eventType, data, meta) => onEventRef.current(eventType, data, meta))
  }, [subscribe])
}

export function useSSEStatus() {
  const context = useContext(SSEContext)
  if (!context) {
    throw new Error("useSSEStatus must be used within an SSEProvider")
  }
  return { isConnected: context.isConnected, isReconnecting: context.isReconnecting }
}
