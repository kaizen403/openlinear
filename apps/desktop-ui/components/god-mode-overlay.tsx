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
import { checkBrainstormAvailability, transcribeAudio } from "@/lib/api/brainstorm"

type OverlayState = "idle" | "pill"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

export function GodModeOverlay() {
  const [state, setState] = useState<OverlayState>("idle")
  const [query, setQuery] = useState("")
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [micSupported, setMicSupported] = useState(true)
  const [webSearchAvailable, setWebSearchAvailable] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  const showPill = state === "pill"

  useEffect(() => {
    if (showPill) {
      const timeout = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timeout)
    }
  }, [showPill])

  useEffect(() => {
    setMicSupported(!!navigator.mediaDevices?.getUserMedia)
    checkBrainstormAvailability()
      .then((res) => setWebSearchAvailable(res.webSearchAvailable ?? false))
      .catch(() => setWebSearchAvailable(false))
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setState("idle")
        setQuery("")
        setWebSearchEnabled(false)
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
          setWebSearchEnabled(false)
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
      setWebSearchEnabled(false)
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

              {webSearchAvailable && (
                <button
                  onClick={() => setWebSearchEnabled((prev) => !prev)}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                    webSearchEnabled
                      ? "text-blue-400 bg-blue-500/10"
                      : "text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]"
                  )}
                >
                  <Globe className="h-3.5 w-3.5" />
                </button>
              )}

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
                        const blob = new Blob(audioChunksRef.current, { type: mimeType })
                        try {
                          const result = await transcribeAudio(blob)
                          setQuery(result.text)
                        } catch {}
                        setIsRecording(false)
                      }
                      mediaRecorderRef.current = recorder
                      recorder.start()
                      setIsRecording(true)
                    } catch {
                      setMicSupported(false)
                    }
                  }
                }}
                disabled={!micSupported}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                  !micSupported && "opacity-40 cursor-not-allowed",
                  isRecording
                    ? "text-red-500 animate-pulse"
                    : "text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]"
                )}
              >
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
