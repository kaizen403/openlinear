"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Plus,
  Globe,
  Telescope,
  Type,
  ArrowRight,
  Sparkles,
  X,
  AlertTriangle,
  Flag,
} from "lucide-react"
import { cn } from "@/lib/utils"

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

type ToggleId = "web" | "research" | "writing"

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

const MOCK_TASKS: GeneratedTask[] = [
  {
    id: "1",
    title: "Refactor authentication middleware to support OAuth2 PKCE flow",
    reasoning:
      "Current auth uses implicit grant which is deprecated. PKCE provides better security for public clients without a client secret.",
    priority: "high",
    inserted: false,
  },
  {
    id: "2",
    title: "Add rate limiting to public API endpoints",
    reasoning:
      "Prevents abuse and ensures fair resource allocation. Should implement sliding window algorithm with Redis backing.",
    priority: "high",
    inserted: false,
  },
  {
    id: "3",
    title: "Create E2E test suite for task execution pipeline",
    reasoning:
      "Execution pipeline has no integration coverage. Critical path from clone to PR creation needs automated verification.",
    priority: "medium",
    inserted: false,
  },
  {
    id: "4",
    title: "Update README with new environment variable documentation",
    reasoning:
      "Several new env vars were added in recent PRs but docs are stale. Quick win for developer onboarding.",
    priority: "low",
    inserted: false,
  },
]

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

function ToggleButton({
  id,
  icon: Icon,
  label,
  active,
  onToggle,
}: {
  id: ToggleId
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  onToggle: (id: ToggleId) => void
}) {
  return (
    <button
      onClick={() => onToggle(id)}
      title={label}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150",
        active
          ? "bg-white/[0.1] text-zinc-200 shadow-[0_0_8px_rgba(255,255,255,0.06)]"
          : "text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.04]"
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GlobalQuickCapture() {
  const [phase, setPhase] = useState<"ghost" | "input" | "stream">("ghost")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [tasks, setTasks] = useState<GeneratedTask[]>([])
  const [toggles, setToggles] = useState<Record<ToggleId, boolean>>({
    web: true,
    research: false,
    writing: false,
  })
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
      setPhase("stream")
      setLoading(true)
      setTasks([])

      const showDelay = 1800
      setTimeout(() => {
        setLoading(false)
        MOCK_TASKS.forEach((task, i) => {
          setTimeout(() => {
            setTasks((prev) => [...prev, { ...task, id: `${task.id}-${Date.now()}` }])
          }, i * 280)
        })
      }, showDelay)
    }

    window.addEventListener("brainstorm-query", handleBrainstorm)
    return () => window.removeEventListener("brainstorm-query", handleBrainstorm)
  }, [])

  const handleClose = useCallback(() => {
    setPhase("ghost")
    setQuery("")
    setTasks([])
    setLoading(false)
  }, [])

  const handleGhostClick = useCallback(() => {
    setPhase("input")
  }, [])

  const handleToggle = useCallback((id: ToggleId) => {
    setToggles((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const handleSubmit = useCallback(() => {
    if (!query.trim()) return

    setPhase("stream")
    setLoading(true)
    setTasks([])

    // Simulate AI loading → staggered card arrival
    const showDelay = 1800
    setTimeout(() => {
      setLoading(false)

      // Stagger each card
      MOCK_TASKS.forEach((task, i) => {
        setTimeout(() => {
          setTasks((prev) => [...prev, { ...task, id: `${task.id}-${Date.now()}` }])
        }, i * 280)
      })
    }, showDelay)
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
              "w-12 h-28",
              "bg-white/[0.08] backdrop-blur-sm",
              "rounded-l-xl",
              "cursor-pointer",
              "hover:bg-white/[0.12]",
              "border-l border-t border-b border-white/[0.06]",
              "flex items-center justify-center"
            )}
          >
            <span 
              className="text-[12px] text-zinc-200 tracking-wide"
              style={{ 
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                transform: 'rotate(180deg)',
                fontFamily: '"Caveat", cursive',
                fontWeight: 600,
                letterSpacing: '0.04em'
              }}
            >
              BrainStorm
            </span>
          </motion.button>
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
                width: phase === "stream" ? "min(400px, 100vw)" : "min(360px, 100vw)",
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
                    OpenLinear
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

              {/* ---------- Command Bar ---------- */}
              <motion.div
                layout
                transition={SPRING}
                className="px-5 pb-4 pt-2"
              >
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
                  {/* Plus icon */}
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
                    <Plus className="h-4 w-4 text-zinc-500" />
                  </div>

                  {/* Input */}
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

                  {/* Toggle icons */}
                  <div className="flex items-center gap-1 border-l border-white/[0.06] pl-3">
                    <ToggleButton
                      id="web"
                      icon={Globe}
                      label="Web search"
                      active={toggles.web}
                      onToggle={handleToggle}
                    />
                    <ToggleButton
                      id="research"
                      icon={Telescope}
                      label="Deep research"
                      active={toggles.research}
                      onToggle={handleToggle}
                    />
                    <ToggleButton
                      id="writing"
                      icon={Type}
                      label="Writing mode"
                      active={toggles.writing}
                      onToggle={handleToggle}
                    />
                  </div>
                </div>
              </motion.div>

              {/* ---------- Divider ---------- */}
              {phase === "stream" && (
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

                  {phase === "input" && (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ ...SPRING, delay: 0.1 }}
                      className="flex flex-col items-center justify-center pt-16 text-center px-6"
                    >
                      <span className="text-[28px] font-bold tracking-tight bg-gradient-to-r from-white via-white to-zinc-400 bg-clip-text text-transparent">
                        Brainstorm
                      </span>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-600">
                          by OpenLinear
                        </span>
                        <span className="text-[9px] font-mono text-zinc-700 border border-white/[0.06] rounded px-1 py-0.5 bg-white/[0.02]">
                          v1
                        </span>
                      </div>

                      <div className="w-8 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent mt-6 mb-6" />

                      <p className="text-[12px] text-zinc-500 max-w-[260px] leading-relaxed">
                        Describe a goal in natural language. AI agents will decompose it into
                        structured, actionable tasks you can insert directly into your board.
                      </p>

                      <div className="mt-6 w-full max-w-[260px] space-y-2">
                        <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-600 block text-left">
                          How it works
                        </span>
                        <div className="space-y-1.5">
                          <div className="flex items-start gap-2.5 text-left">
                            <span className="text-[10px] font-mono text-zinc-600 mt-px shrink-0">01</span>
                            <span className="text-[11px] text-zinc-500 leading-snug">
                              Type what you want to build or fix
                            </span>
                          </div>
                          <div className="flex items-start gap-2.5 text-left">
                            <span className="text-[10px] font-mono text-zinc-600 mt-px shrink-0">02</span>
                            <span className="text-[11px] text-zinc-500 leading-snug">
                              Agents break it into prioritized tasks
                            </span>
                          </div>
                          <div className="flex items-start gap-2.5 text-left">
                            <span className="text-[10px] font-mono text-zinc-600 mt-px shrink-0">03</span>
                            <span className="text-[11px] text-zinc-500 leading-snug">
                              Insert the ones you want into your board
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 mt-8 px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.04]">
                        <span className="text-[10px] text-zinc-600">Press</span>
                        <kbd className="inline-flex h-4 items-center rounded border border-white/[0.08] bg-white/[0.04] px-1 text-[10px] font-mono text-zinc-500">
                          Enter
                        </kbd>
                        <span className="text-[10px] text-zinc-600">
                          to generate
                        </span>
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
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
