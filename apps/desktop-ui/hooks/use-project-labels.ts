"use client"

import { useQuery } from "@tanstack/react-query"
import type { Label } from "@/types/task"
import { projectLabelsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_LABELS: Label[] = []

/**
 * A project's labels, sorted by priority. Cached per project (replacing the
 * label picker's module-level map); `label:*` events patch the cache through
 * the SSE bridge. `enabled: false` still returns labels already cached.
 */
export function useProjectLabels(projectId: string | null | undefined, options: { enabled?: boolean } = {}) {
  const client = useAppQueryClient()
  const enabled = Boolean(projectId) && (options.enabled ?? true)
  const query = useQuery({ ...projectLabelsQuery(projectId ?? ""), enabled }, client)
  return {
    labels: (projectId ? query.data : undefined) ?? NO_LABELS,
    loading: enabled && query.isLoading,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
    refetch: query.refetch,
  }
}
