import type { Query } from "@tanstack/react-query"
import { fetchWorkspaceStructureSummary, type WorkspaceStructureSummary } from "@/lib/api/workspaces"
import { STALE_TIME } from "./client"
import { queryKeys } from "./keys"

/**
 * Settings → Workspaces: one summary tree per workspace (projects, teams and
 * member counts). The workspace list itself is the shared `workspacesQuery`
 * entry, so opening the page costs one summary request per workspace and no
 * list request.
 */
export function workspaceStructureQuery(workspaceId: string) {
  return {
    queryKey: queryKeys.workspaces.structureSummary(workspaceId),
    queryFn: (): Promise<WorkspaceStructureSummary> => fetchWorkspaceStructureSummary(workspaceId),
    staleTime: STALE_TIME.workspaceStructure,
  }
}

export function isWorkspaceStructureQuery(query: Query): boolean {
  return query.queryKey[0] === "ol" && query.queryKey[1] === "ws" && query.queryKey[3] === "structure"
}
