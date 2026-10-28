"use client"

import { useMutation } from "@tanstack/react-query"
import { sendWithIdempotencyKey } from "@/lib/api/idempotency"
import { createTaskWithKey, type CreateTaskRequest } from "@/lib/api/task-commands"
import { writeCreatedTaskToCache } from "@/lib/query/sse-bridge"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import type { Task } from "@/types/task"

export interface CreateTaskVariables {
  body: CreateTaskRequest
  /** The caller's key for this intent; automatic retries resend it (W04a). */
  idempotencyKey: string
}

/**
 * `POST /api/tasks` as a mutation. Automatic retries (network, 409
 * IDEMPOTENCY_IN_PROGRESS, 502–504) reuse the caller's Idempotency-Key, so a
 * lost response never creates the task twice; on success the task goes
 * straight into every cached list it belongs to (a board opened after the
 * form closes shows it without refetching).
 */
export function useCreateTask(): (variables: CreateTaskVariables) => Promise<Task> {
  const client = useAppQueryClient()
  const mutation = useMutation({
    mutationFn: ({ body, idempotencyKey }: CreateTaskVariables) =>
      sendWithIdempotencyKey(idempotencyKey, (key) => createTaskWithKey(body, key)),
    onSuccess: (task) => writeCreatedTaskToCache(client, task),
  }, client)
  return mutation.mutateAsync
}
