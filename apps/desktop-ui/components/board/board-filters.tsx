"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { User, Users, Check, X, Rows3, Ban, CircleCheck, Play } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"
import { useTeamMembers, TeamMemberOption } from "@/hooks/use-team-members"

/** W17a: only tasks waiting on an unfinished task, or only open tasks nothing blocks. */
export type DependencyFilter = "blocked" | "ready"

export interface BoardFiltersState {
  assigneeIds: string[]
  groupByAssignee: boolean
  dependency?: DependencyFilter | null
}

export function parseDependencyFilter(value: string | null): DependencyFilter | null {
  return value === "blocked" || value === "ready" ? value : null
}

/** Whether a task passes the dependency filter (`blocked`: from the board's blocked set). */
export function matchesDependencyFilter(task: { id: string; status: string }, filter: DependencyFilter | null | undefined, blocked: ReadonlySet<string>): boolean {
  if (!filter) return true
  if (filter === "blocked") return blocked.has(task.id)
  return task.status !== "done" && task.status !== "cancelled" && !blocked.has(task.id)
}

interface BoardFiltersProps {
  value: BoardFiltersState
  onChange: (state: BoardFiltersState) => void
  /** With the Ready filter on: run this many ready tasks as one batch (after a confirm). */
  readyCount?: number
  onRunReady?: () => void
}

export function useBoardFilters(): BoardFiltersState & {
  setAssigneeIds: (ids: string[]) => void
  setGroupByAssignee: (v: boolean) => void
  setDependency: (v: DependencyFilter | null) => void
  /** Every filter in one URL update (separate setters each start from the same URL and would undo each other). */
  setFilters: (state: BoardFiltersState) => void
} {
  const searchParams = useSearchParams()
  const router = useRouter()

  const assigneeParam = searchParams.get("assignee") || ""
  const assigneeIds = assigneeParam ? assigneeParam.split(",").filter(Boolean) : []
  const groupByAssignee = searchParams.get("groupBy") === "assignee"
  const dependency = parseDependencyFilter(searchParams.get("deps"))

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        params.delete(key)
      } else {
        params.set(key, value)
      }
    }
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false })
  }, [searchParams, router])

  const setAssigneeIds = useCallback((ids: string[]) => {
    updateParams({ assignee: ids.length > 0 ? ids.join(",") : null })
  }, [updateParams])

  const setGroupByAssignee = useCallback((v: boolean) => {
    updateParams({ groupBy: v ? "assignee" : null })
  }, [updateParams])

  const setDependency = useCallback((v: DependencyFilter | null) => {
    updateParams({ deps: v })
  }, [updateParams])

  const setFilters = useCallback((state: BoardFiltersState) => {
    updateParams({
      assignee: state.assigneeIds.length > 0 ? state.assigneeIds.join(",") : null,
      groupBy: state.groupByAssignee ? "assignee" : null,
      deps: state.dependency ?? null,
    })
  }, [updateParams])

  return { assigneeIds, groupByAssignee, dependency, setAssigneeIds, setGroupByAssignee, setDependency, setFilters }
}

export function BoardFilters({ value, onChange, readyCount = 0, onRunReady }: BoardFiltersProps) {
  const [confirmRun, setConfirmRun] = useState(false)
  const { user } = useAuth()
  const { members } = useTeamMembers()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const isMyTasks = !!(user && value.assigneeIds.length === 1 && value.assigneeIds[0] === user.id)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [dropdownOpen])

  const toggleAssignee = (id: string) => {
    const next = value.assigneeIds.includes(id)
      ? value.assigneeIds.filter((a) => a !== id)
      : [...value.assigneeIds, id]
    onChange({ ...value, assigneeIds: next })
  }

  const toggleMyTasks = () => {
    if (!user) return
    if (isMyTasks) {
      onChange({ ...value, assigneeIds: [] })
    } else {
      onChange({ ...value, assigneeIds: [user.id] })
    }
  }

  const clearAssignees = () => {
    onChange({ ...value, assigneeIds: [] })
  }

  const toggleGroupBy = () => {
    onChange({ ...value, groupByAssignee: !value.groupByAssignee })
  }

  const selectedNames = value.assigneeIds
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean) as TeamMemberOption[]

  const hasFilters = value.assigneeIds.length > 0

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-linear-border bg-linear-bg flex-shrink-0 overflow-x-auto">
      <button
        type="button"
        onClick={toggleMyTasks}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium transition-colors whitespace-nowrap ${
          isMyTasks
            ? "bg-linear-accent/15 text-linear-accent border border-linear-accent/30"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary border border-transparent"
        }`}
      >
        <User className="w-3 h-3" />
        My tasks
      </button>

      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium transition-colors whitespace-nowrap ${
            hasFilters && !isMyTasks
              ? "bg-linear-accent/15 text-linear-accent border border-linear-accent/30"
              : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary border border-transparent"
          }`}
        >
          <Users className="w-3 h-3" />
          {hasFilters && !isMyTasks ? (
            <>
              Assignee
              <span className="ml-0.5 bg-linear-accent/20 text-linear-accent text-[10px] font-bold px-1.5 rounded-full">
                {value.assigneeIds.length}
              </span>
            </>
          ) : (
            "Assignee"
          )}
        </button>

        {dropdownOpen && (
          <div className="absolute top-full left-0 mt-1 z-50 w-56 rounded-md border border-linear-border bg-linear-bg-secondary shadow-lg py-1">
            {members.length === 0 ? (
              <div className="px-3 py-2 text-xs text-linear-text-tertiary">No members found</div>
            ) : (
              members.map((member) => {
                const selected = value.assigneeIds.includes(member.id)
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => toggleAssignee(member.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                  >
                    <div className="w-4 h-4 rounded-sm border border-linear-border flex items-center justify-center flex-shrink-0">
                      {selected && <Check className="w-3 h-3 text-linear-accent" />}
                    </div>
                    {member.avatarUrl ? (
                      <img src={member.avatarUrl} alt="" className="w-4 h-4 rounded-full flex-shrink-0" />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-linear-bg-tertiary flex items-center justify-center flex-shrink-0">
                        <span className="text-[9px] text-linear-text-tertiary uppercase">
                          {member.username?.charAt(0) || "?"}
                        </span>
                      </div>
                    )}
                    <span className="truncate">{member.displayName || member.username}</span>
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      {(["blocked", "ready"] as const).map((kind) => {
        const active = value.dependency === kind
        const Icon = kind === "blocked" ? Ban : CircleCheck
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={active}
            onClick={() => onChange({ ...value, dependency: active ? null : kind })}
            title={kind === "blocked" ? "Tasks waiting on an unfinished task" : "Open tasks nothing is blocking"}
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium transition-colors whitespace-nowrap ${
              active
                ? "bg-linear-accent/15 text-linear-accent border border-linear-accent/30"
                : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary border border-transparent"
            }`}
          >
            <Icon className="w-3 h-3" />
            {kind === "blocked" ? "Blocked" : "Ready"}
          </button>
        )
      })}

      {value.dependency === "ready" && onRunReady && readyCount > 0 && (
        confirmRun ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-xs text-linear-text-secondary">Run {readyCount} ready {readyCount === 1 ? "task" : "tasks"}?</span>
            <button type="button" onClick={() => { setConfirmRun(false); onRunReady() }} className="h-7 px-2.5 rounded-sm text-xs font-medium bg-linear-accent text-white hover:bg-linear-accent/90">Run</button>
            <button type="button" onClick={() => setConfirmRun(false)} className="h-7 px-2 rounded-sm text-xs text-linear-text-secondary hover:bg-linear-bg-tertiary">Cancel</button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRun(true)}
            title="Run the open tasks nothing blocks as one batch (highest priority first, within your batch size)"
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium whitespace-nowrap text-linear-accent hover:bg-linear-accent/10 border border-linear-accent/30"
          >
            <Play className="w-3 h-3" />
            Run {readyCount} ready
          </button>
        )
      )}

      {hasFilters && (
        <button
          type="button"
          onClick={clearAssignees}
          className="flex items-center gap-1 h-7 px-2 rounded-sm text-xs text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
        >
          <X className="w-3 h-3" />
          Clear
        </button>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={toggleGroupBy}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium transition-colors whitespace-nowrap ${
          value.groupByAssignee
            ? "bg-linear-accent/15 text-linear-accent border border-linear-accent/30"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary border border-transparent"
        }`}
      >
        <Rows3 className="w-3 h-3" />
        Group by assignee
      </button>
    </div>
  )
}
