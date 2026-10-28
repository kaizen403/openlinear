"use client"

import { useQuery } from "@tanstack/react-query"
import { useWorkspace } from "@/hooks/use-workspace"
import type { WorkspaceMember } from "@/lib/api/types"
import { workspaceMembersQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

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

/** Module-level so `select` is memoized: the options array keeps its identity until the members change. */
function toOptions(members: WorkspaceMember[]): TeamMemberOption[] {
  return members.map(toOption).filter((m): m is TeamMemberOption => m !== null)
}

const NO_MEMBERS: TeamMemberOption[] = []

/**
 * Workspace members as assignee options. One cache entry per workspace: the
 * board, its filters and the task form used to fetch this list three times
 * each time the board opened; now they share one request.
 */
export function useTeamMembers() {
  const { activeWorkspace } = useWorkspace()
  const workspaceId = activeWorkspace?.id
  const client = useAppQueryClient()
  const { data, isLoading } = useQuery(
    { ...workspaceMembersQuery(workspaceId ?? ""), enabled: Boolean(workspaceId), select: toOptions },
    client,
  )
  return { members: (workspaceId ? data : undefined) ?? NO_MEMBERS, isLoading }
}
