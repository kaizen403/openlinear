"use client"

import { Suspense, useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Users,
  Trash2,
  User,
  Shield,
  Copy,
  Check,
  Pencil,
  Settings,
  FolderKanban,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  SettingsPageShell,
  SettingsPanel,
  SettingsSection,
} from "@/components/settings/settings-layout"
import {
  PROJECT_STATUS_COLORS,
  TEAM_ROLE_COLORS,
  type ColorTriad,
} from "@/lib/design-tokens"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import type { TeamMember } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { useTeamDetail } from "@/hooks/use-team-directory"
import { useTeamMutations } from "@/hooks/use-team-mutations"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"

const roleIcons = {
  owner: User,
  admin: Shield,
  member: User,
}

const getBadgeColorClasses = (colors: ColorTriad) => cn(colors.text, "bg-transparent border-linear-border")

export default function TeamDetailPage() {
  return (
    <Suspense fallback={null}>
      <TeamDetailPageContent />
    </Suspense>
  )
}

function TeamDetailPageContent() {
  const router = useRouter()
  const { user: authUser } = useAuth()
  const searchParams = useSearchParams()
  const teamId = searchParams.get("id") ?? ""

  // The full team from the cache (shared with Settings → Members); `team:*`
  // events patch it in place instead of reloading the page.
  const { team, isLoading, error: loadError, errorUpdatedAt: loadErrorAt } = useTeamDetail(teamId)
  const { update, remove, changeMemberRole, removeMember } = useTeamMutations()
  const [teamName, setTeamName] = useState("")
  const [teamDescription, setTeamDescription] = useState("")
  const [teamColor, setTeamColor] = useState("#10b981")
  const [copiedInviteCode, setCopiedInviteCode] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null)
  const isSavingTeam = update.isPending
  const isDeleting = remove.isPending || remove.isSuccess
  const isRemovingMember = removeMember.isPending

  useEffect(() => {
    if (loadError) console.error("Failed to fetch team:", loadError)
  }, [loadError, loadErrorAt])

  // The form follows the server's values when they change (first load, a
  // successful save, someone else's edit) — not on unrelated refetches, which
  // used to reset it on every team event. While a save is in flight or after
  // it failed, the optimistic write and its rollback leave the typed values alone.
  const serverName = team?.name
  const serverDescription = team?.description
  const serverColor = team?.color
  const saveInFlightOrFailed = (update.isPending || update.isError) && update.variables?.teamId === teamId
  useEffect(() => {
    if (serverName === undefined || saveInFlightOrFailed) return
    setTeamName(serverName)
    setTeamDescription(serverDescription || "")
    if (serverColor) setTeamColor(serverColor)
  }, [teamId, serverName, serverDescription, serverColor, saveInFlightOrFailed])

  const handleSaveTeamInfo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!teamId || !teamName.trim()) return

    try {
      await update.mutateAsync({
        teamId,
        edit: {
          name: teamName,
          description: teamDescription || null,
          color: teamColor,
        },
      })
    } catch (error) {
      console.error("Failed to update team:", error)
    }
  }

  const handleCopyInviteCode = async () => {
    if (!team?.inviteCode) return
    try {
      await navigator.clipboard.writeText(team.inviteCode)
      setCopiedInviteCode(true)
      setTimeout(() => setCopiedInviteCode(false), 2000)
    } catch (error) {
      console.error("Failed to copy:", error)
    }
  }

  const handleRemoveMember = (userId: string) => {
    if (!teamId) return
    setRemoveMemberId(userId)
  }

  const handleRoleChange = async (userId: string, role: TeamMember['role']) => {
    if (!teamId) return
    try {
      // Optimistic, rolled back on failure (as before).
      await changeMemberRole.mutateAsync({ teamId, userId, role })
      toast.success("Role updated")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role")
    }
  }

  const confirmRemoveMember = async () => {
    if (!teamId || !removeMemberId) return
    try {
      await removeMember.mutateAsync({ teamId, userId: removeMemberId })
      setRemoveMemberId(null)
    } catch (error) {
      console.error("Failed to remove team member:", error)
    }
  }

  const handleDeleteTeam = async () => {
    if (!teamId) return

    try {
      await remove.mutateAsync(teamId)
      setIsDeleteDialogOpen(false)
      router.push('/teams')
    } catch (error) {
      console.error("Failed to delete team:", error)
    }
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  const getProjectStatusColor = (status: string) => {
    const key = status as keyof typeof PROJECT_STATUS_COLORS
    return getBadgeColorClasses(PROJECT_STATUS_COLORS[key] ?? PROJECT_STATUS_COLORS.planned)
  }

  if (isLoading) {
    return (
      <SettingsPageShell
        title="Team"
        backLabel="teams"
        onBack={() => router.push('/teams')}
        icon={<Users className="h-4 w-4" />}
      >
        <div className="h-6 w-48 animate-pulse rounded-sm bg-linear-bg-secondary" />
      </SettingsPageShell>
    )
  }

  if (!team) {
    return (
      <SettingsPageShell
        title="Team"
        backLabel="teams"
        onBack={() => router.push('/teams')}
        icon={<Users className="h-4 w-4" />}
      >
        <p className="text-linear-text-tertiary">Team not found</p>
      </SettingsPageShell>
    )
  }

  const members = team.members || []
  const callerMember = members.find((m) => m.userId === authUser?.id)
  const isCallerOwner = callerMember?.role === 'owner'
  const parentProject = team.project

  return (
    <>
      <SettingsPageShell
        title={team.name}
        backLabel="teams"
        onBack={() => router.push('/teams')}
        icon={
          <div
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-linear-border text-[11px] font-semibold"
            style={{ backgroundColor: `${team.color}20`, color: team.color }}
          >
            {team.name.charAt(0)}
          </div>
        }
        actions={
          <Badge variant="outline" className="border-linear-border font-mono text-linear-text-secondary">
            {team.key}
          </Badge>
        }
      >
        <SettingsSection
          title="General"
          description="Customize the team name, color, description, and invite code."
          icon={<Settings className="h-4 w-4" />}
        >
          <SettingsPanel className="p-4">
                <form onSubmit={handleSaveTeamInfo} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="teamName" className="text-linear-text-secondary">Name</Label>
                      <Input
                        id="teamName"
                        value={teamName}
                        onChange={(e) => setTeamName(e.target.value)}
                        placeholder="Team name"
                        className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="teamKey" className="text-linear-text-secondary">Key</Label>
                      <Input
                        id="teamKey"
                        value={team.key}
                        disabled
                        className="bg-linear-bg-tertiary border-linear-border text-linear-text-secondary font-mono opacity-60"
                      />
                      <p className="text-xs text-linear-text-tertiary">Team key cannot be changed</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="teamDescription" className="text-linear-text-secondary">Description</Label>
                    <Input
                      id="teamDescription"
                      value={teamDescription}
                      onChange={(e) => setTeamDescription(e.target.value)}
                      placeholder="Describe your team"
                      className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="teamColor" className="text-linear-text-secondary">Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="teamColor"
                        value={teamColor}
                        onChange={(e) => setTeamColor(e.target.value)}
                        className="w-10 h-10 rounded-sm border border-linear-border cursor-pointer"
                      />
                      <span className="text-sm text-linear-text-secondary font-mono">{teamColor}</span>
                    </div>
                  </div>
                  {team.inviteCode && (
                    <div className="space-y-2">
                      <Label className="text-linear-text-secondary">Invite Code</Label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 rounded-sm bg-linear-bg-tertiary border border-linear-border font-mono text-sm text-linear-text">
                          {team.inviteCode}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleCopyInviteCode}
                          className="border-linear-border hover:bg-linear-bg-tertiary"
                        >
                          {copiedInviteCode ? (
                            <Check className="w-4 h-4 text-success" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end pt-2">
                    <Button
                      type="submit"
                      disabled={isSavingTeam || !teamName.trim()}
                      className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                    >
                      <Pencil className="w-4 h-4 mr-1.5" />
                      {isSavingTeam ? "Saving..." : "Save changes"}
                    </Button>
                  </div>
                </form>
          </SettingsPanel>
        </SettingsSection>

        <SettingsSection
          title="Members"
          description={`${members.length} ${members.length === 1 ? "member" : "members"} in this team`}
          icon={<Users className="h-4 w-4" />}
        >

              {members.length > 0 ? (
                <SettingsPanel className="overflow-hidden divide-y divide-linear-border">
                  {members.map((member: TeamMember) => {
                    const RoleIcon = roleIcons[member.role]
                    const isSelf = member.userId === authUser?.id
                    const canEditRole = isCallerOwner && !isSelf
                    return (
                      <div
                        key={member.id}
                        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-linear-bg-tertiary/30"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium text-linear-text-secondary bg-linear-bg-tertiary border border-linear-border overflow-hidden">
                            {member.user?.avatarUrl ? (
                              <img
                                src={member.user.avatarUrl}
                                alt={member.user.username}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              getInitials(member.user?.username || 'U')
                            )}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-linear-text">
                              {member.user?.username || 'Unknown User'}
                            </div>
                            {member.user?.email && (
                              <div className="text-xs text-linear-text-tertiary">{member.user.email}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {canEditRole ? (
                            <Select
                              value={member.role}
                              onValueChange={(v) => handleRoleChange(member.userId, v as TeamMember['role'])}
                            >
                              <SelectTrigger className="h-7 w-28 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(['owner', 'admin', 'member'] as const).map((r) => (
                                  <SelectItem key={r} value={r}>
                                    <span className="capitalize">{r}</span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge
                              variant="outline"
                              className={cn(
                                getBadgeColorClasses(TEAM_ROLE_COLORS[member.role]),
                                "flex items-center gap-1 capitalize",
                              )}
                            >
                              <RoleIcon className="w-3 h-3" />
                              {member.role}
                            </Badge>
                          )}
                          {canEditRole && (
                            <button
                              onClick={() => handleRemoveMember(member.userId)}
                              className="p-1.5 rounded-sm hover:bg-destructive/10 transition-colors"
                              title="Remove member"
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </SettingsPanel>
              ) : (
                <div className="text-center py-8 rounded-sm bg-linear-bg-secondary border border-linear-border border-dashed">
                  <Users className="w-8 h-8 text-linear-text-tertiary mx-auto mb-2" />
                  <p className="text-sm text-linear-text-secondary">No members yet</p>
                  <p className="text-xs text-linear-text-tertiary">Add members to collaborate on issues</p>
                </div>
              )}
        </SettingsSection>

        <SettingsSection
          title="Parent project"
          description="Teams now belong to one project. Use project settings for project-level access and lifecycle."
          icon={<FolderKanban className="h-4 w-4" />}
        >
              {parentProject ? (
                <SettingsPanel className="px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-xs font-bold"
                        style={{ backgroundColor: `${parentProject.color}20`, color: parentProject.color }}
                      >
                        {parentProject.icon || parentProject.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-linear-text">{parentProject.name}</div>
                        <Badge
                          variant="outline"
                          className={cn(getProjectStatusColor(parentProject.status), "mt-1 text-xs capitalize")}
                        >
                          {parentProject.status.replace('_', ' ')}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/projects/manage?id=${parentProject.id}`)}
                      className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
                    >
                      Manage project
                    </Button>
                  </div>
                </SettingsPanel>
              ) : (
                <div className="rounded-sm border border-dashed border-linear-border bg-linear-bg-secondary px-4 py-6 text-center text-sm text-linear-text-tertiary">
                  This team is not attached to a project.
                </div>
              )}
        </SettingsSection>

        <SettingsSection
          title="Delete team"
          description="Permanently delete this team and its membership records."
        >
              <SettingsPanel className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-medium text-linear-text">Delete this team</h3>
                    <p className="text-sm text-linear-text-secondary mt-1">
                      Once deleted, this team and all its data cannot be recovered.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setIsDeleteDialogOpen(true)}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4 mr-1.5" />
                    Delete team
                  </Button>
                </div>
              </SettingsPanel>
        </SettingsSection>
      </SettingsPageShell>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="bg-linear-bg-secondary border-linear-border">
          <DialogHeader>
            <DialogTitle className="text-linear-text flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-destructive" />
              Delete Team
            </DialogTitle>
            <DialogDescription className="text-linear-text-secondary">
              Are you sure you want to delete <strong>{team.name}</strong>? This action cannot be undone.
              All team data, including members and associated issues, will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isDeleting}
              className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDeleteTeam}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete team"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeMemberId !== null} onOpenChange={(open) => { if (!open) setRemoveMemberId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this member from the team?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemovingMember}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmRemoveMember() }}
              disabled={isRemovingMember}
              className={cn(buttonVariants({ variant: "destructive" }))}
            >
              {isRemovingMember ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  )
}
