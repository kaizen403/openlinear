"use client"

import { useState, useEffect, useCallback, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Search, Plus, Filter, TrendingUp, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { useProjects, mapErrorToForm, projectToFormData, type ProjectFormData } from "@/hooks/use-projects"
import { ProjectFormDialog } from "@/components/projects/project-form-dialog"
import { ProjectList } from "@/components/projects/project-list"
import type { Project } from "@/lib/api"

function ProjectsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const filterTeamId = searchParams.get("teamId") || undefined
  const editProjectId = searchParams.get("editProjectId")

  const {
    projects,
    isLoading,
    handleCreateProject,
    handleUpdateProject,
    handleDeleteProject,
  } = useProjects(filterTeamId)

  const [activeTab, setActiveTab] = useState("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDesktopApp, setIsDesktopApp] = useState(false)

  useEffect(() => {
    const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    setIsDesktopApp(tauri)
  }, [])

  useEffect(() => {
    if (!editProjectId) return
    if (projects.length === 0) return
    const project = projects.find((p) => p.id === editProjectId)
    if (!project) return
    setEditProject(project)
    setIsEditDialogOpen(true)
  }, [editProjectId, projects])

  const handleEditDialogOpenChange = (open: boolean) => {
    setIsEditDialogOpen(open)
    if (!open) {
      setEditProject(null)
      const params = new URLSearchParams(searchParams.toString())
      if (params.has('editProjectId')) {
        params.delete('editProjectId')
        const qs = params.toString()
        router.replace(qs ? `/projects?${qs}` : '/projects', { scroll: false })
      }
    }
  }

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

  const onCreateSubmit = async (formData: ProjectFormData) => {
    await handleCreateProject(formData, isDesktopApp)
  }

  const onEditSubmit = async (formData: ProjectFormData) => {
    if (!editProject) return
    await handleUpdateProject(editProject.id, formData, isDesktopApp, editProject.localPath)
  }

  const onDeleteConfirm = async () => {
    if (!projectToDelete) return
    setIsSubmitting(true)
    try {
      await handleDeleteProject(projectToDelete.id)
      setIsDeleteDialogOpen(false)
      setProjectToDelete(null)
    } catch (error) {
      const { toastMessage } = mapErrorToForm(
        error,
        "Could not reach OpenLinear server. Check your connection and try again.",
      )
      toast.error(`Failed to delete project: ${toastMessage}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto">
                <h1 className="text-xl font-semibold text-linear-text flex-shrink-0">Projects</h1>
                <div className="flex items-center gap-1">
                  {(["all", "active", "archived"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={cn(
                        "px-3 py-1.5 rounded-sm text-sm font-medium transition-colors whitespace-nowrap",
                        activeTab === tab
                          ? "bg-linear-bg-tertiary text-linear-text"
                          : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                      )}
                    >
                      {tab === "all" ? "All projects" : tab === "active" ? "Active" : "Archived"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" size="sm" className="h-8 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text">
                  <TrendingUp className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">New view</span>
                </Button>
                <Button
                  size="sm"
                  className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white"
                  onClick={() => setIsCreateDialogOpen(true)}
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">Add project</span>
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
                <input
                  type="text"
                  placeholder="Filter projects..."
                  aria-label="Filter projects"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-9 pl-10 pr-4 rounded-sm bg-linear-bg-tertiary border border-linear-border text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
                />
              </div>
              <Button variant="outline" size="sm" className="h-9 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary">
                <Filter className="w-4 h-4 mr-1.5" />
                Filter
              </Button>
            </div>
          </div>
        </div>

        <ProjectList
          projects={filteredProjects}
          isLoading={isLoading}
          searchQuery={searchQuery}
          onEdit={(project) => {
            setEditProject(project)
            setIsEditDialogOpen(true)
          }}
          onDelete={(project) => {
            setProjectToDelete(project)
            setIsDeleteDialogOpen(true)
          }}
        />
      </div>

      {/* Create dialog */}
      <ProjectFormDialog
        mode="create"
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        isDesktopApp={isDesktopApp}
        onSubmit={onCreateSubmit}
      />

      {/* Edit dialog */}
      <ProjectFormDialog
        mode="edit"
        open={isEditDialogOpen}
        onOpenChange={handleEditDialogOpenChange}
        project={editProject}
        isDesktopApp={isDesktopApp}
        onSubmit={onEditSubmit}
      />

      {/* Delete confirmation dialog */}
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
              onClick={onDeleteConfirm}
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
    </>
  )
}

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsContent />
    </Suspense>
  )
}
