"use client"

import { useState, type FormEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Bot, Check, History, Loader2, Pencil, RotateCcw, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import {
  approveKnowledge,
  fetchKnowledgeEntry,
  KNOWLEDGE_KIND_LABEL,
  restoreKnowledge,
  retractKnowledge,
  type KnowledgeEntry,
  type KnowledgeRevision,
} from "@/lib/api/knowledge"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * W19b / FE-13: a project's knowledge, by status. Proposals (from agents)
 * wait for a person's Approve; active entries go to every run; retracted
 * ones keep their history and can be restored.
 */

export type KnowledgeTab = "active" | "proposed" | "retracted"

const CHANGE_LABEL: Record<KnowledgeRevision["change"], string> = {
  created: "Created",
  edited: "Edited",
  approved: "Approved",
  retracted: "Retracted",
  restored: "Restored",
}

/** Where an entry came from, in words. */
export function provenance(entry: Pick<KnowledgeEntry, "source" | "sourceRef">): string | null {
  const ref = entry.sourceRef
  if (entry.source === "review_finding") return `From an agent review finding${ref?.commit ? ` at ${ref.commit.slice(0, 7)}` : ""}`
  if (entry.source === "agent") return "Proposed by an agent"
  if (ref?.chatSessionId) return "From Home Chat"
  return null
}

function Revisions({ entryId }: { entryId: string }) {
  const client = useAppQueryClient()
  const detail = useQuery({ queryKey: queryKeys.knowledge.detail(entryId), queryFn: () => fetchKnowledgeEntry(entryId), retry: false }, client)
  if (detail.isLoading) return <p className="text-[11px] text-linear-text-tertiary">Loading history…</p>
  if (detail.isError) return <p role="alert" className="text-[11px] text-linear-text-secondary">{describeApiError(detail.error, "Couldn't load the history.").message}</p>
  return (
    <ol className="space-y-1.5 border-l border-linear-border pl-3" aria-label="Revisions">
      {(detail.data?.versions ?? []).map((revision) => (
        <li key={revision.version} className="text-[11px]">
          <span className="font-medium text-linear-text">v{revision.version} · {CHANGE_LABEL[revision.change]}</span>
          <span className="text-linear-text-tertiary"> · {new Date(revision.createdAt).toLocaleString()}</span>
          {revision.note && <span className="text-linear-text-secondary"> — {revision.note}</span>}
          {(revision.change === "created" || revision.change === "edited") && (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-linear-text-secondary">{revision.title}: {revision.body}</p>
          )}
        </li>
      ))}
    </ol>
  )
}

function EntryRow({ entry, onEdit }: { entry: KnowledgeEntry; onEdit: (entry: KnowledgeEntry) => void }) {
  const client = useAppQueryClient()
  const [showHistory, setShowHistory] = useState(false)
  const [retracting, setRetracting] = useState(false)
  const [reason, setReason] = useState("")
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.knowledge.list(entry.projectId) })
    void client.invalidateQueries({ queryKey: queryKeys.knowledge.detail(entry.id) })
  }
  const act = useMutation({
    mutationFn: (action: { kind: "approve" } | { kind: "retract"; reason: string } | { kind: "restore" }) =>
      action.kind === "approve" ? approveKnowledge(entry.id, entry.version)
        : action.kind === "retract" ? retractKnowledge(entry.id, action.reason)
        : restoreKnowledge(entry.id),
    onSuccess: (saved) => {
      toast.success(saved.status === "active" ? "Active: agents get it from their next run" : "Retracted: no longer given to runs")
      setRetracting(false)
      setReason("")
      refresh()
    },
    onError: (error) => {
      refresh()
      toastApiError(error, { fallbackMessage: "Couldn't update the entry" })
    },
  }, client)
  const submitRetract = (event: FormEvent) => {
    event.preventDefault()
    if (reason.trim()) act.mutate({ kind: "retract", reason: reason.trim() })
  }
  const origin = provenance(entry)

  return (
    <li className="space-y-2 px-4 py-3" aria-label={`${KNOWLEDGE_KIND_LABEL[entry.kind]}: ${entry.title}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm border border-linear-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-linear-text-secondary">{KNOWLEDGE_KIND_LABEL[entry.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-linear-text">{entry.title}</span>
        {entry.status === "proposed" && (
          <span className="flex items-center gap-1 rounded-sm bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
            <Bot className="h-3 w-3" aria-hidden="true" />
            Waiting for approval
          </span>
        )}
        {entry.status === "active" && entry.expired && <span className="rounded-sm bg-foreground/5 px-1.5 py-0.5 text-[10px] text-linear-text-secondary">Expired</span>}
        <span className="text-[11px] text-linear-text-tertiary">v{entry.version}</span>
      </div>
      <p className={cn("whitespace-pre-wrap break-words text-[13px] leading-5", entry.status === "retracted" ? "text-linear-text-tertiary" : "text-linear-text-secondary")}>{entry.body}</p>
      <p className="text-[11px] text-linear-text-tertiary">
        {origin ? `${origin} · ` : ""}updated {new Date(entry.updatedAt).toLocaleDateString()}
        {entry.expiresAt && !entry.expired ? ` · expires ${new Date(entry.expiresAt).toLocaleDateString()}` : ""}
        {entry.retractReason ? ` · retracted: ${entry.retractReason}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.status === "proposed" && (
          <Button size="sm" onClick={() => act.mutate({ kind: "approve" })} disabled={act.isPending}>
            {act.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
            Approve
          </Button>
        )}
        {entry.status !== "retracted" && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(entry)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Button>
        )}
        {entry.status !== "retracted" && !retracting && (
          <Button size="sm" variant="ghost" onClick={() => setRetracting(true)}>
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {entry.status === "proposed" ? "Reject" : "Retract"}
          </Button>
        )}
        {entry.status === "retracted" && (
          <Button size="sm" variant="ghost" onClick={() => act.mutate({ kind: "restore" })} disabled={act.isPending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Restore
          </Button>
        )}
        <button
          type="button"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((value) => !value)}
          className={cn("ml-auto flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] text-linear-text-secondary hover:text-linear-text", focusRing)}
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          History
        </button>
      </div>
      {retracting && (
        <form onSubmit={submitRetract} className="flex items-center gap-2" aria-label="Retract">
          <input
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why it no longer applies"
            aria-label="Reason"
            className={cn("h-7 flex-1 rounded-sm border border-linear-border bg-linear-bg px-2 text-xs text-linear-text", focusRing)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!reason.trim() || act.isPending}>{entry.status === "proposed" ? "Reject" : "Retract"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRetracting(false)}>Cancel</Button>
        </form>
      )}
      {showHistory && <Revisions entryId={entry.id} />}
    </li>
  )
}

export function KnowledgeList({ entries, tab, onEdit }: { entries: KnowledgeEntry[]; tab: KnowledgeTab; onEdit: (entry: KnowledgeEntry) => void }) {
  const shown = entries.filter((entry) => entry.status === tab)
  if (shown.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-linear-text-secondary">
        {tab === "proposed" ? "Nothing waiting for approval. Agents' proposals appear here." : tab === "retracted" ? "Nothing retracted." : "No active knowledge yet."}
      </p>
    )
  }
  return (
    <ul className="divide-y divide-linear-border/50">
      {shown.map((entry) => <EntryRow key={entry.id} entry={entry} onEdit={onEdit} />)}
    </ul>
  )
}
