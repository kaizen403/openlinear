"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import {
  Plus,
  X,
  Globe,
  Mic,
  Zap,
  FlaskConical,
  Loader2,
  Lock,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { checkBrainstormAvailability, generateBrainstormQuestions, streamBrainstormTasks, transcribeAudio, type BrainstormTask } from "@/lib/api/brainstorm"
import { useProject } from "@/hooks/use-project"
import { getApiUrl, getAuthHeader } from "@/lib/api/client"
import { ApiError } from "@/lib/api/fetch"
import { isWhisperHallucination } from "@/lib/audio-utils"
import { toast } from "sonner"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeneratedTask {
  id: string
  title: string
  description: string
  priority: "high" | "medium" | "low"
  selected: boolean
}

type BrainstormMode = "basic" | "pro"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

const PRIORITY_COLORS: Record<GeneratedTask["priority"], string> = {
  high: "border-red-700/40",
  medium: "border-yellow-700/40",
  low: "border-emerald-700/40",
}

const PRIORITY_DOTS: Record<GeneratedTask["priority"], string> = {
  high: "bg-red-700",
  medium: "bg-yellow-700",
  low: "bg-emerald-700",
}

const MIN_TASKS = 2
const MAX_TASKS = 15
const DEFAULT_TASKS = 5

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3 w-3 rounded-full border border-muted-foreground/30 border-t-linear-text-secondary animate-spin",
        className,
      )}
      aria-hidden
    />
  )
}

function SkeletonCard() {
  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
        <div className="h-3.5 w-3/4 rounded bg-linear-bg-tertiary animate-pulse" />
      </div>
      <div className="space-y-1.5 pl-3.5">
        <div className="h-2.5 w-full rounded bg-linear-bg-tertiary animate-pulse" />
        <div className="h-2.5 w-5/6 rounded bg-linear-bg-tertiary animate-pulse" />
      </div>
    </div>
  )
}

function TaskCard({
  task,
  onToggle,
}: {
  task: GeneratedTask
  onToggle: (id: string) => void
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.96, filter: "blur(6px)" }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
      }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.97, filter: "blur(4px)" }}
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 28 }}
      whileHover={reduceMotion ? undefined : { scale: 1.005 }}
      className={cn(
        "group relative rounded-sm border border-linear-border bg-linear-bg-secondary backdrop-blur-sm",
        "border-l-2",
        "transition-opacity hover:border-linear-border-hover",
        PRIORITY_COLORS[task.priority],
        !task.selected && "opacity-50"
      )}
    >
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={task.selected}
            onChange={() => onToggle(task.id)}
            className="mt-1 h-3.5 w-3.5 rounded border-linear-border bg-transparent accent-white cursor-pointer shrink-0"
          />
          <h4 className="text-[13px] font-medium leading-snug text-linear-text flex-1">
            {task.title}
          </h4>
        </div>

        <p className="pl-[22px] text-[11px] leading-relaxed text-linear-text-tertiary">
          {task.description}
        </p>

        <div className="flex items-center gap-1.5 pl-[22px]">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              PRIORITY_DOTS[task.priority]
            )}
          />
          <span className="text-[10px] font-medium uppercase tracking-wider text-linear-text-tertiary">
            {task.priority}
          </span>
        </div>
      </div>
    </motion.div>
  )
}

function ModeToggle({
  mode,
  onChange,
  proAvailable,
}: {
  mode: BrainstormMode
  onChange: (m: BrainstormMode) => void
  proAvailable: boolean
}) {
  return (
    <div className="flex items-center gap-1 rounded-sm bg-linear-bg-secondary border border-linear-border p-1">
      <button
        type="button"
        onClick={() => onChange("basic")}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] font-medium transition-colors",
          mode === "basic"
            ? "bg-linear-bg-tertiary text-linear-text"
            : "text-linear-text-tertiary hover:text-linear-text-secondary",
        )}
      >
        <Zap className="h-3 w-3" />
        Quick
      </button>
      <button
        type="button"
        onClick={() => proAvailable && onChange("pro")}
        disabled={!proAvailable}
        title={proAvailable ? "Deep Research" : "Deep Research not available"}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] font-medium transition-colors",
          mode === "pro"
            ? "bg-linear-bg-tertiary text-linear-text"
            : "text-linear-text-tertiary hover:text-linear-text-secondary",
          !proAvailable && "opacity-50 cursor-not-allowed hover:text-linear-text-tertiary",
        )}
      >
        {proAvailable ? (
          <FlaskConical className="h-3 w-3" />
        ) : (
          <Lock className="h-3 w-3" />
        )}
        Deep Research
      </button>
    </div>
  )
}

function ScopeSlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] text-linear-text-tertiary font-medium">Scope</label>
        <span className="text-[11px] text-linear-text-tertiary tabular-nums">~{value} tasks</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="text-[10px] text-muted-foreground/50 tabular-nums w-3 text-right">{MIN_TASKS}</span>
        <input
          type="range"
          min={MIN_TASKS}
          max={MAX_TASKS}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={cn(
            "flex-1 h-1 appearance-none rounded-full bg-linear-bg-tertiary outline-none cursor-pointer",
            "[&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3",
            "[&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-linear-text-secondary",
            "[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-linear-border",
            "[&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(255,255,255,0.04)]",
            "[&::-webkit-slider-thumb]:cursor-pointer",
            "[&::-webkit-slider-thumb]:transition-transform",
            "[&::-webkit-slider-thumb]:hover:scale-110",
            "[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3",
            "[&::-moz-range-thumb]:rounded-full",
            "[&::-moz-range-thumb]:bg-linear-text-secondary",
            "[&::-moz-range-thumb]:border-0",
            "[&::-moz-range-thumb]:cursor-pointer",
          )}
        />
        <span className="text-[10px] text-muted-foreground/50 tabular-nums w-5">{MAX_TASKS}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GlobalQuickCapture() {
  const [phase, setPhase] = useState<"ghost" | "input" | "questions" | "stream">("ghost")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [tasks, setTasks] = useState<GeneratedTask[]>([])
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [questionsLoading, setQuestionsLoading] = useState(false)
  const { activeProject } = useProject()
  const selectedProjectId = activeProject?.id ?? null
  const [inserting, setInserting] = useState(false)
  const [streamingDone, setStreamingDone] = useState(false)
  const [brainstormAvailable, setBrainstormAvailable] = useState<boolean | null>(null)
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [micSupported, setMicSupported] = useState(true)
  const [webSearchAvailable, setWebSearchAvailable] = useState(false)
  const [proAvailable, setProAvailable] = useState(false)
  const [mode, setMode] = useState<BrainstormMode>("basic")
  const [taskCount, setTaskCount] = useState<number>(DEFAULT_TASKS)
  const inputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef<number>(0)

  // Focus input when entering input/stream phase
  useEffect(() => {
    if (phase === "input" || phase === "stream") {
      const timeout = setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
      return () => clearTimeout(timeout)
    }
  }, [phase])

  // Check availability + fetch projects when panel opens
  useEffect(() => {
    if (phase === "input") {
      checkBrainstormAvailability()
        .then((result) => {
          setBrainstormAvailable(result.available)
          setWebSearchAvailable(result.webSearchAvailable ?? false)
          setProAvailable(result.proAvailable ?? false)
        })
        .catch(() => {
          setBrainstormAvailable(false)
          setWebSearchAvailable(false)
          setProAvailable(false)
        })
    }
  }, [phase])

  // Detect MediaRecorder support
  useEffect(() => {
    setMicSupported(!!navigator.mediaDevices?.getUserMedia)
  }, [])

  const handleClose = useCallback(() => {
    setPhase("ghost")
    setQuery("")
    setTasks([])
    setLoading(false)
    setQuestions([])
    setAnswers({})
    setQuestionsLoading(false)
    setInserting(false)
    setStreamingDone(false)
    setBrainstormAvailable(null)
    setWebSearchEnabled(false)
    setMode("basic")
    setTaskCount(DEFAULT_TASKS)
  }, [])

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        phase !== "ghost" &&
        sidebarRef.current &&
        !sidebarRef.current.contains(e.target as Node)
      ) {
        handleClose()
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [phase, handleClose])

  // Escape to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleClose()
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [handleClose])

  const startStreaming = useCallback(
    async (
      promptText: string,
      answersArray: { question: string; answer: string }[],
      streamMode: BrainstormMode,
    ) => {
      setStreamingDone(false)

      await streamBrainstormTasks(
        promptText,
        answersArray,
        (task: BrainstormTask) => {
          const generatedTask: GeneratedTask = {
            id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            title: task.title,
            description: task.description,
            priority: task.priority,
            selected: true,
          }
          setTasks((prev) => [...prev, generatedTask])
          setLoading(false)
        },
        () => {
          setLoading(false)
          setStreamingDone(true)
        },
        (error) => {
          console.error("Stream error:", error)
          setLoading(false)
          setStreamingDone(true)
        },
        {
          webSearch: webSearchEnabled,
          mode: streamMode,
          taskCount,
          projectId: selectedProjectId ?? undefined,
        },
      )
    },
    [webSearchEnabled, taskCount, selectedProjectId],
  )

  // Inbound: external brainstorm-query event (from god-mode)
  useEffect(() => {
    function handleBrainstorm(e: Event) {
      const raw = (e as CustomEvent).detail
      const parsed =
        typeof raw === "string"
          ? { query: raw, webSearch: false, mode: "basic" as BrainstormMode }
          : (raw as { query: string; webSearch: boolean; mode?: BrainstormMode })
      if (!parsed.query) return

      const incomingMode: BrainstormMode = parsed.mode ?? "basic"
      setQuery(parsed.query)
      setWebSearchEnabled(parsed.webSearch)
      setMode(incomingMode)
      setPhase("input")

      setTimeout(async () => {
        const availability = await checkBrainstormAvailability()
        if (!availability.available) return

        if (incomingMode === "basic") {
          setPhase("stream")
          setLoading(true)
          setTasks([])
          startStreaming(parsed.query, [], "basic")
          return
        }

        setQuestionsLoading(true)
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Questions generation timed out")), 30000),
          )
          const generatedQuestions = await Promise.race([
            generateBrainstormQuestions(parsed.query, parsed.webSearch, selectedProjectId ?? undefined),
            timeoutPromise,
          ])
          setQuestions(generatedQuestions)
          setAnswers({})
          setPhase("questions")
        } catch (err) {
          console.error("Failed to generate questions:", err)
        } finally {
          setQuestionsLoading(false)
        }
      }, 100)
    }

    window.addEventListener("brainstorm-query", handleBrainstorm)
    return () => window.removeEventListener("brainstorm-query", handleBrainstorm)
  }, [startStreaming, selectedProjectId])

  const handleGhostClick = useCallback(() => {
    setPhase("input")
  }, [])

  // Switching mode: if currently in questions phase and downgrading to basic, reset
  const handleModeChange = useCallback((next: BrainstormMode) => {
    setMode(next)
    if (next === "basic") {
      setQuestions([])
      setAnswers({})
      if (phase === "questions") {
        setPhase("input")
      }
    }
  }, [phase])

  const handleSubmit = useCallback(async () => {
    if (!query.trim()) return

    if (mode === "basic") {
      // Skip questions; stream directly.
      setPhase("stream")
      setLoading(true)
      setTasks([])
      await startStreaming(query, [], "basic")
      return
    }

    // Pro mode: generate clarifying questions first.
    setQuestionsLoading(true)
    try {
      const availability = await checkBrainstormAvailability()
      if (!availability.available) {
        setQuestionsLoading(false)
        return
      }
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Questions generation timed out")), 30000),
      )
      const generatedQuestions = await Promise.race([
        generateBrainstormQuestions(query, webSearchEnabled, selectedProjectId ?? undefined),
        timeoutPromise,
      ])
      setQuestions(generatedQuestions)
      setAnswers({})
      setPhase("questions")
    } catch (err) {
      console.error("Failed to generate questions:", err)
    } finally {
      setQuestionsLoading(false)
    }
  }, [query, mode, webSearchEnabled, selectedProjectId, startStreaming])

  const handleToggle = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t)),
    )
  }, [])

  const handleAddToProject = useCallback(async () => {
    if (!selectedProjectId) return
    const selectedTasks = tasks.filter((t) => t.selected)
    if (selectedTasks.length === 0) return

    setInserting(true)
    try {
      const results = await Promise.allSettled(
        selectedTasks.map(async (task) => {
          const res = await fetch(`${getApiUrl()}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeader() },
            body: JSON.stringify({
              title: task.title,
              description: task.description,
              priority: task.priority,
              projectId: selectedProjectId,
            }),
          })
          if (!res.ok) {
            let message = `HTTP ${res.status}`
            try {
              const body = (await res.json()) as { error?: string }
              if (body?.error) message = body.error
            } catch {
              // ignore parse errors
            }
            throw new Error(message)
          }
          return task
        }),
      )

      const succeeded = results.filter(
        (r: PromiseSettledResult<GeneratedTask>) => r.status === "fulfilled",
      ).length
      const failed = results.length - succeeded

      if (failed === 0) {
        toast.success(`Added ${succeeded} task${succeeded === 1 ? "" : "s"} to project`)
        handleClose()
        return
      }

      results.forEach((r: PromiseSettledResult<GeneratedTask>, idx: number) => {
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : "Unknown error"
          toast.error(`"${selectedTasks[idx]!.title}": ${reason}`)
        }
      })
      toast.error(
        `Added ${succeeded} of ${results.length} tasks. ${failed} failed — see details above.`,
      )
      setInserting(false)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not reach OpenLinear server."
      toast.error(`Failed to add tasks: ${msg}`)
      setInserting(false)
    }
  }, [tasks, selectedProjectId, handleClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  const selectedProject = activeProject

  // --------------------------------------------------
  // Render
  // --------------------------------------------------
  return (
    <>
      {/* ============================================= */}
      {/* GHOST TRIGGER                                 */}
      {/* ============================================= */}
      <AnimatePresence>
        {phase === "ghost" && (
          <motion.button
            key="ghost"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={handleGhostClick}
            aria-label="Open quick capture"
            className={cn(
              "fixed right-0 top-1/2 -translate-y-1/2 z-[9999]",
              "w-3 h-24",
              "bg-linear-bg-tertiary backdrop-blur-xl",
              "rounded-l-sm",
              "cursor-pointer",
              "hover:w-4 hover:bg-linear-bg-tertiary/80",
              "border-l border-t border-b border-linear-border",
              "shadow-[-4px_0_20px_rgba(0,0,0,0.4)]",
              "transition-all duration-300 ease-out",
            )}
          />
        )}
      </AnimatePresence>

      {/* ============================================= */}
      {/* SIDEBAR OVERLAY                               */}
      {/* ============================================= */}
      <AnimatePresence>
        {phase !== "ghost" && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[9998] bg-black/40"
            />

            <motion.div
              key="sidebar"
              ref={sidebarRef}
              initial={{ x: "100%", opacity: 0 }}
              animate={{
                x: 0,
                opacity: 1,
                width:
                  phase === "stream" || phase === "questions"
                    ? "min(400px, 100vw)"
                    : "min(380px, 100vw)",
              }}
              exit={{ x: "100%", opacity: 0 }}
              transition={SPRING}
              className={cn(
                "fixed right-0 top-0 z-[9999] h-full",
                "flex flex-col",
                "backdrop-blur-xl",
                "border-l border-linear-border",
                "shadow-[-8px_0_30px_rgba(0,0,0,0.5)]",
              )}
              style={{ backgroundColor: `${BRAND_COLORS.overlaySurface}cc` }}
            >
              {/* ---------- Top bar ---------- */}
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[20px] font-semibold tracking-tight bg-gradient-to-r from-white via-white to-linear-text-tertiary bg-clip-text text-transparent">
                    Brainstorm
                  </span>
                  <span className="text-[14px] text-linear-text-tertiary font-light tracking-wide">
                    by
                  </span>
                  <span className="text-[14px] font-medium tracking-wider text-linear-text-tertiary uppercase">
                    OpenLinear
                  </span>
                </div>
                <button
                  onClick={handleClose}
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary transition-colors"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* ---------- Divider ---------- */}
              {(phase === "stream" || phase === "questions") && (
                <motion.div
                  initial={{ opacity: 0, scaleX: 0 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={{ ...SPRING, delay: 0.1 }}
                  className="mx-4 h-px bg-gradient-to-r from-transparent via-linear-border to-transparent"
                />
              )}

              {/* ---------- Body ---------- */}
              <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6">
                <AnimatePresence mode="wait">
                  {/* ============= INPUT PHASE ============= */}
                  {phase === "input" && (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ ...SPRING, delay: 0.05 }}
                      className="flex flex-col px-1 space-y-5"
                    >
                      {brainstormAvailable === false && (
                        <div className="rounded-sm bg-yellow-900/20 border border-yellow-700/30 px-4 py-2.5">
                          <p className="text-[11px] text-yellow-400/90 leading-relaxed">
                            AI provider not configured. Set{" "}
                            <code className="text-yellow-300 font-mono">BRAINSTORM_API_KEY</code> in
                            your <code className="text-yellow-300 font-mono">.env</code> file.
                          </p>
                        </div>
                      )}

                      {/* Mode toggle */}
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-linear-text-tertiary font-medium">Mode</label>
                        <ModeToggle
                          mode={mode}
                          onChange={handleModeChange}
                          proAvailable={proAvailable}
                        />
                      </div>

                      {/* Scope slider */}
                      <ScopeSlider value={taskCount} onChange={setTaskCount} />

                      {/* Step instructions */}
                      <div className="rounded-sm bg-linear-bg-secondary border border-linear-border px-4 py-3 space-y-2">
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">1</span>
                          <span className="text-[12px] text-linear-text-tertiary leading-snug">
                            Describe what you want to build
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">2</span>
                          <span className="text-[12px] text-linear-text-tertiary leading-snug">
                            AI analyzes your codebase and generates tasks
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">3</span>
                          <span className="text-[12px] text-linear-text-tertiary leading-snug">
                            Select and add tasks to your project
                          </span>
                        </div>
                      </div>

                      {questionsLoading && (
                        <div className="flex items-center gap-2 justify-center">
                          <Spinner />
                          <span className="text-[11px] text-linear-text-tertiary">Preparing...</span>
                        </div>
                      )}
                    </motion.div>
                  )}

                  {/* ============= QUESTIONS PHASE (PRO) ============= */}
                  {phase === "questions" && (
                    <motion.div
                      key="questions"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={SPRING}
                      className="space-y-4"
                    >
                      <div className="rounded-sm bg-linear-bg-secondary border border-linear-border px-4 py-3">
                        <p className="text-[11px] text-linear-text-tertiary mb-1">Your prompt</p>
                        <p className="text-[13px] text-linear-text-secondary leading-relaxed">{query}</p>
                        <div className="mt-2 flex items-center gap-2 text-[10px] text-linear-text-tertiary">
                          <span className="inline-flex items-center gap-1 rounded bg-linear-bg-tertiary px-1.5 py-0.5">
                            <FlaskConical className="h-2.5 w-2.5" />
                            Deep Research
                          </span>
                          <span>~{taskCount} tasks</span>
                          {selectedProject && (
                            <>
                              <span>•</span>
                              <span className="truncate">{selectedProject.name}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {questionsLoading ? (
                        <div className="flex items-center gap-2 py-8 justify-center">
                          <Spinner />
                          <span className="text-[11px] text-linear-text-tertiary">
                            Generating questions...
                          </span>
                        </div>
                      ) : (
                        <>
                          <div className="space-y-3">
                            {questions.map((question, index) => (
                              <motion.div
                                key={index}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...SPRING, delay: index * 0.08 }}
                                className="space-y-1.5"
                              >
                                <label className="flex items-start gap-2">
                                  <span className="text-[11px] font-mono text-linear-text-tertiary mt-0.5 shrink-0">
                                    {index + 1}
                                  </span>
                                  <span className="text-[12px] text-linear-text-tertiary leading-snug">
                                    {question}
                                  </span>
                                </label>
                                <input
                                  type="text"
                                  value={answers[question] || ""}
                                  onChange={(e) =>
                                    setAnswers((prev) => ({
                                      ...prev,
                                      [question]: e.target.value,
                                    }))
                                  }
                                  placeholder="Your answer..."
                                  className="w-full ml-5 bg-linear-bg-secondary border border-linear-border rounded-sm px-3 py-2 text-[13px] text-linear-text-secondary placeholder:text-muted-foreground/50 outline-none focus:border-linear-border-hover transition-colors"
                                />
                              </motion.div>
                            ))}
                          </div>

                          <div className="flex items-center justify-between pt-2">
                            <button
                              onClick={() => {
                                setPhase("input")
                                setQuestions([])
                                setAnswers({})
                              }}
                              className="text-[12px] text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
                            >
                              ← Back
                            </button>
                            <button
                              onClick={() => {
                                const answersArray = Object.entries(answers)
                                  .filter(([, v]) => v.trim())
                                  .map(([question, answer]) => ({ question, answer }))
                                setPhase("stream")
                                setLoading(true)
                                setTasks([])
                                startStreaming(query, answersArray, "pro")
                              }}
                              disabled={
                                Object.values(answers).filter((a) => a.trim()).length === 0
                              }
                              className="flex items-center gap-1.5 rounded-sm bg-linear-bg-tertiary px-3 py-1.5 text-[12px] font-medium text-linear-text-secondary hover:bg-linear-bg-tertiary/80 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                            >
                              <FlaskConical className="h-3 w-3" />
                              Generate Tasks
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  )}

                  {/* ============= STREAM PHASE ============= */}
                  {phase === "stream" && loading && (
                    <motion.div
                      key="skeletons"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={SPRING}
                      className="space-y-3"
                    >
                      <div className="flex items-center gap-2 pb-2">
                        <Spinner />
                        <span className="text-[11px] text-linear-text-tertiary">Generating tasks...</span>
                      </div>
                      <SkeletonCard />
                      <SkeletonCard />
                      <SkeletonCard />
                    </motion.div>
                  )}

                  {phase === "stream" && !loading && tasks.length > 0 && (
                    <motion.div
                      key="tasks"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="space-y-2.5"
                    >
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-[11px] font-medium text-linear-text-tertiary">
                          {tasks.length} task{tasks.length !== 1 && "s"} generated
                        </span>
                        <span className="text-[10px] text-muted-foreground/50">
                          from &quot;{query.slice(0, 32)}
                          {query.length > 32 && "..."}&quot;
                        </span>
                      </div>

                      <AnimatePresence>
                        {tasks.map((task) => (
                          <TaskCard key={task.id} task={task} onToggle={handleToggle} />
                        ))}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ---------- Bottom action bar (stream done) ---------- */}
              <AnimatePresence>
                {phase === "stream" && streamingDone && tasks.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={SPRING}
                    className="border-t border-linear-border px-4 py-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-linear-text-tertiary">
                        {tasks.filter((t) => t.selected).length}/{tasks.length} selected
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setTasks([])
                            setQuery("")
                            setPhase("input")
                            setStreamingDone(false)
                          }}
                          className="text-[11px] font-medium text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
                        >
                          New query
                        </button>
                        <button
                          onClick={handleAddToProject}
                          disabled={
                            inserting ||
                            !selectedProjectId ||
                            tasks.filter((t) => t.selected).length === 0
                          }
                          title={
                            !selectedProjectId
                              ? "Select a project first"
                              : undefined
                          }
                          className="flex items-center gap-1.5 rounded-sm bg-linear-bg-tertiary px-3 py-1.5 text-[12px] font-medium text-linear-text-secondary hover:bg-linear-bg-tertiary/80 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                        >
                          {inserting ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Adding...
                            </>
                          ) : (
                            <>
                              <Plus className="h-3 w-3" />
                              Add to Project
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ---------- Input Bar ---------- */}
              <div className="border-t border-linear-border px-4 py-3">
                <div
                  className={cn(
                    "flex items-center gap-3",
                    "rounded-sm",
                    "bg-linear-bg-secondary border border-linear-border",
                    "px-4 py-3",
                    "transition-shadow duration-300",
                    "focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_0_20px_rgba(255,255,255,0.04)]",
                    "focus-within:border-linear-border-hover",
                  )}
                >
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-linear-bg-tertiary">
                    <Plus className="h-4 w-4 text-linear-text-tertiary" />
                  </div>

                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask agents to..."
                    className={cn(
                      "flex-1 bg-transparent text-[16px] text-linear-text-secondary",
                      "placeholder:text-linear-text-tertiary",
                      "outline-none border-none",
                      "caret-linear-text-tertiary",
                    )}
                  />

                  {webSearchAvailable && mode === "pro" && (
                    <button
                      onClick={() => setWebSearchEnabled((prev) => !prev)}
                      className={cn(
                        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm transition-colors",
                        webSearchEnabled
                          ? "text-linear-accent bg-linear-accent/10"
                          : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary",
                      )}
                      aria-label="Toggle web search"
                    >
                      <Globe className="h-3.5 w-3.5" />
                    </button>
                  )}

                  <button
                    onClick={async () => {
                      if (isRecording) {
                        mediaRecorderRef.current?.stop()
                        setIsRecording(false)
                        return
                      }
                      try {
                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                        audioChunksRef.current = []
                        const mimeType = MediaRecorder.isTypeSupported("audio/webm")
                          ? "audio/webm"
                          : "audio/mp4"
                        const recorder = new MediaRecorder(stream, { mimeType })
                        mediaRecorderRef.current = recorder
                        recorder.ondataavailable = (e) => {
                          if (e.data.size > 0) audioChunksRef.current.push(e.data)
                        }
                        recorder.onstop = async () => {
                          stream.getTracks().forEach((t) => t.stop())
                          const duration = Date.now() - recordingStartRef.current
                          if (duration < 1000) {
                            return
                          }
                          const blob = new Blob(audioChunksRef.current, { type: mimeType })
                          if (blob.size < 1000) {
                            return
                          }
                          try {
                            const { text } = await transcribeAudio(blob)
                            if (text && !isWhisperHallucination(text.trim())) {
                              setQuery(text.trim())
                            }
                          } catch (err) {
                            console.error("Transcription failed:", err)
                          }
                        }
                        recordingStartRef.current = Date.now()
                        recorder.start()
                        setIsRecording(true)
                      } catch {
                        setMicSupported(false)
                      }
                    }}
                    disabled={!micSupported}
                    className={cn(
                      "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm transition-colors",
                      isRecording
                        ? "text-red-400 animate-pulse"
                        : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary",
                      !micSupported && "opacity-40 cursor-not-allowed",
                    )}
                    aria-label={isRecording ? "Stop recording" : "Start voice input"}
                  >
                    <Mic className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
