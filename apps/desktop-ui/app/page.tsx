"use client"

import { useState, useCallback } from "react"
import { Search, Plus } from "lucide-react"
import { KanbanBoard } from "@/components/board/kanban-board"
import { TaskFormDialog } from "@/components/task-form"
import { RepoConnector } from "@/components/repo-connector"

import { AppShell } from "@/components/layout/app-shell"
import { useAuth } from "@/hooks/use-auth"

export default function HomePage() {
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const { isAuthenticated, activeProject } = useAuth()

  const handleTaskCreated = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {activeProject ? activeProject.name : "All Issues"}
          </h1>
          {!isAuthenticated && <RepoConnector />}
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <div className="relative hidden sm:block">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
            <input
              type="text"
              placeholder="Search issues..."
              className="w-full max-w-64 h-9 pl-10 pr-4 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover transition-colors"
            />
          </div>
          <button className="sm:hidden w-9 h-9 rounded-md flex items-center justify-center text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors">
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsTaskFormOpen(true)}
            className="flex items-center gap-2 h-9 px-3 sm:px-4 rounded-md bg-linear-accent hover:bg-linear-accent-hover text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Create Task</span>
          </button>

        </div>
      </header>

      <KanbanBoard key={refreshKey} />
      <TaskFormDialog
        open={isTaskFormOpen}
        onOpenChange={setIsTaskFormOpen}
        onSuccess={handleTaskCreated}
      />
    </AppShell>
  )
}
