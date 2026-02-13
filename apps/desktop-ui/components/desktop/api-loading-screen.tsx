"use client"

import * as React from "react"
import { Loader2, RefreshCw, Server, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ApiLoadingScreenProps {
  onReady: () => void
  onError?: (error: string) => void
}

import { API_URL } from "@/lib/api/client"

const HEALTH_ENDPOINT = `${API_URL}/health`
const POLL_INTERVAL = 500
const TIMEOUT_MS = 30000

export function ApiLoadingScreen({ onReady, onError }: ApiLoadingScreenProps) {
  const [status, setStatus] = React.useState<"loading" | "error">("loading")
  const [dots, setDots] = React.useState(0)
  const [elapsedTime, setElapsedTime] = React.useState(0)
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const intervalRef = React.useRef<NodeJS.Timeout | null>(null)
  const dotsRef = React.useRef<NodeJS.Timeout | null>(null)
  const elapsedRef = React.useRef<NodeJS.Timeout | null>(null)

  const clearAllTimers = React.useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (dotsRef.current) {
      clearInterval(dotsRef.current)
      dotsRef.current = null
    }
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current)
      elapsedRef.current = null
    }
  }, [])

  const checkHealth = React.useCallback(async () => {
    try {
      const response = await fetch(HEALTH_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
      })

      if (response.ok) {
        const data = await response.json()
        if (data.status === "ok") {
          clearAllTimers()
          onReady()
          return true
        }
      }
    } catch {
      // Errors are expected while server starts
    }
    return false
  }, [onReady, clearAllTimers])

  const startPolling = React.useCallback(() => {
    clearAllTimers()
    setStatus("loading")
    setDots(0)
    setElapsedTime(0)

    intervalRef.current = setInterval(async () => {
      const isReady = await checkHealth()
      if (isReady) {
        clearAllTimers()
      }
    }, POLL_INTERVAL)

    dotsRef.current = setInterval(() => {
      setDots((prev) => (prev + 1) % 4)
    }, 500)

    elapsedRef.current = setInterval(() => {
      setElapsedTime((prev) => prev + 100)
    }, 100)

    timeoutRef.current = setTimeout(() => {
      clearAllTimers()
      setStatus("error")
      if (onError) {
        onError("Server failed to start within 30 seconds")
      }
    }, TIMEOUT_MS)
  }, [checkHealth, clearAllTimers, onError])

  React.useEffect(() => {
    startPolling()

    return () => {
      clearAllTimers()
    }
  }, [startPolling, clearAllTimers])

  const handleRetry = () => {
    startPolling()
  }

  const formatElapsedTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const tenths = Math.floor((ms % 1000) / 100)
    return `${seconds}.${tenths}s`
  }

  if (status === "error") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-linear-bg">
        <div className="flex flex-col items-center gap-6 px-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
            <AlertCircle className="h-8 w-8 text-red-500" />
          </div>

          <div className="text-center">
            <h2 className="text-lg font-semibold text-linear-text">
              Server failed to start
            </h2>
            <p className="mt-2 text-sm text-linear-text-secondary">
              The API server did not respond within 30 seconds.
            </p>
          </div>

          <Button onClick={handleRetry} variant="outline" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-linear-bg">
      <div className="flex flex-col items-center gap-6 px-4">
        <div className="relative">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-linear-accent/10">
            <Server className="h-8 w-8 text-linear-accent" />
          </div>
          <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-linear-bg">
            <Loader2 className="h-4 w-4 animate-spin text-linear-accent" />
          </div>
        </div>

        <div className="text-center">
          <h2 className="text-lg font-semibold text-linear-text">
            Starting API server{" ".repeat(dots).replace(/ /g, "\u00A0")}
          </h2>
          <p className="mt-2 text-sm text-linear-text-secondary">
            Waiting for backend to become ready...
          </p>
          <p className="mt-1 text-xs text-linear-text-tertiary font-mono">
            {formatElapsedTime(elapsedTime)} / 30.0s
          </p>
        </div>

        <div className="w-48 h-1 bg-linear-border rounded-full overflow-hidden">
          <div
            className="h-full bg-linear-accent transition-all duration-100 ease-linear"
            style={{
              width: `${Math.min((elapsedTime / TIMEOUT_MS) * 100, 100)}%`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
