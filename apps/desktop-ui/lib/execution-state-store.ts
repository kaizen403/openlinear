"use client"

import { useCallback, useSyncExternalStore } from "react"
import type { ExecutionLogEntry, ExecutionProgress } from "@/types/task"

const MAX_LOGS_PER_TASK = 2_000
const EMPTY_LOGS: ExecutionLogEntry[] = []

type Listener = () => void

const logsByTaskId = new Map<string, ExecutionLogEntry[]>()
const progressByTaskId = new Map<string, ExecutionProgress>()
const logListenersByTaskId = new Map<string, Set<Listener>>()
const progressListenersByTaskId = new Map<string, Set<Listener>>()
const pendingLogTaskIds = new Set<string>()
const pendingProgressTaskIds = new Set<string>()

let notifyScheduled = false

function getListeners(
  listenersByTaskId: Map<string, Set<Listener>>,
  taskId: string,
): Set<Listener> {
  let listeners = listenersByTaskId.get(taskId)
  if (!listeners) {
    listeners = new Set()
    listenersByTaskId.set(taskId, listeners)
  }
  return listeners
}

function notifyListeners(
  listenersByTaskId: Map<string, Set<Listener>>,
  taskId: string,
) {
  const listeners = listenersByTaskId.get(taskId)
  if (!listeners) return
  listeners.forEach((listener) => listener())
}

function flushNotifications() {
  notifyScheduled = false

  const logTaskIds = Array.from(pendingLogTaskIds)
  const progressTaskIds = Array.from(pendingProgressTaskIds)
  pendingLogTaskIds.clear()
  pendingProgressTaskIds.clear()

  logTaskIds.forEach((taskId) => notifyListeners(logListenersByTaskId, taskId))
  progressTaskIds.forEach((taskId) => notifyListeners(progressListenersByTaskId, taskId))
}

function scheduleNotification(kind: "logs" | "progress", taskId: string) {
  if (kind === "logs") pendingLogTaskIds.add(taskId)
  else pendingProgressTaskIds.add(taskId)

  if (notifyScheduled) return
  notifyScheduled = true

  if (typeof window !== "undefined" && "requestAnimationFrame" in window) {
    window.requestAnimationFrame(flushNotifications)
    return
  }

  setTimeout(flushNotifications, 16)
}

function trimLogs(logs: ExecutionLogEntry[]) {
  if (logs.length <= MAX_LOGS_PER_TASK) return logs
  return logs.slice(logs.length - MAX_LOGS_PER_TASK)
}

export function appendExecutionLog(taskId: string, entry: ExecutionLogEntry) {
  const current = logsByTaskId.get(taskId) ?? EMPTY_LOGS
  logsByTaskId.set(taskId, trimLogs([...current, entry]))
  scheduleNotification("logs", taskId)
}

export function replaceExecutionLogs(taskId: string, logs: ExecutionLogEntry[]) {
  logsByTaskId.set(taskId, trimLogs(logs))
  scheduleNotification("logs", taskId)
}

export function hasExecutionLogs(taskId: string): boolean {
  return logsByTaskId.has(taskId)
}

export function getExecutionProgress(taskId: string): ExecutionProgress | undefined {
  return progressByTaskId.get(taskId)
}

export function setExecutionProgress(progress: ExecutionProgress) {
  const previous = progressByTaskId.get(progress.taskId)
  if (
    previous &&
    previous.status === progress.status &&
    previous.message === progress.message &&
    previous.prUrl === progress.prUrl &&
    previous.isCompareLink === progress.isCompareLink
  ) {
    return
  }

  progressByTaskId.set(progress.taskId, progress)
  scheduleNotification("progress", progress.taskId)
}

export function clearExecutionProgress(taskId: string) {
  if (!progressByTaskId.has(taskId)) return
  progressByTaskId.delete(taskId)
  scheduleNotification("progress", taskId)
}

export function useExecutionLogs(taskId: string | null | undefined) {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!taskId) return () => {}

      const listeners = getListeners(logListenersByTaskId, taskId)
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          logListenersByTaskId.delete(taskId)
        }
      }
    },
    [taskId],
  )

  const getSnapshot = useCallback(() => {
    if (!taskId) return EMPTY_LOGS
    return logsByTaskId.get(taskId) ?? EMPTY_LOGS
  }, [taskId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useExecutionProgress(taskId: string | null | undefined) {
  const subscribe = useCallback(
    (listener: Listener) => {
      if (!taskId) return () => {}

      const listeners = getListeners(progressListenersByTaskId, taskId)
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          progressListenersByTaskId.delete(taskId)
        }
      }
    },
    [taskId],
  )

  const getSnapshot = useCallback(() => {
    if (!taskId) return undefined
    return progressByTaskId.get(taskId)
  }, [taskId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
