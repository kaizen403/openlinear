"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Plus, X, Globe } from "lucide-react"
import { cn } from "@/lib/utils"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { checkBrainstormAvailability, generateBrainstormQuestions, streamBrainstormTasks, type BrainstormTask } from "@/lib/api/brainstorm"
import { useProject } from "@/hooks/use-project"
import { getApiUrl, getAuthHeader } from "@/lib/api/client"
import { ApiError } from "@/lib/api/fetch"
import { toast } from "sonner"
import { VoiceCapture } from "./quick-capture/voice-capture"
import { BrainstormPanel, type GeneratedTask, type BrainstormMode } from "./quick-capture/brainstorm-panel"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }
const DEFAULT_TASKS = 5

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

  useEffect(() => {
    if (phase === "input" || phase === "stream") {
      const timeout = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timeout)
    }
  }, [phase])

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

  useEffect(() => { setMicSupported(!!navigator.mediaDevices?.getUserMedia) }, [])

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

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (phase !== "ghost" && sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [phase, handleClose])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") handleClose() }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [handleClose])

  const startStreaming = useCallback(
    async (promptText: string, answersArray: { question: string; answer: string }[], streamMode: BrainstormMode) => {
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
        () => { setLoading(false); setStreamingDone(true) },
        (error) => { console.error("Stream error:", error); setLoading(false); setStreamingDone(true) },
        { webSearch: webSearchEnabled, mode: streamMode, taskCount, projectId: selectedProjectId ?? undefined },
      )
    },
    [webSearchEnabled, taskCount, selectedProjectId],
  )

  useEffect(() => {
    function handleBrainstorm(e: Event) {
      const raw = (e as CustomEvent).detail
      const parsed = typeof raw === "string"
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
          setPhase("stream"); setLoading(true); setTasks([])
          startStreaming(parsed.query, [], "basic")
          return
        }

        setQuestionsLoading(true)
        try {
          const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Questions generation timed out")), 30000))
          const generatedQuestions = await Promise.race([generateBrainstormQuestions(parsed.query, parsed.webSearch, selectedProjectId ?? undefined), timeoutPromise])
          setQuestions(generatedQuestions); setAnswers({}); setPhase("questions")
        } catch (err) { console.error("Failed to generate questions:", err) }
        finally { setQuestionsLoading(false) }
      }, 100)
    }
    window.addEventListener("brainstorm-query", handleBrainstorm)
    return () => window.removeEventListener("brainstorm-query", handleBrainstorm)
  }, [startStreaming, selectedProjectId])

  const handleModeChange = useCallback((next: BrainstormMode) => {
    setMode(next)
    if (next === "basic") { setQuestions([]); setAnswers({}); if (phase === "questions") setPhase("input") }
  }, [phase])

  const handleSubmit = useCallback(async () => {
    if (!query.trim()) return
    if (mode === "basic") {
      setPhase("stream"); setLoading(true); setTasks([])
      await startStreaming(query, [], "basic")
      return
    }
    setQuestionsLoading(true)
    try {
      const availability = await checkBrainstormAvailability()
      if (!availability.available) { setQuestionsLoading(false); return }
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Questions generation timed out")), 30000))
      const generatedQuestions = await Promise.race([generateBrainstormQuestions(query, webSearchEnabled, selectedProjectId ?? undefined), timeoutPromise])
      setQuestions(generatedQuestions); setAnswers({}); setPhase("questions")
    } catch (err) { console.error("Failed to generate questions:", err) }
    finally { setQuestionsLoading(false) }
  }, [query, mode, webSearchEnabled, selectedProjectId, startStreaming])

  const handleToggle = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t)))
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
            body: JSON.stringify({ title: task.title, description: task.description, priority: task.priority, projectId: selectedProjectId }),
          })
          if (!res.ok) {
            let message = `HTTP ${res.status}`
            try { const body = (await res.json()) as { error?: string }; if (body?.error) message = body.error } catch {}
            throw new Error(message)
          }
          return task
        }),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed === 0) { toast.success(`Added ${succeeded} task${succeeded === 1 ? "" : "s"} to project`); handleClose(); return }
      results.forEach((r, idx) => {
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : "Unknown error"
          toast.error(`"${selectedTasks[idx]!.title}": ${reason}`)
        }
      })
      toast.error(`Added ${succeeded} of ${results.length} tasks. ${failed} failed — see details above.`)
      setInserting(false)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not reach OpenLinear server."
      toast.error(`Failed to add tasks: ${msg}`)
      setInserting(false)
    }
  }, [tasks, selectedProjectId, handleClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }, [handleSubmit])

  return (
    <>
      {/* Ghost trigger */}
      <AnimatePresence>
        {phase === "ghost" && (
          <motion.button
            key="ghost"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => setPhase("input")}
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

      {/* Sidebar */}
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
              animate={{ x: 0, opacity: 1, width: phase === "stream" || phase === "questions" ? "min(400px, 100vw)" : "min(380px, 100vw)" }}
              exit={{ x: "100%", opacity: 0 }}
              transition={SPRING}
              className={cn("fixed right-0 top-0 z-[9999] h-full", "flex flex-col", "backdrop-blur-xl", "border-l border-linear-border", "shadow-[-8px_0_30px_rgba(0,0,0,0.5)]")}
              style={{ backgroundColor: `${BRAND_COLORS.overlaySurface}cc` }}
            >
              {/* Top bar */}
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[20px] font-semibold tracking-tight bg-gradient-to-r from-white via-white to-linear-text-tertiary bg-clip-text text-transparent">Brainstorm</span>
                  <span className="text-[14px] text-linear-text-tertiary font-light tracking-wide">by</span>
                  <span className="text-[14px] font-medium tracking-wider text-linear-text-tertiary uppercase">OpenLinear</span>
                </div>
                <button onClick={handleClose} className="flex h-8 w-8 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary transition-colors" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {(phase === "stream" || phase === "questions") && (
                <motion.div initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ ...SPRING, delay: 0.1 }} className="mx-4 h-px bg-gradient-to-r from-transparent via-linear-border to-transparent" />
              )}

              {/* Brainstorm content */}
              <BrainstormPanel
                phase={phase as "input" | "questions" | "stream"}
                query={query}
                tasks={tasks}
                questions={questions}
                answers={answers}
                loading={loading}
                questionsLoading={questionsLoading}
                streamingDone={streamingDone}
                inserting={inserting}
                brainstormAvailable={brainstormAvailable}
                webSearchAvailable={webSearchAvailable}
                proAvailable={proAvailable}
                mode={mode}
                taskCount={taskCount}
                selectedProject={activeProject}
                selectedProjectId={selectedProjectId}
                onModeChange={handleModeChange}
                onTaskCountChange={setTaskCount}
                onToggleTask={handleToggle}
                onAnswerChange={(q, a) => setAnswers((prev) => ({ ...prev, [q]: a }))}
                onBackFromQuestions={() => { setPhase("input"); setQuestions([]); setAnswers({}) }}
                onGenerateFromQuestions={() => {
                  const answersArray = Object.entries(answers).filter(([, v]) => v.trim()).map(([question, answer]) => ({ question, answer }))
                  setPhase("stream"); setLoading(true); setTasks([])
                  startStreaming(query, answersArray, "pro")
                }}
                onNewQuery={() => { setTasks([]); setQuery(""); setPhase("input"); setStreamingDone(false) }}
                onAddToProject={handleAddToProject}
              />

              {/* Input bar */}
              <div className="border-t border-linear-border px-4 py-3">
                <div className={cn("flex items-center gap-3", "rounded-sm", "bg-linear-bg-secondary border border-linear-border", "px-4 py-3", "transition-shadow duration-300", "focus-within:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_0_20px_rgba(255,255,255,0.04)]", "focus-within:border-linear-border-hover")}>
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
                    className={cn("flex-1 bg-transparent text-[16px] text-linear-text-secondary", "placeholder:text-linear-text-tertiary", "outline-none border-none", "caret-linear-text-tertiary")}
                  />
                  {webSearchAvailable && mode === "pro" && (
                    <button
                      onClick={() => setWebSearchEnabled((prev) => !prev)}
                      className={cn("flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm transition-colors", webSearchEnabled ? "text-linear-accent bg-linear-accent/10" : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary")}
                      aria-label="Toggle web search"
                    >
                      <Globe className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <VoiceCapture
                    isRecording={isRecording}
                    setIsRecording={setIsRecording}
                    micSupported={micSupported}
                    setMicSupported={setMicSupported}
                    onTranscription={(text) => setQuery(text)}
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
