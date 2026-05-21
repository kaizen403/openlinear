"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Users,
  Trash2,
  User,
  Shield,
  Eye,
  Ban,
  Plus,
  Settings,
  FolderKanban,
  Tag,
  Pencil,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  SettingsPageShell,
  SettingsPanel,
  SettingsSection,
} from "@/components/settings/settings-layout"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { invalidateLabelCache } from "@/components/label-picker"

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

  // Labels state
  interface ProjectLabel {
    id: string
    name: string
    color: string
    priority: number
    projectId: string
  }

  const [labels, setLabels] = useState<ProjectLabel[]>([])
  const [isLoadingLabels, setIsLoadingLabels] = useState(false)
  const [newLabelName, setNewLabelName] = useState("")
  const [newLabelColor, setNewLabelColor] = useState("#6366f1")
  const [isCreatingLabel, setIsCreatingLabel] = useState(false)
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editLabelName, setEditLabelName] = useState("")
  const [editLabelColor, setEditLabelColor] = useState("")

  const PRESET_COLORS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#64748b",
  ]

  const loadSettings = useCallback(async () => {
    if (!projectId) return
    setIsLoading(true)
    setIsLoadingAccess(true)
    try {
      const [projectData, accessData] = await Promise.all([
        apiFetch<Project>(`/api/projects/${projectId}`),
        fetchProjectAccess(projectId),
      ])

      setProject(projectData)
      setProjectName(projectData.name)
      setProjectDescription(projectData.description || "")
      setAccess(accessData)

      const workspaceId = projectData.workspaceId ?? activeWorkspace?.id
      if (workspaceId) {
        setWorkspaceMembers(await fetchWorkspaceMembers(workspaceId))
      } else {
        setWorkspaceMembers([])
      }
    } catch {
      toast.error("Failed to load project")
    } finally {
      setIsLoading(false)
      setIsLoadingAccess(false)
    }
  }, [activeWorkspace?.id, projectId])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const loadLabels = useCallback(async () => {
    if (!projectId) return
    setIsLoadingLabels(true)
    try {
      const data = await apiFetch<ProjectLabel[]>(`/api/labels?projectId=${projectId}`)
      setLabels(data.sort((a, b) => b.priority - a.priority))
    } catch {
      toast.error("Failed to load labels")
    } finally {
      setIsLoadingLabels(false)
    }
  }, [projectId])

  useEffect(() => {
    if (projectId) void loadLabels()
  }, [projectId, loadLabels])

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
      const granted = await grantProjectAccess(projectId, grantUserId, grantPermission)
      setAccess((prev) => [
        ...prev.filter((entry) => entry.userId !== granted.userId),
        granted,
      ])
      setGrantUserId("")
      setGrantPermission("full")
      toast.success("Access granted")
    } catch {
      toast.error("Failed to grant access")
    } finally {
      setIsGranting(false)
    }
  }

  const handlePermissionChange = async (userId: string, permission: ProjectPermission) => {
    if (!projectId) return
    const previous = access
    setAccess((prev) =>
      prev.map((entry) => (entry.userId === userId ? { ...entry, permission } : entry)),
    )
    try {
      const updated = await grantProjectAccess(projectId, userId, permission)
      setAccess((prev) =>
        prev.map((entry) => (entry.userId === userId ? updated : entry)),
      )
      toast.success("Access updated")
    } catch {
      setAccess(previous)
      toast.error("Failed to update access")
    }
  }

  const handleRevoke = async () => {
    if (!projectId || !revokeTarget) return
    try {
      setIsRevoking(true)
      await revokeProjectAccess(projectId, revokeTarget.userId)
      setAccess((prev) =>
        prev.map((entry) =>
          entry.userId === revokeTarget.userId ? { ...entry, permission: "deny" } : entry,
        ),
      )
      toast.success(`Access revoked for ${revokeTarget.username}`)
    } catch {
      toast.error("Failed to revoke access")
    } finally {
      setIsRevoking(false)
      setRevokeTarget(null)
    }
  }

  const handleCreateLabel = async () => {
    if (!newLabelName.trim() || !projectId) return
    setIsCreatingLabel(true)
    try {
      const label = await apiFetch<ProjectLabel>('/api/labels', {
        method: 'POST',
        body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor, projectId }),
      })
      setLabels((prev) => [label, ...prev])
      setNewLabelName("")
      setNewLabelColor("#6366f1")
      invalidateLabelCache(projectId)
      toast.success(`Label "${label.name}" created`)
    } catch {
      toast.error("Failed to create label")
    } finally {
      setIsCreatingLabel(false)
    }
  }

  const handleUpdateLabel = async (labelId: string) => {
    if (!editLabelName.trim()) return
    try {
      const updated = await apiFetch<ProjectLabel>(`/api/labels/${labelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editLabelName.trim(), color: editLabelColor }),
      })
      setLabels((prev) => prev.map((l) => (l.id === labelId ? updated : l)))
      setEditingLabelId(null)
      invalidateLabelCache(projectId)
      toast.success("Label updated")
    } catch {
      toast.error("Failed to update label")
    }
  }

  const handleDeleteLabel = async (labelId: string) => {
    try {
      await apiFetch(`/api/labels/${labelId}`, { method: 'DELETE' })
      setLabels((prev) => prev.filter((l) => l.id !== labelId))
      invalidateLabelCache(projectId)
      toast.success("Label deleted")
    } catch {
      toast.error("Failed to delete label")
    }
  }

  const availableMembers = workspaceMembers.filter(
    (m) => !access.some((a) => a.userId === m.userId)
  )

  if (isLoading) {
    return (
      <SettingsPageShell
        title="Project"
        backLabel="projects"
        onBack={() => router.push("/projects")}
        icon={<FolderKanban className="h-4 w-4" />}
      >
        <div className="h-6 w-48 bg-linear-bg-secondary rounded-sm animate-pulse" />
      </SettingsPageShell>
    )
  }

  if (!project) {
    return (
      <SettingsPageShell
        title="Project"
        backLabel="projects"
        onBack={() => router.push("/projects")}
        icon={<FolderKanban className="h-4 w-4" />}
      >
        <p className="text-linear-text-tertiary">Project not found</p>
      </SettingsPageShell>
    )
  }

  return (
    <>
      <SettingsPageShell
        title={project.name}
        backLabel="projects"
        onBack={() => router.push("/projects")}
        icon={<FolderKanban className="h-4 w-4" />}
      >
        <SettingsSection
          title="General"
          description="Control the project name and description shown across issues, teams, and navigation."
          icon={<Settings className="h-4 w-4" />}
        >
          <SettingsPanel className="max-w-xl p-4">
            <div className="space-y-4">
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
          </SettingsPanel>
        </SettingsSection>

        <SettingsSection
          title="Access"
          description={`${access.length} explicit ${access.length === 1 ? "rule" : "rules"}. Workspace members keep default access unless denied here.`}
          icon={<Users className="h-4 w-4" />}
        >

          {availableMembers.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
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
            <SettingsPanel className="overflow-hidden">
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
                          <Select
                            value={entry.permission}
                            onValueChange={(value) =>
                              handlePermissionChange(entry.userId, value as ProjectPermission)
                            }
                          >
                            <SelectTrigger className="h-7 w-32 bg-linear-bg text-xs">
                              <div className="flex items-center gap-1.5">
                                <Icon className="h-3 w-3" />
                                <SelectValue />
                              </div>
                            </SelectTrigger>
                            <SelectContent>
                              {(["full", "view", "deny"] as ProjectPermission[]).map((permission) => (
                                <SelectItem key={permission} value={permission}>
                                  {permissionLabels[permission]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
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
            </SettingsPanel>
          )}
        </SettingsSection>

        <SettingsSection
          title="Labels"
          description="Manage labels for categorizing issues in this project."
        >
          <SettingsPanel>
            <div className="p-4 space-y-4">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs text-linear-text-tertiary">Name</Label>
                  <Input
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.target.value)}
                    placeholder="Label name"
                    className="h-8"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleCreateLabel() } }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-linear-text-tertiary">Color</Label>
                  <div className="flex gap-1">
                    {PRESET_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`w-6 h-6 rounded-sm transition-all ${newLabelColor === color ? "ring-1 ring-foreground ring-offset-1 ring-offset-background scale-110" : "hover:scale-110"}`}
                        style={{ backgroundColor: color }}
                        onClick={() => setNewLabelColor(color)}
                      />
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={handleCreateLabel}
                  disabled={!newLabelName.trim() || isCreatingLabel}
                  className="h-8"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>

              {isLoadingLabels ? (
                <div className="text-sm text-linear-text-tertiary py-4 text-center">Loading...</div>
              ) : labels.length === 0 ? (
                <div className="text-sm text-linear-text-tertiary py-4 text-center">
                  No labels yet. Create one above.
                </div>
              ) : (
                <div className="space-y-1">
                  {labels.map((label) => (
                    <div
                      key={label.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-linear-bg-tertiary group"
                    >
                      {editingLabelId === label.id ? (
                        <>
                          <div className="flex gap-1">
                            {PRESET_COLORS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                className={`w-4 h-4 rounded-sm ${editLabelColor === color ? "ring-1 ring-foreground" : ""}`}
                                style={{ backgroundColor: color }}
                                onClick={() => setEditLabelColor(color)}
                              />
                            ))}
                          </div>
                          <Input
                            value={editLabelName}
                            onChange={(e) => setEditLabelName(e.target.value)}
                            className="h-7 flex-1 text-sm"
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleUpdateLabel(label.id) } }}
                            autoFocus
                          />
                          <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdateLabel(label.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingLabelId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <div
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="flex-1 text-sm text-linear-text">{label.name}</span>
                          <button
                            onClick={() => { setEditingLabelId(label.id); setEditLabelName(label.name); setEditLabelColor(label.color) }}
                            className="opacity-0 group-hover:opacity-100 text-linear-text-tertiary hover:text-linear-text transition-opacity"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteLabel(label.id)}
                            className="opacity-0 group-hover:opacity-100 text-linear-text-tertiary hover:text-destructive transition-opacity"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SettingsPanel>
        </SettingsSection>

        <SettingsSection
          title="Delete project"
          description="Permanently delete this project and all its issues. This cannot be undone."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsDeleteDialogOpen(true)}
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete project
          </Button>
        </SettingsSection>
      </SettingsPageShell>

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
    </>
  )
}
