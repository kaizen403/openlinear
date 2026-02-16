"use client"

import { useState, useEffect, useCallback, Suspense } from "react"
import { useSearchParams } from "next/navigation"
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
  Loader2,
  Pencil,
  GitBranch,
  Lock,
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
import {
  fetchProjects,
  fetchTeams,
  createProject,
  updateProject,
  deleteProject,
  fetchGitHubRepos,
  getLoginUrl,
  type Project,
  type Team,
  type GitHubRepo,
} from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"

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

function ProjectsContent() {
  const searchParams = useSearchParams()
  const filterTeamId = searchParams.get("teamId") || undefined
  const [activeTab, setActiveTab] = useState("all")
  const [projects, setProjects] = useState<Project[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  // Form state
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    status: "planned" as StatusType,
    teamId: filterTeamId || "" as string,
    targetDate: "",
    sourceType: "none" as "none" | "repo" | "local",
    repoUrl: "",
    localPath: "",
  })
  const [editFormData, setEditFormData] = useState({
    name: "",
    description: "",
    status: "planned" as StatusType,
    teamId: "",
    targetDate: "",
    sourceType: "none" as "none" | "repo" | "local",
    repoUrl: "",
    localPath: "",
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const [repoMode, setRepoMode] = useState<'url' | 'picker'>('url')
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoSearch, setRepoSearch] = useState('')
  const [githubError, setGithubError] = useState<string | null>(null)

  const [editRepoMode, setEditRepoMode] = useState<'url' | 'picker'>('url')
  const [editGithubRepos, setEditGithubRepos] = useState<GitHubRepo[]>([])
  const [editReposLoading, setEditReposLoading] = useState(false)
  const [editRepoSearch, setEditRepoSearch] = useState('')
  const [editGithubError, setEditGithubError] = useState<string | null>(null)

  const loadGitHubRepos = useCallback(async (isEdit = false) => {
    if (isEdit) {
      setEditReposLoading(true)
      setEditGithubError(null)
    } else {
      setReposLoading(true)
      setGithubError(null)
    }

    try {
      const repos = await fetchGitHubRepos()
      if (isEdit) {
        setEditGithubRepos(repos)
      } else {
        setGithubRepos(repos)
      }
    } catch {
      if (isEdit) {
        setEditGithubError('Failed to fetch GitHub repos')
      } else {
        setGithubError('Failed to fetch GitHub repos')
      }
    } finally {
      if (isEdit) {
        setEditReposLoading(false)
      } else {
        setReposLoading(false)
      }
    }
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchProjects(filterTeamId)
      setProjects(data)
    } catch (error) {
      console.error("Failed to fetch projects:", error)
    }
  }, [filterTeamId])

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

  useSSESubscription((eventType) => {
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
        teamIds: formData.teamId ? [formData.teamId] : undefined,
        targetDate: formData.targetDate ? new Date(formData.targetDate).toISOString() : undefined,
        color: "#3b82f6",
        repoUrl: formData.sourceType === "repo" ? formData.repoUrl.trim() : undefined,
        localPath: formData.sourceType === "local" ? formData.localPath.trim() : undefined,
      })

      setFormData({
        name: "",
        description: "",
        status: "planned",
        teamId: "",
        targetDate: "",
        sourceType: "none",
        repoUrl: "",
        localPath: "",
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

  const handleEditProject = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!editProject) return

    setIsSubmitting(true)
    try {
      await updateProject(editProject.id, {
        name: editFormData.name.trim(),
        description: editFormData.description.trim() || null,
        status: editFormData.status,
        ...(editFormData.teamId ? { teamIds: [editFormData.teamId] } : { teamIds: [] }),
        targetDate: editFormData.targetDate ? new Date(editFormData.targetDate).toISOString() : null,
        repoUrl: editFormData.sourceType === "repo" ? editFormData.repoUrl.trim() : null,
        localPath: editFormData.sourceType === "local" ? editFormData.localPath.trim() : null,
      })

      setIsEditDialogOpen(false)
      setEditProject(null)
      loadProjects()
    } catch (error) {
      console.error("Failed to update project:", error)
    } finally {
      setIsSubmitting(false)
    }
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
                        <Label htmlFor="team" className="text-linear-text">Team</Label>
                        <Select
                          value={formData.teamId}
                          onValueChange={(value) => setFormData(prev => ({ ...prev, teamId: value }))}
                        >
                          <SelectTrigger className="bg-linear-bg-tertiary border-linear-border text-linear-text">
                            <SelectValue placeholder="Select a team" />
                          </SelectTrigger>
                          <SelectContent className="bg-linear-bg border-linear-border">
                            {teams.length === 0 ? (
                              <SelectItem value="no-teams" disabled className="text-linear-text-tertiary">
                                No teams available
                              </SelectItem>
                            ) : (
                              teams.map((team) => (
                                <SelectItem
                                  key={team.id}
                                  value={team.id}
                                  className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text"
                                >
                                  {team.name}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
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

                      <div className="space-y-2">
                        <Label className="text-linear-text">Source</Label>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                            <input
                              type="radio"
                              name="sourceType"
                              value="none"
                              checked={formData.sourceType === "none"}
                              onChange={() => setFormData(prev => ({ ...prev, sourceType: "none", repoUrl: "", localPath: "" }))}
                              className="accent-[hsl(var(--linear-accent))]"
                            />
                            None
                          </label>
                          <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                            <input
                              type="radio"
                              name="sourceType"
                              value="repo"
                              checked={formData.sourceType === "repo"}
                              onChange={() => {
                                setFormData(prev => ({ ...prev, sourceType: "repo", localPath: "" }))
                                setRepoMode('url')
                              }}
                              className="accent-[hsl(var(--linear-accent))]"
                            />
                            GitHub Repo
                          </label>
                          <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                            <input
                              type="radio"
                              name="sourceType"
                              value="local"
                              checked={formData.sourceType === "local"}
                              onChange={() => setFormData(prev => ({ ...prev, sourceType: "local", repoUrl: "" }))}
                              className="accent-[hsl(var(--linear-accent))]"
                            />
                            Local Folder
                          </label>
                        </div>

                        {formData.sourceType === "repo" && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setRepoMode('url')}
                                className={cn(
                                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                  repoMode === 'url'
                                    ? "bg-linear-bg-tertiary text-linear-text"
                                    : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                                )}
                              >
                                Enter URL
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRepoMode('picker')
                                  if (githubRepos.length === 0 && !githubError) {
                                    loadGitHubRepos()
                                  }
                                }}
                                className={cn(
                                  "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                  repoMode === 'picker'
                                    ? "bg-linear-bg-tertiary text-linear-text"
                                    : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                                )}
                              >
                                My Repos
                              </button>
                            </div>

                            {repoMode === 'url' && (
                              <Input
                                value={formData.repoUrl}
                                onChange={(e) => setFormData(prev => ({ ...prev, repoUrl: e.target.value }))}
                                placeholder="https://github.com/owner/repo"
                                className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                              />
                            )}

                            {repoMode === 'picker' && (
                              <div className="space-y-2">
                                {reposLoading ? (
                                  <div className="flex items-center justify-center py-8">
                                    <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
                                  </div>
                                ) : githubError ? (
                                  <div className="text-sm text-linear-text-secondary py-4">
                                    Connect your GitHub account to browse repos.{" "}
                                    <a
                                      href={getLoginUrl()}
                                      className="text-linear-accent hover:underline"
                                    >
                                      Connect GitHub
                                    </a>
                                  </div>
                                ) : (
                                  <>
                                    <Input
                                      value={repoSearch}
                                      onChange={(e) => setRepoSearch(e.target.value)}
                                      placeholder="Search repositories..."
                                      className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                                    />
                                    <div className="max-h-[200px] overflow-y-auto space-y-1">
                                      {githubRepos
                                        .filter(repo =>
                                          repo.full_name.toLowerCase().includes(repoSearch.toLowerCase()) ||
                                          (repo.description?.toLowerCase() || '').includes(repoSearch.toLowerCase())
                                        )
                                        .map(repo => (
                                          <button
                                            key={repo.id}
                                            type="button"
                                            onClick={() => {
                                              setFormData(prev => ({ ...prev, repoUrl: `https://github.com/${repo.full_name}` }))
                                              setRepoMode('url')
                                            }}
                                            className="w-full text-left p-2 rounded-md hover:bg-linear-bg-tertiary transition-colors"
                                          >
                                            <div className="flex items-center gap-2">
                                              <GitBranch className="w-4 h-4 text-linear-text-tertiary" />
                                              <span className="text-sm font-medium text-linear-text">{repo.full_name}</span>
                                              {repo.private && (
                                                <Lock className="w-3 h-3 text-linear-text-tertiary" />
                                              )}
                                            </div>
                                            {repo.description && (
                                              <p className="text-xs text-linear-text-secondary ml-6 line-clamp-1">
                                                {repo.description}
                                              </p>
                                            )}
                                          </button>
                                        ))}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {formData.sourceType === "local" && (
                          <Input
                            value={formData.localPath}
                            onChange={(e) => setFormData(prev => ({ ...prev, localPath: e.target.value }))}
                            placeholder="/absolute/path/to/project"
                            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                          />
                        )}
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
                          <div className="flex items-center gap-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditProject(project)
                                setEditFormData({
                                  name: project.name,
                                  description: project.description || "",
                                  status: project.status,
                                  teamId: project.teams?.[0]?.id || "",
                                  targetDate: project.targetDate ? project.targetDate.split('T')[0] : "",
                                  sourceType: project.repoUrl ? "repo" : project.localPath ? "local" : "none",
                                  repoUrl: project.repoUrl || "",
                                  localPath: project.localPath || "",
                                })
                                setIsEditDialogOpen(true)
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
                            >
                              <Pencil className="w-4 h-4 text-linear-text-secondary" />
                            </button>
                            <button
                              onClick={() => {
                                setProjectToDelete(project)
                                setIsDeleteDialogOpen(true)
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
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

          <div className="block md:hidden space-y-3 p-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-linear-text-tertiary" />
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="text-center py-12 text-linear-text-tertiary">
                {searchQuery ? "No projects match your search" : "No projects yet. Create your first project!"}
              </div>
            ) : (
              filteredProjects.map((project) => (
                <div
                  key={project.id}
                  className="bg-linear-bg-secondary border border-linear-border rounded-lg p-4"
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
                        onClick={() => {
                          setEditProject(project)
                          setEditFormData({
                            name: project.name,
                            description: project.description || "",
                            status: project.status,
                            teamId: project.teams?.[0]?.id || "",
                            targetDate: project.targetDate ? project.targetDate.split('T')[0] : "",
                            sourceType: project.repoUrl ? "repo" : project.localPath ? "local" : "none",
                            repoUrl: project.repoUrl || "",
                            localPath: project.localPath || "",
                          })
                          setIsEditDialogOpen(true)
                        }}
                        className="p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
                      >
                        <Pencil className="w-4 h-4 text-linear-text-secondary" />
                      </button>
                      <button
                        onClick={() => {
                          setProjectToDelete(project)
                          setIsDeleteDialogOpen(true)
                        }}
                        className="p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
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

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[500px] bg-linear-bg border-linear-border">
          <DialogHeader>
            <DialogTitle className="text-linear-text">Edit Project</DialogTitle>
            <DialogDescription className="text-linear-text-secondary">
              Update the project details.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditProject} className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="text-linear-text">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit-name"
                value={editFormData.name}
                onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Project name"
                className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description" className="text-linear-text">Description</Label>
              <Input
                id="edit-description"
                value={editFormData.description}
                onChange={(e) => setEditFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Project description (optional)"
                className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-status" className="text-linear-text">Status</Label>
              <Select
                value={editFormData.status}
                onValueChange={(value) => setEditFormData(prev => ({ ...prev, status: value as StatusType }))}
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
              <Label htmlFor="edit-team" className="text-linear-text">Team</Label>
              <Select
                value={editFormData.teamId || "__none__"}
                onValueChange={(value) => setEditFormData(prev => ({ ...prev, teamId: value === "__none__" ? "" : value }))}
              >
                <SelectTrigger className="bg-linear-bg-tertiary border-linear-border text-linear-text">
                  <SelectValue placeholder="Select a team" />
                </SelectTrigger>
                <SelectContent className="bg-linear-bg border-linear-border">
                  <SelectItem value="__none__" className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text">
                    No team
                  </SelectItem>
                  {teams.map((team) => (
                    <SelectItem
                      key={team.id}
                      value={team.id}
                      className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text"
                    >
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-targetDate" className="text-linear-text">Target Date</Label>
              <Input
                id="edit-targetDate"
                type="date"
                value={editFormData.targetDate}
                onChange={(e) => setEditFormData(prev => ({ ...prev, targetDate: e.target.value }))}
                className="bg-linear-bg-tertiary border-linear-border text-linear-text"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-linear-text">Source</Label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                  <input
                    type="radio"
                    name="edit-sourceType"
                    value="none"
                    checked={editFormData.sourceType === "none"}
                    onChange={() => setEditFormData(prev => ({ ...prev, sourceType: "none", repoUrl: "", localPath: "" }))}
                    className="accent-[hsl(var(--linear-accent))]"
                  />
                  None
                </label>
                <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                  <input
                    type="radio"
                    name="edit-sourceType"
                    value="repo"
                    checked={editFormData.sourceType === "repo"}
                    onChange={() => {
                      setEditFormData(prev => ({ ...prev, sourceType: "repo", localPath: "" }))
                      setEditRepoMode('url')
                    }}
                    className="accent-[hsl(var(--linear-accent))]"
                  />
                  GitHub Repo
                </label>
                <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
                  <input
                    type="radio"
                    name="edit-sourceType"
                    value="local"
                    checked={editFormData.sourceType === "local"}
                    onChange={() => setEditFormData(prev => ({ ...prev, sourceType: "local", repoUrl: "" }))}
                    className="accent-[hsl(var(--linear-accent))]"
                  />
                  Local Folder
                </label>
              </div>

              {editFormData.sourceType === "repo" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditRepoMode('url')}
                      className={cn(
                        "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                        editRepoMode === 'url'
                          ? "bg-linear-bg-tertiary text-linear-text"
                          : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                      )}
                    >
                      Enter URL
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditRepoMode('picker')
                        if (editGithubRepos.length === 0 && !editGithubError) {
                          loadGitHubRepos(true)
                        }
                      }}
                      className={cn(
                        "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                        editRepoMode === 'picker'
                          ? "bg-linear-bg-tertiary text-linear-text"
                          : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                      )}
                    >
                      My Repos
                    </button>
                  </div>

                  {editRepoMode === 'url' && (
                    <Input
                      value={editFormData.repoUrl}
                      onChange={(e) => setEditFormData(prev => ({ ...prev, repoUrl: e.target.value }))}
                      placeholder="https://github.com/owner/repo"
                      className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                    />
                  )}

                  {editRepoMode === 'picker' && (
                    <div className="space-y-2">
                      {editReposLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
                        </div>
                      ) : editGithubError ? (
                        <div className="text-sm text-linear-text-secondary py-4">
                          Connect your GitHub account to browse repos.{" "}
                          <a
                            href={getLoginUrl()}
                            className="text-linear-accent hover:underline"
                          >
                            Connect GitHub
                          </a>
                        </div>
                      ) : (
                        <>
                          <Input
                            value={editRepoSearch}
                            onChange={(e) => setEditRepoSearch(e.target.value)}
                            placeholder="Search repositories..."
                            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                          />
                          <div className="max-h-[200px] overflow-y-auto space-y-1">
                            {editGithubRepos
                              .filter(repo =>
                                repo.full_name.toLowerCase().includes(editRepoSearch.toLowerCase()) ||
                                (repo.description?.toLowerCase() || '').includes(editRepoSearch.toLowerCase())
                              )
                              .map(repo => (
                                <button
                                  key={repo.id}
                                  type="button"
                                  onClick={() => {
                                    setEditFormData(prev => ({ ...prev, repoUrl: `https://github.com/${repo.full_name}` }))
                                    setEditRepoMode('url')
                                  }}
                                  className="w-full text-left p-2 rounded-md hover:bg-linear-bg-tertiary transition-colors"
                                >
                                  <div className="flex items-center gap-2">
                                    <GitBranch className="w-4 h-4 text-linear-text-tertiary" />
                                    <span className="text-sm font-medium text-linear-text">{repo.full_name}</span>
                                    {repo.private && (
                                      <Lock className="w-3 h-3 text-linear-text-tertiary" />
                                    )}
                                  </div>
                                  {repo.description && (
                                    <p className="text-xs text-linear-text-secondary ml-6 line-clamp-1">
                                      {repo.description}
                                    </p>
                                  )}
                                </button>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {editFormData.sourceType === "local" && (
                <Input
                  value={editFormData.localPath}
                  onChange={(e) => setEditFormData(prev => ({ ...prev, localPath: e.target.value }))}
                  placeholder="/absolute/path/to/project"
                  className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                />
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEditDialogOpen(false)
                  setEditProject(null)
                }}
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
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsContent />
    </Suspense>
  )
}
