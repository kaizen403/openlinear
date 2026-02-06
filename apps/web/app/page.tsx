"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { Layout, Home, Inbox, Layers, Settings, Search, Plus } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"
import { UserMenu } from "@/components/auth/user-menu"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"

export default function HomePage() {
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const { isAuthenticated, activeProject } = useAuth()

  const handleTaskCreated = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  return (
    <div className="flex h-screen bg-linear-bg text-linear-text">
      <aside className="w-64 bg-linear-bg-secondary border-r border-linear-border flex flex-col">
        <div className="p-4 border-b border-linear-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-linear-accent flex items-center justify-center">
              <Layout className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold">OpenLinear</span>
          </div>
        </div>

        {isAuthenticated && (
          <div className="p-3 border-b border-linear-border">
            <ProjectSelector />
          </div>
        )}

        <nav className="flex-1 p-3">
          <ul className="space-y-1">
            <li>
              <a
                href="#"
                className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
              >
                <Home className="w-4 h-4" />
                Home
              </a>
            </li>
            <li>
              <a
                href="#"
                className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
              >
                <Inbox className="w-4 h-4" />
                Inbox
              </a>
            </li>
            <li>
              <a
                href="#"
                className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
              >
                <Layers className="w-4 h-4" />
                My Issues
              </a>
            </li>
          </ul>

          <div className="mt-6">
            <div className="px-3 mb-2 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider">
              Teams
            </div>
            <ul className="space-y-1">
              <li>
                <a
                  href="#"
                  className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                >
                  <div className="w-4 h-4 rounded bg-linear-accent flex items-center justify-center text-[10px] font-bold">
                    E
                  </div>
                  Engineering
                </a>
              </li>
              <li>
                <a
                  href="#"
                  className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                >
                  <div className="w-4 h-4 rounded bg-emerald-500 flex items-center justify-center text-[10px] font-bold">
                    D
                  </div>
                  Design
                </a>
              </li>
            </ul>
          </div>
        </nav>

        <div className="p-3 border-t border-linear-border">
          <Link
            href="/settings"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
          >
            <Settings className="w-4 h-4" />
            Settings
          </Link>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-linear-border flex items-center justify-between px-6 bg-linear-bg">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold">
              {activeProject ? activeProject.name : 'All Issues'}
            </h1>
          </div>
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
