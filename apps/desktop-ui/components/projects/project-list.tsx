"use client"

import {
  FolderKanban,
  Target,
  Hexagon,
  Calendar,
  Pencil,
  Settings,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { statusConfig, type StatusType } from "@/hooks/use-projects"
import type { Project, Team } from "@/lib/api"
import { useRouter } from "next/navigation"

function ProjectIcon({ type, color }: { type: string | null; color: string }) {
  const iconClass = "w-3.5 h-3.5 text-linear-text-secondary"
  return (
    <div
      className="w-7 h-7 rounded-sm flex items-center justify-center flex-shrink-0 border border-linear-border"
      style={{ backgroundColor: color || '#10b981' }}
    >
      {type === "target" && <Target className={iconClass} />}
      {type === "hexagon" && <Hexagon className={iconClass} />}
      {(!type || type === "folder") && <FolderKanban className={iconClass} />}
    </div>
  )
}

function StatusBadge({ status }: { status: StatusType }) {
  const config = statusConfig[status] || statusConfig.planned
  return (
    <Badge variant={config.variant} className="text-xs">
      {config.label}
    </Badge>
  )
}

function TeamBadges({ teams }: { teams?: Team[] }) {
  if (!teams || teams.length === 0) return <span className="text-sm text-linear-text-tertiary">—</span>

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {teams.slice(0, 3).map((team) => (
        <Badge key={team.id} variant="outline" className="text-xs">
          {team.name}
        </Badge>
      ))}
      {teams.length > 3 && (
        <Badge variant="outline" className="text-xs">
          +{teams.length - 3}
        </Badge>
      )}
    </div>
  )
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "—"
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface ProjectListProps {
  projects: Project[]
  isLoading: boolean
  searchQuery: string
  onEdit: (project: Project) => void
  onDelete: (project: Project) => void
}

export function ProjectList({ projects, isLoading, searchQuery, onEdit, onDelete }: ProjectListProps) {
  const router = useRouter()

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="min-w-[800px]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-linear-border">
                <th className="text-left py-3 px-6 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                  Name
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                  Status
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[180px]">
                  Teams
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[130px]">
                  Target date
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[100px]">
                  Tasks
                </th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-linear-border/50">
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-3">
                        <Skeleton className="w-7 h-7 rounded-sm" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-3.5 w-40 rounded" />
                          <Skeleton className="h-2.5 w-56 rounded" />
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4"><Skeleton className="h-5 w-16 rounded" /></td>
                    <td className="py-3 px-4"><Skeleton className="h-5 w-24 rounded" /></td>
                    <td className="py-3 px-4"><Skeleton className="h-3 w-20 rounded" /></td>
                    <td className="py-3 px-4"><Skeleton className="h-3 w-6 rounded" /></td>
                    <td className="py-3 px-4" />
                  </tr>
                ))
              ) : projects.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-0">
                    <EmptyState
                      icon={FolderKanban}
                      title={searchQuery ? "No projects match your search" : "No projects yet"}
                      description={
                        searchQuery
                          ? "Try adjusting your search query"
                          : "Create your first project to start organizing tasks"
                      }
                    />
                  </td>
                </tr>
              ) : (
                projects.map((project) => (
                  <tr
                    key={project.id}
                    className="border-b border-linear-border/50 hover:bg-linear-bg-secondary/50 transition-colors cursor-pointer group"
                  >
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-3">
                        <ProjectIcon type={project.icon} color={project.color} />
                        <div>
                          <div className="text-sm font-medium text-linear-text">{project.name}</div>
                          {project.description && (
                            <div className="text-xs text-linear-text-tertiary line-clamp-1">{project.description}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={project.status} />
                    </td>
                    <td className="py-3 px-4">
                      <TeamBadges teams={project.teams} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2 text-sm text-linear-text-secondary">
                        <Calendar className="w-3.5 h-3.5 text-linear-text-tertiary" />
                        {formatDate(project.targetDate)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-sm text-linear-text-secondary">
                        {project._count?.tasks || 0}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onEdit(project)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                        >
                          <Pencil className="w-4 h-4 text-linear-text-secondary" />
                        </button>
                        <button
                          type="button"
                          onClick={() => router.push(`/projects/manage?id=${project.id}`)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                        >
                          <Settings className="w-4 h-4 text-linear-text-secondary" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(project)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="block md:hidden space-y-3 p-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-linear-bg-secondary border border-linear-border rounded-sm p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="w-7 h-7 rounded-sm" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40 rounded" />
                  <Skeleton className="h-2.5 w-56 rounded" />
                </div>
              </div>
            </div>
          ))
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title={searchQuery ? "No projects match your search" : "No projects yet"}
            description={
              searchQuery
                ? "Try adjusting your search query"
                : "Create your first project to start organizing tasks"
            }
          />
        ) : (
          projects.map((project) => (
            <div
              key={project.id}
              className="bg-linear-bg-secondary border border-linear-border rounded-sm p-4"
            >
              <div className="flex items-start gap-3">
                <ProjectIcon type={project.icon} color={project.color} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-medium text-linear-text">{project.name}</div>
                    <StatusBadge status={project.status} />
                  </div>
                  {project.description && (
                    <div className="text-xs text-linear-text-tertiary line-clamp-1 mt-1">{project.description}</div>
                  )}
                  <div className="mt-2">
                    <TeamBadges teams={project.teams} />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mt-3 pt-3 border-t border-linear-border/50">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-sm text-linear-text-secondary">
                    <Calendar className="w-3.5 h-3.5 text-linear-text-tertiary" />
                    <span className="text-xs">{formatDate(project.targetDate)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <FolderKanban className="w-3.5 h-3.5 text-linear-text-tertiary" />
                    <span className="text-xs text-linear-text-secondary">
                      {project._count?.tasks || 0}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(project)}
                    className="p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                  >
                    <Pencil className="w-4 h-4 text-linear-text-secondary" />
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/projects/manage?id=${project.id}`)}
                    className="p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                  >
                    <Settings className="w-4 h-4 text-linear-text-secondary" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(project)}
                    className="p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                  >
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
