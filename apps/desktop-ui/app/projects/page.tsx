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
  Target, 
  Hexagon, 
  Briefcase,
  Filter,
  AlertCircle,
  Calendar,
  MoreHorizontal,
  ChevronRight,
  CheckCircle2,
  TrendingUp,
  Users
} from "lucide-react"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface Project {
  id: string
  name: string
  description: string
  icon: "target" | "hexagon" | "folder"
  iconColor: string
  health: "on_track" | "at_risk" | "off_track" | "no_updates"
  priority: "high" | "medium" | "low" | "none"
  lead: {
    name: string
    initials: string
    avatarColor: string
  }
  targetDate: string
  status: {
    completed: number
    total: number
  }
}

const projects: Project[] = [
  {
    id: "1",
    name: "MVP Development",
    description: "Core product minimum viable release",
    icon: "hexagon",
    iconColor: "bg-blue-500",
    health: "on_track",
    priority: "high",
    lead: { name: "You", initials: "YO", avatarColor: "bg-blue-500" },
    targetDate: "Mar 30, 2026",
    status: { completed: 0, total: 10 }
  }
]

const navItemClass = (isActive: boolean) => cn(
  "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer group",
  isActive 
    ? "bg-linear-bg-tertiary text-linear-text shadow-sm" 
    : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
)

const sectionHeaderClass = "flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider hover:text-linear-text-secondary transition-colors duration-200"

function ProjectIcon({ type, color }: { type: Project["icon"]; color: string }) {
  const iconClass = "w-3.5 h-3.5 text-linear-text-secondary"
  return (
    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-linear-bg-tertiary border border-linear-border">
      {type === "target" && <Target className={iconClass} />}
      {type === "hexagon" && <Hexagon className={iconClass} />}
      {type === "folder" && <FolderKanban className={iconClass} />}
    </div>
  )
}

function HealthIndicator({ health }: { health: Project["health"] }) {
  const configs = {
    on_track: { icon: CheckCircle2, color: "text-emerald-400", text: "On track" },
    at_risk: { icon: AlertCircle, color: "text-amber-400", text: "At risk" },
    off_track: { icon: AlertCircle, color: "text-red-400", text: "Off track" },
    no_updates: { icon: Circle, color: "text-gray-400", text: "No updates" }
  }
  const config = configs[health]
  const Icon = config.icon
  
  return (
    <div className="flex items-center gap-2">
      <Icon className={cn("w-4 h-4", config.color)} />
      <span className="text-sm text-linear-text-secondary">{config.text}</span>
    </div>
  )
}

function PriorityIndicator({ priority }: { priority: Project["priority"] }) {
  if (priority === "none") return <span className="text-sm text-linear-text-tertiary">—</span>
  
  const colors = {
    high: "text-orange-400",
    medium: "text-blue-400",
    low: "text-gray-400"
  }
  
  return (
    <AlertCircle className={cn("w-4 h-4", colors[priority])} />
  )
}

function StatusBar({ completed, total }: { completed: number; total: number }) {
  const percentage = Math.round((completed / total) * 100)
  
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1.5 bg-linear-bg-tertiary rounded-full overflow-hidden max-w-[100px]">
        <div 
          className="h-full bg-linear-accent rounded-full transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-sm text-linear-text-secondary w-12">{percentage}%</span>
    </div>
  )
}

export default function ProjectsPage() {
  const pathname = usePathname()
  const { isAuthenticated, activeProject } = useAuth()
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [favoritesExpanded, setFavoritesExpanded] = useState(true)
  const [activeTab, setActiveTab] = useState("all")

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
              className={navItemClass(false)}
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
                <h1 className="text-xl font-semibold text-linear-text">Projects</h1>
                <div className="flex items-center gap-1">
                  <button 
                    onClick={() => setActiveTab("all")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      activeTab === "all" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    All projects
                  </button>
                  <button 
                    onClick={() => setActiveTab("active")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      activeTab === "active" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    Active
                  </button>
                  <button 
                    onClick={() => setActiveTab("archived")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      activeTab === "archived" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    Archived
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text">
                  <TrendingUp className="w-4 h-4 mr-1.5" />
                  New view
                </Button>
                <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                  <Plus className="w-4 h-4 mr-1.5" />
                  Add project
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
                <input
                  type="text"
                  placeholder="Filter projects..."
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
          <div className="min-w-[800px]">
            <table className="w-full">
              <thead>
                <tr className="border-b border-linear-border">
                  <th className="text-left py-3 px-6 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider">
                    Name
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[140px]">
                    Health
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[80px]">
                    Priority
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[120px]">
                    Lead
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[130px]">
                    Target date
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-linear-text-tertiary uppercase tracking-wider w-[160px]">
                    Status
                  </th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr 
                    key={project.id} 
                    className="border-b border-linear-border/50 hover:bg-linear-bg-secondary/50 transition-colors cursor-pointer group"
                  >
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-3">
                        <ProjectIcon type={project.icon} color={project.iconColor} />
                        <div>
                          <div className="text-sm font-medium text-linear-text">{project.name}</div>
                          <div className="text-xs text-linear-text-tertiary">{project.description}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <HealthIndicator health={project.health} />
                    </td>
                    <td className="py-3 px-4">
                      <PriorityIndicator priority={project.priority} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-linear-text-secondary bg-linear-bg-tertiary border border-linear-border">
                          {project.lead.initials}
                        </div>
                        <span className="text-sm text-linear-text-secondary">{project.lead.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2 text-sm text-linear-text-secondary">
                        <Calendar className="w-3.5 h-3.5 text-linear-text-tertiary" />
                        {project.targetDate}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBar completed={project.status.completed} total={project.status.total} />
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
        </div>
      </main>
    </div>
  )
}
