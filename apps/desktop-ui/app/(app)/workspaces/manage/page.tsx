"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Building2,
  Users,
  Trash2,
  User,
  Crown,
  Shield,
  Eye,
  Plus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  SettingsPageShell,
  SettingsPanel,
  SettingsSection,
} from "@/components/settings/settings-layout"
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
  fetchWorkspace,
  fetchWorkspaceMembers,
  updateWorkspace,
  deleteWorkspace,
  inviteWorkspaceMember,
  updateWorkspaceMember,
  removeWorkspaceMember,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from "@/lib/api"
import { ApiError } from "@/lib/api/fetch"
import { useWorkspace } from "@/hooks/use-workspace"
import { useAuth } from "@/hooks/use-auth"
import { useSSESubscription, type SSEEventData, type SSEEventType } from "@/providers/sse-provider"
import { toast } from "sonner"

const roleIcons: Record<WorkspaceRole, typeof Crown> = {
  owner: Crown,
  admin: Shield,
  member: User,
  viewer: Eye,
}

const roleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
}

export default function WorkspaceManagePage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceManageContent />
    </Suspense>
  )
}

function WorkspaceManageContent() {
  const router = useRouter()
  const { user } = useAuth()
  const { activeWorkspace, refreshWorkspaces, setActiveWorkspace, workspaces } = useWorkspace()
  const workspaceId = activeWorkspace?.id ?? ""

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [name, setName] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [isLoadingMembers, setIsLoadingMembers] = useState(false)

  const [inviteUsername, setInviteUsername] = useState("")
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member")
  const [isInviting, setIsInviting] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<{ userId: string; username: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const isOwner = workspace?.role === "owner"
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"

  const loadSettings = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    setIsLoadingMembers(true)
    try {
      const [workspaceResult, membersResult] = await Promise.allSettled([
        fetchWorkspace(workspaceId),
        fetchWorkspaceMembers(workspaceId),
      ])

      if (workspaceResult.status === "fulfilled") {
        setWorkspace(workspaceResult.value)
        setName(workspaceResult.value.name)
      } else {
        const msg =
          workspaceResult.reason instanceof Error
            ? workspaceResult.reason.message
            : "Failed to load workspace"
        toast.error(msg)
      }

      setMembers(membersResult.status === "fulfilled" ? membersResult.value : [])
    } finally {
      setIsLoading(false)
      setIsLoadingMembers(false)
    }
  }, [workspaceId])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useSSESubscription(useCallback((eventType: SSEEventType, data: SSEEventData) => {
    if (!workspaceId) return
    if (eventType === 'workspace:updated') {
      const ws = data as unknown as Workspace
      if (ws?.id === workspaceId) {
        setWorkspace((prev) => (prev ? { ...prev, ...ws } : ws))
        setName(ws.name)
      }
      return
    }
    if (eventType === 'workspace:member-added' || eventType === 'workspace:member-updated') {
      const m = data as unknown as WorkspaceMember
      if (m?.workspaceId !== workspaceId) return
      setMembers((prev) => {
        const exists = prev.some((x) => x.userId === m.userId)
        if (exists) return prev.map((x) => (x.userId === m.userId ? { ...x, ...m } : x))
        return [...prev, m]
      })
      return
    }
    if (eventType === 'workspace:member-removed') {
      const userId = (data as { userId?: string }).userId
      if (!userId) return
      setMembers((prev) => prev.filter((x) => x.userId !== userId))
    }
  }, [workspaceId]))

  const handleSave = async () => {
    if (!workspaceId || !name.trim() || name === workspace?.name) return
    setIsSaving(true)
    try {
      const updated = await updateWorkspace(workspaceId, { name: name.trim() })
      setWorkspace((prev) => (prev ? { ...prev, ...updated } : updated))
      await refreshWorkspaces()
      toast.success("Workspace updated")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update workspace")
    } finally {
      setIsSaving(false)
    }
  }

  const handleInvite = async () => {
    if (!workspaceId || !inviteUsername.trim()) return
    setIsInviting(true)
    try {
      const member = await inviteWorkspaceMember(workspaceId, {
        username: inviteUsername.trim(),
        role: inviteRole,
      })
      setMembers((prev) => (prev.some((x) => x.userId === member.userId) ? prev : [...prev, member]))
      setInviteUsername("")
      setInviteRole("member")
      toast.success(`Invited ${member.user?.username ?? inviteUsername.trim()}`)
    } catch (err) {
      if (err instanceof ApiError && err.code === "USER_NOT_FOUND") {
        toast.error(`No user named ${inviteUsername.trim()}`)
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to invite member")
      }
    } finally {
      setIsInviting(false)
    }
  }

  const handleRoleChange = async (userId: string, role: WorkspaceRole) => {
    if (!workspaceId) return
    const prev = members
    setMembers((curr) => curr.map((m) => (m.userId === userId ? { ...m, role } : m)))
    try {
      await updateWorkspaceMember(workspaceId, userId, { role })
      toast.success("Role updated")
    } catch (err) {
      setMembers(prev)
      toast.error(err instanceof Error ? err.message : "Failed to update role")
    }
  }

  const handleRemoveMember = async () => {
    if (!workspaceId || !removeTarget) return
    setIsRemoving(true)
    try {
      await removeWorkspaceMember(workspaceId, removeTarget.userId)
      setMembers((curr) => curr.filter((x) => x.userId !== removeTarget.userId))
      toast.success(`Removed ${removeTarget.username}`)
      setRemoveTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member")
    } finally {
      setIsRemoving(false)
    }
  }

  const handleDelete = async () => {
    if (!workspaceId) return
    setIsDeleting(true)
    try {
      await deleteWorkspace(workspaceId)
      toast.success("Workspace deleted")
      await refreshWorkspaces()
      const remaining = workspaces.filter((w) => w.id !== workspaceId)
      if (remaining[0]) setActiveWorkspace(remaining[0])
      router.push("/")
    } catch (err) {
      if (err instanceof ApiError && err.code === "WORKSPACE_NOT_EMPTY") {
        toast.error("Delete or move all projects first")
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to delete workspace")
      }
      setIsDeleting(false)
      setIsDeleteOpen(false)
    }
  }

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-linear-text-tertiary">
        No workspace selected.
      </div>
    )
  }

  return (
    <>
      <SettingsPageShell
        title={workspace?.name ?? "Workspace"}
        backLabel="workspace"
        onBack={() => router.back()}
        icon={<Building2 className="h-4 w-4" />}
      >
        <SettingsSection
          title="General"
          description="Update the workspace name. The URL slug stays system-managed."
          icon={<Building2 className="h-4 w-4" />}
        >
          <SettingsPanel className="max-w-xl p-4">
            <div className="space-y-2">
              <Label htmlFor="workspace-name" className="text-xs text-linear-text-secondary">
                Name
              </Label>
              <div className="flex gap-2">
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canManage || isLoading}
                  className="max-w-sm"
                />
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!canManage || isSaving || !name.trim() || name === workspace?.name}
                >
                  {isSaving ? "Saving..." : "Save"}
                </Button>
              </div>
              {workspace?.slug && (
                <p className="text-xs text-linear-text-tertiary">
                  Slug: <span className="font-mono">{workspace.slug}</span>
                </p>
              )}
            </div>
          </SettingsPanel>
        </SettingsSection>

        <SettingsSection
          title="Members"
          description={`${members.length} ${members.length === 1 ? "member" : "members"} in this workspace`}
          icon={<Users className="h-4 w-4" />}
        >

            {canManage && (
              <div className="flex gap-2 rounded-sm border border-linear-border bg-linear-bg-secondary p-3">
                <Input
                  placeholder="GitHub username"
                  value={inviteUsername}
                  onChange={(e) => setInviteUsername(e.target.value)}
                  className="max-w-xs"
                />
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as WorkspaceRole)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["admin", "member", "viewer"] as WorkspaceRole[]).map((r) => (
                      <SelectItem key={r} value={r}>
                        {roleLabels[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={handleInvite}
                  disabled={isInviting || !inviteUsername.trim()}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Invite
                </Button>
              </div>
            )}

            <div className="rounded-sm border border-linear-border bg-linear-bg-secondary">
              {isLoadingMembers ? (
                <div className="px-4 py-3 text-xs text-linear-text-tertiary">Loading...</div>
              ) : members.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-linear-text-tertiary">
                  No members
                </div>
              ) : (
                <ul className="divide-y divide-linear-border">
                  {members.map((member) => {
                    const RoleIcon = roleIcons[member.role]
                    const isSelf = member.userId === user?.id
                    return (
                      <li
                        key={member.id}
                        className="flex items-center gap-3 px-4 py-2.5"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-linear-bg-tertiary text-xs text-linear-text-secondary">
                          {member.user?.avatarUrl ? (
                            <img
                              src={member.user.avatarUrl}
                              alt={member.user.username}
                              className="h-full w-full rounded-sm object-cover"
                            />
                          ) : (
                            (member.user?.username ?? "?").slice(0, 1).toUpperCase()
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm text-linear-text">
                            <span className="truncate">{member.user?.username ?? "Unknown"}</span>
                            {isSelf && (
                              <Badge
                                variant="outline"
                                className="h-4 border-linear-border bg-transparent px-1.5 text-[10px] text-linear-text-tertiary"
                              >
                                You
                              </Badge>
                            )}
                          </div>
                          {member.user?.email && (
                            <div className="truncate text-xs text-linear-text-tertiary">
                              {member.user.email}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isOwner && !isSelf ? (
                            <Select
                              value={member.role}
                              onValueChange={(v) => handleRoleChange(member.userId, v as WorkspaceRole)}
                            >
                              <SelectTrigger className="h-7 w-28 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(["owner", "admin", "member", "viewer"] as WorkspaceRole[]).map((r) => (
                                  <SelectItem key={r} value={r}>
                                    {roleLabels[r]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="flex items-center gap-1.5 text-xs text-linear-text-secondary">
                              <RoleIcon className="h-3.5 w-3.5" />
                              <span>{roleLabels[member.role]}</span>
                            </div>
                          )}
                          {isOwner && !isSelf && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-linear-text-tertiary hover:bg-destructive/10 hover:text-destructive"
                              onClick={() =>
                                setRemoveTarget({
                                  userId: member.userId,
                                  username: member.user?.username ?? "this member",
                                })
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
        </SettingsSection>

          {isOwner && (
            <SettingsSection
              title="Delete workspace"
              description="Permanently delete this workspace. All projects must be removed first."
            >
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setIsDeleteOpen(true)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete workspace
              </Button>
            </SettingsSection>
          )}
      </SettingsPageShell>

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will lose access to all projects in this workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveMember}
              disabled={isRemoving}
              className={cn(
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {isRemoving ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {workspace?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the workspace, its membership, and all access records. Projects must be removed first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className={cn(
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {isDeleting ? "Deleting..." : "Delete workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
