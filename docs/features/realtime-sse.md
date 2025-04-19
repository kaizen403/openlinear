# Real-Time Server-Sent Events (SSE)

## Overview

OpenLinear uses Server-Sent Events (SSE) to push live updates from the API server to the desktop UI. Every mutation that matters — task changes, execution progress, batch lifecycle, permission requests — gets broadcast over a persistent HTTP connection. The client never polls; it listens.

SSE was chosen over WebSockets because the communication is one-directional (server to client), and SSE works natively in browsers without extra libraries.

---

## Key Files

| File | Role |
|------|------|
| `apps/api/src/sse.ts` | Server-side client registry and broadcast helpers |
| `apps/desktop-ui/hooks/use-sse.ts` | Low-level React hook wrapping `EventSource` |
| `apps/desktop-ui/providers/sse-provider.tsx` | App-wide provider with pub/sub, reconnection, and auth gating |

---

## Architecture

```
API Server (Express)
  └── GET /api/events
        └── registers SSEClient in clients Map
              │
              │  SSE stream (text/event-stream)
              ▼
        SSEProvider (React context)
              │
              │  pub/sub via listenersRef Set
              ▼
        useSSESubscription() consumers
        (task list, execution panel, inbox count, etc.)
```

The server holds a `Map<string, SSEClient>` in memory. When any route mutates data, it calls `broadcast()` or `sendToClient()` to push an event to all connected clients.

---

## Server Implementation

**File:** `apps/api/src/sse.ts`

```typescript
export interface SSEClient {
  id: string;
  res: Response;
}

export const clients: Map<string, SSEClient> = new Map();
```

The `clients` map is a module-level singleton. Each connected browser tab gets an entry keyed by a generated client ID.

### `broadcast(event, data)`

Iterates every registered client and writes the SSE-formatted message to the response stream. It skips clients whose response stream has already ended (`writableEnded`).

```typescript
export function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  clients.forEach((client) => {
    if (!client.res.writableEnded) {
      client.res.write(message);
    }
  });
}
```

Execution events (`execution:*`) get an extra console log showing how many clients received the message.

### `sendToClient(clientId, event, data)`

Targets a single client by ID. Returns `true` if the message was delivered, `false` if the client was not found or its stream had ended.

### SSE Endpoint

The `/api/events` endpoint (referenced as `SSE_URL` in the provider) sets the required headers and registers the client:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

On connection close, the client is removed from the `clients` map.

---

## Client Hook: `useSSE`

**File:** `apps/desktop-ui/hooks/use-sse.ts`

A lower-level hook that wraps the browser's `EventSource` API. It's used directly in contexts where a single component needs SSE without the full provider.

### Connection lifecycle

1. Creates an `EventSource` pointing at the given URL.
2. Registers named event listeners for every `SSEEventType`.
3. On `onerror`, closes the current connection and schedules a reconnect after `SSE_RECONNECT_DELAY` (3000 ms).
4. On unmount, closes the `EventSource` and cancels any pending reconnect timer.

```typescript
const SSE_RECONNECT_DELAY = 3000

eventSource.onerror = () => {
  eventSource.close()
  reconnectTimeoutRef.current = setTimeout(() => {
    connect()
  }, SSE_RECONNECT_DELAY)
}
```

The `onEvent` callback is stored in a ref (`onEventRef`) so the event listeners never go stale when the parent component re-renders.

### Supported event types

```typescript
export type SSEEventType =
  | 'connected'
  | 'task:created' | 'task:updated' | 'task:deleted'
  | 'label:created' | 'label:updated' | 'label:deleted'
  | 'settings:updated'
  | 'execution:progress' | 'execution:log'
  | 'batch:created' | 'batch:started'
  | 'batch:task:started' | 'batch:task:completed'
  | 'batch:task:failed' | 'batch:task:skipped' | 'batch:task:cancelled'
  | 'batch:merging' | 'batch:completed' | 'batch:failed' | 'batch:cancelled'
  | 'permission:requested' | 'permission:resolved'
  | 'team:created' | 'team:updated' | 'team:deleted'
  | 'project:created' | 'project:updated' | 'project:deleted'
```

---

## App-Wide Provider: `SSEProvider`

**File:** `apps/desktop-ui/providers/sse-provider.tsx`

The provider is the recommended way to consume SSE in the UI. It maintains a single `EventSource` connection for the entire app and distributes events to subscribers via an in-memory pub/sub pattern.

### Why a provider instead of multiple hooks?

Each `useSSE` call would open its own `EventSource` connection. With a provider, the app opens exactly one connection regardless of how many components subscribe.

### Connection URL

```typescript
const SSE_URL = `${API_URL}/api/events`
```

`API_URL` comes from `apps/desktop-ui/lib/api/client.ts` and points to the local sidecar API server (default `http://localhost:3001`).

### Auth gating

The provider checks `isAuthenticated` from `useAuth()` before connecting. If the user is not authenticated, no connection is attempted.

```typescript
const connect = useCallback(() => {
  if (!isAuthenticated) return
  // ...
}, [broadcast, isAuthenticated])
```

### Pub/sub pattern

Subscribers register a listener function. The provider stores all listeners in a `Set` held in a ref (not state, to avoid re-renders).

```typescript
const subscribe = useCallback((listener: SSEListener) => {
  listenersRef.current.add(listener)
  return () => {
    listenersRef.current.delete(listener)
  }
}, [])
```

`useSSESubscription()` is the consumer hook:

```typescript
export function useSSESubscription(
  onEvent: (eventType: SSEEventType, data: SSEEventData) => void
) {
  const { subscribe } = useContext(SSEContext)
  // ...
  useEffect(() => {
    return subscribe((eventType, data) => onEventRef.current(eventType, data))
  }, [subscribe])
}
```

### Reconnection strategy

The provider uses a fixed 3-second delay between reconnect attempts. A `retryCountRef` tracks how many consecutive failures have occurred (logged but not used for backoff — reconnects always happen at 3 s).

### Network and focus recovery

Beyond the `onerror` reconnect, the provider also reconnects when:

- The browser comes back online (`window` `online` event)
- The window regains focus (`window` `focus` event)

```typescript
window.addEventListener("online", handleResume)
window.addEventListener("focus", handleResume)
```

This covers the case where the desktop app was backgrounded or the machine woke from sleep.

---

## Event Data Shape

All events share the `SSEEventData` interface:

```typescript
export interface SSEEventData {
  type?: string
  clientId?: string
  id?: string
  title?: string
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled'
  priority?: 'low' | 'medium' | 'high'
  sessionId?: string | null
  executionProgress?: number | null
  prUrl?: string | null
  outcome?: string | null
  batchId?: string | null
  inboxRead?: boolean
  tasks?: Array<{ taskId: string; title: string; status: string }>
  permission?: { id: string; type: string; title: string; pattern: string }
  // ... more fields
}
```

Not every field is present on every event. Consumers should check for the fields they care about.

---

## Data Flow: Task Update Example

1. A route handler updates a task in the database.
2. It calls `broadcast('task:updated', updatedTask)`.
3. The server writes `event: task:updated\ndata: {...}\n\n` to every open SSE response stream.
4. The browser's `EventSource` fires the `task:updated` named event.
5. `SSEProvider` receives it and calls every registered listener.
6. Components subscribed via `useSSESubscription` update their local state.

---

## Settings Updates via SSE

When settings change, the settings route broadcasts immediately after the database write:

```typescript
// apps/api/src/routes/settings.ts
broadcast('settings:updated', settings);
```

The UI receives `settings:updated` and can refresh its local settings cache without a manual refetch.
