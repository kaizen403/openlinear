"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter, useParams } from "next/navigation"
import {
  ArrowLeft,
  Users,
  Plus,
  Trash2,
  User,
  Crown,
  Shield,
  Mail,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { AppShell } from "@/components/layout/app-shell"
import {
  fetchTeam,
  addTeamMember,
  removeTeamMember,
  type Team,
  type TeamMember,
} from "@/lib/api"
import { useSSE } from "@/hooks/use-sse"

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

export default function TeamDetailPage() {
  const router = useRouter()
  const params = useParams()
  const teamId = params.id as string

  const [team, setTeam] = useState<Team | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [memberEmail, setMemberEmail] = useState("")
  const [selectedRole, setSelectedRole] = useState<'member' | 'admin' | 'owner'>('member')
  const [isAddingMember, setIsAddingMember] = useState(false)

  const loadTeam = useCallback(async () => {
    if (!teamId) return
    try {
      setIsLoading(true)
      const data = await fetchTeam(teamId)
      setTeam(data)
    } catch (error) {
      console.error("Failed to fetch team:", error)
    } finally {
      setIsLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    loadTeam()
  }, [loadTeam])

  useSSE(`${API_URL}/api/events`, (eventType) => {
    if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
      loadTeam()
    }
  })

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!memberEmail.trim() || !teamId) return

    try {
      setIsAddingMember(true)
      await addTeamMember(teamId, {
        email: memberEmail,
        role: selectedRole,
      })
      setMemberEmail("")
      loadTeam()
    } catch (error) {
      console.error("Failed to add team member:", error)
    } finally {
      setIsAddingMember(false)
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

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
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
          <div className="max-w-3xl mx-auto p-6">
            <div className="mb-8">
              <h2 className="text-lg font-medium text-linear-text mb-4 flex items-center gap-2">
                <Users className="w-5 h-5 text-linear-text-secondary" />
                Members ({members.length})
              </h2>

              <form onSubmit={handleAddMember} className="mb-6 p-4 rounded-lg bg-linear-bg-secondary border border-linear-border">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <Label htmlFor="email" className="sr-only">Email</Label>
                    <div className="relative">
                      <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
                      <Input
                        id="email"
                        type="email"
                        value={memberEmail}
                        onChange={(e) => setMemberEmail(e.target.value)}
                        placeholder="member@example.com"
                        className="pl-10 bg-linear-bg-tertiary border-linear-border text-linear-text"
                        required
                      />
                    </div>
                  </div>
                  <div className="w-full sm:w-32">
                    <Label htmlFor="role" className="sr-only">Role</Label>
                    <select
                      id="role"
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value as 'member' | 'admin' | 'owner')}
                      className="w-full h-10 rounded-md bg-linear-bg-tertiary border border-linear-border text-linear-text px-3 text-sm focus:outline-none focus:border-linear-border-hover"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                  </div>
                  <Button
                    type="submit"
                    disabled={isAddingMember || !memberEmail.trim()}
                    className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                  >
                    <Plus className="w-4 h-4 mr-1.5" />
                    Add
                  </Button>
                </div>
              </form>

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
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
