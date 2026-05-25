"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

/**
 * ChatPanelHandoff coordinates handing off a query from the brainstorm popup
 * to the ChatPanel rendered inside the sidebar drawer.
 *
 * Flow:
 *   popup.onSend(text)
 *     -> queueQuery(text)             // sets pendingQuery + opens sidebar
 *     -> ChatPanel (in sidebar) reads pendingQuery on mount and calls send()
 *     -> ChatPanel calls consumeQuery() so it isn't replayed on remount
 */
type ChatPanelHandoffContextValue = {
  isSidebarOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  toggleSidebar: () => void
  pendingQuery: string | null
  queueQuery: (query: string) => void
  consumeQuery: () => string | null
}

const ChatPanelHandoffContext = createContext<ChatPanelHandoffContextValue | null>(null)

export function ChatPanelHandoffProvider({ children }: { children: ReactNode }) {
  const [isSidebarOpen, setSidebarOpen] = useState(false)
  const [pendingQuery, setPendingQuery] = useState<string | null>(null)

  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), [])

  const queueQuery = useCallback((query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setPendingQuery(trimmed)
    setSidebarOpen(true)
  }, [])

  const consumeQuery = useCallback((): string | null => {
    let captured: string | null = null
    setPendingQuery((current) => {
      captured = current
      return null
    })
    return captured
  }, [])

  const value = useMemo<ChatPanelHandoffContextValue>(
    () => ({
      isSidebarOpen,
      openSidebar,
      closeSidebar,
      toggleSidebar,
      pendingQuery,
      queueQuery,
      consumeQuery,
    }),
    [isSidebarOpen, openSidebar, closeSidebar, toggleSidebar, pendingQuery, queueQuery, consumeQuery],
  )

  return (
    <ChatPanelHandoffContext.Provider value={value}>
      {children}
    </ChatPanelHandoffContext.Provider>
  )
}

export function useChatPanelHandoff(): ChatPanelHandoffContextValue {
  const ctx = useContext(ChatPanelHandoffContext)
  if (!ctx) {
    throw new Error("useChatPanelHandoff must be used inside ChatPanelHandoffProvider")
  }
  return ctx
}
