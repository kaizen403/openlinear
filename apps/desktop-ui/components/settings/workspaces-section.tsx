"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Loader2,
  Network,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { cn } from "@/lib/utils"
import {
  fetchWorkspaces,
  fetchWorkspaceStructure,
  type WorkspaceStructure,
  type WorkspaceStructureProject,
  type WorkspaceStructureTeam,
} from "@/lib/api/workspaces"

function plural(count: number, singular: string, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`
}

function TeamRow({ team }: { team: WorkspaceStructureTeam }) {
  return (
    <Link
      href={`/teams/manage?id=${team.id}`}
      className="group flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-linear-bg-tertiary"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: team.color }} />
      <span className="min-w-0 flex-1 truncate text-sm text-linear-text">{team.name}</span>
      <span className="text-xs text-linear-text-tertiary">{team.key}</span>
      <span className="text-xs text-linear-text-tertiary">{plural(team.members.length, "member")}</span>
    </Link>
  )
}

function ProjectRow({ project }: { project: WorkspaceStructureProject }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-linear-bg-tertiary"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-linear-text-tertiary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-linear-text-tertiary" />
        )}
        <FolderKanban className="h-3.5 w-3.5 shrink-0 text-linear-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-linear-text">{project.name}</span>
        {project.key && <span className="text-xs text-linear-text-tertiary">{project.key}</span>}
        <span className="text-xs text-linear-text-tertiary">{plural(project.teams.length, "team")}</span>
        <span className="text-xs text-linear-text-tertiary">{plural(project._count?.tasks ?? 0, "task")}</span>
        <Link
          href={`/projects/manage?id=${project.id}`}
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 text-linear-text-tertiary hover:text-linear-text transition-opacity"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Link>
      </button>
      {expanded && (
        <div className="ml-6 border-l border-linear-border pl-3">
          {project.teams.length > 0 ? (
            project.teams.map((team) => <TeamRow key={team.id} team={team} />)
          ) : (
            <p className="px-2 py-1.5 text-xs text-linear-text-tertiary">No teams yet</p>
          )}
        </div>
      )}
    </div>
  )
}

function WorkspaceRow({ workspace }: { workspace: WorkspaceStructure }) {
  const [expanded, setExpanded] = useState(true)
  const teamCount = workspace.projects.reduce((sum, p) => sum + p.teams.length, 0)

  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-linear-bg-tertiary"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-linear-text-tertiary" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-linear-text-tertiary" />
        )}
        <Building2 className="h-4 w-4 shrink-0 text-linear-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-linear-text">{workspace.name}</span>
        <span className="text-xs text-linear-text-tertiary">{workspace.slug}</span>
        <span className="text-xs text-linear-text-tertiary">{plural(workspace.projects.length, "project")}</span>
        <span className="text-xs text-linear-text-tertiary">{plural(teamCount, "team")}</span>
        <span className="text-xs text-linear-text-tertiary">{plural(workspace.members.length, "member")}</span>
        <Link
          href="/settings?section=workspace-general"
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 text-linear-text-tertiary hover:text-linear-text transition-opacity"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Link>
      </button>
      {expanded && (
        <div className="border-t border-linear-border px-3 py-2">
          <div className="ml-4 border-l border-linear-border pl-3">
            {workspace.projects.length > 0 ? (
              workspace.projects.map((project) => <ProjectRow key={project.id} project={project} />)
            ) : (
              <p className="px-2 py-1.5 text-xs text-linear-text-tertiary">No projects yet</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkspacesSection() {
  const [workspaces, setWorkspaces] = useState<WorkspaceStructure[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadWorkspaces = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const baseWorkspaces = await fetchWorkspaces()
      const structures = await Promise.all(baseWorkspaces.map((ws) => fetchWorkspaceStructure(ws.id)))
      setWorkspaces(structures)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  const totals = useMemo(() => {
    return workspaces.reduce(
      (acc, ws) => {
        acc.projects += ws.projects.length
        acc.teams += ws.projects.reduce((sum, p) => sum + p.teams.length, 0)
        acc.members += ws.members.length
        return acc
      },
      { projects: 0, teams: 0, members: 0 },
    )
  }, [workspaces])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-linear-text">Workspaces</h2>
          <p className="mt-0.5 text-sm text-linear-text-tertiary">
            Workspace → Projects → Teams → Members
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void loadWorkspaces()}
          disabled={isLoading}
          className="text-linear-text-secondary hover:text-linear-text"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-sm border border-linear-border bg-linear-bg-secondary px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FolderKanban className="h-3.5 w-3.5 text-linear-text-tertiary" />
            <span className="text-xs text-linear-text-tertiary">Projects</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-linear-text">{totals.projects}</p>
        </div>
        <div className="rounded-sm border border-linear-border bg-linear-bg-secondary px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Network className="h-3.5 w-3.5 text-linear-text-tertiary" />
            <span className="text-xs text-linear-text-tertiary">Teams</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-linear-text">{totals.teams}</p>
        </div>
        <div className="rounded-sm border border-linear-border bg-linear-bg-secondary px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-linear-text-tertiary" />
            <span className="text-xs text-linear-text-tertiary">Members</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-linear-text">{totals.members}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center rounded-sm border border-linear-border bg-linear-bg-secondary py-12">
          <Loader2 className="h-5 w-5 animate-spin text-linear-text-secondary" />
        </div>
      ) : error ? (
        <div className="rounded-sm border border-linear-border bg-linear-bg-secondary p-6">
          <EmptyState
            icon={Building2}
            title="Couldn't load workspaces"
            description={error}
            action={
              <Button onClick={() => void loadWorkspaces()} size="sm">
                Try again
              </Button>
            }
          />
        </div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-sm border border-linear-border bg-linear-bg-secondary p-6">
          <EmptyState
            icon={Building2}
            title="No workspaces"
            description="Create a workspace to organize your projects and teams."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {workspaces.map((ws) => <WorkspaceRow key={ws.id} workspace={ws} />)}
        </div>
      )}
    </div>
  )
}
