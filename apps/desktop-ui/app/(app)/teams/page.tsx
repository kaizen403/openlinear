"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Plus,
  LogIn,
  Filter,
  Users,
  Trash2,
  X,
  Pencil,
  Copy,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { fetchTeams, createTeam, deleteTeam, updateTeam, joinTeam, ApiError, type Team } from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"
import { toast } from "sonner"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "OWNERSHIP_REQUIRED") {
      return err.status === 404
        ? "You don't have access to this team."
        : "You don't have permission to perform this action."
    }
    return err.message
  }
  return fallback
}

type TeamDialogMode = "create" | "join"

export default function TeamsPage() {
  const router = useRouter()
  const [teams, setTeams] = useState<Team[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [teamDialogMode, setTeamDialogMode] = useState<TeamDialogMode>("create")
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editTeam, setEditTeam] = useState<Team | null>(null)
  const [editFormData, setEditFormData] = useState({ name: "", description: "", color: "#6366f1" })
  const [filterText, setFilterText] = useState("")
  const [formData, setFormData] = useState({
    name: "",
    key: "",
    description: "",
    color: "#6366f1",
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createdTeam, setCreatedTeam] = useState<Team | null>(null)
  const [joinCode, setJoinCode] = useState("")
  const [joinError, setJoinError] = useState("")
  const [copiedTeamId, setCopiedTeamId] = useState<string | null>(null)
  const [copiedCreatedCode, setCopiedCreatedCode] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [deleteTeamId, setDeleteTeamId] = useState<string | null>(null)
  const [isDeletingTeam, setIsDeletingTeam] = useState(false)

  const loadTeams = useCallback(async () => {
    try {
      setIsLoading(true)
      const data = await fetchTeams()
      setTeams(data)
    } catch (error) {
      toast.error(`Failed to load teams: ${describeApiError(error, "Could not reach OpenLinear server.")}`)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTeams()
  }, [loadTeams])

  useSSESubscription((eventType) => {
    if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
      loadTeams()
    }
  })

  const handleCopyInviteCode = async (inviteCode: string, teamId: string) => {
    try {
      await navigator.clipboard.writeText(inviteCode)
      setCopiedTeamId(teamId)
      setTimeout(() => setCopiedTeamId(null), 2000)
    } catch {
      toast.error("Could not copy invite code to clipboard.")
    }
  }

  const handleCopyCreatedCode = async () => {
    if (!createdTeam?.inviteCode) return
    try {
      await navigator.clipboard.writeText(createdTeam.inviteCode)
      setCopiedCreatedCode(true)
      setTimeout(() => setCopiedCreatedCode(false), 2000)
    } catch {
      toast.error("Could not copy invite code to clipboard.")
    }
  }

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim() || !formData.key.trim()) return

    try {
      setIsSubmitting(true)
      setCreateError(null)
      const team = await createTeam({
        name: formData.name,
        key: formData.key.toUpperCase(),
        description: formData.description || undefined,
        color: formData.color,
      })
      setCreatedTeam(team)
      setFormData({ name: "", key: "", description: "", color: "#6366f1" })
      loadTeams()
    } catch (error) {
      const message = describeApiError(error, "Could not reach OpenLinear server. Check your connection and try again.")
      setCreateError(message)
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleJoinTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!joinCode.trim()) return

    try {
      setIsSubmitting(true)
      setJoinError("")
      await joinTeam(joinCode.trim())
      setJoinCode("")
      setIsDialogOpen(false)
      loadTeams()
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Failed to join team")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCloseCreateDialog = () => {
    setIsDialogOpen(false)
    setCreatedTeam(null)
    setJoinCode("")
    setJoinError("")
    setTeamDialogMode("create")
  }

  const openCreateTeamDialog = () => {
    setCreatedTeam(null)
    setJoinCode("")
    setJoinError("")
    setTeamDialogMode("create")
    setIsDialogOpen(true)
  }

  const openJoinTeamDialog = () => {
    setCreatedTeam(null)
    setJoinCode("")
    setJoinError("")
    setTeamDialogMode("join")
    setIsDialogOpen(true)
  }

  const handleDeleteTeam = (teamId: string) => {
    setDeleteTeamId(teamId)
  }

  const confirmDeleteTeam = async () => {
    if (!deleteTeamId) return
    try {
      setIsDeletingTeam(true)
      await deleteTeam(deleteTeamId)
      setDeleteTeamId(null)
      loadTeams()
    } catch (error) {
      const message = describeApiError(error, "Could not reach OpenLinear server. Check your connection and try again.")
      toast.error(`Failed to delete team: ${message}`)
    } finally {
      setIsDeletingTeam(false)
    }
  }

  const handleEditTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTeam || !editFormData.name.trim()) return

    try {
      setIsSubmitting(true)
      setEditError(null)
      await updateTeam(editTeam.id, {
        name: editFormData.name,
        description: editFormData.description || null,
        color: editFormData.color,
      })
      setIsEditDialogOpen(false)
      setEditTeam(null)
      setEditFormData({ name: "", description: "", color: "#6366f1" })
      loadTeams()
    } catch (error) {
      const message = describeApiError(error, "Could not reach OpenLinear server. Check your connection and try again.")
      setEditError(message)
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const filteredTeams = teams.filter(team =>
    team.name.toLowerCase().includes(filterText.toLowerCase()) ||
    team.key.toLowerCase().includes(filterText.toLowerCase()) ||
    (team.description && team.description.toLowerCase().includes(filterText.toLowerCase()))
  )

  return (
    <>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-linear-text">Teams</h1>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={openJoinTeamDialog}
                    className="h-8 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text"
                  >
                    <LogIn className="w-4 h-4 mr-1.5" />
                    <span className="hidden sm:inline">Join team</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={openCreateTeamDialog}
                    className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white"
                  >
                    <Plus className="w-4 h-4 mr-1.5" />
                    <span className="hidden sm:inline">Create team</span>
                  </Button>
                  <DialogContent className="bg-linear-bg-secondary border-linear-border" onCloseAutoFocus={handleCloseCreateDialog}>
                    <DialogHeader>
                      <DialogTitle className="text-linear-text">
                        {createdTeam ? "Team Created!" : teamDialogMode === "join" ? "Join Team" : "Create Team"}
                      </DialogTitle>
                      {!createdTeam && (
                        <DialogDescription className="text-linear-text-secondary">
                          {teamDialogMode === "join"
                            ? "Enter your invite code to join an existing team."
                            : "Create a new team and invite your teammates."}
                        </DialogDescription>
                      )}
                    </DialogHeader>
                    {createdTeam ? (
                      <div className="space-y-6 mt-4">
                        <div className="p-4 rounded-sm bg-green-500/10 border border-green-500/20">
                          <div className="text-sm text-green-600 dark:text-green-400 font-medium mb-2">
                            Team created successfully!
                          </div>
                          <div className="text-sm text-linear-text-secondary mb-4">
                            Share this invite code with others to let them join your team.
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 px-3 py-2 rounded-sm bg-linear-bg-tertiary border border-linear-border font-mono text-sm text-linear-text">
                              {createdTeam.inviteCode}
                            </code>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleCopyCreatedCode}
                              className="border-linear-border hover:bg-linear-bg-tertiary"
                            >
                              {copiedCreatedCode ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            onClick={handleCloseCreateDialog}
                            className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                          >
                            Done
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4">
                        {teamDialogMode === "create" ? (
                          <form onSubmit={handleCreateTeam} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="name" className="text-linear-text-secondary">Name</Label>
                        <Input
                          id="name"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                          placeholder="Engineering"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="key" className="text-linear-text-secondary">Key</Label>
                        <Input
                          id="key"
                          value={formData.key}
                          onChange={(e) => setFormData({ ...formData, key: e.target.value.toUpperCase() })}
                          placeholder="ENG"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text font-mono"
                          required
                        />
                        <p className="text-xs text-linear-text-tertiary">A short unique identifier for your team</p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="description" className="text-linear-text-secondary">Description</Label>
                        <Input
                          id="description"
                          value={formData.description}
                          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                          placeholder="Product engineering team"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="color" className="text-linear-text-secondary">Color</Label>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            id="color"
                            value={formData.color}
                            onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                            className="w-10 h-10 rounded-sm border border-linear-border cursor-pointer"
                          />
                          <span className="text-sm text-linear-text-secondary font-mono">{formData.color}</span>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleCloseCreateDialog}
                          className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={isSubmitting || !formData.name.trim() || !formData.key.trim()}
                          className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                        >
                          {isSubmitting ? "Creating..." : "Create team"}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <form onSubmit={handleJoinTeam} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="inviteCode" className="text-linear-text-secondary">Invite Code</Label>
                        <Input
                          id="inviteCode"
                          value={joinCode}
                          onChange={(e) => {
                            setJoinCode(e.target.value.toUpperCase())
                            setJoinError("")
                          }}
                          placeholder="KEY-XXXXXXXX"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text font-mono"
                          required
                        />
                        <p className="text-xs text-linear-text-tertiary">
                          Enter the invite code you received (format: KEY-XXXXXXXX)
                        </p>
                      </div>
                      {joinError && (
                        <div className="text-sm text-red-500">
                          {joinError}
                        </div>
                      )}
                      <div className="flex justify-end gap-2 pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleCloseCreateDialog}
                          className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={isSubmitting || !joinCode.trim()}
                          className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                        >
                          {isSubmitting ? "Joining..." : "Join Team"}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>
                <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
                  <DialogContent className="bg-linear-bg-secondary border-linear-border">
                    <DialogHeader>
                      <DialogTitle className="text-linear-text">Edit team</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleEditTeam} className="space-y-4 mt-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-name" className="text-linear-text-secondary">Name</Label>
                        <Input
                          id="edit-name"
                          value={editFormData.name}
                          onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                          placeholder="Engineering"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-key" className="text-linear-text-secondary">Key</Label>
                        <Input
                          id="edit-key"
                          value={editTeam?.key || ""}
                          disabled
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text-secondary font-mono opacity-60"
                        />
                        <p className="text-xs text-linear-text-tertiary">Team key cannot be changed</p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-description" className="text-linear-text-secondary">Description</Label>
                        <Input
                          id="edit-description"
                          value={editFormData.description}
                          onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                          placeholder="Product engineering team"
                          className="bg-linear-bg-tertiary border-linear-border text-linear-text"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-color" className="text-linear-text-secondary">Color</Label>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            id="edit-color"
                            value={editFormData.color}
                            onChange={(e) => setEditFormData({ ...editFormData, color: e.target.value })}
                            className="w-10 h-10 rounded-sm border border-linear-border cursor-pointer"
                          />
                          <span className="text-sm text-linear-text-secondary font-mono">{editFormData.color}</span>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setIsEditDialogOpen(false)}
                          className="border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={isSubmitting || !editFormData.name.trim()}
                          className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                        >
                          {isSubmitting ? "Saving..." : "Save changes"}
                        </Button>
                      </div>
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
                  placeholder="Filter teams..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-full h-9 pl-10 pr-4 rounded-sm bg-linear-bg-tertiary border border-linear-border text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
                />
                {filterText && (
                  <button
                    type="button"
                    onClick={() => setFilterText("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary hover:text-linear-text"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" className="h-9 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary">
                <Filter className="w-4 h-4 mr-1.5" />
                Filter
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="hidden md:block">
              <table className="w-full">
                <tbody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-linear-border/50">
                      <td className="py-3 px-6">
                        <div className="flex items-center gap-3">
                          <Skeleton className="w-7 h-7 rounded-sm" />
                          <div className="space-y-1.5">
                            <Skeleton className="h-3.5 w-32 rounded" />
                            <Skeleton className="h-2.5 w-48 rounded" />
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4"><Skeleton className="h-3 w-12 rounded" /></td>
                      <td className="py-3 px-4"><Skeleton className="h-3 w-28 rounded" /></td>
                      <td className="py-3 px-4"><Skeleton className="h-3 w-8 rounded" /></td>
                      <td className="py-3 px-4" />
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="block md:hidden space-y-3 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-sm" />
                ))}
              </div>
            </div>
          ) : filteredTeams.length > 0 ? (
            <>
              <div className="hidden md:block">
                <div className="min-w-[800px]">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-linear-border">
                        <th className="text-left py-3 px-6 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                          Team
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[100px]">
                          Key
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[180px]">
                          Invite Code
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[140px]">
                          Members
                        </th>
                        <th className="w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTeams.map((team) => (
                        <tr
                          key={team.id}
                          onClick={() => router.push(`/teams/manage?id=${team.id}`)}
                          className="border-b border-linear-border/50 hover:bg-linear-bg-secondary/50 transition-colors cursor-pointer group"
                        >
                          <td className="py-3 px-6">
                            <div className="flex items-center gap-3">
                              <div
                                className="w-7 h-7 rounded-sm flex items-center justify-center flex-shrink-0 border border-linear-border"
                                style={{ backgroundColor: `${team.color}20` }}
                              >
                                <span className="text-xs font-bold" style={{ color: team.color }}>
                                  {team.name.charAt(0)}
                                </span>
                              </div>
                              <div>
                                <div className="text-sm font-medium text-linear-text">{team.name}</div>
                                {team.description && (
                                  <div className="text-xs text-linear-text-tertiary">{team.description}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-sm text-linear-text-secondary font-mono">{team.key}</span>
                          </td>
                          <td className="py-3 px-4">
                            {team.inviteCode ? (
                              <div className="flex items-center gap-2">
                                <code className="text-sm font-mono text-linear-text-secondary">
                                  {team.inviteCode}
                                </code>
                                <button
                                  type="button"
                                  onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation()
                                    handleCopyInviteCode(team.inviteCode!, team.id)
                                  }}
                                  className="p-1 rounded hover:bg-linear-bg-tertiary transition-colors"
                                  title="Copy invite code"
                                >
                                  {copiedTeamId === team.id ? (
                                    <Check className="w-3.5 h-3.5 text-green-500" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5 text-linear-text-tertiary" />
                                  )}
                                </button>
                              </div>
                            ) : (
                              <span className="text-sm text-linear-text-tertiary">—</span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1">
                              <Users className="w-4 h-4 text-linear-text-tertiary" />
                              <span className="text-sm text-linear-text-secondary">
                                {team._count?.members ?? team.members?.length ?? 0}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation()
                                  setEditTeam(team)
                                  setEditFormData({
                                    name: team.name,
                                    description: team.description || "",
                                    color: team.color,
                                  })
                                  setIsEditDialogOpen(true)
                                }}
                                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                                title="Edit team"
                              >
                                <Pencil className="w-4 h-4 text-linear-text-secondary" />
                              </button>
                              <button
                                type="button"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation()
                                  handleDeleteTeam(team.id)
                                }}
                                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-sm hover:bg-red-500/10 transition-all"
                                title="Delete team"
                              >
                                <Trash2 className="w-4 h-4 text-red-500" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="block md:hidden space-y-3 p-4">
                {filteredTeams.map((team) => (
                  <div
                    key={team.id}
                    className="bg-linear-bg-secondary border border-linear-border rounded-sm p-4 cursor-pointer"
                  >
                    <button
                      type="button"
                      onClick={() => router.push(`/teams/manage?id=${team.id}`)}
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="w-10 h-10 rounded-sm flex items-center justify-center flex-shrink-0 border border-linear-border"
                            style={{ backgroundColor: `${team.color}20` }}
                          >
                            <span className="text-sm font-bold" style={{ color: team.color }}>
                              {team.name.charAt(0)}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-medium text-linear-text truncate">{team.name}</div>
                              <span className="text-xs text-linear-text-secondary font-mono bg-linear-bg-tertiary px-1.5 py-0.5 rounded">{team.key}</span>
                            </div>
                            {team.description && (
                              <div className="text-xs text-linear-text-tertiary line-clamp-1">{team.description}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-linear-border/50">
                      <div className="flex items-center gap-3">
                        {team.inviteCode ? (
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-mono text-linear-text-secondary">
                              {team.inviteCode}
                            </code>
                            <button
                              type="button"
                              onClick={(e: React.MouseEvent) => {
                                e.stopPropagation()
                                handleCopyInviteCode(team.inviteCode!, team.id)
                              }}
                              className="p-1 rounded hover:bg-linear-bg-tertiary transition-colors"
                              title="Copy invite code"
                            >
                              {copiedTeamId === team.id ? (
                                <Check className="w-3 h-3 text-green-500" />
                              ) : (
                                <Copy className="w-3 h-3 text-linear-text-tertiary" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-linear-text-tertiary">—</span>
                        )}
                        <div className="flex items-center gap-1">
                          <Users className="w-3.5 h-3.5 text-linear-text-tertiary" />
                          <span className="text-xs text-linear-text-secondary">
                            {team._count?.members ?? team.members?.length ?? 0}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation()
                            setEditTeam(team)
                            setEditFormData({
                              name: team.name,
                              description: team.description || "",
                              color: team.color,
                            })
                            setIsEditDialogOpen(true)
                          }}
                          className="p-1.5 rounded-sm hover:bg-linear-bg-tertiary transition-all"
                          title="Edit team"
                        >
                          <Pencil className="w-4 h-4 text-linear-text-secondary" />
                        </button>
                        <button
                          type="button"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation()
                            handleDeleteTeam(team.id)
                          }}
                          className="p-1.5 rounded-sm hover:bg-red-500/10 transition-all"
                          title="Delete team"
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon={Users}
              title={filterText ? "No teams found" : "No teams yet"}
              description={
                filterText
                  ? "Try adjusting your filter"
                  : "Create a team to organize your members and issues"
              }
              action={
                !filterText && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white"
                    onClick={openCreateTeamDialog}
                  >
                    <Plus className="w-4 h-4 mr-1.5" />
                    Create team
                  </Button>
                )
              }
            />
          )}
        </div>
      </div>

      <AlertDialog open={deleteTeamId !== null} onOpenChange={(open) => { if (!open) setDeleteTeamId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete team</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this team? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingTeam}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmDeleteTeam() }}
              disabled={isDeletingTeam}
              className={cn(buttonVariants({ variant: "destructive" }))}
            >
              {isDeletingTeam ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
