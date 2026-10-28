"use client"

import { useQuery } from "@tanstack/react-query"
import type { MyIssueTask } from "@/lib/api/types"
import type { TaskListFilter } from "@/lib/query/keys"
import { myIssuesQuery, projectIssuesQuery } from "@/lib/query/task-queries"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_TASKS: MyIssueTask[] = []

/**
 * "My issues" from the query cache. The SSE bridge merges `task:*` events into
 * the cached rows in place and refetches only when a task enters the list —
 * the page used to refetch the whole list on every `task:updated`.
 */
export function useMyIssues(filter: TaskListFilter = "assigned") {
  const client = useAppQueryClient()
  const { data, isPending } = useQuery(myIssuesQuery({ kind: "mine", filter }), client)
  return { tasks: data ?? NO_TASKS, loading: isPending }
}

/** A project's issues list (same live-update rules as `useMyIssues`). */
export function useProjectIssues(projectId: string | null) {
  const client = useAppQueryClient()
  const { data, isPending } = useQuery(
    { ...projectIssuesQuery({ kind: "project-issues", projectId: projectId ?? "" }), enabled: Boolean(projectId) },
    client,
  )
  return { tasks: (projectId ? data : undefined) ?? NO_TASKS, loading: isPending }
}
