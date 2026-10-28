"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ApiError } from "@/lib/api/fetch"
import {
  fetchTaskDiff,
  fetchTaskRunState,
  sendTaskFollowUp,
  type FollowUpResponse,
  type TaskDiffResponse,
  type TaskRunState,
} from "@/lib/api/review"
import { queryKeys } from "@/lib/query/keys"
import { queryRetryDelay, shouldRetryQuery } from "@/lib/query/client"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { useSSESubscription, type SSEEventData, type SSEEventType } from "@/providers/sse-provider"
import { normalizeRunState, normalizeTaskDiff } from "./model/normalize"
import {
  applyDraftAction,
  browserDraftStorage,
  draftStorageKey,
  loadDrafts,
  saveDrafts,
  type DraftAction,
  type DraftStorage,
  type ReviewDraftState,
} from "./model/drafts"
import type { FollowUpPlan } from "./model/follow-up"
import { isRouteMissing } from "./review-errors"

/** How often the diff refreshes while the agent is working (the response is cached by revision). */
export const DIFF_POLL_MS = 4_000
const RUN_STATE_POLL_MS = 5_000

function retryReview(failureCount: number, error: unknown): boolean {
  return shouldRetryQuery(failureCount, error) && !isRouteMissing(error)
}

/** Keep the cached object (and every memo downstream) when a refetch returns the same content. */
function keepSameRevision(previous: unknown, next: unknown): unknown {
  const a = previous as TaskDiffResponse | undefined
  const b = next as TaskDiffResponse
  return a && b && a.revision === b.revision && a.head.sha === b.head.sha && a.base.sha === b.base.sha ? a : b
}

/** Statuses after which the worktree content changes or settles. */
const DIFF_REFRESH_STATUSES = new Set(["cloning", "committing", "creating_pr", "done", "error", "cancelled"])

export interface UseTaskDiffOptions {
  taskId: string
  base: string | null
  /** The agent is working: poll for a live diff. */
  live: boolean
  enabled?: boolean
}

export function useTaskDiff({ taskId, base, live, enabled = true }: UseTaskDiffOptions) {
  const client = useAppQueryClient()
  const query = useQuery(
    {
      queryKey: queryKeys.tasks.diff(taskId, base),
      queryFn: async ({ signal }) => normalizeTaskDiff(await fetchTaskDiff(taskId, { base, signal })),
      enabled,
      staleTime: live ? 0 : 15_000,
      refetchInterval: live ? DIFF_POLL_MS : false,
      refetchIntervalInBackground: false,
      retry: retryReview,
      retryDelay: queryRetryDelay,
      structuralSharing: keepSameRevision,
    },
    client,
  )

  // Run boundaries change (or settle) the worktree: refresh the diff and the
  // run state. A new attempt may also live in a new worktree.
  const onEvent = useCallback(
    (eventType: SSEEventType, data: SSEEventData) => {
      if (data.taskId !== taskId) return
      const status = typeof data.status === "string" ? data.status : null
      const runState = typeof data.runState === "string" ? data.runState : null
      const relevant =
        (eventType === "execution:progress" && ((status !== null && DIFF_REFRESH_STATUSES.has(status)) || runState !== null)) ||
        (eventType === "task:updated" && (data.status === "done" || data.status === "cancelled"))
      if (!relevant) return
      void client.invalidateQueries({ queryKey: queryKeys.tasks.diffs(taskId) }, { cancelRefetch: false })
      void client.invalidateQueries({ queryKey: queryKeys.tasks.runState(taskId) }, { cancelRefetch: false })
    },
    [client, taskId],
  )
  useSSESubscription(onEvent)

  return query
}

/** v2 run state, or null when this device has no v2 run for the task (legacy engine, older sidecar). */
export function useTaskRunState(taskId: string, live: boolean, enabled = true) {
  const client = useAppQueryClient()
  return useQuery<TaskRunState | null>(
    {
      queryKey: queryKeys.tasks.runState(taskId),
      queryFn: async () => {
        try {
          return normalizeRunState(await fetchTaskRunState(taskId))
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        }
      },
      enabled,
      staleTime: live ? 0 : 10_000,
      refetchInterval: live ? RUN_STATE_POLL_MS : false,
      retry: retryReview,
      retryDelay: queryRetryDelay,
    },
    client,
  )
}

/**
 * Drafts for one task, persisted to localStorage on every change and synced
 * from other windows (`storage` events). `persisted` is false when the
 * browser refused the write (quota, privacy mode) — drafts then live only in
 * memory, and the composer says so.
 */
export function useReviewDrafts(taskId: string, storage: DraftStorage | null = browserDraftStorage()) {
  const storageRef = useRef(storage)
  storageRef.current = storage
  const [state, setState] = useState(() => ({ taskId, drafts: loadDrafts(taskId, storage) }))
  const savedRef = useRef<ReviewDraftState>(state.drafts)
  const [persisted, setPersisted] = useState(true)

  let current = state
  if (state.taskId !== taskId) {
    // Switched task without a remount: read its drafts before rendering (render-phase update of own state).
    current = { taskId, drafts: loadDrafts(taskId, storage) }
    savedRef.current = current.drafts
    setState(current)
  }

  useEffect(() => {
    if (state.drafts === savedRef.current) return
    savedRef.current = state.drafts
    setPersisted(saveDrafts(state.taskId, state.drafts, storageRef.current))
  }, [state])

  useEffect(() => {
    if (typeof window === "undefined") return
    const key = draftStorageKey(taskId)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      const drafts = loadDrafts(taskId, storageRef.current)
      savedRef.current = drafts
      setState({ taskId, drafts })
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [taskId])

  const dispatch = useCallback((action: DraftAction) => {
    setState((previous) => {
      const drafts = applyDraftAction(previous.drafts, action)
      return drafts === previous.drafts ? previous : { taskId: previous.taskId, drafts }
    })
  }, [])

  return { drafts: current.drafts, dispatch, persisted }
}

/**
 * Removes sent drafts from storage directly, so a follow-up that completes
 * after the panel unmounted (sheet closed, task switched) still clears them.
 */
export function forgetSentDrafts(taskId: string, commentIds: readonly string[], storage: DraftStorage | null = browserDraftStorage()): void {
  const stored = loadDrafts(taskId, storage)
  const next = applyDraftAction(stored, { type: "sent", commentIds, clearMessage: true })
  if (next !== stored) saveDrafts(taskId, next, storage)
}

export interface UseFollowUpOptions {
  taskId: string
  onSent: (plan: FollowUpPlan, response: FollowUpResponse) => void
}

/** Sends drafts to the agent. Never retried automatically: a retry is the user's decision. */
export function useFollowUp({ taskId, onSent }: UseFollowUpOptions) {
  const client = useAppQueryClient()
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent
  return useMutation(
    {
      mutationFn: (plan: FollowUpPlan) => sendTaskFollowUp(taskId, plan.request),
      onSuccess: (response, plan) => {
        onSentRef.current(plan, response)
        void client.invalidateQueries({ queryKey: queryKeys.tasks.runState(taskId) }, { cancelRefetch: false })
        void client.invalidateQueries({ queryKey: queryKeys.tasks.diffs(taskId) }, { cancelRefetch: false })
      },
      retry: false,
    },
    client,
  )
}
