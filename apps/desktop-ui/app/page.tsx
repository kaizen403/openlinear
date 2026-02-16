"use client"

import { Suspense, useState, useCallback, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Search, FolderKanban, GitBranch, ArrowRight, ArrowLeftRight } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"

import { AppShell } from "@/components/layout/app-shell"
import { useAuth } from "@/hooks/use-auth"
import { fetchProjects, fetchTeams, Project, Team } from "@/lib/api"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"

function HomeContent() {
  const searchParams = useSearchParams()
  const urlTeamId = searchParams.get("teamId")
  const urlProjectId = searchParams.get("projectId")

  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const { isAuthenticated, isLoading, activeRepository } = useAuth()
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)

  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => setProjects([]))
    fetchTeams().then(setTeams).catch(() => setTeams([]))
  }, [])

  useEffect(() => {
    if (urlProjectId) {
      setSelectedProjectId(urlProjectId)
      setSelectedTeamId(null)
    } else if (urlTeamId) {
      setSelectedTeamId(urlTeamId)
      setSelectedProjectId(null)
    } else {
      setSelectedProjectId(null)
      setSelectedTeamId(null)
    }
  }, [urlProjectId, urlTeamId])

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/login')
    }
  }, [isLoading, isAuthenticated, router])

  const handleTaskCreated = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  const rawHeaderLabel = selectedTeamId
    ? teams.find(t => t.id === selectedTeamId)?.name || "Team Issues"
    : selectedProjectId
      ? projects.find(p => p.id === selectedProjectId)?.name || "Project"
        : activeRepository
          ? activeRepository.name
          : "Dashboard"
  const headerLabel = rawHeaderLabel.replace(/openlinear/gi, "Dashboard")

  if (isLoading || !isAuthenticated) {
    return null
  }

  if (!selectedProjectId && !urlProjectId && !urlTeamId) {
    // New user with no projects — show onboarding wizard
    if (projects.length === 0) {
      return (
        <AppShell>
          <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
            <div className="flex items-center gap-4 min-w-0">
              <h1 className="text-lg font-semibold truncate">Dashboard</h1>
            </div>
            <div className="flex-1 h-full" data-tauri-drag-region />
          </header>
          <div className="flex-1 flex items-center justify-center p-6">
            <OnboardingWizard
              teams={teams}
              onComplete={(projectId) => {
                fetchProjects().then(setProjects)
                setSelectedProjectId(projectId)
              }}
            />
          </div>
        </AppShell>
      )
    }

    // Returning user with projects — show project selector
    return (
      <AppShell>
        <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
          <div className="flex items-center gap-4 min-w-0">
            <h1 className="text-lg font-semibold truncate">Dashboard</h1>
          </div>
          <div className="flex-1 h-full" data-tauri-drag-region />
        </header>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md">
            <div className="text-center mb-8">
              <FolderKanban className="w-10 h-10 text-linear-text-tertiary mx-auto mb-3" />
              <h1 className="text-xl font-semibold text-linear-text mb-1">Select a project</h1>
              <p className="text-sm text-linear-text-tertiary">Choose a project to view its board</p>
            </div>

            <div className="flex flex-col gap-2">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => {
                    setSelectedProjectId(project.id)
                    setSelectedTeamId(null)
                  }}
                  className="group flex items-center gap-3 w-full px-4 py-3 rounded-lg bg-linear-bg-secondary border border-linear-border hover:border-linear-border-hover hover:bg-linear-bg-tertiary transition-colors text-left"
                >
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: project.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-linear-text truncate">
                      {project.name}
                    </div>
                    {project.repoUrl ? (
                      <div className="flex items-center gap-1 mt-0.5">
                        <GitBranch className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
                        <span className="text-xs text-linear-text-tertiary truncate">
                          {project.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                        </span>
                      </div>
                    ) : project.localPath ? (
                      <div className="flex items-center gap-1 mt-0.5">
                        <FolderKanban className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
                        <span className="text-xs text-linear-text-tertiary truncate">
                          {project.localPath}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {project._count?.tasks !== undefined && (
                    <span className="text-xs text-linear-text-tertiary flex-shrink-0">
                      {project._count.tasks} {project._count.tasks === 1 ? "issue" : "issues"}
                    </span>
                  )}
                  <ArrowRight className="w-4 h-4 text-linear-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </AppShell>
    )
  }


  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {headerLabel}
          </h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <button
            onClick={() => {
              setSelectedProjectId(null)
              setSelectedTeamId(null)
            }}
            className="flex items-center gap-1.5 h-8 px-2.5 text-xs rounded-md bg-linear-bg-tertiary border border-linear-border hover:border-linear-border-hover text-linear-text transition-colors"
          >
            <ArrowLeftRight className="w-3.5 h-3.5 text-linear-text-tertiary" />
            Switch project
          </button>

          <div className="relative hidden sm:block">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
            <input
              type="text"
              placeholder="Search issues..."
              className="w-full max-w-64 h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
            />
          </div>
          <button className="sm:hidden w-9 h-9 rounded-md flex items-center justify-center text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors">
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsTaskFormOpen(true)}
            className="flex items-center h-9 px-3 sm:px-4 rounded-md bg-linear-bg-tertiary hover:bg-linear-bg-secondary border border-linear-border text-linear-text text-sm font-medium transition-colors"
          >
            <span className="hidden sm:inline">+ Issues</span>
          </button>

        </div>
      </header>

      <KanbanBoard
        key={refreshKey}
        projectId={selectedProjectId}
        teamId={selectedTeamId}
        projects={projects}
      />
      <TaskFormDialog
        open={isTaskFormOpen}
        onOpenChange={setIsTaskFormOpen}
        onSuccess={handleTaskCreated}
        defaultProjectId={selectedProjectId}
        projects={projects}
      />
    </AppShell>
  )
}

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  )
}
