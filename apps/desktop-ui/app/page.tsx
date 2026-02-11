"use client"

import { Suspense, useState, useCallback, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Search, Plus, FolderKanban } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"
import { RepoConnector } from "@/components/repo-connector"

import { AppShell } from "@/components/layout/app-shell"
import { useAuth } from "@/hooks/use-auth"
import { fetchProjects, fetchTeams, Project, Team } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function HomeContent() {
  const searchParams = useSearchParams()
  const urlTeamId = searchParams.get("teamId")
  const urlProjectId = searchParams.get("projectId")

  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const { isAuthenticated, isLoading, activeRepository, refreshActiveRepository } = useAuth()
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

  const handleRepoConnected = useCallback(() => {
    refreshActiveRepository()
    setRefreshKey((prev) => prev + 1)
  }, [refreshActiveRepository])

  const headerLabel = selectedTeamId
    ? teams.find(t => t.id === selectedTeamId)?.name || "Team Issues"
    : selectedProjectId
      ? projects.find(p => p.id === selectedProjectId)?.name || "Project"
        : activeRepository
          ? activeRepository.name
          : "Dashboard"

  if (isLoading || !isAuthenticated) {
    return null
  }

  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4" data-tauri-drag-region>
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {headerLabel}
          </h1>
          {!isAuthenticated && <RepoConnector onRepoConnected={handleRepoConnected} />}
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <Select
            value={selectedProjectId || "all"}
            onValueChange={(value) => {
              setSelectedProjectId(value === "all" ? null : value)
              setSelectedTeamId(null)
            }}
          >
            <SelectTrigger className="h-8 w-auto min-w-[140px] px-2.5 text-xs rounded-md bg-linear-bg-tertiary border border-linear-border hover:border-linear-border-hover text-linear-text gap-1.5 focus:ring-0 shadow-none">
              <div className="flex items-center gap-1.5">
                <FolderKanban className="w-3.5 h-3.5 text-linear-text-tertiary" />
                <SelectValue placeholder="Any project">
                  {selectedProjectId
                    ? projects.find((p) => p.id === selectedProjectId)?.name || "Any project"
                    : "Any project"}
                </SelectValue>
              </div>
            </SelectTrigger>
            <SelectContent className="bg-linear-bg-secondary border-linear-border">
              <SelectItem
                value="all"
                className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
              >
                <div className="flex items-center gap-2">
                  <FolderKanban className="w-3.5 h-3.5 text-linear-text-tertiary" />
                  Any project
                </div>
              </SelectItem>
              {projects.map((project) => (
                <SelectItem
                  key={project.id}
                  value={project.id}
                  className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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

      <KanbanBoard key={refreshKey} projectId={selectedProjectId} teamId={selectedTeamId} />
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
