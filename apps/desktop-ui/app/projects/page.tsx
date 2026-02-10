"use client"

import { useState, useEffect, useCallback } from "react"
import { 
  Search, 
  Plus, 
  FolderKanban, 
  Target, 
  Hexagon, 
  Filter,
  Calendar,
  TrendingUp,
  Trash2,
  Loader2
} from "lucide-react"
import { AppShell } from "@/components/layout/app-shell"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { fetchProjects, fetchTeams, createProject, deleteProject, type Project, type Team } from "@/lib/api"
import { useSSE } from "@/hooks/use-sse"

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

type StatusType = 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled'

const statusConfig: Record<StatusType, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  planned: { label: "Planned", variant: "outline" },
  in_progress: { label: "In Progress", variant: "default" },
  paused: { label: "Paused", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  cancelled: { label: "Cancelled", variant: "destructive" }
}

const statusOptions = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const

function ProjectIcon({ type, color }: { type: string | null; color: string }) {
  const iconClass = "w-3.5 h-3.5 text-linear-text-secondary"
  return (
    <div 
      className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border border-linear-border"
      style={{ backgroundColor: color || '#3b82f6' }}
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

export default function ProjectsPage() {
  const [activeTab, setActiveTab] = useState("all")
  const [projects, setProjects] = useState<Project[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  // Form state
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    status: "planned" as StatusType,
    teamIds: [] as string[],
    targetDate: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchProjects()
      setProjects(data)
    } catch (error) {
      console.error("Failed to fetch projects:", error)
    }
  }, [])

  const loadTeams = useCallback(async () => {
    try {
      const data = await fetchTeams()
      setTeams(data)
    } catch (error) {
      console.error("Failed to fetch teams:", error)
    }
  }, [])

  useEffect(() => {
    setIsLoading(true)
    Promise.all([loadProjects(), loadTeams()]).finally(() => {
      setIsLoading(false)
    })
  }, [loadProjects, loadTeams])

  useSSE(`${API_URL}/api/events`, (eventType) => {
    if (['project:created', 'project:updated', 'project:deleted'].includes(eventType)) {
      loadProjects()
    }
    if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
      loadTeams()
    }
  })

  const filteredProjects = projects.filter((project) => {
    if (activeTab === "active") {
      if (project.status !== "in_progress") return false
    } else if (activeTab === "archived") {
      if (!["completed", "cancelled"].includes(project.status)) return false
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        project.name.toLowerCase().includes(query) ||
        (project.description?.toLowerCase() || "").includes(query)
      )
    }
    
    return true
  })

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    
    if (!formData.name.trim()) {
      errors.name = "Name is required"
    }
    
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!validateForm()) return
    
    setIsSubmitting(true)
    try {
      await createProject({
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        status: formData.status,
        teamIds: formData.teamIds.length > 0 ? formData.teamIds : undefined,
        targetDate: formData.targetDate || undefined,
        color: "#3b82f6",
      })
      
      setFormData({
        name: "",
        description: "",
        status: "planned",
        teamIds: [],
        targetDate: "",
      })
      setIsCreateDialogOpen(false)
      loadProjects()
    } catch (error) {
      console.error("Failed to create project:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteProject = async () => {
    if (!projectToDelete) return
    
    setIsSubmitting(true)
    try {
      await deleteProject(projectToDelete.id)
      setIsDeleteDialogOpen(false)
      setProjectToDelete(null)
      loadProjects()
    } catch (error) {
      console.error("Failed to delete project:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const toggleTeamSelection = (teamId: string) => {
    setFormData(prev => ({
      ...prev,
      teamIds: prev.teamIds.includes(teamId)
        ? prev.teamIds.filter(id => id !== teamId)
        : [...prev.teamIds, teamId]
    }))
  }

  return (
    <AppShell>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto">
                <h1 className="text-xl font-semibold text-linear-text flex-shrink-0">Projects</h1>
                <div className="flex items-center gap-1">
                  <button 
                    onClick={() => setActiveTab("all")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      activeTab === "all" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    All projects
                  </button>
                  <button 
                    onClick={() => setActiveTab("active")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      activeTab === "active" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    Active
                  </button>
                  <button 
                    onClick={() => setActiveTab("archived")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      activeTab === "archived" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    Archived
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" size="sm" className="h-8 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text">
                  <TrendingUp className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">New view</span>
                </Button>
                <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                      <Plus className="w-4 h-4 mr-1.5" />
                      <span className="hidden sm:inline">Add project</span>
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[500px] bg-linear-bg border-linear-border">
                    <DialogHeader>
                      <DialogTitle className="text-linear-text">Create Project</DialogTitle>
                      <DialogDescription className="text-linear-text-secondary">
                        Create a new project to organize your tasks.
                      </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleCreateProject} className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="name" className="text-linear-text">
                          Name <span className="text-red-500">*</span>
                        </Label>
                        <Input
                          id="name"
                          value={formData.name}
                          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                          placeholder="Project name"
                          className={cn(
                            "bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary",
                            formErrors.name && "border-red-500"
                          )}
                        />
                        {formErrors.name && (
                          <p className="text-xs text-red-500">{formErrors.name}</p>
                        )}
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="description" className="text-linear-text">Description</Label>
                        <Input
                          id="description"
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          placeholder="Project description (optional)"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                        />
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="status" className="text-linear-text">Status</Label>
                        <Select
                          value={formData.status}
                          onValueChange={(value) => setFormData(prev => ({ ...prev, status: value as StatusType }))}
                        >
                          <SelectTrigger className="bg-linear-bg-tertiary border-linear-border text-linear-text">
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                          <SelectContent className="bg-linear-bg border-linear-border">
                            {statusOptions.map((option) => (
                              <SelectItem 
                                key={option.value} 
                                value={option.value}
                                className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text"
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-2">
                        <Label className="text-linear-text">Teams</Label>
                        <div className="max-h-32 overflow-y-auto space-y-2 border border-linear-border rounded-md p-3 bg-linear-bg-tertiary">
                          {teams.length === 0 ? (
                            <p className="text-sm text-linear-text-tertiary">No teams available</p>
                          ) : (
                            teams.map((team) => (
                              <div key={team.id} className="flex items-center space-x-2">
                                <Checkbox
                                  id={`team-${team.id}`}
                                  checked={formData.teamIds.includes(team.id)}
                                  onCheckedChange={() => toggleTeamSelection(team.id)}
                                  className="border-linear-border data-[state=checked]:bg-linear-accent data-[state=checked]:border-linear-accent"
                                />
                                <Label
                                  htmlFor={`team-${team.id}`}
                                  className="text-sm text-linear-text cursor-pointer"
                                >
                                  {team.name}
                                </Label>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="targetDate" className="text-linear-text">Target Date</Label>
                        <Input
                          id="targetDate"
                          type="date"
                          value={formData.targetDate}
                          onChange={(e) => setFormData(prev => ({ ...prev, targetDate: e.target.value }))}
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                        />
                      </div>
                      
                      <DialogFooter className="gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setIsCreateDialogOpen(false)}
                          className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={isSubmitting}
                          className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                        >
                          {isSubmitting ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Creating...
                            </>
                          ) : (
                            "Create Project"
                          )}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
                <input
                  type="text"
                  placeholder="Filter projects..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
                />
              </div>
              <Button variant="outline" size="sm" className="h-9 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary">
                <Filter className="w-4 h-4 mr-1.5" />
                Filter
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
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
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-linear-text-tertiary" />
                    </td>
                  </tr>
                ) : filteredProjects.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-linear-text-tertiary">
                      {searchQuery ? "No projects match your search" : "No projects yet. Create your first project!"}
                    </td>
                  </tr>
                ) : (
                  filteredProjects.map((project) => (
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
                        <button 
                          onClick={() => {
                            setProjectToDelete(project)
                            setIsDeleteDialogOpen(true)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[400px] bg-linear-bg border-linear-border">
          <DialogHeader>
            <DialogTitle className="text-linear-text">Delete Project</DialogTitle>
            <DialogDescription className="text-linear-text-secondary">
              Are you sure you want to delete &quot;{projectToDelete?.name}&quot;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setIsDeleteDialogOpen(false)
                setProjectToDelete(null)
              }}
              className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeleteProject}
              disabled={isSubmitting}
              variant="destructive"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
