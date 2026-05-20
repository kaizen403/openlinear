"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  Users,
  Trash2,
  User,
  Shield,
  Eye,
  Ban,
  Plus,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  updateProject,
  deleteProject,
  fetchProjectAccess,
  grantProjectAccess,
  revokeProjectAccess,
  fetchWorkspaceMembers,
  type Project,
  type ProjectAccess,
  type ProjectPermission,
  type WorkspaceMember,
} from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { toast } from "sonner"

const permissionLabels: Record<ProjectPermission, string> = {
  full: "Full access",
  view: "View only",
  deny: "Denied",
}

const permissionIcons: Record<ProjectPermission, typeof Shield> = {
  full: Shield,
  view: Eye,
  deny: Ban,
}

export default function ProjectManagePage() {
  return (
    <Suspense fallback={null}>
      <ProjectManageContent />
    </Suspense>
  )
}

function ProjectManageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = searchParams.get("id") ?? ""
  const { refreshProjects } = useProject()
  const { activeWorkspace } = useWorkspace()

  const [project, setProject] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [projectName, setProjectName] = useState("")
  const [projectDescription, setProjectDescription] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const [access, setAccess] = useState<ProjectAccess[]>([])
  const [isLoadingAccess, setIsLoadingAccess] = useState(false)
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([])

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<{ userId: string; username: string } | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  const [grantUserId, setGrantUserId] = useState("")
  const [grantPermission, setGrantPermission] = useState<ProjectPermission>("full")
  const [isGranting, setIsGranting] = useState(false)

  const loadProject = useCallback(async () => {
    if (!projectId) return
    try {
      setIsLoading(true)
      const data = await apiFetch<Project>(`/api/projects/${projectId}`)
      setProject(data)
      setProjectName(data.name)
      setProjectDescription(data.description || "")
    } catch {
      toast.error("Failed to load project")
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  const loadAccess = useCallback(async () => {
    if (!projectId) return
    try {
      setIsLoadingAccess(true)
      const data = await fetchProjectAccess(projectId)
      setAccess(data)
    } catch {
    } finally {
      setIsLoadingAccess(false)
    }
  }, [projectId])

  const loadMembers = useCallback(async () => {
    if (!activeWorkspace) return
    try {
      const data = await fetchWorkspaceMembers(activeWorkspace.id)
      setWorkspaceMembers(data)
    } catch {
    }
  }, [activeWorkspace])

  useEffect(() => {
    loadProject()
    loadAccess()
    loadMembers()
  }, [loadProject, loadAccess, loadMembers])

  const handleSave = async () => {
    if (!projectId || !projectName.trim()) return
    try {
      setIsSaving(true)
      const updated = await updateProject(projectId, {
        name: projectName.trim(),
        description: projectDescription.trim() || null,
      })
      setProject(updated)
      refreshProjects()
      toast.success("Project updated")
    } catch {
      toast.error("Failed to update project")
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!projectId) return
    try {
      setIsDeleting(true)
      await deleteProject(projectId)
      refreshProjects()
      toast.success("Project deleted")
      router.push("/projects")
    } catch {
      toast.error("Failed to delete project")
    } finally {
      setIsDeleting(false)
      setIsDeleteDialogOpen(false)
    }
  }

  const handleGrantAccess = async () => {
    if (!projectId || !grantUserId) return
    try {
      setIsGranting(true)
      await grantProjectAccess(projectId, grantUserId, grantPermission)
      setGrantUserId("")
      setGrantPermission("full")
      await loadAccess()
      toast.success("Access granted")
    } catch {
      toast.error("Failed to grant access")
    } finally {
      setIsGranting(false)
    }
  }

  const handleRevoke = async () => {
    if (!projectId || !revokeTarget) return
    try {
      setIsRevoking(true)
      await revokeProjectAccess(projectId, revokeTarget.userId)
      await loadAccess()
      toast.success(`Access revoked for ${revokeTarget.username}`)
    } catch {
      toast.error("Failed to revoke access")
    } finally {
      setIsRevoking(false)
      setRevokeTarget(null)
    }
  }

  const availableMembers = workspaceMembers.filter(
    (m) => !access.some((a) => a.userId === m.userId)
  )

  if (isLoading) {
    return (
      <div className="flex-1 p-6 sm:p-8">
        <div className="h-6 w-48 bg-linear-bg-secondary rounded-sm animate-pulse" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 p-6 sm:p-8">
        <p className="text-linear-text-tertiary">Project not found</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="flex items-center gap-3 mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/projects")}
          className="text-linear-text-tertiary hover:text-linear-text"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Projects
        </Button>
        <span className="text-linear-text-tertiary">/</span>
        <h1 className="text-lg font-medium text-linear-text">{project.name}</h1>
      </div>

      <div className="space-y-10">
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Settings className="h-4 w-4 text-linear-text-tertiary" />
            <h2 className="text-sm font-medium text-linear-text">Settings</h2>
          </div>
          <div className="space-y-4 max-w-lg">
            <div className="space-y-1.5">
              <Label className="text-xs text-linear-text-secondary">Name</Label>
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="bg-linear-bg-secondary border-linear-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-linear-text-secondary">Description</Label>
              <Input
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                placeholder="Optional description"
                className="bg-linear-bg-secondary border-linear-border"
              />
            </div>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving || !projectName.trim()}
              className="mt-2"
            >
              {isSaving ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-4">
            <Users className="h-4 w-4 text-linear-text-tertiary" />
            <h2 className="text-sm font-medium text-linear-text">Access</h2>
            <span className="text-xs text-linear-text-tertiary">
              ({access.length} {access.length === 1 ? "member" : "members"})
            </span>
          </div>

          {/* Grant access form */}
          {availableMembers.length > 0 && (
            <div className="flex items-center gap-2 mb-4">
              <Select value={grantUserId} onValueChange={setGrantUserId}>
                <SelectTrigger className="w-[200px] h-8 text-xs bg-linear-bg-secondary border-linear-border">
                  <SelectValue placeholder="Select member" />
                </SelectTrigger>
                <SelectContent>
                  {availableMembers.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.user?.username || m.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={grantPermission} onValueChange={(v) => setGrantPermission(v as ProjectPermission)}>
                <SelectTrigger className="w-[130px] h-8 text-xs bg-linear-bg-secondary border-linear-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full access</SelectItem>
                  <SelectItem value="view">View only</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={handleGrantAccess}
                disabled={!grantUserId || isGranting}
                className="h-8 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Grant
              </Button>
            </div>
          )}

          {/* Access table */}
          {isLoadingAccess ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-linear-bg-secondary rounded-sm animate-pulse" />
              ))}
            </div>
          ) : access.length === 0 ? (
            <p className="text-xs text-linear-text-tertiary">
              No explicit access rules. All workspace members have access by default.
            </p>
          ) : (
            <div className="border border-linear-border rounded-sm overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-linear-border bg-linear-bg-secondary">
                    <th className="text-left px-3 py-2 font-medium text-linear-text-secondary">Member</th>
                    <th className="text-left px-3 py-2 font-medium text-linear-text-secondary w-[140px]">Permission</th>
                    <th className="text-right px-3 py-2 font-medium text-linear-text-secondary w-[80px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {access.map((entry) => {
                    const Icon = permissionIcons[entry.permission]
                    return (
                      <tr key={entry.id} className="border-b border-linear-border last:border-b-0">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {entry.user.avatarUrl ? (
                              <img
                                src={entry.user.avatarUrl}
                                alt=""
                                className="h-5 w-5 rounded-sm"
                              />
                            ) : (
                              <div className="h-5 w-5 rounded-sm bg-linear-bg-tertiary flex items-center justify-center">
                                <User className="h-3 w-3 text-linear-text-tertiary" />
                              </div>
                            )}
                            <span className="text-linear-text">{entry.user.username}</span>
                            {entry.user.email && (
                              <span className="text-linear-text-tertiary">{entry.user.email}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <Icon className="h-3 w-3" />
                            {permissionLabels[entry.permission]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => setRevokeTarget({ userId: entry.userId, username: entry.user.username })}
                            className="text-linear-text-tertiary hover:text-destructive transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="border-t border-linear-border pt-8">
          <h2 className="text-sm font-medium text-linear-text mb-2">Delete project</h2>
          <p className="text-xs text-linear-text-tertiary mb-4">
            Permanently delete this project and all its issues. This cannot be undone.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsDeleteDialogOpen(true)}
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete project
          </Button>
        </section>
      </div>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project and all associated issues. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revokeTarget} onOpenChange={() => setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deny {revokeTarget?.username}&apos;s access to this project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={isRevoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRevoking ? "Revoking..." : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
