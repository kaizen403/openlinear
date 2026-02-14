"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Plus,
  ArrowRight,
  Sparkles,
  X,
  AlertTriangle,
  Flag,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { checkBrainstormAvailability, generateBrainstormQuestions } from "@/lib/api/brainstorm"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeneratedTask {
  id: string
  title: string
  reasoning: string
  priority: "high" | "medium" | "low"
  inserted: boolean
}

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

const PRIORITY_ICONS: Record<
  GeneratedTask["priority"],
  React.ComponentType<{ className?: string }>
> = {
  high: AlertTriangle,
  medium: Flag,
  low: Flag,
}


// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-zinc-900/60 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-zinc-700 animate-pulse" />
        <div className="h-3.5 w-3/4 rounded bg-zinc-800 animate-pulse" />
      </div>
      <div className="space-y-1.5 pl-3.5">
        <div className="h-2.5 w-full rounded bg-zinc-800/60 animate-pulse" />
        <div className="h-2.5 w-5/6 rounded bg-zinc-800/60 animate-pulse" />
      </div>
    </div>
  )
}

function TaskCard({
  task,
  onInsert,
}: {
  task: GeneratedTask
  onInsert: (id: string) => void
}) {
  const PriorityIcon = PRIORITY_ICONS[task.priority]

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.96, filter: "blur(6px)" }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        boxShadow: "0 0 0 rgba(255,255,255,0)",
      }}
      exit={{ opacity: 0, y: -12, scale: 0.97, filter: "blur(4px)" }}
      transition={{ type: "spring", stiffness: 260, damping: 28 }}
      whileHover={{
        boxShadow: "0 0 20px rgba(255,255,255,0.03)",
        borderColor: "rgba(255,255,255,0.1)",
      }}
      className={cn(
        "group relative rounded-lg border border-white/[0.06] bg-zinc-900/60 backdrop-blur-sm",
        "border-l-2",
        PRIORITY_COLORS[task.priority],
        task.inserted && "opacity-50"
      )}
    >
      <div className="p-4 space-y-2">
        {/* Header row */}
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded",
              "bg-white/[0.04]"
            )}
          >
            <PriorityIcon className={cn("w-2.5 h-2.5", {
              "text-red-600": task.priority === "high",
              "text-yellow-600": task.priority === "medium",
              "text-emerald-600": task.priority === "low",
            })} />
          </div>
          <h4 className="text-[13px] font-medium leading-snug text-zinc-100 flex-1">
            {task.title}
          </h4>
        </div>

        {/* Reasoning */}
        <p className="pl-[26px] text-[11px] leading-relaxed text-zinc-500">
          {task.reasoning}
        </p>

        {/* Footer */}
        <div className="flex items-center justify-between pl-[26px] pt-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                PRIORITY_DOTS[task.priority]
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">
              {task.priority}
            </span>
          </div>

          {/* Insert button */}
          <motion.button
            initial={false}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onInsert(task.id)}
            disabled={task.inserted}
            className={cn(
              "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium",
              "opacity-0 translate-y-1 transition-all duration-200",
              "group-hover:opacity-100 group-hover:translate-y-0",
              task.inserted
                ? "bg-emerald-500/10 text-emerald-400 cursor-default opacity-100 translate-y-0"
                : "bg-white/[0.06] text-zinc-400 hover:bg-white/[0.1] hover:text-zinc-200"
            )}
          >
            {task.inserted ? (
              <>
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Inserted
              </>
            ) : (
              <>
                <ArrowRight className="h-3 w-3" />
                Insert
              </>
            )}
          </motion.button>
        </div>
      </div>
    </motion.div>
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
  const inputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Focus input when entering input phase
  useEffect(() => {
    if (phase === "input" || phase === "stream") {
      // Small delay to wait for animation
      const timeout = setTimeout(() => {
        inputRef.current?.focus()
      }, 100)
      return () => clearTimeout(timeout)
    }
  }, [phase])

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
  }, [phase])

  // Escape to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleClose()
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [])

  useEffect(() => {
    function handleBrainstorm(e: Event) {
      const query = (e as CustomEvent<string>).detail
      if (!query) return

      setQuery(query)
      setPhase("input")
      // Auto-submit after setting query
      setTimeout(async () => {
        setQuestionsLoading(true)
        try {
          const availability = await checkBrainstormAvailability()
          if (!availability.available) {
            setQuestionsLoading(false)
            return
          }
          const generatedQuestions = await generateBrainstormQuestions(query)
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
  }, [])

  const handleClose = useCallback(() => {
    setPhase("ghost")
    setQuery("")
    setTasks([])
    setLoading(false)
    setQuestions([])
    setAnswers({})
    setQuestionsLoading(false)
  }, [])

  const handleGhostClick = useCallback(() => {
    setPhase("input")
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!query.trim()) return

    setQuestionsLoading(true)
    try {
      const availability = await checkBrainstormAvailability()
      if (!availability.available) {
        setQuestionsLoading(false)
        return
      }
      const generatedQuestions = await generateBrainstormQuestions(query)
      setQuestions(generatedQuestions)
      setAnswers({})
      setPhase("questions")
    } catch (err) {
      console.error("Failed to generate questions:", err)
    } finally {
      setQuestionsLoading(false)
    }
  }, [query])

  const handleInsert = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, inserted: true } : t))
    )
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

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
              "bg-white/[0.08] backdrop-blur-xl",
              "rounded-l-lg",
              "cursor-pointer",
              "hover:w-4 hover:bg-white/[0.14]",
              "border-l border-t border-b border-white/[0.12]",
              "shadow-[-4px_0_20px_rgba(0,0,0,0.4)]",
              "transition-all duration-300 ease-out"
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
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[9998] bg-black/40"
            />

            {/* Sidebar panel */}
            <motion.div
              key="sidebar"
              ref={sidebarRef}
              initial={{ x: "100%", opacity: 0 }}
              animate={{
                x: 0,
                opacity: 1,
                width: phase === "stream" || phase === "questions" ? "min(400px, 100vw)" : "min(360px, 100vw)",
              }}
              exit={{ x: "100%", opacity: 0 }}
              transition={SPRING}
              className={cn(
                "fixed right-0 top-0 z-[9999] h-full",
                "flex flex-col",
                "bg-[#09090b]/80 backdrop-blur-xl",
                "border-l border-white/10",
                "shadow-[-8px_0_30px_rgba(0,0,0,0.5)]"
              )}
            >
              {/* ---------- Top bar ---------- */}
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[20px] font-semibold tracking-tight bg-gradient-to-r from-white via-white to-zinc-400 bg-clip-text text-transparent">
                    Brainstorm
                  </span>
                  <span className="text-[14px] text-zinc-600 font-light tracking-wide">
                    by
                  </span>
                  <span className="text-[14px] font-medium tracking-wider text-zinc-500 uppercase">
                    KazCode
                  </span>
                </div>
                <button
                  onClick={handleClose}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
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
                  className="mx-4 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
                />
              )}

              {/* ---------- Stream content ---------- */}
              <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6">
                <AnimatePresence mode="wait">
                  {phase === "stream" && loading && (
                    <motion.div
                      key="skeletons"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={SPRING}
                      className="space-y-3"
                    >
                      {/* Loading header */}
                      <div className="flex items-center gap-2 pb-2">
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{
                            repeat: Infinity,
                            duration: 2,
                            ease: "linear",
                          }}
                        >
                          <Sparkles className="h-3 w-3 text-zinc-600" />
                        </motion.div>
                        <span className="text-[11px] text-zinc-600">
                          Generating tasks...
                        </span>
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
                      {/* Result header */}
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-[11px] font-medium text-zinc-500">
                          {tasks.length} task{tasks.length !== 1 && "s"} generated
                        </span>
                        <span className="text-[10px] text-zinc-700">
                          from &quot;{query.slice(0, 32)}
                          {query.length > 32 && "..."}&quot;
                        </span>
                      </div>

                      <AnimatePresence>
                        {tasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            onInsert={handleInsert}
                          />
                        ))}
                      </AnimatePresence>
                    </motion.div>
                  )}

                  {phase === "questions" && (
                    <motion.div
                      key="questions"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={SPRING}
                      className="space-y-4"
                    >
                      <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-4 py-3">
                        <p className="text-[11px] text-zinc-600 mb-1">Your prompt</p>
                        <p className="text-[13px] text-zinc-300 leading-relaxed">{query}</p>
                      </div>

                      {questionsLoading ? (
                        <div className="flex items-center gap-2 py-8 justify-center">
                          <motion.div
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                          >
                            <Sparkles className="h-3 w-3 text-zinc-600" />
                          </motion.div>
                          <span className="text-[11px] text-zinc-600">Generating questions...</span>
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
                                  <span className="text-[11px] font-mono text-zinc-600 mt-0.5 shrink-0">
                                    {index + 1}
                                  </span>
                                  <span className="text-[12px] text-zinc-400 leading-snug">
                                    {question}
                                  </span>
                                </label>
                                <input
                                  type="text"
                                  value={answers[question] || ""}
                                  onChange={(e) =>
                                    setAnswers((prev) => ({ ...prev, [question]: e.target.value }))
                                  }
                                  placeholder="Your answer..."
                                  className="w-full ml-5 bg-zinc-900/80 border border-white/[0.06] rounded-md px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-white/[0.12] transition-colors"
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
                              className="text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                              ← Back
                            </button>
                            <button
                              onClick={() => {
                                setPhase("stream")
                                setLoading(true)
                                setTasks([])
                              }}
                              disabled={Object.values(answers).filter(a => a.trim()).length === 0}
                              className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-zinc-300 hover:bg-white/[0.12] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                            >
                              <Sparkles className="h-3 w-3" />
                              Generate Tasks
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  )}

                  {phase === "input" && (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ ...SPRING, delay: 0.1 }}
                      className="flex flex-col items-center justify-center pt-10 text-center px-6"
                    >
                      <span className="text-[26px] font-bold tracking-tight bg-gradient-to-r from-white via-white to-zinc-300 bg-clip-text text-transparent">
                        Brainstorm
                      </span>

                      <p className="text-[13px] text-zinc-400 max-w-[280px] leading-relaxed mt-3">
                        Describe a goal — AI turns it into actionable tasks for your board.
                      </p>

                      <div className="mt-5 w-full max-w-[280px] rounded-lg bg-white/[0.03] border border-white/[0.06] px-4 py-3 space-y-2">
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-zinc-500 shrink-0">1</span>
                          <span className="text-[12px] text-zinc-400 leading-snug">
                            Type what you want to build or fix
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-zinc-500 shrink-0">2</span>
                          <span className="text-[12px] text-zinc-400 leading-snug">
                            AI breaks it into prioritized tasks
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5 text-left">
                          <span className="text-[11px] font-mono text-zinc-500 shrink-0">3</span>
                          <span className="text-[12px] text-zinc-400 leading-snug">
                            Insert the ones you want into your board
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ---------- Bottom status bar ---------- */}
              <AnimatePresence>
                {phase === "stream" && tasks.length > 0 && !loading && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={SPRING}
                    className="border-t border-white/[0.06] px-4 py-3 flex items-center justify-between"
                  >
                    <span className="text-[11px] text-zinc-600">
                      {tasks.filter((t) => t.inserted).length}/{tasks.length}{" "}
                      inserted
                    </span>
                    <button
                      onClick={() => {
                        setTasks([])
                        setQuery("")
                        setPhase("input")
                      }}
                      className="text-[11px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      New query
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ---------- Input Bar ---------- */}
              <div className="border-t border-white/[0.06] px-4 py-3">
                <div
                  className={cn(
                    "flex items-center gap-3",
                    "rounded-full",
                    "bg-zinc-900/90 border border-white/[0.06]",
                    "px-4 py-3",
                    "transition-shadow duration-300",
                    "focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_0_20px_rgba(255,255,255,0.04)]",
                    "focus-within:border-white/[0.12]"
                  )}
                >
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
                    <Plus className="h-4 w-4 text-zinc-500" />
                  </div>

                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask agents to..."
                    className={cn(
                      "flex-1 bg-transparent text-[16px] text-zinc-200",
                      "placeholder:text-zinc-600",
                      "outline-none border-none",
                      "caret-zinc-400"
                    )}
                  />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
