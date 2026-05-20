"use client"

import { Suspense, useState, useCallback, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Search, Plus } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"

import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { fetchTeams, Team } from "@/lib/api"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"
import { Skeleton } from "@/components/ui/skeleton"

function HomePageSkeleton() {
  return (
    <main className="flex flex-1 flex-col bg-linear-bg">
      <header className="min-h-14 border-b border-linear-border flex items-center px-4 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4">
        <Skeleton className="h-5 w-36" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-20" />
        </div>
      </header>
      <div className="flex-1 p-4 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, columnIndex) => (
            <div
              key={columnIndex}
              className="rounded-sm border border-linear-border bg-linear-bg-secondary p-3"
            >
              <Skeleton className="mb-3 h-4 w-24" />
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, cardIndex) => (
                  <Skeleton key={cardIndex} className="h-24 w-full" />
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
  const searchParams = useSearchParams()
  const urlTeamId = searchParams.get("teamId")

  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const { isAuthenticated, isLoading, user } = useAuth()
  const { activeProject, projects, isLoading: isProjectsLoading, refreshProjects } = useProject()
  const { refreshWorkspaces } = useWorkspace()
  const router = useRouter()
  const [teams, setTeams] = useState<Team[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    fetchTeams().then(setTeams).catch(() => setTeams([]))
  }, [isAuthenticated])

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, router])

  const handleTaskCreated = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  const selectedProjectId = urlTeamId ? null : (activeProject?.id ?? null)
  const selectedTeamId = urlTeamId || null

  if (!selectedProjectId && !selectedTeamId) {
    return <HomePageSkeleton />
  }

  const headerLabel = selectedTeamId
    ? teams.find(t => t.id === selectedTeamId)?.name || "Team Issues"
    : activeProject
      ? activeProject.name
      : "Dashboard"

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
      <header className="min-h-14 border-b border-linear-border flex flex-wrap items-center px-3 sm:px-6 py-2 sm:py-0 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {headerLabel}
          </h1>
        </div>
        <div className="hidden sm:block flex-1 h-full" data-tauri-drag-region />
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-auto">
          <div className="relative hidden sm:block">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
            <input
              type="text"
              placeholder="Search issues..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full max-w-64 h-9 pl-10 pr-4 rounded-sm bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={() => setIsMobileSearchOpen((prev) => !prev)}
            className="sm:hidden w-9 h-9 rounded-sm flex items-center justify-center text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
            aria-label="Toggle issue search"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsTaskFormOpen(true)}
            className="flex items-center h-9 px-3 sm:px-4 rounded-sm bg-linear-bg-tertiary hover:bg-linear-bg-secondary border border-linear-border text-linear-text text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            <span>Issue</span>
          </button>
        </div>
        {isMobileSearchOpen && (
          <div className="w-full sm:hidden mt-1">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
              <input
                type="text"
                placeholder="Search issues..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-9 pl-10 pr-4 rounded-sm bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
              />
            </div>
          </div>
        )}
      </header>

      <KanbanBoard
        key={refreshKey}
        projectId={selectedProjectId}
        teamId={selectedTeamId}
        projects={projects}
        searchQuery={searchQuery}
      />
      <TaskFormDialog
        open={isTaskFormOpen}
        onOpenChange={setIsTaskFormOpen}
        onSuccess={handleTaskCreated}
        defaultProjectId={selectedProjectId}
        projects={projects}
      />
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
