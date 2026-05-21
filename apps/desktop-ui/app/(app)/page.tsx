"use client"

import { Suspense, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { useTeams } from "@/providers/teams-provider"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { Skeleton } from "@/components/ui/skeleton"

function HomePageSkeleton() {
  return (
    <main className="flex flex-1 flex-col bg-linear-bg">
      <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4">
        <Skeleton className="h-5 w-36" />
      </header>
      <div className="flex-1 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-sm border border-linear-border bg-linear-bg-secondary p-3">
              <Skeleton className="mb-3 h-4 w-24" />
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-24 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

function HomeContent() {
  const { isAuthenticated, isLoading } = useAuth()
  const { projects, isLoading: isProjectsLoading, refreshProjects } = useProject()
  const { refreshWorkspaces } = useWorkspace()
  const { teams } = useTeams()
  const router = useRouter()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, router])

  if (isLoading || !isAuthenticated || isProjectsLoading) {
    return <HomePageSkeleton />
  }

  if (projects.length === 0) {
    return (
      <>
        <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
          <div className="flex items-center gap-4 min-w-0">
            <h1 className="text-lg font-semibold truncate">Dashboard</h1>
          </div>
          <div className="flex-1 h-full" data-tauri-drag-region />
        </header>
        <div className="flex-1 flex items-center justify-center p-6">
          <OnboardingWizard
            teams={teams}
            onComplete={({ workspaceId }) => {
              refreshWorkspaces()
              refreshProjects()
            }}
          />
        </div>
      </>
    )
  }

  return (
    <>
      <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold truncate">Home</h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>
      <div className="flex-1 flex items-center justify-center text-linear-text-tertiary text-sm">
        Select a project from the sidebar to open its board
      </div>
    </>
  )
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomePageSkeleton />}>
      <HomeContent />
    </Suspense>
  )
}
