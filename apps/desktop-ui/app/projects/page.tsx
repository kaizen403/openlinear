"use client"

import { useState } from "react"
import { 
  Search, 
  Plus, 
  FolderKanban, 
  Circle, 
  Target, 
  Hexagon, 
  Filter,
  AlertCircle,
  Calendar,
  MoreHorizontal,
  CheckCircle2,
  TrendingUp
} from "lucide-react"
import { AppShell } from "@/components/layout/app-shell"
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
    high: "text-orange-600",
    medium: "text-blue-600",
    low: "text-gray-500"
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
  const [activeTab, setActiveTab] = useState("all")

  return (
    <AppShell>
      <div className="flex-1 flex flex-col min-w-0 bg-linear-bg">
        <div className="border-b border-linear-border">
          <div className="px-4 sm:px-6 py-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto">
                <h1 className="text-xl font-semibold text-linear-text flex-shrink-0">Projects</h1>
                <div className="flex items-center gap-1">
                  <button 
                    onClick={() => setActiveTab("all")}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
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
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
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
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                      activeTab === "archived" 
                        ? "bg-linear-bg-tertiary text-linear-text" 
                        : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                  >
                    Archived
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" size="sm" className="h-8 border-linear-border bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text">
                  <TrendingUp className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">New view</span>
                </Button>
                <Button size="sm" className="h-8 bg-linear-accent hover:bg-linear-accent-hover text-white">
                  <Plus className="w-4 h-4 mr-1.5" />
                  <span className="hidden sm:inline">Add project</span>
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
      </div>
    </AppShell>
  )
}
