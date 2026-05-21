"use client";

import { Suspense, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { useTeams } from "@/providers/teams-provider"
import { useChatSessions } from "@/hooks/use-chat-sessions"
import { useChatStream } from "@/hooks/use-chat-stream"
import { useChatScope } from "@/hooks/use-chat-scope"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { ChatComposer, ChatMessageList, ChatSessionStrip, ChatEmptyState, ChatContextPills, ChatSuggestions } from "@/components/chat"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchChatSession } from "@/lib/api/chat"

function HomePageSkeleton() {
  return (
    <main className="flex flex-1 flex-col bg-linear-bg">
      <div className="flex-1 flex items-center justify-center p-6">
        <Skeleton className="h-12 w-full max-w-3xl rounded-sm" />
      </div>
    </main>
  )
}

function HomeContent() {
  const { isAuthenticated, isLoading } = useAuth()
  const { projects, isLoading: isProjectsLoading, refreshProjects } = useProject()
  const { workspaces, activeWorkspace, isLoading: isWorkspacesLoading, refreshWorkspaces } = useWorkspace()
  const { teams } = useTeams()
  const { sessions, activeSessionId, setActiveSessionId, createSession } = useChatSessions()
  const { messages, status, streamingContent, send, stop, reset, loadHistory } = useChatStream()
  const { scope, setScope } = useChatScope()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, router])

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
    let sessionId = activeSessionId
    if (!sessionId) {
      const session = await createSession(scope === "project" ? undefined : undefined)
      if (!session) return
      sessionId = session.id
      setActiveSessionId(sessionId)
    }
    send(sessionId, content)
  }, [activeSessionId, createSession, scope, setActiveSessionId, send])

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null)
    reset()
  }, [setActiveSessionId, reset])

  if (isLoading || !isAuthenticated || isProjectsLoading || isWorkspacesLoading) {
    return <HomePageSkeleton />
  }

  if (workspaces.length === 0 || projects.length === 0) {
    return (
      <>
        <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
          <h1 className="text-lg font-semibold truncate">Dashboard</h1>
          <div className="flex-1 h-full" data-tauri-drag-region />
        </header>
        <div className="flex-1 flex items-center justify-center p-6">
          <OnboardingWizard
            teams={teams}
            onComplete={() => {
              refreshWorkspaces()
              refreshProjects()
            }}
          />
        </div>
      </>
    )
  }

  const hasMessages = messages.length > 0
  const isStreaming = status === "streaming"

  return (
    <div className="flex flex-1 flex-col bg-linear-bg overflow-hidden">
      {hasMessages ? (
        <>
          <ChatMessageList messages={messages} streamingContent={streamingContent} className="flex-1" />
          <div className="shrink-0 border-t border-linear-border bg-linear-bg px-4 py-3">
            <div className="flex items-center justify-between max-w-3xl mx-auto mb-2">
              <ChatContextPills />
            </div>
            <div className="max-w-3xl mx-auto">
              <ChatComposer
                onSend={handleSend}
                onStop={stop}
                onNewChat={handleNewChat}
                isStreaming={isStreaming}
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
                onNewChat={sessions.length > 0 ? handleNewChat : undefined}
                isStreaming={isStreaming}
                centered
              />
              <ChatContextPills className="justify-center" />
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

export default function HomePage() {
  return (
    <Suspense fallback={<HomePageSkeleton />}>
      <HomeContent />
    </Suspense>
  )
}
