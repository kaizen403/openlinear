import type { Query, QueryClient } from "@tanstack/react-query"
import { fetchProjects, fetchTeam, fetchTeams } from "@/lib/api"
import type { Project, Team, TeamMember } from "@/lib/api/types"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Team pages in the query cache: the Teams page directory (full rows, every
 * workspace), the full team (team settings and Settings → Members share it)
 * and the project picker of the create-team dialog.
 *
 * Writes (hooks/use-team-mutations.ts) and `team:*` events (page-caches.ts)
 * patch these entries precisely from the server's full team, so an edit costs
 * the write and nothing else; the pages used to refetch after every write and
 * again on its own event.
 */

export type ProjectOption = Pick<Project, "id" | "name">

export function teamDirectoryQuery(projectId?: string | null) {
  return {
    queryKey: queryKeys.teams.directory(projectId),
    queryFn: (): Promise<Team[]> => fetchTeams(projectId ? { projectId } : undefined),
    staleTime: STALE_TIME.teams,
  }
}

export function teamDetailQuery(teamId: string) {
  return {
    queryKey: queryKeys.teams.detail(teamId),
    queryFn: (): Promise<Team> => fetchTeam(teamId),
    staleTime: STALE_TIME.teamDetail,
  }
}

export function projectDirectoryQuery() {
  return {
    queryKey: queryKeys.projects.directory(),
    queryFn: async (): Promise<ProjectOption[]> =>
      (await fetchProjects({ fields: ["id", "name"] })).map(({ id, name }) => ({ id, name })),
    staleTime: STALE_TIME.projects,
  }
}

// --- reading the cache --------------------------------------------------------

export function isTeamDirectoryQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "teams" && query.queryKey[2] === "directory"
}

export function isTeamDetailQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "team" && query.queryKey[3] === "detail"
}

/** The `projectId` filter of a directory key (null = every team). */
export function directoryFilter(query: Query): string | null {
  const params = query.queryKey[3]
  if (typeof params !== "object" || params === null) return null
  const projectId = (params as { projectId?: unknown }).projectId
  return typeof projectId === "string" ? projectId : null
}

export function isTeam(value: unknown): value is Team {
  return typeof value === "object" && value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { key?: unknown }).key === "string"
}

export function isTeamMember(value: unknown): value is TeamMember {
  return typeof value === "object" && value !== null &&
    typeof (value as { teamId?: unknown }).teamId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { role?: unknown }).role === "string"
}

function teamList(query: Query): Team[] | undefined {
  const data = query.state.data
  return Array.isArray(data) ? (data as Team[]) : undefined
}

function directories(client: QueryClient): Query[] {
  return client.getQueryCache().findAll({ queryKey: queryKeys.teams.directories() })
}

// --- writing the cache ---------------------------------------------------------

/**
 * A deleted resource's own entries (team or project detail, access, …): drop
 * what nothing shows; mark what a page still shows as stale without
 * refetching it (the page is usually navigating away; the next visit
 * refetches and gets the 404).
 */
export function forgetDeleted(client: QueryClient, queryKey: readonly unknown[]): void {
  for (const query of client.getQueryCache().findAll({ queryKey })) {
    if (query.getObserversCount() === 0) client.getQueryCache().remove(query)
    else void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" })
  }
}

/** Merge a team (partial or the server's full row) into every cached copy; insert it where `insert` allows. */
export function writeTeamToCaches(client: QueryClient, team: Partial<Team> & { id: string }, options: { insert?: boolean } = {}): void {
  const detailKey = queryKeys.teams.detail(team.id)
  const detail = client.getQueryData<Team>(detailKey)
  if (detail) client.setQueryData<Team>(detailKey, { ...detail, ...team })

  for (const query of directories(client)) {
    const list = teamList(query)
    if (!list) continue
    if (list.some((row) => row.id === team.id)) {
      client.setQueryData<Team[]>(query.queryKey, list.map((row) => (row.id === team.id ? { ...row, ...team } : row)))
      continue
    }
    const filter = directoryFilter(query)
    if (options.insert && isTeam(team) && (filter === null || filter === team.projectId)) {
      client.setQueryData<Team[]>(query.queryKey, [...list, team])
    }
  }
}

export interface RemovedTeam {
  readonly detail: Team | undefined
  /** Each directory list it was removed from, with its index there. */
  readonly rows: ReadonlyArray<{ readonly queryKey: readonly unknown[]; readonly index: number; readonly team: Team }>
}

/** Drop a team from every directory list; returns what `restoreTeam` needs. */
export function removeTeamFromCaches(client: QueryClient, teamId: string): RemovedTeam {
  const rows: Array<{ queryKey: readonly unknown[]; index: number; team: Team }> = []
  for (const query of directories(client)) {
    const list = teamList(query)
    const index = list?.findIndex((row) => row.id === teamId) ?? -1
    if (!list || index < 0) continue
    rows.push({ queryKey: query.queryKey, index, team: list[index]! })
    client.setQueryData<Team[]>(query.queryKey, list.filter((row) => row.id !== teamId))
  }
  return { detail: client.getQueryData<Team>(queryKeys.teams.detail(teamId)), rows }
}

/** Put a removed team back where it was (a failed delete), unless it is already back. */
export function restoreTeam(client: QueryClient, removed: RemovedTeam): void {
  for (const { queryKey, index, team } of removed.rows) {
    const list = client.getQueryData<Team[]>(queryKey)
    if (!list || list.some((row) => row.id === team.id)) continue
    const next = [...list]
    next.splice(Math.min(index, next.length), 0, team)
    client.setQueryData<Team[]>(queryKey, next)
  }
}

/** Members of a cached full team, updated in place (detail and the directory rows that embed them). */
export function updateTeamMembers(client: QueryClient, teamId: string, update: (members: TeamMember[]) => TeamMember[]): void {
  const detailKey = queryKeys.teams.detail(teamId)
  const detail = client.getQueryData<Team>(detailKey)
  if (detail?.members) {
    const members = update(detail.members)
    if (members !== detail.members) {
      client.setQueryData<Team>(detailKey, { ...detail, members, _count: detail._count ? { ...detail._count, members: members.length } : detail._count })
    }
  }
  for (const query of directories(client)) {
    const list = teamList(query)
    if (!list?.some((row) => row.id === teamId && row.members)) continue
    client.setQueryData<Team[]>(query.queryKey, list.map((row) => {
      if (row.id !== teamId || !row.members) return row
      const members = update(row.members)
      return members === row.members ? row : { ...row, members, _count: row._count ? { ...row._count, members: members.length } : row._count }
    }))
  }
}

/** Insert or replace one member (by user) in a team's cached member lists. */
export function upsertTeamMember(client: QueryClient, member: TeamMember): void {
  updateTeamMembers(client, member.teamId, (members) => {
    const index = members.findIndex((m) => m.userId === member.userId)
    if (index < 0) return [...members, member]
    const existing = members[index]!
    if (existing.role === member.role && existing.id === member.id && (existing.user ?? null) === (member.user ?? existing.user ?? null)) return members
    const next = [...members]
    next[index] = { ...existing, ...member, user: member.user ?? existing.user }
    return next
  })
}
