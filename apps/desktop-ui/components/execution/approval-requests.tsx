"use client"

import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, Hand, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { decideApproval, expiresIn, fetchApprovals, type ApprovalScope, type PendingApproval } from "@/lib/api/approvals"
import { isApiErrorCode, toastApiError } from "@/lib/api/errors"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { useSSESubscription } from "@/providers/sse-provider"

/**
 * FE-04: the permission requests this task's run is waiting on, with Allow /
 * Deny. The decision quotes the digest of the operation shown; a changed,
 * expired or already-answered request refreshes instead of applying.
 */

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** The toast after a decision. */
export function decisionMessage(result: { decision: "allow" | "deny"; scope?: ApprovalScope }, tool: string): string {
  if (result.decision === "deny") return "Denied; the agent was told no"
  return result.scope === "run" ? `Allowed; ${tool} won't ask again in this run` : "Allowed; the agent continues"
}

export function ApprovalRow({ approval, onDecide, busy, now, showTask = false }: { approval: PendingApproval; onDecide: (decision: "allow" | "deny", scope?: ApprovalScope) => void; busy: boolean; now: number; showTask?: boolean }) {
  return (
    <li className="space-y-2 rounded-sm border border-warning/40 bg-warning/5 p-3" aria-label={`Approval request: ${approval.tool}`}>
      <div className="flex items-center gap-2 text-xs">
        <Hand className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-linear-text">
          The agent wants to use <span className="font-mono">{approval.tool}</span>
          {showTask && approval.taskTitle && <span className="font-normal text-linear-text-secondary"> in “{approval.taskTitle}”</span>}
        </span>
        <span className="ml-auto shrink-0 text-linear-text-tertiary">{expiresIn(approval.expiresAt, now)}</span>
      </div>
      {approval.detail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-linear-bg px-2 py-1.5 font-mono text-[11px] text-linear-text-secondary">{approval.detail}</pre>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("deny")}>
          <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Deny
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide("allow", "run")} title={`Allow ${approval.tool} now and for the rest of this run`}>
          Allow for this run
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDecide("allow")}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
          Allow once
        </Button>
      </div>
    </li>
  )
}

export function ApprovalRequests({ taskId, active }: { taskId: string; active: boolean }) {
  const client = useAppQueryClient()
  const key = [...queryKeys.tasks.detail(taskId), "approvals"] as const
  const approvals = useQuery({ queryKey: key, queryFn: () => fetchApprovals(taskId), enabled: active, retry: false, refetchInterval: active ? 15_000 : false }, client)
  const now = useNow(5_000)

  useSSESubscription((type, data) => {
    if (type === "approval:changed" && data.taskId === taskId) void client.invalidateQueries({ queryKey: key, exact: true })
  })

  const decide = useMutation({
    mutationFn: ({ approval, decision, scope }: { approval: PendingApproval; decision: "allow" | "deny"; scope?: ApprovalScope }) =>
      decideApproval(taskId, approval.id, { decision, ...(scope ? { scope } : {}), digest: approval.digest }),
    onSuccess: (result, { approval }) => {
      toast.success(decisionMessage(result, approval.tool))
      void client.invalidateQueries({ queryKey: key, exact: true })
    },
    onError: (error) => {
      if (isApiErrorCode(error, "APPROVAL_NOT_FOUND") || isApiErrorCode(error, "APPROVAL_CHANGED")) void client.invalidateQueries({ queryKey: key, exact: true })
      toastApiError(error, { fallbackMessage: "Couldn't send your decision" })
    },
  }, client)

  const pending = active ? (approvals.data ?? []) : []
  if (pending.length === 0) return null
  return (
    <section aria-label="Waiting for your approval" className="mb-4">
      <ul className="space-y-2">
        {pending.map((approval) => (
          <ApprovalRow
            key={approval.id}
            approval={approval}
            now={now}
            busy={decide.isPending && decide.variables?.approval.id === approval.id}
            onDecide={(decision, scope) => decide.mutate({ approval, decision, scope })}
          />
        ))}
      </ul>
    </section>
  )
}
