"use client";

import { Suspense, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { ChatPanel } from "@/components/chat/chat-panel"
import { Skeleton } from "@/components/ui/skeleton"

function HomePageSkeleton() {
  return (
    <main className="flex flex-1 flex-col min-h-0 bg-linear-bg">
      <div className="flex-1 flex items-center justify-center p-6">
        <Skeleton className="h-12 w-full max-w-3xl rounded-sm" />
      </div>
    </main>
  )
}

function HomeContent() {
  const { isAuthenticated, isLoading } = useAuth()
  const { projects, isLoading: isProjectsLoading } = useProject()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login/')
    }
  }, [isLoading, isAuthenticated, router])

  const projectWithoutTeam = projects.find((project) => {
    const projectTeams = project.teams ?? []
    return projectTeams.length === 0
  }) ?? null
  const shouldOpenProjects = projects.length === 0 || Boolean(projectWithoutTeam)

  useEffect(() => {
    if (isLoading || !isAuthenticated || isProjectsLoading) return
    if (shouldOpenProjects) {
      router.replace('/projects')
    }
  }, [isLoading, isAuthenticated, isProjectsLoading, shouldOpenProjects, router])

  if (isLoading || !isAuthenticated || isProjectsLoading || shouldOpenProjects) {
    return <HomePageSkeleton />
  }

  return <ChatPanel />
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomePageSkeleton />}>
      <HomeContent />
    </Suspense>
  )
}
