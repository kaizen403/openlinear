"use client";

import { Suspense, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { useTeams } from "@/providers/teams-provider"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { ChatPanel } from "@/components/chat/chat-panel"
import { Skeleton } from "@/components/ui/skeleton"

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
  const { activeProject, projects, isLoading: isProjectsLoading, refreshProjects } = useProject()
  const { workspaces, activeWorkspace, isLoading: isWorkspacesLoading, refreshWorkspaces } = useWorkspace()
  const { teams, reload: reloadTeams } = useTeams()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login/')
    }
  }, [isLoading, isAuthenticated, router])

  if (isLoading || !isAuthenticated || isProjectsLoading || isWorkspacesLoading) {
    return <HomePageSkeleton />
  }

  const onboardingWorkspaceId = activeWorkspace?.id ?? workspaces[0]?.id ?? null
  const projectWithoutTeam = projects.find((project) => {
    const projectTeams = project.teams ?? []
    const visibleTeams = teams.filter((team) => team.projectId === project.id)
    return projectTeams.length === 0 && visibleTeams.length === 0
  }) ?? null

  if (workspaces.length === 0 || projects.length === 0 || projectWithoutTeam) {
    return (
      <>
        <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
          <h1 className="text-lg font-semibold truncate">Dashboard</h1>
          <div className="flex-1 h-full" data-tauri-drag-region />
        </header>
        <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden px-4 py-3">
          <OnboardingWizard
            initialWorkspaceId={onboardingWorkspaceId}
            initialProjectId={projectWithoutTeam?.id ?? null}
            initialProjectName={projectWithoutTeam?.name ?? null}
            onComplete={() => {
              refreshWorkspaces()
              refreshProjects()
              void reloadTeams()
            }}
          />
        </div>
      </>
    )
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
