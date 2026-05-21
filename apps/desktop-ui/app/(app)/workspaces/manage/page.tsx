"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Hexagon,
  Users,
  Settings,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/hooks/use-workspace"
import {
  fetchProjects,
  fetchTeams,
  type Project,
  type Team,
  type Workspace,
} from "@/lib/api"
import { Skeleton } from "@/components/ui/skeleton"
import Link from "next/link"

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const [expanded, setExpanded] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const toggle = useCallback(async () => {
    if (!expanded && !loaded) {
      setLoading(true)
      try {
        const data = await fetchProjects({ workspaceId: workspace.id })
        setProjects(data)
        setLoaded(true)
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  }, [expanded, loaded, workspace.id])

  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-linear-bg-tertiary transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
        )}
        <Building2 className="w-4 h-4 text-linear-text-secondary flex-shrink-0" />
        <span className="text-sm font-medium text-linear-text truncate">{workspace.name}</span>
        <span className="text-xs text-linear-text-tertiary ml-auto flex-shrink-0">{workspace.role}</span>
        <Link
          href="/workspaces/manage"
          onClick={(e) => e.stopPropagation()}
          className="p-1 rounded hover:bg-linear-bg-secondary text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
        </Link>
      </button>

      {expanded && (
        <div className="ml-6">
          {loading ? (
            <div className="px-4 py-2 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : projects.length === 0 ? (
            <div className="px-4 py-2 text-xs text-linear-text-tertiary">No projects</div>
          ) : (
            projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ProjectRow({ project }: { project: Project }) {
  const [expanded, setExpanded] = useState(false)
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const toggle = useCallback(async () => {
    if (!expanded && !loaded) {
      setLoading(true)
      try {
        const data = await fetchTeams({ projectId: project.id })
        setTeams(data)
        setLoaded(true)
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  }, [expanded, loaded, project.id])

  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-linear-bg-tertiary transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
        )}
        <Hexagon className="w-3.5 h-3.5 text-linear-text-secondary flex-shrink-0" />
        <span className="text-sm text-linear-text truncate">{project.name}</span>
        <Link
          href={`/projects/manage?id=${project.id}`}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto p-1 rounded hover:bg-linear-bg-secondary text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
        >
          <Settings className="w-3 h-3" />
        </Link>
      </button>

      {expanded && (
        <div className="ml-6">
          {loading ? (
            <div className="px-4 py-1.5">
              <Skeleton className="h-3.5 w-28" />
            </div>
          ) : teams.length === 0 ? (
            <div className="px-4 py-1.5 text-xs text-linear-text-tertiary">No teams</div>
          ) : (
            teams.map((team) => (
              <Link
                key={team.id}
                href={`/teams/manage?id=${team.id}`}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-linear-bg-tertiary transition-colors"
              >
                <Users className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
                <span className="text-xs text-linear-text-secondary truncate">{team.name}</span>
                <span className="text-[10px] text-linear-text-tertiary font-mono ml-auto">{team.key}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function WorkspacesContent() {
  const { workspaces, isLoading } = useWorkspace()

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg" data-tauri-drag-region>
        <div className="flex items-center gap-3">
          <Building2 className="w-5 h-5 text-linear-text-secondary" />
          <h1 className="text-lg font-semibold">Workspaces</h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex-1 overflow-y-auto bg-linear-bg">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="w-4 h-4 rounded" />
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-linear-text-tertiary text-sm">
            <Building2 className="w-8 h-8 mb-2 opacity-40" />
            No workspaces yet
          </div>
        ) : (
          <div className="divide-y divide-linear-border">
            {workspaces.map((ws) => (
              <WorkspaceRow key={ws.id} workspace={ws} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export default function WorkspaceManagePage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-linear-bg" />}>
      <WorkspacesContent />
    </Suspense>
  )
}
