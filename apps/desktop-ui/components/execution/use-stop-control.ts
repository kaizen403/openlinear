"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "@/lib/api/fetch"
import { describeApiError } from "@/lib/api/errors"

/**
 * Stop is a request, not a fact (W01): the sidecar answers 200 only after the
 * provider confirmed the abort, and a 4xx leaves the run reserved with its
 * work retained. The control therefore reports what actually happened:
 *
 * - `requested`   the HTTP call is in flight ("Stop requested…")
 * - `stopped`     the service confirmed the agent stopped
 * - `unconfirmed` the stop was rejected or couldn't be confirmed → Retry stop
 * - `not_running` the run had already finished
 */
export type StopStatus = "idle" | "requested" | "stopped" | "unconfirmed" | "not_running"

export interface StopState {
  status: StopStatus
  message: string | null
  hint: string | null
}

export const STOP_COPY: Readonly<Record<StopStatus, { label: string; message: string | null }>> = {
  idle: { label: "Stop", message: null },
  requested: { label: "Stopping…", message: "Stop requested — waiting for the agent to confirm." },
  stopped: { label: "Stopped", message: "Stopped — the agent confirmed it stopped." },
  unconfirmed: { label: "Retry stop", message: "Stop unconfirmed — the agent may still be running. Work is retained." },
  not_running: { label: "Stop", message: "The run had already finished." },
}

const IDLE: StopState = { status: "idle", message: null, hint: null }

function isNotRunning(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "TASK_NOT_RUNNING" || /\bnot running\b/i.test(error.message))
}

export interface UseStopControlOptions {
  /**
   * Sends the stop. Resolve `false` when it wasn't accepted (the board's
   * contract), or reject with the API error for precise copy.
   */
  onStop?: (() => unknown) | null
  /** Was the run already over when the stop was sent? Used when `onStop` only reports `false`. */
  wasRunFinished?: () => boolean
  /** Changing this (e.g. a new attempt) clears the last outcome. */
  resetKey?: unknown
}

export function useStopControl({ onStop, wasRunFinished, resetKey }: UseStopControlOptions) {
  const [state, setState] = useState<StopState>(IDLE)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop
  const finishedRef = useRef(wasRunFinished)
  finishedRef.current = wasRunFinished

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger (a new task or attempt clears the last outcome).
  useEffect(() => {
    if (!inFlight.current) setState(IDLE)
  }, [resetKey])

  const request = useCallback(() => {
    const send = onStopRef.current
    if (!send || inFlight.current) return
    inFlight.current = true
    const finishedBefore = finishedRef.current?.() ?? false
    setState({ status: "requested", message: STOP_COPY.requested.message, hint: null })
    let sent: unknown
    try {
      sent = send()
    } catch (error) {
      sent = Promise.reject(error)
    }
    Promise.resolve(sent)
      .then((result) => {
        if (!mounted.current) return
        if (result === false) {
          setState(
            finishedBefore
              ? { status: "not_running", message: STOP_COPY.not_running.message, hint: null }
              : { status: "unconfirmed", message: STOP_COPY.unconfirmed.message, hint: "Retry the stop. If it keeps failing, inspect the retained branch before running again." },
          )
          return
        }
        setState({ status: "stopped", message: STOP_COPY.stopped.message, hint: null })
      })
      .catch((error: unknown) => {
        if (!mounted.current) return
        if (isNotRunning(error)) {
          setState({ status: "not_running", message: STOP_COPY.not_running.message, hint: null })
          return
        }
        const described = describeApiError(error, "The stop request couldn't be confirmed.")
        setState({
          status: "unconfirmed",
          message: `Stop unconfirmed — ${described.message.replace(/\.$/, "")}.`,
          hint: described.hint ?? "Retry the stop. Work is retained.",
        })
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [])

  const dismiss = useCallback(() => {
    if (!inFlight.current) setState(IDLE)
  }, [])

  return { state, request, dismiss, canStop: Boolean(onStop) }
}
