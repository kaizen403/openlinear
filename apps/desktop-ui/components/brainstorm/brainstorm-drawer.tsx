"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { Plus, X, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { useProject } from "@/hooks/use-project"
import { useChatSessions } from "@/hooks/use-chat-sessions"
import { useChatStream } from "@/hooks/use-chat-stream"
import { useChatPanelHandoff } from "@/hooks/use-chat-panel-handoff"
import { ChatComposer, ChatMessageList, ChatEmptyState, ChatSuggestions } from "@/components/chat"
import { fetchChatSession } from "@/lib/api/chat"

const MIN_WIDTH = 280
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 360
const STORAGE_KEY = "openlinear-chat-sidebar-width"

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === null) return DEFAULT_WIDTH
  const n = Number(stored)
  return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)) : DEFAULT_WIDTH
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function BrainstormDrawer() {
  const pathname = usePathname()
  const isHomePage = pathname === "/" || pathname === ""
  const { isSidebarOpen, pendingQuery, openSidebar, closeSidebar, consumeQuery } = useChatPanelHandoff()
  const { activeProject } = useProject()
  const { sessions, activeSessionId, setActiveSessionId, createSession } = useChatSessions()
  const { messages, status, streamingContent, activeToolCalls, send, stop, reset, loadHistory } = useChatStream()

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [dragging, setDragging] = useState(false)
  const [mounted, setMounted] = useState(false)
  const startX = useRef(0)
  const startWidth = useRef(DEFAULT_WIDTH)
  const pendingWidth = useRef<number | null>(null)
  const resizeFrame = useRef<number | null>(null)

  useEffect(() => {
    setWidth(readStoredWidth())
    setMounted(true)
  }, [])

  useEffect(() => {
    if (mounted) localStorage.setItem(STORAGE_KEY, String(width))
  }, [width, mounted])

  useEffect(() => {
    const onToggle = () => {
      if (isSidebarOpen) closeSidebar()
      else openSidebar()
    }
    window.addEventListener("openlinear:toggle-chat-sidebar", onToggle)
    return () => window.removeEventListener("openlinear:toggle-chat-sidebar", onToggle)
  }, [openSidebar, closeSidebar, isSidebarOpen])

  useEffect(() => {
    if (!isSidebarOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isSidebarOpen, closeSidebar])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const delta = startX.current - e.clientX
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      pendingWidth.current = newWidth
      if (resizeFrame.current !== null) return
      resizeFrame.current = window.requestAnimationFrame(() => {
        resizeFrame.current = null
        if (pendingWidth.current !== null) setWidth(pendingWidth.current)
      })
    }

    const handleMouseUp = () => {
      if (!dragging) return
      setDragging(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      if (resizeFrame.current !== null) {
        window.cancelAnimationFrame(resizeFrame.current)
        resizeFrame.current = null
      }
      if (pendingWidth.current !== null) {
        setWidth(pendingWidth.current)
        pendingWidth.current = null
      }
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
      if (resizeFrame.current !== null) {
        window.cancelAnimationFrame(resizeFrame.current)
        resizeFrame.current = null
      }
    }
  }, [dragging])

  const handleLoadSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId)
    reset()
    try {
      const session = await fetchChatSession(sessionId)
      if (session.messages) loadHistory(session.messages)
    } catch {}
  }, [setActiveSessionId, reset, loadHistory])

  const handleSend = useCallback(async (content: string, attachmentIds?: string[]) => {
    if (!activeProject) return
    let sessionId = activeSessionId
    if (!sessionId) {
      const session = await createSession(activeProject.id)
      if (!session) return
      sessionId = session.id
      setActiveSessionId(sessionId)
    }
    send(sessionId, content, attachmentIds)
  }, [activeProject, activeSessionId, createSession, setActiveSessionId, send])

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null)
    reset()
  }, [setActiveSessionId, reset])

  useEffect(() => {
    if (!isSidebarOpen) return
    if (!activeProject) return
    if (!pendingQuery) return
    consumeQuery()
    void handleSend(pendingQuery)
  }, [isSidebarOpen, pendingQuery, activeProject, consumeQuery, handleSend])

  const hasMessages = messages.length > 0
  const isStreaming = status === "streaming"
  const isThinking = isStreaming && !streamingContent
  const composerPlaceholder = activeProject
    ? `ask ${activeProject.name.toLowerCase()}...`
    : "select a project..."
  const composerDisabled = !activeProject
  const recentSessions = sessions.slice(0, 8)

  if (isHomePage) return null

  return (
    <>
      <AnimatePresence>
        {!isSidebarOpen && (
          <motion.button
            key="ghost"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={openSidebar}
            aria-label="Open chat"
            className={cn(
              "fixed right-0 top-1/2 -translate-y-1/2 z-[9999]",
              "w-3 h-24",
              "bg-linear-bg-tertiary backdrop-blur-xl",
              "rounded-l-sm cursor-pointer",
              "hover:w-4 hover:bg-linear-bg-tertiary/80",
              "border-l border-t border-b border-linear-border",
              "shadow-[-4px_0_20px_rgba(0,0,0,0.4)]",
              "transition-all duration-300 ease-out",
            )}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[9998] bg-black/40"
              onClick={closeSidebar}
            />

            <motion.div
              key="panel"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed top-0 bottom-0 right-0 z-[9999] flex"
              style={{ width: `${width}px` }}
            >
        <button
          type="button"
          onMouseDown={handleMouseDown}
          className="w-2 flex-shrink-0 cursor-col-resize relative group"
          aria-label="Resize chat panel"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] bg-transparent group-hover:bg-linear-accent/60 transition-colors duration-150" />
        </button>

        <div className="flex-1 flex flex-col bg-linear-bg border-l border-linear-border overflow-hidden">
          <header className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-linear-border">
            <span className="text-xs font-medium text-linear-text-secondary uppercase tracking-wide">
              Brainstorm
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={handleNewChat}
                aria-label="New chat"
                className="flex h-6 w-6 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-secondary transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={closeSidebar}
                aria-label="Close chat"
                className="flex h-6 w-6 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-secondary transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>

          {hasMessages ? (
            <ChatMessageList
              messages={messages}
              streamingContent={streamingContent}
              activeToolCalls={activeToolCalls}
              isThinking={isThinking}
              className="flex-1"
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 gap-8">
                <ChatEmptyState />
                <ChatSuggestions onSelect={handleSend} />
              </div>
              {recentSessions.length > 0 && (
                <div className="shrink-0 border-t border-linear-border px-2 py-2">
                  <p className="px-2 pb-1.5 text-[10px] uppercase tracking-wide text-linear-text-tertiary">
                    Recent
                  </p>
                  <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                    {recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => handleLoadSession(session.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors text-left",
                          session.id === activeSessionId
                            ? "bg-linear-bg-tertiary text-linear-text"
                            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-secondary",
                        )}
                      >
                        <MessageSquare className="h-3 w-3 shrink-0 text-linear-text-tertiary" />
                        <span className="flex-1 truncate">{session.title || "New chat"}</span>
                        <span className="shrink-0 text-[10px] text-linear-text-tertiary">
                          {relativeTime(session.lastMessageAt || session.createdAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="shrink-0 border-t border-linear-border px-3 py-2.5">
            <ChatComposer
              onSend={handleSend}
              onStop={stop}
              isStreaming={isStreaming}
              disabled={composerDisabled}
              placeholder={composerPlaceholder}
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
