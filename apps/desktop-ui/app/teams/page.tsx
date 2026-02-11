"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Plus,
  Filter,
  Users,
  Trash2,
  X,
  Pencil
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { AppShell } from "@/components/layout/app-shell"
import { fetchTeams, createTeam, deleteTeam, updateTeam, type Team } from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"

export default function TeamsPage() {
  const router = useRouter()
  const [teams, setTeams] = useState<Team[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
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

  const loadTeams = useCallback(async () => {
    try {
      setIsLoading(true)
      const data = await fetchTeams()
      setTeams(data)
    } catch (error) {
      console.error("Failed to fetch teams:", error)
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

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim() || !formData.key.trim()) return

    try {
      setIsSubmitting(true)
      await createTeam({
        name: formData.name,
        key: formData.key.toUpperCase(),
        description: formData.description || undefined,
        color: formData.color,
      })
      setIsDialogOpen(false)
      setFormData({ name: "", key: "", description: "", color: "#6366f1" })
      loadTeams()
    } catch (error) {
      console.error("Failed to create team:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteTeam = async (teamId: string) => {
    if (!confirm("Are you sure you want to delete this team?")) return

    try {
      await deleteTeam(teamId)
      loadTeams()
    } catch (error) {
      console.error("Failed to delete team:", error)
    }
  }

  const handleEditTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTeam || !editFormData.name.trim()) return

    try {
      setIsSubmitting(true)
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
      console.error("Failed to update team:", error)
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
    <AppShell>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-linear-text">Teams</h1>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                      <Plus className="w-4 h-4 mr-1.5" />
                      <span className="hidden sm:inline">Create team</span>
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="bg-linear-bg-secondary border-linear-border">
                    <DialogHeader>
                      <DialogTitle className="text-linear-text">Create new team</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreateTeam} className="space-y-4 mt-4">
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
                            className="w-10 h-10 rounded-md border border-linear-border cursor-pointer"
                          />
                          <span className="text-sm text-linear-text-secondary font-mono">{formData.color}</span>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setIsDialogOpen(false)}
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
                            className="w-10 h-10 rounded-md border border-linear-border cursor-pointer"
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
                  className="w-full h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
                />
                {filterText && (
                  <button
                    onClick={() => setFilterText("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary hover:text-linear-text"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Button variant="outline" size="sm" className="h-9 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary">
                <Filter className="w-4 h-4 mr-1.5" />
                Filter
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center py-24">
              <div className="text-linear-text-tertiary">Loading teams...</div>
            </div>
          ) : filteredTeams.length > 0 ? (
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
                      onClick={() => router.push(`/teams/${team.id}`)}
                      className="border-b border-linear-border/50 hover:bg-linear-bg-secondary/50 transition-colors cursor-pointer group"
                    >
                      <td className="py-3 px-6">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border border-linear-border"
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
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all"
                            title="Edit team"
                          >
                            <Pencil className="w-4 h-4 text-linear-text-secondary" />
                          </button>
                          <button
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation()
                              handleDeleteTeam(team.id)
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-red-500/10 transition-all"
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
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center py-24">
              <div className="w-12 h-12 rounded-xl bg-linear-bg-tertiary border border-linear-border flex items-center justify-center mb-4">
                <Users className="w-6 h-6 text-linear-text-tertiary" />
              </div>
              <h3 className="text-sm font-medium text-linear-text mb-1">
                {filterText ? "No teams found" : "No teams yet"}
              </h3>
              <p className="text-sm text-linear-text-tertiary mb-4">
                {filterText
                  ? "Try adjusting your filter"
                  : "Create a team to organize your members and issues"}
              </p>
              {!filterText && (
                <Button
                  size="sm"
                  className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white"
                  onClick={() => setIsDialogOpen(true)}
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  Create team
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
