"use client"

import { Suspense, useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Users,
  Trash2,
  User,
  Crown,
  Shield,
  Copy,
  Check,
  Pencil,
  Settings,
  FolderKanban,
  ListTodo,
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
  PRIORITY_COLORS,
  PROJECT_STATUS_COLORS,
  STATUS_COLORS,
  TEAM_ROLE_COLORS,
  type ColorTriad,
  type PriorityKey,
  type StatusKey,
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
import {
  fetchTeam,
  updateTeam,
  deleteTeam,
  removeTeamMember,
  updateTeamMember,
  type Team,
  type TeamMember,
} from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"
import { apiFetch, ApiError } from "@/lib/api/fetch"
import { useAuth } from "@/hooks/use-auth"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"

const roleIcons = {
  owner: Crown,
  admin: Shield,
  member: User,
}

const taskStatusColorKeys: Record<string, StatusKey> = {
  backlog: "todo",
  completed: "done",
  done: "done",
  in_progress: "in_progress",
  todo: "todo",
}

const getBadgeColorClasses = (colors: ColorTriad) => cn(colors.text, "bg-transparent border-linear-border")

interface Task {
  id: string
  title: string
  status: string
  priority: string
  identifier: string | null
}

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

  const [team, setTeam] = useState<Team | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [teamName, setTeamName] = useState("")
  const [teamDescription, setTeamDescription] = useState("")
  const [teamColor, setTeamColor] = useState("#10b981")
  const [isSavingTeam, setIsSavingTeam] = useState(false)
  const [copiedInviteCode, setCopiedInviteCode] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null)
  const [isRemovingMember, setIsRemovingMember] = useState(false)

  const loadTeam = useCallback(async () => {
    if (!teamId) return
    try {
      setIsLoading(true)
      const data = await fetchTeam(teamId)
      setTeam(data)
      setTeamName(data.name)
      setTeamDescription(data.description || "")
      setTeamColor(data.color)
    } catch (error) {
      console.error("Failed to fetch team:", error)
    } finally {
      setIsLoading(false)
    }
  }, [teamId])

  const loadTasks = useCallback(async () => {
    if (!teamId) return
    try {
      setIsLoadingTasks(true)
      const data = await apiFetch<{ items: Task[] } | Task[]>(`/api/tasks?teamId=${teamId}`)
      setTasks(Array.isArray(data) ? data : data.items)
    } catch (error) {
      console.error("Failed to fetch tasks:", error)
      if (!(error instanceof ApiError && error.status === 401)) {
        toast.error(error instanceof Error ? error.message : 'Failed to fetch tasks')
      }
    } finally {
      setIsLoadingTasks(false)
    }
  }, [teamId])

  useEffect(() => {
    loadTeam()
    loadTasks()
  }, [loadTeam, loadTasks])

  useSSESubscription((eventType) => {
    if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
      loadTeam()
    }
    if (['task:created', 'task:updated', 'task:deleted'].includes(eventType)) {
      loadTasks()
    }
  })

  const handleSaveTeamInfo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!teamId || !teamName.trim()) return

    try {
      setIsSavingTeam(true)
      await updateTeam(teamId, {
        name: teamName,
        description: teamDescription || null,
        color: teamColor,
      })
      loadTeam()
    } catch (error) {
      console.error("Failed to update team:", error)
    } finally {
      setIsSavingTeam(false)
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
    const prev = team?.members ?? []
    setTeam((t) => (t ? { ...t, members: prev.map((m) => (m.userId === userId ? { ...m, role } : m)) } : t))
    try {
      await updateTeamMember(teamId, userId, { role })
      toast.success("Role updated")
    } catch (err) {
      setTeam((t) => (t ? { ...t, members: prev } : t))
      toast.error(err instanceof Error ? err.message : "Failed to update role")
    }
  }

  const confirmRemoveMember = async () => {
    if (!teamId || !removeMemberId) return
    try {
      setIsRemovingMember(true)
      await removeTeamMember(teamId, removeMemberId)
      setRemoveMemberId(null)
      loadTeam()
    } catch (error) {
      console.error("Failed to remove team member:", error)
    } finally {
      setIsRemovingMember(false)
    }
  }

  const handleDeleteTeam = async () => {
    if (!teamId) return

    try {
      setIsDeleting(true)
      await deleteTeam(teamId)
      setIsDeleteDialogOpen(false)
      router.push('/teams')
    } catch (error) {
      console.error("Failed to delete team:", error)
      setIsDeleting(false)
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

  const getPriorityColor = (priority: string) => {
    const key = priority.toLowerCase() as PriorityKey
    return getBadgeColorClasses(PRIORITY_COLORS[key] ?? PRIORITY_COLORS.low)
  }

  const getStatusColor = (status: string) => {
    return getBadgeColorClasses(STATUS_COLORS[taskStatusColorKeys[status.toLowerCase()] ?? "todo"])
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
                            <Check className="w-4 h-4 text-green-500" />
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
          title="Issues"
          description={`${tasks.length} ${tasks.length === 1 ? "issue" : "issues"} currently attached to this team`}
          icon={<ListTodo className="h-4 w-4" />}
        >
              <SettingsPanel className="overflow-hidden">
                {isLoadingTasks ? (
                  <div className="py-8 text-center text-linear-text-tertiary">Loading issues...</div>
                ) : tasks.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-linear-border bg-linear-bg-tertiary/50">
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                          Title
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                          Status
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                          Priority
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr
                          key={task.id}
                          className="border-b border-linear-border/50 hover:bg-linear-bg-tertiary/30 transition-colors cursor-pointer"
                          onClick={() => router.push(`/?teamId=${teamId}`)}
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              {task.identifier && (
                                <span className="text-xs font-mono text-linear-text-tertiary">{task.identifier}</span>
                              )}
                              <span className="text-sm text-linear-text truncate">{task.title}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={cn(getStatusColor(task.status), "text-xs capitalize whitespace-nowrap")}>
                              {task.status.replace('_', ' ')}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={cn(getPriorityColor(task.priority), "text-xs capitalize whitespace-nowrap")}>
                              {task.priority}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-center py-8">
                    <ListTodo className="w-8 h-8 text-linear-text-tertiary mx-auto mb-2" />
                    <p className="text-sm text-linear-text-secondary">No issues yet</p>
                    <p className="text-xs text-linear-text-tertiary">Issues assigned to this team will appear here</p>
                  </div>
                )}
              </SettingsPanel>
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
