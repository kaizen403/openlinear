"use client"

import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query"
import {
  inviteWorkspaceMember,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from "@/lib/api/workspaces"
import type { WorkspaceMember, WorkspaceRole } from "@/lib/api/types"
import { queryKeys } from "@/lib/query/keys"
import { workspaceMembersQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_MEMBERS: WorkspaceMember[] = []

function updateMembers(client: QueryClient, workspaceId: string, update: (members: WorkspaceMember[]) => WorkspaceMember[]): void {
  const key = queryKeys.workspaces.members(workspaceId)
  const members = client.getQueryData<WorkspaceMember[]>(key)
  if (!members) return
  const next = update(members)
  if (next !== members) client.setQueryData(key, next)
}

/**
 * Settings → Members, workspace tab: the workspace member list is the same
 * cache entry as the assignee options (`useTeamMembers`), so the page and the
 * board share one request and see each other's edits. Writes follow the
 * board's discipline: optimistic, server copy on success, per-member rollback.
 */
export function useWorkspaceMemberAdmin(workspaceId: string | null | undefined, enabled: boolean) {
  const client = useAppQueryClient()
  const query = useQuery({ ...workspaceMembersQuery(workspaceId ?? ""), enabled: enabled && Boolean(workspaceId) }, client)

  const changeRole = useMutation({
    mutationFn: ({ workspaceId: id, userId, role }: { workspaceId: string; userId: string; role: WorkspaceRole }) =>
      updateWorkspaceMember(id, userId, { role }),
    onMutate: async ({ workspaceId: id, userId, role }) => {
      await client.cancelQueries({ queryKey: queryKeys.workspaces.members(id), exact: true })
      const captured: { previous: WorkspaceRole | null } = { previous: null }
      updateMembers(client, id, (members) => {
        const member = members.find((m) => m.userId === userId)
        if (!member || member.role === role) return members
        captured.previous = member.role
        return members.map((m) => (m.userId === userId ? { ...m, role } : m))
      })
      return captured
    },
    onSuccess: (member, { workspaceId: id, userId }) => {
      if (!member || member.userId !== userId) return
      updateMembers(client, id, (members) => members.map((m) => (m.userId === userId ? { ...m, ...member, user: member.user ?? m.user } : m)))
    },
    onError: (_error, { workspaceId: id, userId, role }, context) => {
      const previous = context?.previous
      if (!previous) return
      updateMembers(client, id, (members) => (
        members.some((m) => m.userId === userId && m.role === role)
          ? members.map((m) => (m.userId === userId ? { ...m, role: previous } : m))
          : members
      ))
    },
  }, client)

  const remove = useMutation({
    mutationFn: ({ workspaceId: id, userId }: { workspaceId: string; userId: string }) => removeWorkspaceMember(id, userId),
    onMutate: async ({ workspaceId: id, userId }) => {
      await client.cancelQueries({ queryKey: queryKeys.workspaces.members(id), exact: true })
      const captured: { removed: { member: WorkspaceMember; index: number } | null } = { removed: null }
      updateMembers(client, id, (members) => {
        const index = members.findIndex((m) => m.userId === userId)
        if (index < 0) return members
        captured.removed = { member: members[index]!, index }
        return members.filter((m) => m.userId !== userId)
      })
      return captured
    },
    onError: (_error, { workspaceId: id }, context) => {
      const removed = context?.removed
      if (!removed) return
      updateMembers(client, id, (members) => {
        if (members.some((m) => m.userId === removed.member.userId)) return members
        const next = [...members]
        next.splice(Math.min(removed.index, next.length), 0, removed.member)
        return next
      })
    },
  }, client)

  const invite = useMutation({
    mutationFn: ({ workspaceId: id, username, role }: { workspaceId: string; username: string; role: WorkspaceRole }) =>
      inviteWorkspaceMember(id, { username, role }),
    // The server's member row goes straight into the list (the page used to refetch it).
    onSuccess: (member, { workspaceId: id }) => {
      if (!member || typeof member.userId !== "string") {
        void client.invalidateQueries({ queryKey: queryKeys.workspaces.members(id), exact: true })
        return
      }
      updateMembers(client, id, (members) => (members.some((m) => m.userId === member.userId) ? members : [...members, member]))
    },
  }, client)

  return {
    members: (workspaceId ? query.data : undefined) ?? NO_MEMBERS,
    isLoading: enabled && Boolean(workspaceId) && query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
    changeRole,
    remove,
    invite,
  }
}
