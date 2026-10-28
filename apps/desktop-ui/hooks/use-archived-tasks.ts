"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import type { Task } from "@/types/task"
import {
  archivedTasksQuery,
  deleteAllArchivedTasks,
  deleteArchivedTask,
  removeArchivedTasks,
  restoreArchivedTasks,
} from "@/lib/query/archived"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_TASKS: Task[] = []

export interface DeleteArchivedOutcome {
  /** Ids whose delete failed (restored in the list). */
  readonly failed: readonly string[]
}

/**
 * The archive from the query cache. Deletes are optimistic and roll back per
 * item, like the board's bulk actions: only the tasks whose delete failed come
 * back, and they come back where they were.
 */
export function useArchivedTasks() {
  const client = useAppQueryClient()
  const query = useQuery(archivedTasksQuery(), client)

  const deleteMany = useMutation({
    mutationFn: async (ids: readonly string[]): Promise<DeleteArchivedOutcome> => {
      const results = await Promise.allSettled(ids.map((id) => deleteArchivedTask(id)))
      return { failed: ids.filter((_id, index) => results[index]?.status === "rejected") }
    },
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: queryKeys.archivedTasks(), exact: true })
      return { before: removeArchivedTasks(client, new Set(ids)) }
    },
    onSuccess: (outcome, _ids, context) => {
      if (outcome.failed.length > 0 && context?.before) restoreArchivedTasks(client, context.before, new Set(outcome.failed))
    },
    onError: (_error, ids, context) => {
      if (context?.before) restoreArchivedTasks(client, context.before, new Set(ids))
    },
  }, client)

  const deleteAll = useMutation({
    mutationFn: () => deleteAllArchivedTasks(),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: queryKeys.archivedTasks(), exact: true })
      return { before: removeArchivedTasks(client, "all") }
    },
    onError: (_error, _variables, context) => {
      if (context?.before) restoreArchivedTasks(client, context.before, "all")
    },
  }, client)

  return {
    tasks: query.data ?? NO_TASKS,
    loading: query.isPending,
    error: query.error,
    errorUpdatedAt: query.errorUpdatedAt,
    /** Refetch from the server (after a partial failure). */
    refetch: query.refetch,
    deleteMany,
    deleteAll,
  }
}
