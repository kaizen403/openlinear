"use client"

import { useState, useEffect, useCallback } from "react"
import { useWorkspace } from "@/hooks/use-workspace"
import { fetchWorkspaceMembers } from "@/lib/api/workspaces"
import type { WorkspaceMember } from "@/lib/api/types"

export interface TeamMemberOption {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

function toOption(member: WorkspaceMember): TeamMemberOption | null {
  if (!member.user) return null
  return {
    id: member.user.id,
    username: member.user.username,
    displayName: member.user.username,
    avatarUrl: member.user.avatarUrl,
  }
}

export function useTeamMembers() {
  const { activeWorkspace } = useWorkspace()
  const [members, setMembers] = useState<TeamMemberOption[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const load = useCallback(async () => {
    if (!activeWorkspace) {
      setMembers([])
      return
    }
    setIsLoading(true)
    try {
      const raw = await fetchWorkspaceMembers(activeWorkspace.id)
      const opts = raw.map(toOption).filter((m): m is TeamMemberOption => m !== null)
      setMembers(opts)
    } catch {
      setMembers([])
    } finally {
      setIsLoading(false)
    }
  }, [activeWorkspace])

  useEffect(() => {
    void load()
  }, [load])

  return { members, isLoading }
}
