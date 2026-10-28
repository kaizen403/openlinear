"use client"

import { useCallback, useMemo } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useAuth } from "@/hooks/use-auth"
import type { WorkspaceStructureSummary } from "@/lib/api/workspaces"
import { workspacesQuery } from "@/lib/query/resources"
import { workspaceStructureQuery } from "@/lib/query/workspace-structure"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * Settings → Workspaces: every workspace's summary tree. The workspace list
 * is the shared cache entry (no request when the app already has it), and
 * each tree is the `view=summary` structure — counts, not member lists. The
 * page used to fetch the list plus one full structure per workspace on every
 * visit.
 */
export function useWorkspaceStructures() {
  const client = useAppQueryClient()
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const enabled = isAuthenticated && !authLoading
  const list = useQuery({ ...workspacesQuery(), enabled }, client)
  const ids = useMemo(() => (list.data ?? []).map((workspace) => workspace.id), [list.data])
  const trees = useQueries({ queries: ids.map((id) => ({ ...workspaceStructureQuery(id), enabled })) }, client)

  const workspaces = trees.flatMap((tree): WorkspaceStructureSummary[] => (tree.data ? [tree.data] : []))
  const error = list.error ?? trees.find((tree) => tree.error)?.error ?? null
  const isLoading = !enabled || list.isPending || trees.some((tree) => tree.isPending)
  const isFetching = list.isFetching || trees.some((tree) => tree.isFetching)

  /** The refresh button: the list and every tree, from the server. */
  const refresh = useCallback(async () => {
    await client.refetchQueries({ queryKey: workspacesQuery().queryKey, exact: true })
    await Promise.all(
      (client.getQueryData<Array<{ id: string }>>(workspacesQuery().queryKey) ?? []).map((workspace) =>
        client.refetchQueries({ queryKey: workspaceStructureQuery(workspace.id).queryKey, exact: true }),
      ),
    )
  }, [client])

  return { workspaces, isLoading, isFetching, error, refresh }
}
