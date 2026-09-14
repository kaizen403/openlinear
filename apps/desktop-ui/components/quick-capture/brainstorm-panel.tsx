"use client"

import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import { FlaskConical, Loader2, Plus, Zap, Lock } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/api"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

const PRIORITY_COLORS: Record<string, string> = {
  high: "border-red-700/40",
  medium: "border-yellow-700/40",
  low: "border-emerald-700/40",
}

const PRIORITY_DOTS: Record<string, string> = {
  high: "bg-red-700",
  medium: "bg-yellow-700",
  low: "bg-emerald-700",
}

const MIN_TASKS = 2
const MAX_TASKS = 15

export interface GeneratedTask {
  id: string
  title: string
  description: string
  priority: "high" | "medium" | "low"
  selected: boolean
}

export type BrainstormMode = "basic" | "pro"

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

function TaskCard({ task, onToggle }: { task: GeneratedTask; onToggle: (id: string) => void }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.96, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
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
          <h4 className="text-[13px] font-medium leading-snug text-linear-text flex-1">{task.title}</h4>
        </div>
        <p className="pl-[22px] text-[11px] leading-relaxed text-linear-text-tertiary">{task.description}</p>
        <div className="flex items-center gap-1.5 pl-[22px]">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", PRIORITY_DOTS[task.priority])} />
          <span className="text-[10px] font-medium uppercase tracking-wider text-linear-text-tertiary">{task.priority}</span>
        </div>
      </div>
    </motion.div>
  )
}

function ModeToggle({ mode, onChange, proAvailable }: { mode: BrainstormMode; onChange: (m: BrainstormMode) => void; proAvailable: boolean }) {
  return (
    <div className="flex items-center gap-1 rounded-sm bg-linear-bg-secondary border border-linear-border p-1">
      <button
        type="button"
        onClick={() => onChange("basic")}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] font-medium transition-colors",
          mode === "basic" ? "bg-linear-bg-tertiary text-linear-text" : "text-linear-text-tertiary hover:text-linear-text-secondary",
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
          mode === "pro" ? "bg-linear-bg-tertiary text-linear-text" : "text-linear-text-tertiary hover:text-linear-text-secondary",
          !proAvailable && "opacity-50 cursor-not-allowed hover:text-linear-text-tertiary",
        )}
      >
        {proAvailable ? <FlaskConical className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
        Deep Research
      </button>
    </div>
  )
}

function ScopeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

export interface BrainstormPanelProps {
  phase: "input" | "questions" | "stream"
  query: string
  tasks: GeneratedTask[]
  questions: string[]
  answers: Record<string, string>
  loading: boolean
  questionsLoading: boolean
  streamingDone: boolean
  inserting: boolean
  brainstormAvailable: boolean | null
  webSearchAvailable: boolean
  proAvailable: boolean
  mode: BrainstormMode
  taskCount: number
  selectedProject: Project | null | undefined
  selectedProjectId: string | null
  onModeChange: (m: BrainstormMode) => void
  onTaskCountChange: (v: number) => void
  onToggleTask: (id: string) => void
  onAnswerChange: (question: string, answer: string) => void
  onBackFromQuestions: () => void
  onGenerateFromQuestions: () => void
  onNewQuery: () => void
  onAddToProject: () => void
}

export function BrainstormPanel({
  phase,
  query,
  tasks,
  questions,
  answers,
  loading,
  questionsLoading,
  streamingDone,
  inserting,
  brainstormAvailable,
  proAvailable,
  mode,
  taskCount,
  selectedProject,
  selectedProjectId,
  onModeChange,
  onTaskCountChange,
  onToggleTask,
  onAnswerChange,
  onBackFromQuestions,
  onGenerateFromQuestions,
  onNewQuery,
  onAddToProject,
}: BrainstormPanelProps) {
  return (
    <>
      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-6">
        <AnimatePresence mode="wait">
          {/* INPUT PHASE */}
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

              <div className="space-y-1.5">
                <label className="text-[11px] text-linear-text-tertiary font-medium">Mode</label>
                <ModeToggle mode={mode} onChange={onModeChange} proAvailable={proAvailable} />
              </div>

              <ScopeSlider value={taskCount} onChange={onTaskCountChange} />

              <div className="rounded-sm bg-linear-bg-secondary border border-linear-border px-4 py-3 space-y-2">
                <div className="flex items-center gap-2.5 text-left">
                  <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">1</span>
                  <span className="text-[12px] text-linear-text-tertiary leading-snug">Describe what you want to build</span>
                </div>
                <div className="flex items-center gap-2.5 text-left">
                  <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">2</span>
                  <span className="text-[12px] text-linear-text-tertiary leading-snug">AI analyzes your codebase and generates tasks</span>
                </div>
                <div className="flex items-center gap-2.5 text-left">
                  <span className="text-[11px] font-mono text-linear-text-tertiary shrink-0">3</span>
                  <span className="text-[12px] text-linear-text-tertiary leading-snug">Select and add tasks to your project</span>
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

          {/* QUESTIONS PHASE */}
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
                  <span className="text-[11px] text-linear-text-tertiary">Generating questions...</span>
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
                          <span className="text-[11px] font-mono text-linear-text-tertiary mt-0.5 shrink-0">{index + 1}</span>
                          <span className="text-[12px] text-linear-text-tertiary leading-snug">{question}</span>
                        </label>
                        <input
                          type="text"
                          value={answers[question] || ""}
                          onChange={(e) => onAnswerChange(question, e.target.value)}
                          placeholder="Your answer..."
                          className="w-full ml-5 bg-linear-bg-secondary border border-linear-border rounded-sm px-3 py-2 text-[13px] text-linear-text-secondary placeholder:text-muted-foreground/50 outline-none focus:border-linear-border-hover transition-colors"
                        />
                      </motion.div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={onBackFromQuestions}
                      className="text-[12px] text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
                    >
                      ← Back
                    </button>
                    <button
                      onClick={onGenerateFromQuestions}
                      disabled={Object.values(answers).filter((a) => a.trim()).length === 0}
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

          {/* STREAM PHASE - loading */}
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

          {/* STREAM PHASE - tasks */}
          {phase === "stream" && !loading && tasks.length > 0 && (
            <motion.div key="tasks" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2.5">
              <div className="flex items-center justify-between pb-1">
                <span className="text-[11px] font-medium text-linear-text-tertiary">
                  {tasks.length} task{tasks.length !== 1 && "s"} generated
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  from &quot;{query.slice(0, 32)}{query.length > 32 && "..."}&quot;
                </span>
              </div>
              <AnimatePresence>
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} onToggle={onToggleTask} />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom action bar */}
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
                  onClick={onNewQuery}
                  className="text-[11px] font-medium text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
                >
                  New query
                </button>
                <button
                  onClick={onAddToProject}
                  disabled={inserting || !selectedProjectId || tasks.filter((t) => t.selected).length === 0}
                  title={!selectedProjectId ? "Select a project first" : undefined}
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
    </>
  )
}
