"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Layout,
  Home,
  Inbox,
  Layers,
  Settings,
  Search,
  Plus,
  FolderKanban,
  ChevronDown,
  Circle,
  Hash,
  Hexagon,
  Briefcase,
  Filter,
  MoreHorizontal,
  Users,
  UserCircle
} from "lucide-react"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

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

const navItemClass = (isActive: boolean) => cn(
  "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer group",
  isActive
    ? "bg-linear-bg-tertiary text-linear-text shadow-sm"
    : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
)

const sectionHeaderClass = "flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider hover:text-linear-text-secondary transition-colors duration-200"

export default function TeamsPage() {
  const pathname = usePathname()
  const { isAuthenticated, activeProject } = useAuth()
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [favoritesExpanded, setFavoritesExpanded] = useState(true)

  return (
    <div className="flex h-screen bg-linear-bg text-linear-text">
      <aside className="w-64 bg-linear-bg-secondary border-r border-linear-border flex flex-col">
        <div className="p-4 border-b border-linear-border flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-linear-accent flex items-center justify-center">
            <Layout className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-semibold text-linear-text">OpenLinear</span>
        </div>

        {isAuthenticated && (
          <div className="p-3 border-b border-linear-border">
            <ProjectSelector />
          </div>
        )}

        <nav className="flex-1 overflow-y-auto py-2">
          <div className="px-3 space-y-0.5">
            <Link href="/" className={navItemClass(pathname === '/')}>
              <Home className="w-4 h-4" />
              Home
            </Link>
            <Link href="/inbox" className={navItemClass(pathname === '/inbox')}>
              <Inbox className="w-4 h-4" />
              Inbox
              <span className="ml-auto text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">3</span>
            </Link>
            <Link href="/my-issues" className={navItemClass(pathname === '/my-issues')}>
              <Layers className="w-4 h-4" />
              My Issues
            </Link>
          </div>

          <div className="mt-4 px-3">
            <button onClick={() => setProjectsExpanded(!projectsExpanded)} className={sectionHeaderClass}>
              <span className={cn("transition-transform duration-200", projectsExpanded ? "" : "-rotate-90")}>
                <ChevronDown className="w-3 h-3" />
              </span>
              Projects
            </button>
            <div className={cn(
              "overflow-hidden transition-all duration-200 ease-in-out",
              projectsExpanded ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0"
            )}>
              <div className="space-y-0.5">
                <Link href="/projects" className={navItemClass(pathname === '/projects')}>
                  <Briefcase className="w-4 h-4 text-linear-text-secondary" />
                  All Projects
                </Link>
                {activeProject ? (
                  <Link href={`/projects/${activeProject.id}`} className={navItemClass(false)}>
                    <div className="w-4 h-4 rounded bg-linear-accent flex items-center justify-center">
                      <span className="text-[10px] font-bold text-white">{activeProject.name.charAt(0).toUpperCase()}</span>
                    </div>
                    <span className="truncate">{activeProject.name}</span>
                  </Link>
                ) : (
                  <div className="px-3 py-2 text-xs text-linear-text-tertiary">No project selected</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 px-3">
            <Link
              href="/teams"
              className={navItemClass(pathname === '/teams')}
            >
              <Users className="w-4 h-4 text-linear-text-secondary" />
              Teams
            </Link>
          </div>

          <div className="mt-4 px-3">
            <button onClick={() => setFavoritesExpanded(!favoritesExpanded)} className={sectionHeaderClass}>
              <span className={cn("transition-transform duration-200", favoritesExpanded ? "" : "-rotate-90")}>
                <ChevronDown className="w-3 h-3" />
              </span>
              Favorites
            </button>
            <div className={cn(
              "overflow-hidden transition-all duration-200 ease-in-out",
              favoritesExpanded ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0"
            )}>
              <div className="space-y-0.5">
                <Link href="/view/active" className={navItemClass(false)}>
                  <Circle className="w-3 h-3 text-linear-text-tertiary" />
                  Active Sprint
                </Link>
                <Link href="/view/backlog" className={navItemClass(false)}>
                  <Hash className="w-4 h-4 text-linear-text-tertiary" />
                  Backlog
                </Link>
              </div>
            </div>
          </div>
        </nav>

        <div className="p-3 border-t border-linear-border">
          <Link href="/settings" className={navItemClass(pathname === '/settings')}>
            <Settings className="w-4 h-4" />
            Settings
          </Link>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-linear-text">Teams</h1>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                  <Plus className="w-4 h-4 mr-1.5" />
                  Create team
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
      </main>
    </div>
  )
}
