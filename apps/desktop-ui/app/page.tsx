"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Layout, Home, Inbox, Layers, Settings, Search, Plus, FolderKanban, ChevronDown, Circle, Hash, Hexagon, Briefcase, Users } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"
import { UserMenu } from "@/components/auth/user-menu"
import { ProjectSelector } from "@/components/auth/project-selector"
import { RepoConnector } from "@/components/repo-connector"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"

export default function HomePage() {
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [favoritesExpanded, setFavoritesExpanded] = useState(true)
  const pathname = usePathname()
  const { isAuthenticated, activeProject } = useAuth()

  const handleTaskCreated = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  const navItemClass = (isActive: boolean) => cn(
    "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer group",
    isActive 
      ? "bg-linear-bg-tertiary text-linear-text shadow-sm" 
      : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
  )

  const sectionHeaderClass = "flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider hover:text-linear-text-secondary transition-colors duration-200"

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
            <Link
              href="/"
              className={navItemClass(pathname === '/')}
            >
              <Home className="w-4 h-4" />
              Home
            </Link>
            <Link
              href="/inbox"
              className={navItemClass(pathname === '/inbox')}
            >
              <Inbox className="w-4 h-4" />
              Inbox
              <span className="ml-auto text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">3</span>
            </Link>
            <Link
              href="/my-issues"
              className={navItemClass(pathname === '/my-issues')}
            >
              <Layers className="w-4 h-4" />
              My Issues
            </Link>
          </div>

          <div className="mt-4 px-3">
            <button 
              onClick={() => setProjectsExpanded(!projectsExpanded)}
              className={sectionHeaderClass}
            >
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
                <Link
                  href="/projects"
                  className={navItemClass(pathname === '/projects')}
                >
                  <Briefcase className="w-4 h-4 text-linear-text-secondary" />
                  All Projects
                </Link>
                {activeProject ? (
                  <Link
                    href={`/projects/${activeProject.id}`}
                    className={navItemClass(pathname.startsWith('/projects/') && pathname !== '/projects')}
                  >
                    <div className="w-4 h-4 rounded bg-linear-accent flex items-center justify-center">
                      <span className="text-[10px] font-bold text-white">{activeProject.name.charAt(0).toUpperCase()}</span>
                    </div>
                    <span className="truncate">{activeProject.name}</span>
                  </Link>
                ) : (
                  <div className="px-3 py-2 text-xs text-linear-text-tertiary">
                    No project selected
                  </div>
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
            <button 
              onClick={() => setFavoritesExpanded(!favoritesExpanded)}
              className={sectionHeaderClass}
            >
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
                <Link
                  href="/view/active"
                  className={navItemClass(pathname === '/view/active')}
                >
                  <Circle className="w-3 h-3 text-linear-text-tertiary" />
                  Active Sprint
                </Link>
                <Link
                  href="/view/backlog"
                  className={navItemClass(pathname === '/view/backlog')}
                >
                  <Hash className="w-4 h-4 text-linear-text-tertiary" />
                  Backlog
                </Link>
              </div>
            </div>
          </div>
        </nav>

        <div className="p-3 border-t border-linear-border">
          <Link
            href="/settings"
            className={cn(
              "flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium transition-all duration-200",
              pathname === '/settings'
                ? "bg-linear-bg-tertiary text-linear-text"
                : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
            )}
          >
            <Settings className="w-4 h-4" />
            Settings
          </Link>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-14 border-b border-linear-border flex items-center px-6 bg-linear-bg gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <h1 className="text-lg font-semibold">
              {activeProject ? activeProject.name : 'All Issues'}
            </h1>
            {!isAuthenticated && <RepoConnector />}
          </div>
          <div className="flex-1 h-full" data-tauri-drag-region />
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
              <input
                type="text"
                placeholder="Search issues..."
                className="w-64 h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
              />
            </div>
            <button
              onClick={() => setIsTaskFormOpen(true)}
              className="flex items-center gap-2 h-9 px-4 rounded-md bg-linear-accent hover:bg-linear-accent-hover text-white text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Task
            </button>
            <UserMenu />
          </div>
        </header>

        <KanbanBoard key={refreshKey} />
        <TaskFormDialog
          open={isTaskFormOpen}
          onOpenChange={setIsTaskFormOpen}
          onSuccess={handleTaskCreated}
        />
      </main>
    </div>
  )
}
