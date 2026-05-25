"use client"

import { useCallback, useEffect, useRef } from "react"
import { Plus } from "lucide-react"
import { useProject } from "@/hooks/use-project"
import { useChatSessions } from "@/hooks/use-chat-sessions"
import { useChatStream } from "@/hooks/use-chat-stream"
import { useChatPanelHandoff } from "@/hooks/use-chat-panel-handoff"
import {
  ChatComposer,
  ChatMessageList,
  ChatSessionStrip,
  ChatEmptyState,
  ChatSuggestions,
  ScopePicker,
} from "@/components/chat"
import { fetchChatSession } from "@/lib/api/chat"

type ChatPanelProps = {
  showHeader?: boolean
  className?: string
}

export function ChatPanel({ showHeader = true, className }: ChatPanelProps) {
  const { activeProject } = useProject()
  const { sessions, activeSessionId, setActiveSessionId, createSession } = useChatSessions()
  const { messages, status, streamingContent, activeToolCalls, send, stop, reset, loadHistory } = useChatStream()
  const { consumeQuery } = useChatPanelHandoff()

  const handleLoadSession = useCallback(async (sessionId: string) => {
    setActiveSessionId(sessionId)
    reset()
    try {
      const session = await fetchChatSession(sessionId)
      if (session.messages) {
        loadHistory(session.messages)
      }
    } catch {}
  }, [setActiveSessionId, reset, loadHistory])

  const handleSend = useCallback(async (content: string) => {
    if (!activeProject) return
    let sessionId = activeSessionId
    if (!sessionId) {
      const session = await createSession(activeProject.id)
      if (!session) return
      sessionId = session.id
      setActiveSessionId(sessionId)
    }
    send(sessionId, content)
  }, [activeProject, activeSessionId, createSession, setActiveSessionId, send])

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null)
    reset()
  }, [setActiveSessionId, reset])

  const handoffDrainedRef = useRef(false)
  useEffect(() => {
    if (handoffDrainedRef.current) return
    if (!activeProject) return
    const pending = consumeQuery()
    if (pending) {
      handoffDrainedRef.current = true
      void handleSend(pending)
    }
  }, [activeProject, consumeQuery, handleSend])

  const hasMessages = messages.length > 0
  const isStreaming = status === "streaming"
  const isThinking = isStreaming && !streamingContent
  const composerPlaceholder = activeProject
    ? `Ask about ${activeProject.name.toLowerCase()}...`
    : "Select a project to start..."
  const composerDisabled = !activeProject

  return (
    <div className={`flex flex-1 flex-col min-h-0 bg-linear-bg overflow-hidden ${className ?? ""}`}>
      {showHeader && (
        <header className="min-h-14 shrink-0 border-b border-linear-border bg-linear-bg/95 px-4 sm:px-6" data-tauri-drag-region>
          <div className="flex h-14 items-center gap-3">
            <div className="min-w-0 flex-1" data-tauri-drag-region>
              <p className="text-sm font-medium text-linear-text">Chat</p>
              <p className="hidden text-xs text-linear-text-tertiary sm:block">
                Grounded in the selected project
              </p>
            </div>
            <ScopePicker />
            <button
              type="button"
              onClick={handleNewChat}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-linear-border bg-linear-bg-secondary px-3 text-xs font-medium text-linear-text-secondary transition-colors hover:border-linear-border-hover hover:bg-linear-bg-tertiary hover:text-linear-text"
            >
              <Plus className="h-3.5 w-3.5" />
              New chat
            </button>
          </div>
        </header>
      )}
      {hasMessages ? (
        <>
          <ChatMessageList
            messages={messages}
            streamingContent={streamingContent}
            activeToolCalls={activeToolCalls}
            isThinking={isThinking}
            className="flex-1"
          />
          <div className="shrink-0 border-t border-linear-border bg-linear-bg px-4 py-3">
            <div className="max-w-3xl mx-auto">
              <ChatComposer
                onSend={handleSend}
                onStop={stop}
                isStreaming={isStreaming}
                disabled={composerDisabled}
                placeholder={composerPlaceholder}
              />
            </div>
            <ChatSessionStrip
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={handleLoadSession}
              className="mt-2 max-w-3xl mx-auto"
            />
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-10 p-6 overflow-y-auto">
          <div className="flex flex-col items-center gap-8 w-full max-w-3xl">
            <ChatEmptyState />
            <div className="w-full space-y-3">
              <ChatComposer
                onSend={handleSend}
                onStop={stop}
                isStreaming={isStreaming}
                disabled={composerDisabled}
                placeholder={composerPlaceholder}
                centered
              />
              <ChatSuggestions onSelect={handleSend} />
            </div>
            {sessions.length > 0 && (
              <ChatSessionStrip
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={handleLoadSession}
                className="justify-center"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
