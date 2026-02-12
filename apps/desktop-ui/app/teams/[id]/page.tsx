"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter, useParams } from "next/navigation"
import {
  ArrowLeft,
  Users,
  Trash2,
  User,
  Crown,
  Shield,
  Copy,
  Check,
  Pencil,
  Settings,
  AlertTriangle,
  FolderKanban,
  ListTodo,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { AppShell } from "@/components/layout/app-shell"
import {
  fetchTeam,
  updateTeam,
  deleteTeam,
  fetchProjects,
  removeTeamMember,
  type Team,
  type TeamMember,
  type Project,
} from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const roleIcons = {
  owner: Crown,
  admin: Shield,
  member: User,
}

const roleColors = {
  owner: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  admin: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  member: "bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border",
}

interface Task {
  id: string
  title: string
  status: string
  priority: string
  identifier: string | null
}

export default function TeamDetailPage() {
  const router = useRouter()
  const params = useParams()
  const teamId = params.id as string

  const [team, setTeam] = useState<Team | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [teamName, setTeamName] = useState("")
  const [teamDescription, setTeamDescription] = useState("")
  const [teamColor, setTeamColor] = useState("#6366f1")
  const [isSavingTeam, setIsSavingTeam] = useState(false)
  const [copiedInviteCode, setCopiedInviteCode] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

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
      const res = await fetch(`${API_URL}/api/tasks?teamId=${teamId}`)
      if (res.ok) {
        const data = await res.json()
        setTasks(data)
      }
    } catch (error) {
      console.error("Failed to fetch tasks:", error)
    } finally {
      setIsLoadingTasks(false)
    }
  }, [teamId])

  const loadProjects = useCallback(async () => {
    if (!teamId) return
    try {
      setIsLoadingProjects(true)
      const data = await fetchProjects(teamId)
      setProjects(data)
    } catch (error) {
      console.error("Failed to fetch projects:", error)
    } finally {
      setIsLoadingProjects(false)
    }
  }, [teamId])

  useEffect(() => {
    loadTeam()
    loadTasks()
    loadProjects()
  }, [loadTeam, loadTasks, loadProjects])

  useSSESubscription((eventType) => {
    if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
      loadTeam()
    }
    if (['task:created', 'task:updated', 'task:deleted'].includes(eventType)) {
      loadTasks()
    }
    if (['project:created', 'project:updated', 'project:deleted'].includes(eventType)) {
      loadProjects()
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

  const handleRemoveMember = async (userId: string) => {
    if (!teamId) return
    if (!confirm("Are you sure you want to remove this member?")) return

    try {
      await removeTeamMember(teamId, userId)
      loadTeam()
    } catch (error) {
      console.error("Failed to remove team member:", error)
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
    switch (priority.toLowerCase()) {
      case 'high':
        return 'bg-red-500/10 text-red-500 border-red-500/20'
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
      case 'low':
        return 'bg-green-500/10 text-green-500 border-green-500/20'
      default:
        return 'bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border'
    }
  }

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'done':
      case 'completed':
        return 'bg-green-500/10 text-green-500 border-green-500/20'
      case 'in_progress':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/20'
      case 'todo':
      case 'backlog':
        return 'bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border'
      default:
        return 'bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border'
    }
  }

  const getProjectStatusColor = (status: string) => {
    switch (status) {
      case 'planned':
        return 'bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border'
      case 'in_progress':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/20'
      case 'paused':
        return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
      case 'completed':
        return 'bg-green-500/10 text-green-500 border-green-500/20'
      case 'cancelled':
        return 'bg-red-500/10 text-red-500 border-red-500/20'
      default:
        return 'bg-linear-text-tertiary/10 text-linear-text-secondary border-linear-border'
    }
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '—'
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex-1 flex items-center justify-center bg-linear-bg">
          <div className="text-linear-text-tertiary">Loading team...</div>
        </div>
      </AppShell>
    )
  }

  if (!team) {
    return (
      <AppShell>
        <div className="flex-1 flex flex-col items-center justify-center bg-linear-bg">
          <div className="text-linear-text-tertiary mb-4">Team not found</div>
          <Button
            variant="outline"
            onClick={() => router.push('/teams')}
            className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to teams
          </Button>
        </div>
      </AppShell>
    )
  }

  const members = team.members || []

  return (
    <AppShell>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex items-center gap-4 mb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/teams')}
                className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
              >
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Back
              </Button>
            </div>

            <div className="flex items-start gap-4">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border border-linear-border"
                style={{ backgroundColor: `${team.color}20` }}
              >
                <span className="text-lg font-bold" style={{ color: team.color }}>
                  {team.name.charAt(0)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-xl font-semibold text-linear-text">{team.name}</h1>
                  <Badge variant="outline" className="font-mono text-linear-text-secondary border-linear-border">
                    {team.key}
                  </Badge>
                </div>
                {team.description && (
                  <p className="text-sm text-linear-text-secondary">{team.description}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto p-6 space-y-8">
            <section>
              <h2 className="text-lg font-medium text-linear-text mb-4 flex items-center gap-2">
                <Settings className="w-5 h-5 text-linear-text-secondary" />
                Team Info
              </h2>
              <div className="p-4 rounded-lg bg-linear-bg-secondary border border-linear-border">
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
                        className="w-10 h-10 rounded-md border border-linear-border cursor-pointer"
                      />
                      <span className="text-sm text-linear-text-secondary font-mono">{teamColor}</span>
                    </div>
                  </div>
                  {team.inviteCode && (
                    <div className="space-y-2">
                      <Label className="text-linear-text-secondary">Invite Code</Label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 rounded-md bg-linear-bg-tertiary border border-linear-border font-mono text-sm text-linear-text">
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
              </div>
            </section>

            <section>
              <h2 className="text-lg font-medium text-linear-text mb-4 flex items-center gap-2">
                <Users className="w-5 h-5 text-linear-text-secondary" />
                Members ({members.length})
              </h2>

              {members.length > 0 ? (
                <div className="space-y-2">
                  {members.map((member: TeamMember) => {
                    const RoleIcon = roleIcons[member.role]
                    return (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-linear-bg-secondary border border-linear-border/50 hover:border-linear-border transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium text-linear-text-secondary bg-linear-bg-tertiary border border-linear-border">
                            {member.user?.avatarUrl ? (
                              <img
                                src={member.user.avatarUrl}
                                alt={member.user.username}
                                className="w-full h-full rounded-full"
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
                          <Badge
                            variant="outline"
                            className={`${roleColors[member.role]} flex items-center gap-1 capitalize`}
                          >
                            <RoleIcon className="w-3 h-3" />
                            {member.role}
                          </Badge>
                          <button
                            onClick={() => handleRemoveMember(member.userId)}
                            className="p-1.5 rounded-md hover:bg-red-500/10 transition-colors"
                            title="Remove member"
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-center py-8 rounded-lg bg-linear-bg-secondary border border-linear-border border-dashed">
                  <Users className="w-8 h-8 text-linear-text-tertiary mx-auto mb-2" />
                  <p className="text-sm text-linear-text-secondary">No members yet</p>
                  <p className="text-xs text-linear-text-tertiary">Add members to collaborate on issues</p>
                </div>
              )}
            </section>

            <section>
              <h2 className="text-lg font-medium text-linear-text mb-4 flex items-center gap-2">
                <ListTodo className="w-5 h-5 text-linear-text-secondary" />
                Issues ({tasks.length})
              </h2>
              <div className="rounded-lg bg-linear-bg-secondary border border-linear-border overflow-hidden">
                {isLoadingTasks ? (
                  <div className="py-8 text-center text-linear-text-tertiary">Loading issues...</div>
                ) : tasks.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-linear-border bg-linear-bg-tertiary/50">
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                          Title
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[100px]">
                          Status
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[100px]">
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
                            <Badge variant="outline" className={`${getStatusColor(task.status)} text-xs capitalize`}>
                              {task.status.replace('_', ' ')}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={`${getPriorityColor(task.priority)} text-xs capitalize`}>
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
              </div>
            </section>

            <section>
              <h2 className="text-lg font-medium text-linear-text mb-4 flex items-center gap-2">
                <FolderKanban className="w-5 h-5 text-linear-text-secondary" />
                Projects ({projects.length})
              </h2>
              <div className="rounded-lg bg-linear-bg-secondary border border-linear-border overflow-hidden">
                {isLoadingProjects ? (
                  <div className="py-8 text-center text-linear-text-tertiary">Loading projects...</div>
                ) : projects.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-linear-border bg-linear-bg-tertiary/50">
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                          Name
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                          Status
                        </th>
                        <th className="text-left py-2 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                          Target Date
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((project) => (
                        <tr
                          key={project.id}
                          className="border-b border-linear-border/50 hover:bg-linear-bg-tertiary/30 transition-colors"
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <div
                                className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
                                style={{ backgroundColor: `${project.color}20`, color: project.color }}
                              >
                                {project.icon || project.name.charAt(0)}
                              </div>
                              <span className="text-sm text-linear-text">{project.name}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="outline" className={`${getProjectStatusColor(project.status)} text-xs capitalize`}>
                              {project.status.replace('_', ' ')}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-sm text-linear-text-secondary">{formatDate(project.targetDate)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-center py-8">
                    <FolderKanban className="w-8 h-8 text-linear-text-tertiary mx-auto mb-2" />
                    <p className="text-sm text-linear-text-secondary">No projects yet</p>
                    <p className="text-xs text-linear-text-tertiary">Projects associated with this team will appear here</p>
                  </div>
                )}
              </div>
            </section>

            <section>
              <h2 className="text-lg font-medium text-red-500 mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                Danger Zone
              </h2>
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20">
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
                    className="border-red-500/30 text-red-500 hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 className="w-4 h-4 mr-1.5" />
                    Delete team
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="bg-linear-bg-secondary border-linear-border">
          <DialogHeader>
            <DialogTitle className="text-linear-text flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500" />
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
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {isDeleting ? "Deleting..." : "Delete team"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
