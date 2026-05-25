"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Inbox,
  ListChecks,
  FolderKanban,
  Users,
  Archive,
  Settings,
  Plus,
  Sun,
  Moon,
  CheckSquare,
  Hash,
  Loader2,
} from "lucide-react"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { apiFetch } from "@/lib/api/fetch"

interface TaskHit {
  id: string
  title: string
  identifier: string | null
  type: "task"
}

interface ProjectHit {
  id: string
  name: string
  type: "project"
}

interface TeamHit {
  id: string
  name: string
  key: string
  type: "team"
}

interface SearchResponse {
  tasks: TaskHit[]
  projects: ProjectHit[]
  teams: TeamHit[]
}

const EMPTY_RESULTS: SearchResponse = { tasks: [], projects: [], teams: [] }

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const deferredQuery = React.useDeferredValue(query)
  const [debouncedQuery, setDebouncedQuery] = React.useState("")
  const [results, setResults] = React.useState<SearchResponse>(EMPTY_RESULTS)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    const handleFocusSearch = () => setOpen(true)
    window.addEventListener("keydown", handleKey)
    window.addEventListener("openlinear:focus-search", handleFocusSearch)
    return () => {
      window.removeEventListener("keydown", handleKey)
      window.removeEventListener("openlinear:focus-search", handleFocusSearch)
    }
  }, [])

  React.useEffect(() => {
    if (!open) {
      setQuery("")
      setDebouncedQuery("")
      setResults(EMPTY_RESULTS)
    }
  }, [open])

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(deferredQuery.trim())
    }, 200)
    return () => window.clearTimeout(handle)
  }, [deferredQuery])

  React.useEffect(() => {
    if (!open || debouncedQuery.length === 0) {
      setResults(EMPTY_RESULTS)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)

    apiFetch<SearchResponse>(
      `/api/search?q=${encodeURIComponent(debouncedQuery)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setResults(data ?? EMPTY_RESULTS)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setResults(EMPTY_RESULTS)
        setLoading(false)
      })

    return () => controller.abort()
  }, [open, debouncedQuery])

  const runCommand = React.useCallback((fn: () => void) => {
    setOpen(false)
    // Defer until after the dialog closes to avoid focus / route conflicts
    window.setTimeout(fn, 0)
  }, [])

  const toggleTheme = React.useCallback(() => {
    if (typeof document === "undefined") return
    document.documentElement.classList.toggle("dark")
  }, [])

  const showSearchGroup =
    debouncedQuery.length > 0 &&
    (results.tasks.length > 0 ||
      results.projects.length > 0 ||
      results.teams.length > 0 ||
      loading)

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search or jump to..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {!loading && debouncedQuery.length > 0 &&
          results.tasks.length === 0 &&
          results.projects.length === 0 &&
          results.teams.length === 0 && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}

        <CommandGroup heading="Navigate">
          <CommandItem
            onSelect={() => runCommand(() => router.push("/inbox"))}
          >
            <Inbox />
            <span>Inbox</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/my-issues"))}
          >
            <ListChecks />
            <span>My Issues</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/projects"))}
          >
            <FolderKanban />
            <span>Projects</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/teams"))}
          >
            <Users />
            <span>Teams</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/archived"))}
          >
            <Archive />
            <span>Archived</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/settings"))}
          >
            <Settings />
            <span>Settings</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Quick Actions">
          <CommandItem
            onSelect={() => runCommand(() => router.push("/inbox?new=task"))}
          >
            <Plus />
            <span>New Task</span>
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              runCommand(() => router.push("/projects?new=project"))
            }
          >
            <Plus />
            <span>New Project</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => router.push("/teams/manage"))}
          >
            <Plus />
            <span>New Team</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(toggleTheme)}>
            <Sun />
            <Moon />
            <span>Toggle Theme</span>
          </CommandItem>
        </CommandGroup>

        {showSearchGroup && (
          <>
            <CommandSeparator />
            {loading && results.tasks.length === 0 &&
              results.projects.length === 0 &&
              results.teams.length === 0 && (
                <CommandGroup heading="Search">
                  <CommandItem disabled value="__loading__">
                    <Loader2 className="animate-spin" />
                    <span>Searching…</span>
                  </CommandItem>
                </CommandGroup>
              )}

            {results.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {results.tasks.map((task) => (
                  <CommandItem
                    key={`task-${task.id}`}
                    value={`task-${task.id}-${task.title}`}
                    onSelect={() =>
                      runCommand(() => router.push(`/inbox?taskId=${task.id}`))
                    }
                  >
                    <CheckSquare />
                    <span className="truncate">{task.title}</span>
                    {task.identifier && (
                      <CommandShortcut>{task.identifier}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.projects.length > 0 && (
              <CommandGroup heading="Projects">
                {results.projects.map((project) => (
                  <CommandItem
                    key={`project-${project.id}`}
                    value={`project-${project.id}-${project.name}`}
                    onSelect={() =>
                      runCommand(() =>
                        router.push(`/projects?projectId=${project.id}`),
                      )
                    }
                  >
                    <FolderKanban />
                    <span className="truncate">{project.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {results.teams.length > 0 && (
              <CommandGroup heading="Teams">
                {results.teams.map((team) => (
                  <CommandItem
                    key={`team-${team.id}`}
                    value={`team-${team.id}-${team.name}`}
                    onSelect={() =>
                      runCommand(() =>
                        router.push(`/teams/manage?id=${team.id}`),
                      )
                    }
                  >
                    <Users />
                    <span className="truncate">{team.name}</span>
                    <CommandShortcut>
                      <Hash className="inline h-3 w-3" />
                      {team.key}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
