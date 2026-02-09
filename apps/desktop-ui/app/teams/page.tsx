"use client"

import {
  Search,
  Plus,
  Filter,
  MoreHorizontal,
  Users
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AppShell } from "@/components/layout/app-shell"

interface Team {
  id: string
  name: string
  identifier: string
  description: string
  color: string
  members: {
    name: string
    initials: string
  }[]
  openIssues: number
  activeProjects: number
}

const teams: Team[] = []

export default function TeamsPage() {

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
                <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                  <Plus className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">Create team</span>
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
                <input
                  type="text"
                  placeholder="Filter teams..."
                  className="w-full h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
                />
              </div>
              <Button variant="outline" size="sm" className="h-9 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary">
                <Filter className="w-4 h-4 mr-1.5" />
                Filter
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {teams.length > 0 ? (
            <div className="min-w-[800px]">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-linear-border">
                    <th className="text-left py-3 px-6 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                      Team
                    </th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[100px]">
                      Identifier
                    </th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[140px]">
                      Members
                    </th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                      Open Issues
                    </th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                      Projects
                    </th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team) => (
                    <tr
                      key={team.id}
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
                            <div className="text-xs text-linear-text-tertiary">{team.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm text-linear-text-secondary font-mono">{team.identifier}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          <div className="flex -space-x-1.5">
                            {team.members.slice(0, 3).map((member, i) => (
                              <div
                                key={i}
                                className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-medium text-linear-text-secondary bg-linear-bg-tertiary border border-linear-bg"
                              >
                                {member.initials}
                              </div>
                            ))}
                          </div>
                          {team.members.length > 3 && (
                            <span className="text-xs text-linear-text-tertiary ml-1">
                              +{team.members.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm text-linear-text-secondary">{team.openIssues}</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm text-linear-text-secondary">{team.activeProjects}</span>
                      </td>
                      <td className="py-3 px-4">
                        <button className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-all">
                          <MoreHorizontal className="w-4 h-4 text-linear-text-tertiary" />
                        </button>
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
              <h3 className="text-sm font-medium text-linear-text mb-1">No teams yet</h3>
              <p className="text-sm text-linear-text-tertiary mb-4">Create a team to organize your members and issues</p>
              <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                <Plus className="w-4 h-4 mr-1.5" />
                Create team
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
