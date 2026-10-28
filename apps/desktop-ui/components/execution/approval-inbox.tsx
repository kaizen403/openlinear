"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { decideApproval, fetchMyApprovals, type ApprovalScope, type PendingApproval } from "@/lib/api/approvals"
import { isApiErrorCode, toastApiError } from "@/lib/api/errors"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { useSSESubscription } from "@/providers/sse-provider"
import { ApprovalRow, decisionMessage, useNow } from "./approval-requests"

/**
 * FE-04 approval inbox: every permission request waiting on you, across
 * tasks, answerable in place. Silent when the local execution service isn't
 * reachable (web mode) or nothing waits.
 */

const KEY = ["ol", "approvals", "mine"] as const

export function ApprovalInbox() {
  const client = useAppQueryClient()
  const approvals = useQuery({ queryKey: KEY, queryFn: fetchMyApprovals, retry: false, refetchInterval: 15_000 }, client)
  const now = useNow(5_000)
  useSSESubscription((type) => {
    if (type === "approval:changed") void client.invalidateQueries({ queryKey: KEY, exact: true })
  })
  const decide = useMutation({
    mutationFn: ({ approval, decision, scope }: { approval: PendingApproval; decision: "allow" | "deny"; scope?: ApprovalScope }) =>
      decideApproval(approval.taskId, approval.id, { decision, ...(scope ? { scope } : {}), digest: approval.digest }),
    onSuccess: (result, { approval }) => {
      toast.success(decisionMessage(result, approval.tool))
      void client.invalidateQueries({ queryKey: KEY, exact: true })
    },
    onError: (error) => {
      if (isApiErrorCode(error, "APPROVAL_NOT_FOUND") || isApiErrorCode(error, "APPROVAL_CHANGED")) void client.invalidateQueries({ queryKey: KEY, exact: true })
      toastApiError(error, { fallbackMessage: "Couldn't send your decision" })
    },
  }, client)

  const pending = approvals.data ?? []
  if (pending.length === 0) return null
  return (
    <section aria-label="Waiting for your approval" className="border-b border-linear-border px-4 py-3 sm:px-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-warning">Waiting for your approval · {pending.length}</h2>
      <ul className="space-y-2">
        {pending.map((approval) => (
          <ApprovalRow
            key={approval.id}
            approval={approval}
            now={now}
            showTask
            busy={decide.isPending && decide.variables?.approval.id === approval.id}
            onDecide={(decision, scope) => decide.mutate({ approval, decision, scope })}
          />
        ))}
      </ul>
    </section>
  )
}
