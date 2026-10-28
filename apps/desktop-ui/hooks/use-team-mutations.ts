"use client"

import { useMutation, type QueryClient } from "@tanstack/react-query"
import {
  createTeam,
  deleteTeam,
  joinTeam,
  removeTeamMember,
  updateTeam,
  updateTeamMember,
} from "@/lib/api"
import type { Team, TeamMember } from "@/lib/api/types"
import { queryKeys } from "@/lib/query/keys"
import {
  forgetDeleted,
  removeTeamFromCaches,
  restoreTeam,
  updateTeamMembers,
  upsertTeamMember,
  writeTeamToCaches,
} from "@/lib/query/teams"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * Team writes with the board's write discipline: apply optimistically, replace
 * with the server's copy, and on failure roll back only what this write
 * changed (other edits that landed meanwhile survive). Every cached copy is
 * kept in step: the Teams page directory, the full team (team settings,
 * Settings → Members) and the workspace team lists (sidebar, filters).
 */

export type TeamEdit = Partial<Pick<Team, "name" | "description" | "color">>

type TeamFields = Partial<Team> & { id: string }

/** The current values of `keys` for a team, from the first cached copy that has it. */
function readTeamFields(client: QueryClient, teamId: string, keys: readonly (keyof Team)[]): TeamFields | null {
  const copies: Team[] = []
  const detail = client.getQueryData<Team>(queryKeys.teams.detail(teamId))
  if (detail) copies.push(detail)
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.teams.directories() })) {
    const row = Array.isArray(query.state.data) ? (query.state.data as Team[]).find((team) => team.id === teamId) : undefined
    if (row) copies.push(row)
  }
  for (const query of client.getQueryCache().findAll({ predicate: isWorkspaceTeamList })) {
    const row = Array.isArray(query.state.data) ? (query.state.data as Team[]).find((team) => team.id === teamId) : undefined
    if (row) copies.push(row)
  }
  if (copies.length === 0) return null
  const fields: TeamFields = { id: teamId }
  for (const key of keys) {
    const copy = copies.find((team) => key in team)
    if (copy) Object.assign(fields, { [key]: copy[key] })
  }
  return fields
}

function isWorkspaceTeamList(query: { queryKey: readonly unknown[] }): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "ws" && query.queryKey[3] === "teams"
}

/** Merge into the workspace team lists, only the fields those (field-limited) rows carry. */
function patchWorkspaceTeamLists(client: QueryClient, team: TeamFields): void {
  for (const query of client.getQueryCache().findAll({ predicate: isWorkspaceTeamList })) {
    const list = query.state.data
    if (!Array.isArray(list) || !(list as Team[]).some((row) => row.id === team.id)) continue
    client.setQueryData<Team[]>(query.queryKey, (list as Team[]).map((row) => {
      if (row.id !== team.id) return row
      const next: Team = { ...row }
      for (const [key, value] of Object.entries(team)) {
        if (key in row) Object.assign(next, { [key]: value })
      }
      return next
    }))
  }
}

function writeEverywhere(client: QueryClient, team: TeamFields, options: { insert?: boolean } = {}): void {
  writeTeamToCaches(client, team, options)
  patchWorkspaceTeamLists(client, team)
}

async function cancelTeamReads(client: QueryClient, teamId: string): Promise<void> {
  // A read in flight could land after the optimistic write with the old values.
  await Promise.all([
    client.cancelQueries({ queryKey: queryKeys.teams.directories() }),
    client.cancelQueries({ queryKey: queryKeys.teams.detail(teamId) }),
  ])
}

export function useTeamMutations() {
  const client = useAppQueryClient()

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createTeam>[0]) => createTeam(input),
    // The server copy is complete (members, counts, invite code): no refetch.
    onSuccess: (team) => writeEverywhere(client, team, { insert: true }),
  }, client)

  const join = useMutation({
    mutationFn: (inviteCode: string) => joinTeam(inviteCode),
    onSuccess: (team) => writeEverywhere(client, team, { insert: true }),
  }, client)

  const update = useMutation({
    mutationFn: ({ teamId, edit }: { teamId: string; edit: TeamEdit }) => updateTeam(teamId, edit),
    onMutate: async ({ teamId, edit }) => {
      await cancelTeamReads(client, teamId)
      const keys = Object.keys(edit) as (keyof Team)[]
      const previous = readTeamFields(client, teamId, keys)
      const optimistic: TeamFields = { id: teamId, ...edit }
      writeEverywhere(client, optimistic)
      return { previous, optimistic }
    },
    onSuccess: (team) => writeEverywhere(client, team),
    onError: (_error, { teamId }, context) => {
      if (!context?.previous) return
      // Restore only the fields this edit set, and only where they still hold its values.
      const current = readTeamFields(client, teamId, Object.keys(context.optimistic) as (keyof Team)[])
      const restore: TeamFields = { id: teamId }
      for (const [key, value] of Object.entries(context.previous)) {
        if (key === "id") continue
        if (current && (current as Record<string, unknown>)[key] !== (context.optimistic as Record<string, unknown>)[key]) continue
        Object.assign(restore, { [key]: value })
      }
      writeEverywhere(client, restore)
    },
  }, client)

  const remove = useMutation({
    mutationFn: (teamId: string) => deleteTeam(teamId),
    onMutate: async (teamId) => {
      await cancelTeamReads(client, teamId)
      return { removed: removeTeamFromCaches(client, teamId) }
    },
    onSuccess: (_result, teamId) => forgetDeleted(client, queryKeys.teams.detail(teamId)),
    onError: (_error, _teamId, context) => {
      if (context) restoreTeam(client, context.removed)
    },
  }, client)

  const changeMemberRole = useMutation({
    mutationFn: ({ teamId, userId, role }: { teamId: string; userId: string; role: TeamMember["role"] }) =>
      updateTeamMember(teamId, userId, { role }),
    onMutate: async ({ teamId, userId, role }) => {
      await client.cancelQueries({ queryKey: queryKeys.teams.detail(teamId) })
      // The updater runs once per cached copy (detail, directory rows): keep the first.
      const captured: { previous: TeamMember["role"] | null } = { previous: null }
      updateTeamMembers(client, teamId, (members) => {
        const member = members.find((m) => m.userId === userId)
        if (!member || member.role === role) return members
        captured.previous ??= member.role
        return members.map((m) => (m.userId === userId ? { ...m, role } : m))
      })
      return { previous: captured.previous }
    },
    onSuccess: (member) => {
      if (member && typeof member.userId === "string") upsertTeamMember(client, member)
    },
    onError: (_error, { teamId, userId, role }, context) => {
      const previous = context?.previous
      if (!previous) return
      updateTeamMembers(client, teamId, (members) => (
        members.some((m) => m.userId === userId && m.role === role)
          ? members.map((m) => (m.userId === userId ? { ...m, role: previous } : m))
          : members
      ))
    },
  }, client)

  const removeMember = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) => removeTeamMember(teamId, userId),
    onMutate: async ({ teamId, userId }) => {
      await client.cancelQueries({ queryKey: queryKeys.teams.detail(teamId) })
      const captured: { removed: { member: TeamMember; index: number } | null } = { removed: null }
      updateTeamMembers(client, teamId, (members) => {
        const index = members.findIndex((m) => m.userId === userId)
        if (index < 0) return members
        captured.removed ??= { member: members[index]!, index }
        return members.filter((m) => m.userId !== userId)
      })
      return { removed: captured.removed }
    },
    onError: (_error, { teamId }, context) => {
      const removed = context?.removed
      if (!removed) return
      updateTeamMembers(client, teamId, (members) => {
        if (members.some((m) => m.userId === removed.member.userId)) return members
        const next = [...members]
        next.splice(Math.min(removed.index, next.length), 0, removed.member)
        return next
      })
    },
  }, client)

  return { create, join, update, remove, changeMemberRole, removeMember }
}
