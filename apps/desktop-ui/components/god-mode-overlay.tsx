"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { usePathname } from "next/navigation"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import {
  Plus,
  Mic,
  ArrowUp,
  Brain,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { transcribeChatAudio } from "@/lib/api/chat"
import { isWhisperHallucination } from "@/lib/audio-utils"
import { useChatPanelHandoff } from "@/hooks/use-chat-panel-handoff"

type OverlayState = "idle" | "pill"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

export function GodModeOverlay() {
  const pathname = usePathname()
  const isHomePage = pathname === "/" || pathname === ""
  const [state, setState] = useState<OverlayState>("idle")
  const [query, setQuery] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [micSupported, setMicSupported] = useState(true)
  const reduceMotion = useReducedMotion()
  const inputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef<number>(0)
  const { queueQuery } = useChatPanelHandoff()

  const showPill = state === "pill"

  useEffect(() => {
    if (showPill) {
      const timeout = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timeout)
    }
  }, [showPill])

  useEffect(() => {
    setMicSupported(!!navigator.mediaDevices?.getUserMedia)
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setState("idle")
        setQuery("")
        /* webSearchEnabled removed */
        return
      }

      const isMac = navigator.platform.toUpperCase().includes("MAC")
      // Cmd+K / Ctrl+K is owned by CommandPalette (T25); god-mode keeps Alt+Space on mac only.
      const isToggle = isMac && e.altKey && e.code === "Space"

      if (isToggle) {
        e.preventDefault()
        setState((prev) => (prev === "idle" ? "pill" : "idle"))
        if (state !== "idle") {
          setQuery("")
          /* webSearchEnabled removed */
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
      /* webSearchEnabled removed */
      return "idle"
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed) return

    queueQuery(trimmed)

    setState("idle")
    setQuery("")
    /* webSearchEnabled removed */
  }, [query, queueQuery])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  if (isHomePage) return null

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <motion.button
        onClick={togglePill}
        animate={state === "pill" || reduceMotion ? { scale: 1 } : { scale: [1, 1.05, 1] }}
        transition={
          state === "pill" || reduceMotion
            ? { duration: 0 }
            : { repeat: Infinity, duration: 2.4, ease: "easeInOut" }
        }
        className={cn(
          "pointer-events-auto",
          "fixed bottom-4 right-4 sm:bottom-6 sm:right-6",
          "flex items-center justify-center",
          "w-12 h-12 rounded-full",
          "bg-linear-bg-secondary/80 backdrop-blur-2xl border border-linear-border shadow-2xl",
          "cursor-pointer",
          "transition-colors duration-200",
          "hover:bg-linear-bg-tertiary/80"
        )}
        aria-label="Toggle God Mode"
      >
        <Brain className="w-5 h-5 text-linear-text-tertiary" />
      </motion.button>

      <AnimatePresence>
        {showPill && (
          <motion.div
            key="pill"
            initial={reduceMotion ? false : { y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: 100, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : SPRING}
            className={cn(
              "pointer-events-auto",
              "fixed bottom-12 inset-x-0 mx-auto",
              "w-[calc(100%-2rem)] sm:w-[600px] max-w-[600px] h-14 sm:h-16 rounded-full",
              "bg-linear-bg-secondary/80 backdrop-blur-2xl border border-linear-border shadow-2xl",
              "flex items-center gap-3 px-4"
            )}
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-linear-bg-tertiary">
              <Plus className="h-4 w-4 text-linear-text-tertiary" />
            </div>

            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              className={cn(
                "flex-1 bg-transparent text-lg text-linear-text",
                "placeholder:text-linear-text-tertiary",
                "outline-none border-none",
                "caret-linear-text-secondary"
              )}
            />

            <div className="flex items-center gap-2 border-l border-linear-border pl-3">
              <span className="text-[11px] font-medium tracking-wide text-linear-text-tertiary select-none">
                Brainstorm
              </span>

              <button
                onClick={async () => {
                  if (!micSupported) return
                  if (isRecording) {
                    mediaRecorderRef.current?.stop()
                  } else {
                    try {
                      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
                        ? "audio/webm"
                        : "audio/mp4"
                      const recorder = new MediaRecorder(stream, { mimeType })
                      audioChunksRef.current = []
                      recorder.ondataavailable = (e) => {
                        if (e.data.size > 0) audioChunksRef.current.push(e.data)
                      }
                      recorder.onstop = async () => {
                        stream.getTracks().forEach((t) => t.stop())
                        const duration = Date.now() - recordingStartRef.current
                        if (duration < 1000) {
                          setIsRecording(false)
                          return
                        }
                        const blob = new Blob(audioChunksRef.current, { type: mimeType })
                        if (blob.size < 1000) {
                          setIsRecording(false)
                          return
                        }
                        try {
                          const result = await transcribeChatAudio(blob)
                          const text = result.text?.trim()
                          if (text && !isWhisperHallucination(text)) {
                            setQuery(text)
                          }
                        } catch {}
                        setIsRecording(false)
                      }
                      mediaRecorderRef.current = recorder
                      recordingStartRef.current = Date.now()
                      recorder.start()
                      setIsRecording(true)
                    } catch {
                      setMicSupported(false)
                    }
                  }
                }}
                disabled={!micSupported}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-sm transition-colors",
                  !micSupported && "opacity-40 cursor-not-allowed",
                  isRecording
                    ? "text-red-500 animate-pulse"
                    : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary"
                )}
              >
                <Mic className="h-3.5 w-3.5" />
              </button>

              <button
                onClick={handleSubmit}
                className={cn(
                  "flex items-center justify-center",
                  "w-8 h-8 rounded-full",
                  "bg-linear-bg-tertiary hover:bg-linear-border",
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
