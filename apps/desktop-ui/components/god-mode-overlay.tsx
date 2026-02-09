"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Plus,
  Globe,
  Mic,
  ArrowUp,
  Brain,
} from "lucide-react"
import { cn } from "@/lib/utils"

type OverlayState = "idle" | "pill"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

export function GodModeOverlay() {
  const [state, setState] = useState<OverlayState>("idle")
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const showPill = state === "pill"

  useEffect(() => {
    if (showPill) {
      const timeout = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timeout)
    }
  }, [showPill])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setState("idle")
        setQuery("")
        return
      }

      const isMac = navigator.platform.toUpperCase().includes("MAC")
      const isToggle = isMac
        ? e.altKey && e.code === "Space"
        : e.ctrlKey && e.key === "k"

      if (isToggle) {
        e.preventDefault()
        setState((prev) => (prev === "idle" ? "pill" : "idle"))
        if (state !== "idle") {
          setQuery("")
        }
      }
    }

    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [state])

  const togglePill = useCallback(() => {
    setState((prev) => {
      if (prev === "idle") return "pill"
      setQuery("")
      return "idle"
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed) return

    window.dispatchEvent(
      new CustomEvent("brainstorm-query", { detail: trimmed })
    )

    setState("idle")
    setQuery("")
  }, [query])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <motion.button
        onClick={togglePill}
        animate={{ scale: [1, 1.05, 1] }}
        transition={{
          repeat: Infinity,
          duration: 2.4,
          ease: "easeInOut",
        }}
        className={cn(
          "pointer-events-auto",
          "fixed bottom-4 right-4 sm:bottom-6 sm:right-6",
          "flex items-center justify-center",
          "w-12 h-12 rounded-full",
          "bg-zinc-950/80 backdrop-blur-2xl border border-white/10 shadow-2xl",
          "cursor-pointer",
          "transition-colors duration-200",
          "hover:bg-zinc-900/80"
        )}
        aria-label="Toggle God Mode"
      >
        <Brain className="w-5 h-5 text-zinc-400" />
      </motion.button>

      <AnimatePresence>
        {showPill && (
          <motion.div
            key="pill"
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={SPRING}
            className={cn(
              "pointer-events-auto",
              "fixed bottom-12 inset-x-0 mx-auto",
              "w-[calc(100%-2rem)] sm:w-[600px] max-w-[600px] h-14 sm:h-16 rounded-full",
              "bg-zinc-950/80 backdrop-blur-2xl border border-white/10 shadow-2xl",
              "flex items-center gap-3 px-4"
            )}
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
              <Plus className="h-4 w-4 text-zinc-500" />
            </div>

            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              className={cn(
                "flex-1 bg-transparent text-lg text-zinc-200",
                "placeholder:text-zinc-600",
                "outline-none border-none",
                "caret-zinc-400"
              )}
            />

            <div className="flex items-center gap-2 border-l border-white/[0.06] pl-3">
              <span className="text-[11px] font-medium tracking-wide text-zinc-600 select-none">
                Brainstorm
              </span>

              <button className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04] transition-colors">
                <Globe className="h-3.5 w-3.5" />
              </button>

              <button className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04] transition-colors">
                <Mic className="h-3.5 w-3.5" />
              </button>

              <button
                onClick={handleSubmit}
                className={cn(
                  "flex items-center justify-center",
                  "w-8 h-8 rounded-full",
                  "bg-white/[0.1] hover:bg-white/[0.15]",
                  "transition-colors duration-150"
                )}
              >
                <ArrowUp className="h-4 w-4 text-white" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
