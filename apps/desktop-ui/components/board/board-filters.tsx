"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { User, Users, Check, X, Rows3 } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"
import { useTeamMembers, TeamMemberOption } from "@/hooks/use-team-members"

export interface BoardFiltersState {
  assigneeIds: string[]
  groupByAssignee: boolean
}

interface BoardFiltersProps {
  value: BoardFiltersState
  onChange: (state: BoardFiltersState) => void
}

export function useBoardFilters(): BoardFiltersState & { setAssigneeIds: (ids: string[]) => void; setGroupByAssignee: (v: boolean) => void } {
  const searchParams = useSearchParams()
  const router = useRouter()

  const assigneeParam = searchParams.get("assignee") || ""
  const assigneeIds = assigneeParam ? assigneeParam.split(",").filter(Boolean) : []
  const groupByAssignee = searchParams.get("groupBy") === "assignee"

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

  return { assigneeIds, groupByAssignee, setAssigneeIds, setGroupByAssignee }
}

export function BoardFilters({ value, onChange }: BoardFiltersProps) {
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
