"use client"

import { useQuery } from "@tanstack/react-query"
import { ApiError } from "@/lib/api/fetch"
import type { Team } from "@/lib/api/types"
import { projectDirectoryQuery, teamDetailQuery, teamDirectoryQuery, type ProjectOption } from "@/lib/query/teams"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_TEAMS: Team[] = []

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}
const NO_PROJECTS: ProjectOption[] = []

/**
 * The Teams page list (every team the user can see, optionally one project's).
 * Cached per filter and kept live by `team:*` events (page-caches.ts): the
 * page used to refetch the whole list on every team event and after every
 * write.
 */
export function useTeamDirectory(projectId?: string | null) {
  const client = useAppQueryClient()
  const query = useQuery(teamDirectoryQuery(projectId), client)
  return {
    teams: query.data ?? NO_TEAMS,
    isLoading: query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
  }
}

/** One full team (members, project). Team settings and Settings → Members share the entry. */
export function useTeamDetail(teamId: string | null | undefined) {
  const client = useAppQueryClient()
  const query = useQuery({ ...teamDetailQuery(teamId ?? ""), enabled: Boolean(teamId) }, client)
  return {
    // A 404 means it is gone, even if an older copy is still cached.
    team: teamId && !isNotFound(query.error) ? query.data ?? null : null,
    /** No data yet (also while no team is selected, as the pages always showed). */
    isLoading: query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
  }
}

/** `{ id, name }` of every project, for the create-team dialog; fetched once it is first needed. */
export function useProjectDirectory(enabled: boolean) {
  const client = useAppQueryClient()
  const query = useQuery({ ...projectDirectoryQuery(), enabled }, client)
  return {
    projects: query.data ?? NO_PROJECTS,
    isLoading: enabled && query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
    refetch: query.refetch,
  }
}
