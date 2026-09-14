"use client"

import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import {
  Users,
  UserPlus,
  MoreHorizontal,
  Shield,
  Trash2,
  Loader2,
  Mail,
} from "lucide-react"

import { useAuth } from "@/hooks/use-auth"
import { useWorkspace } from "@/hooks/use-workspace"
import { useTeams } from "@/providers/teams-provider"
import {
  fetchWorkspaceMembers,
  inviteWorkspaceMember,
  updateWorkspaceMember,
  removeWorkspaceMember,
} from "@/lib/api/workspaces"
import {
  fetchTeam,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
} from "@/lib/api/teams"
import type { WorkspaceMember, TeamMember, WorkspaceRole } from "@/lib/api/types"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { EmptyState } from "@/components/empty-state"

const WORKSPACE_ROLES: WorkspaceRole[] = ["owner", "admin", "member", "viewer"]
const TEAM_ROLES: Array<TeamMember["role"]> = ["owner", "admin", "member"]

function getRoleBadgeColor(role: string) {
  switch (role) {
    case "owner":
      return "bg-linear-accent text-white"
    case "admin":
      return "bg-linear-accent/80 text-white"
    case "member":
      return "bg-linear-bg-tertiary text-linear-text-secondary border-linear-border"
    case "viewer":
      return "bg-linear-bg-tertiary text-linear-text-tertiary border-linear-border"
    default:
      return "bg-linear-bg-tertiary text-linear-text-secondary border-linear-border"
  }
}

function MemberAvatar({
  name,
  avatarUrl,
  email,
}: {
  name: string
  avatarUrl: string | null
  email: string | null
}) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <Avatar className="h-8 w-8 rounded-sm">
      <AvatarImage src={avatarUrl ?? undefined} alt={name} />
      <AvatarFallback className="bg-linear-bg-tertiary text-linear-text-secondary text-xs rounded-sm">
        {initials || email?.slice(0, 2).toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  )
}

function MemberRow({
  member,
  currentUserId,
  roles,
  onRoleChange,
  onRemove,
  isUpdating,
}: {
  member: WorkspaceMember | TeamMember
  currentUserId: string | undefined
  roles: readonly string[]
  onRoleChange: (userId: string, role: string) => void
  onRemove: (userId: string) => void
  isUpdating: boolean
}) {
  const user = member.user
  const name = user?.username ?? "Unknown"
  const email = user?.email ?? null
  const avatarUrl = user?.avatarUrl ?? null
  const isCurrentUser = user?.id === currentUserId

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-linear-bg-tertiary/50 transition-colors">
      <MemberAvatar name={name} avatarUrl={avatarUrl} email={email} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-linear-text truncate">{name}</span>
          {isCurrentUser && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-linear-border text-linear-text-tertiary">
              You
            </Badge>
          )}
        </div>
        {email && (
          <span className="text-xs text-linear-text-tertiary truncate block">{email}</span>
        )}
      </div>

      <Badge className={`text-xs capitalize ${getRoleBadgeColor(member.role)}`}>
        {member.role}
      </Badge>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-linear-text-secondary hover:text-linear-text"
            disabled={isUpdating}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <div className="px-2 py-1.5 text-xs font-semibold text-linear-text-tertiary">
            Change role
          </div>
          {roles.map((role) => (
            <DropdownMenuItem
              key={role}
              onClick={() => onRoleChange(member.userId, role)}
              disabled={member.role === role || isUpdating}
              className="capitalize text-sm"
            >
              <Shield className="h-3.5 w-3.5 mr-2" />
              {role}
              {member.role === role && (
                <span className="ml-auto text-xs text-linear-text-tertiary">Current</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onRemove(member.userId)}
            disabled={isUpdating}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Remove member
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function MembersList({
  members,
  currentUserId,
  roles,
  onRoleChange,
  onRemove,
  isUpdating,
  isLoading,
  error,
  emptyTitle,
  emptyDescription,
}: {
  members: (WorkspaceMember | TeamMember)[]
  currentUserId: string | undefined
  roles: readonly string[]
  onRoleChange: (userId: string, role: string) => void
  onRemove: (userId: string) => void
  isUpdating: boolean
  isLoading: boolean
  error: string | null
  emptyTitle: string
  emptyDescription: string
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-linear-text-secondary" />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={Users}
        title="Couldn't load members"
        description={error}
        size="compact"
      />
    )
  }

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={emptyTitle}
        description={emptyDescription}
        size="compact"
      />
    )
  }

  return (
    <div className="divide-y divide-linear-border">
      {members.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          currentUserId={currentUserId}
          roles={roles}
          onRoleChange={onRoleChange}
          onRemove={onRemove}
          isUpdating={isUpdating}
        />
      ))}
    </div>
  )
}

export default function MembersPage() {
  const { user } = useAuth()
  const { activeWorkspace } = useWorkspace()
  const { teams } = useTeams()

  const [activeTab, setActiveTab] = useState("workspace")
  const [selectedTeamId, setSelectedTeamId] = useState<string>("")

  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)

  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)

  const [isUpdating, setIsUpdating] = useState(false)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member")
  const [inviteLoading, setInviteLoading] = useState(false)

  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; name: string } | null>(null)
  const [removeLoading, setRemoveLoading] = useState(false)

  const loadWorkspaceMembers = useCallback(async () => {
    if (!activeWorkspace?.id) return
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    try {
      const data = await fetchWorkspaceMembers(activeWorkspace.id)
      setWorkspaceMembers(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load workspace members"
      setWorkspaceError(message)
      toast.error(message)
    } finally {
      setWorkspaceLoading(false)
    }
  }, [activeWorkspace?.id])

  const loadTeamMembers = useCallback(async () => {
    if (!selectedTeamId) {
      setTeamMembers([])
      return
    }
    setTeamLoading(true)
    setTeamError(null)
    try {
      const team = await fetchTeam(selectedTeamId)
      setTeamMembers(team.members ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load team members"
      setTeamError(message)
      toast.error(message)
    } finally {
      setTeamLoading(false)
    }
  }, [selectedTeamId])

  useEffect(() => {
    if (activeTab === "workspace") {
      void loadWorkspaceMembers()
    }
  }, [activeTab, loadWorkspaceMembers])

  useEffect(() => {
    if (activeTab === "teams") {
      void loadTeamMembers()
    }
  }, [activeTab, loadTeamMembers])

  useEffect(() => {
    if (teams.length > 0 && !selectedTeamId) {
      setSelectedTeamId(teams[0].id)
    }
  }, [teams, selectedTeamId])

  const handleWorkspaceRoleChange = useCallback(
    async (userId: string, role: string) => {
      if (!activeWorkspace?.id) return
      setIsUpdating(true)
      try {
        await updateWorkspaceMember(activeWorkspace.id, userId, { role: role as WorkspaceRole })
        setWorkspaceMembers((prev) =>
          prev.map((m) => (m.userId === userId ? { ...m, role: role as WorkspaceRole } : m))
        )
        toast.success("Role updated")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update role"
        toast.error(message)
      } finally {
        setIsUpdating(false)
      }
    },
    [activeWorkspace?.id]
  )

  const handleTeamRoleChange = useCallback(
    async (userId: string, role: string) => {
      if (!selectedTeamId) return
      setIsUpdating(true)
      try {
        await updateTeamMember(selectedTeamId, userId, { role: role as TeamMember["role"] })
        setTeamMembers((prev) =>
          prev.map((m) => (m.userId === userId ? { ...m, role: role as TeamMember["role"] } : m))
        )
        toast.success("Role updated")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update role"
        toast.error(message)
      } finally {
        setIsUpdating(false)
      }
    },
    [selectedTeamId]
  )

  const handleRemoveWorkspaceMember = useCallback(
    async (userId: string) => {
      if (!activeWorkspace?.id) return
      setRemoveLoading(true)
      try {
        await removeWorkspaceMember(activeWorkspace.id, userId)
        setWorkspaceMembers((prev) => prev.filter((m) => m.userId !== userId))
        toast.success("Member removed")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to remove member"
        toast.error(message)
      } finally {
        setRemoveLoading(false)
        setRemoveDialogOpen(false)
        setRemoveTarget(null)
      }
    },
    [activeWorkspace?.id]
  )

  const handleRemoveTeamMember = useCallback(
    async (userId: string) => {
      if (!selectedTeamId) return
      setRemoveLoading(true)
      try {
        await removeTeamMember(selectedTeamId, userId)
        setTeamMembers((prev) => prev.filter((m) => m.userId !== userId))
        toast.success("Member removed")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to remove member"
        toast.error(message)
      } finally {
        setRemoveLoading(false)
        setRemoveDialogOpen(false)
        setRemoveTarget(null)
      }
    },
    [selectedTeamId]
  )

  const openRemoveDialog = useCallback((userId: string, name: string) => {
    setRemoveTarget({ userId, name })
    setRemoveDialogOpen(true)
  }, [])

  const handleInvite = useCallback(async () => {
    if (!activeWorkspace?.id || !inviteEmail.trim()) return
    setInviteLoading(true)
    try {
      await inviteWorkspaceMember(activeWorkspace.id, {
        username: inviteEmail.trim(),
        role: inviteRole,
      })
      toast.success("Invitation sent")
      setInviteOpen(false)
      setInviteEmail("")
      setInviteRole("member")
      void loadWorkspaceMembers()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send invitation"
      toast.error(message)
    } finally {
      setInviteLoading(false)
    }
  }, [activeWorkspace?.id, inviteEmail, inviteRole, loadWorkspaceMembers])

  const handleRemoveConfirm = useCallback(() => {
    if (!removeTarget) return
    if (activeTab === "workspace") {
      void handleRemoveWorkspaceMember(removeTarget.userId)
    } else {
      void handleRemoveTeamMember(removeTarget.userId)
    }
  }, [removeTarget, activeTab, handleRemoveWorkspaceMember, handleRemoveTeamMember])

  const canManageWorkspace = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin"
  const selectedTeam = teams.find((t) => t.id === selectedTeamId)
  const currentUserTeamRole = selectedTeam?.members?.find((m) => m.userId === user?.id)?.role
  const canManageTeam = currentUserTeamRole === "owner" || currentUserTeamRole === "admin"

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-linear-text">Members</h2>
          <p className="mt-0.5 text-sm text-linear-text-tertiary">
            Manage workspace and team members
          </p>
        </div>
        <Button
          onClick={() => setInviteOpen(true)}
          disabled={!canManageWorkspace}
          className="self-start sm:self-auto"
        >
          <UserPlus className="h-4 w-4 mr-1.5" />
          Invite
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-linear-bg-secondary border border-linear-border">
          <TabsTrigger
            value="workspace"
            className="data-[state=active]:bg-linear-bg-tertiary data-[state=active]:text-linear-text text-linear-text-secondary"
          >
            Workspace
          </TabsTrigger>
          <TabsTrigger
            value="teams"
            className="data-[state=active]:bg-linear-bg-tertiary data-[state=active]:text-linear-text text-linear-text-secondary"
          >
            Teams
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workspace" className="mt-4">
          <div className="rounded-sm border border-linear-border bg-linear-bg-secondary">
            <div className="px-3 py-2 border-b border-linear-border flex items-center justify-between">
              <span className="text-sm font-medium text-linear-text">
                {workspaceMembers.length} {workspaceMembers.length === 1 ? "member" : "members"}
              </span>
              <span className="text-xs text-linear-text-tertiary">
                {activeWorkspace?.name}
              </span>
            </div>
            <MembersList
              members={workspaceMembers}
              currentUserId={user?.id}
              roles={WORKSPACE_ROLES}
              onRoleChange={handleWorkspaceRoleChange}
              onRemove={(userId) => {
                const member = workspaceMembers.find((m) => m.userId === userId)
                if (member) {
                  openRemoveDialog(userId, member.user?.username ?? "Unknown")
                }
              }}
              isUpdating={isUpdating}
              isLoading={workspaceLoading}
              error={workspaceError}
              emptyTitle="No workspace members"
              emptyDescription="Invite members to collaborate in this workspace."
            />
          </div>
        </TabsContent>

        <TabsContent value="teams" className="mt-4 space-y-3">
          {teams.length > 0 && (
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
              <SelectTrigger className="w-full sm:w-72 border-linear-border bg-linear-bg-secondary text-linear-text">
                <SelectValue placeholder="Select a team" />
              </SelectTrigger>
              <SelectContent className="border-linear-border bg-linear-bg-secondary">
                {teams.map((team) => (
                  <SelectItem
                    key={team.id}
                    value={team.id}
                    className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: team.color }}
                      />
                      <span>{team.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="rounded-sm border border-linear-border bg-linear-bg-secondary">
            <div className="px-3 py-2 border-b border-linear-border flex items-center justify-between">
              <span className="text-sm font-medium text-linear-text">
                {teamMembers.length} {teamMembers.length === 1 ? "member" : "members"}
              </span>
              {selectedTeam && (
                <span className="text-xs text-linear-text-tertiary">{selectedTeam.name}</span>
              )}
            </div>
            {teams.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No teams available"
                description="Create a team first to manage its members."
                size="compact"
              />
            ) : (
              <MembersList
                members={teamMembers}
                currentUserId={user?.id}
                roles={TEAM_ROLES}
                onRoleChange={handleTeamRoleChange}
                onRemove={(userId) => {
                  const member = teamMembers.find((m) => m.userId === userId)
                  if (member) {
                    openRemoveDialog(userId, member.user?.username ?? "Unknown")
                  }
                }}
                isUpdating={isUpdating}
                isLoading={teamLoading}
                error={teamError}
                emptyTitle="No team members"
                emptyDescription="Add members to this team."
              />
            )}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="bg-linear-bg-secondary border-linear-border text-linear-text">
          <DialogHeader>
            <DialogTitle className="text-linear-text">Invite member</DialogTitle>
            <DialogDescription className="text-linear-text-tertiary">
              Send an invitation to join the workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-linear-text">Email or username</label>
              <Input
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="border-linear-border bg-linear-bg text-linear-text placeholder:text-linear-text-tertiary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-linear-text">Role</label>
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as WorkspaceRole)}
              >
                <SelectTrigger className="border-linear-border bg-linear-bg text-linear-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-linear-border bg-linear-bg-secondary">
                  {WORKSPACE_ROLES.map((role) => (
                    <SelectItem
                      key={role}
                      value={role}
                      className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text capitalize"
                    >
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInviteOpen(false)}
              className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleInvite()}
              disabled={!inviteEmail.trim() || inviteLoading}
            >
              {inviteLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Mail className="h-4 w-4 mr-1.5" />
              )}
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent className="bg-linear-bg-secondary border-linear-border text-linear-text">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-linear-text">Remove member</AlertDialogTitle>
            <AlertDialogDescription className="text-linear-text-tertiary">
              Are you sure you want to remove <strong className="text-linear-text">{removeTarget?.name}</strong>?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRemoveDialogOpen(false)}
              className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRemoveConfirm()}
              disabled={removeLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
