"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { createComment, deleteComment, updateComment, type Comment } from "@/lib/api/comments"
import type { TeamMember } from "@/lib/api/types"
import { queryKeys } from "@/lib/query/keys"
import { taskCommentsQuery, taskDetailQuery, teamMembersQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

const NO_COMMENTS: Comment[] = []
const NO_MEMBERS: TeamMember[] = []

/**
 * A task's comment thread from the query cache, plus the task's team members
 * for @-mentions. `comment:*` events patch the thread through the SSE bridge
 * (the component used to subscribe itself); writes go through mutations that
 * update the same cache entry.
 */
export function useTaskComments(taskId: string) {
  const client = useAppQueryClient()
  const commentsKey = queryKeys.tasks.comments(taskId)
  const commentsQuery = useQuery(taskCommentsQuery(taskId), client)
  const taskQuery = useQuery(taskDetailQuery(taskId), client)
  const teamId = taskQuery.data?.teamId ?? null
  const membersQuery = useQuery({ ...teamMembersQuery(teamId ?? ""), enabled: Boolean(teamId) }, client)

  const loadError = commentsQuery.error ?? taskQuery.error ?? null
  const loading = commentsQuery.isPending || taskQuery.isPending || (Boolean(teamId) && membersQuery.isLoading)

  const setComments = (update: (comments: Comment[]) => Comment[]) => {
    client.setQueryData<Comment[]>(commentsKey, (prev) => update(prev ?? []))
  }

  const create = useMutation({
    mutationFn: (body: string) => createComment(taskId, body),
    onSuccess: (created) => setComments((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created])),
  }, client)

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => updateComment(id, body),
    onSuccess: (updated, { id }) => setComments((prev) => prev.map((c) => (c.id === id ? updated : c))),
  }, client)

  // Optimistic, with rollback on failure — as the thread behaved before.
  const remove = useMutation({
    mutationFn: (id: string) => deleteComment(id),
    onMutate: (id) => {
      const previous = client.getQueryData<Comment[]>(commentsKey)
      setComments((prev) => prev.filter((c) => c.id !== id))
      return { previous }
    },
    onError: (_error, _id, context) => {
      if (context?.previous) client.setQueryData(commentsKey, context.previous)
    },
  }, client)

  return {
    comments: commentsQuery.data ?? NO_COMMENTS,
    members: (teamId ? membersQuery.data : undefined) ?? NO_MEMBERS,
    loading,
    loadError,
    createComment: create.mutateAsync,
    updateComment: update.mutateAsync,
    deleteComment: remove.mutateAsync,
  }
}
