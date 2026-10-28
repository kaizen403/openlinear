"use client"

import { useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { BookOpen, Bot, FilePlus2, Loader2, MessageSquarePlus, Square } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { KnowledgeForm } from "@/components/knowledge/knowledge-form"
import { focusRing } from "@/components/ui/focus-ring"
import { cancelAgentReview, fetchAgentReviews, startAgentReview, type AgentReview, type AgentReviewFinding } from "@/lib/api/agent-reviews"
import { isApiErrorCode, toastApiError } from "@/lib/api/errors"
import { bulkCreateTasks } from "@/lib/api/task-commands"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { useSSESubscription } from "@/providers/sse-provider"
import { evidenceLabel, findingIssue, findingIssueKey, findingLocation, SEVERITY_LABEL } from "./model/agent-review"
import { TEXT, TONE } from "./diff-colors"

/**
 * W19a / FE-12: "Review with agent" for a finished run. A fresh agent
 * session reviews the run's commit (it can't change anything) and lists
 * findings anchored to the code; each one can become a draft comment for the
 * next follow-up or a sub-issue — only when the user clicks.
 */

const SEVERITY_TONE: Record<AgentReviewFinding["severity"], string> = {
  blocker: cn("bg-danger/10", TONE.danger.text),
  major: cn("bg-warning/10", TONE.warning.text),
  minor: "bg-foreground/10 text-foreground",
  nit: "bg-foreground/5 text-linear-text-secondary",
}

export interface AgentReviewSectionProps {
  taskId: string
  projectId: string | null
  identifier: string | null
  /** The task is running: a review waits until the run has finished. */
  live: boolean
  onComment: (finding: AgentReviewFinding) => void
  onJump: (finding: AgentReviewFinding) => void
}

function FindingRow({ finding, review, onComment, onIssue, onRemember, onJump, creating }: {
  finding: AgentReviewFinding
  review: AgentReview
  onComment: () => void
  onIssue: (() => void) | null
  /** W19b: turn the lesson into project knowledge (a person edits it first). */
  onRemember: (() => void) | null
  onJump: () => void
  creating: boolean
}) {
  const evidence = evidenceLabel(finding)
  return (
    <li className={cn("space-y-1 px-3 py-2", finding.stale === true && "opacity-60")} aria-label={`${SEVERITY_LABEL[finding.severity]} finding: ${finding.title}`}>
      <div className="flex items-start gap-1.5">
        <span className={cn("mt-px shrink-0 rounded-sm px-1 text-[10px] font-medium uppercase", SEVERITY_TONE[finding.severity])}>{SEVERITY_LABEL[finding.severity]}</span>
        <span className="min-w-0 text-[12px] font-medium leading-4 text-foreground">{finding.title}</span>
      </div>
      <button type="button" onClick={onJump} className={cn("block max-w-full truncate rounded-sm font-mono text-[11px] text-linear-text-secondary hover:text-foreground", focusRing)} title={`Show ${findingLocation(finding)} in the diff`}>
        {findingLocation(finding)}
      </button>
      {finding.body && <p className={cn("whitespace-pre-wrap break-words text-[11px] leading-4", TEXT.secondary)}>{finding.body}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn("rounded-sm px-1 text-[10px]", evidence.tone === "ok" ? TONE.success.text : evidence.tone === "warning" ? TONE.warning.text : TEXT.muted)}
          title={finding.stale === true
            ? "A later commit no longer contains the quoted code"
            : finding.evidence === "unverified"
              ? "The reviewer's quote is not in this file at the reviewed commit; check it yourself"
              : `The quoted code is in the file at ${review.commit.slice(0, 7)}`}
        >
          {evidence.text}
        </span>
        {!finding.inDiff && <span className={cn("text-[10px]", TEXT.muted)}>outside the change</span>}
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={onComment} className={cn("flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)} title="Add as a comment for the next follow-up">
            <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
            Comment
          </button>
          {onIssue && (
            <button type="button" disabled={creating} onClick={onIssue} className={cn("flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground disabled:opacity-50", focusRing)} title="Create a sub-issue with this finding">
              {creating ? <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" /> : <FilePlus2 className="h-3 w-3" aria-hidden="true" />}
              Issue
            </button>
          )}
          {onRemember && (
            <button type="button" onClick={onRemember} className={cn("flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)} title="Save the lesson as project knowledge, so later runs know it">
              <BookOpen className="h-3 w-3" aria-hidden="true" />
              Remember
            </button>
          )}
        </span>
      </div>
    </li>
  )
}

export function AgentReviewSection({ taskId, projectId, identifier, live, onComment, onJump }: AgentReviewSectionProps) {
  const client = useAppQueryClient()
  const key = [...queryKeys.tasks.detail(taskId), "agent-reviews"] as const
  const reviews = useQuery({
    queryKey: key,
    queryFn: () => fetchAgentReviews(taskId),
    retry: false,
    refetchInterval: (query) => (query.state.data?.reviewing ? 5_000 : false),
  }, client)

  useSSESubscription((type, data) => {
    if (type === "review:changed" && data.taskId === taskId) void client.invalidateQueries({ queryKey: key, exact: true })
  })

  const start = useMutation({
    mutationFn: () => startAgentReview(taskId),
    onSuccess: () => {
      toast.success("Review started", { description: "A fresh agent session is reading the change. Findings appear here." })
      void client.invalidateQueries({ queryKey: key, exact: true })
    },
    onError: (error) => {
      if (isApiErrorCode(error, "REVIEW_RUNNING")) void client.invalidateQueries({ queryKey: key, exact: true })
      toastApiError(error, { fallbackMessage: "Couldn't start the review" })
    },
  }, client)

  const cancel = useMutation({
    mutationFn: (reviewId: string) => cancelAgentReview(taskId, reviewId),
    onSettled: () => void client.invalidateQueries({ queryKey: key, exact: true }),
    onError: (error) => {
      if (!isApiErrorCode(error, "REVIEW_NOT_RUNNING")) toastApiError(error, { fallbackMessage: "Couldn't stop the review" })
    },
  }, client)

  const [creating, setCreating] = useState<ReadonlySet<string>>(() => new Set())
  const creatingRef = useRef(new Set<string>())
  const createIssue = async (review: AgentReview, finding: AgentReviewFinding) => {
    if (!projectId || creatingRef.current.has(finding.id)) return
    creatingRef.current.add(finding.id)
    setCreating(new Set(creatingRef.current))
    try {
      const issue = findingIssue(finding, { identifier, commit: review.commit })
      const result = await bulkCreateTasks({ projectId, tasks: [{ title: issue.title, description: issue.description, parentId: taskId }] }, findingIssueKey(review.id, finding))
      const created = result.created[0]
      if (created) toast.success(`Created ${created.identifier ?? "an issue"}`, { description: "A sub-issue of this task, with the finding, file, lines and commit." })
      else toast.error("Couldn't create the issue", { description: result.failed[0]?.error })
    } catch (error) {
      toastApiError(error, { fallbackMessage: "Couldn't create the issue" })
    } finally {
      creatingRef.current.delete(finding.id)
      setCreating(new Set(creatingRef.current))
    }
  }

  const [remembering, setRemembering] = useState<{ review: AgentReview; finding: AgentReviewFinding } | null>(null)

  const latest = reviews.data?.reviews[0] ?? null
  const running = latest?.status === "running"
  const startDisabled = live || running || start.isPending

  return (
    <section aria-label="Agent review" className="border-t border-border pb-2">
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-linear-text-secondary">Agent review</h3>
        {running && latest ? (
          <button type="button" onClick={() => cancel.mutate(latest.id)} disabled={cancel.isPending} className={cn("ml-auto flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)}>
            <Square className="h-3 w-3" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={startDisabled}
            title={live ? "Review the change when the run has finished" : "A fresh agent session reviews this change; it can't modify anything"}
            className={cn("ml-auto flex h-6 items-center gap-1 rounded-sm border border-border px-1.5 text-[11px] text-foreground hover:bg-foreground/5 disabled:opacity-50", focusRing)}
          >
            {start.isPending ? <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" /> : <Bot className="h-3 w-3" aria-hidden="true" />}
            {latest ? "Review again" : "Review with agent"}
          </button>
        )}
      </div>
      {reviews.isError && <p className={cn("px-3 text-[11px]", TEXT.muted)}>Agent reviews aren't available here.</p>}
      {latest && (
        <div className="space-y-1 px-3 text-[11px]" role="status">
          {running && (
            <p className={cn("flex items-center gap-1.5", TEXT.secondary)}>
              <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
              Reviewing {latest.commit.slice(0, 7)} with {latest.runner}…
            </p>
          )}
          {latest.status === "failed" && <p className={TONE.warning.text}>Review failed: {latest.error ?? "unknown error"}</p>}
          {latest.status === "cancelled" && <p className={TEXT.muted}>Review stopped.</p>}
          {latest.status === "completed" && (
            <>
              <p className={TEXT.secondary}>
                {latest.findings.length === 0 ? "No problems found" : `${latest.findings.length} finding${latest.findings.length === 1 ? "" : "s"}`} at {latest.commit.slice(0, 7)}
                {latest.usage.usd > 0 ? ` · $${latest.usage.usd.toFixed(2)}` : ""}
              </p>
              {latest.headCommit && <p className={TEXT.muted}>The code has changed since ({latest.headCommit.slice(0, 7)}); stale findings are dimmed.</p>}
              {latest.summary && <p className={cn("whitespace-pre-wrap break-words", TEXT.secondary)}>{latest.summary}</p>}
              {latest.dropped > 0 && <p className={TEXT.muted}>{latest.dropped} finding{latest.dropped === 1 ? "" : "s"} pointed outside the repository and were left out.</p>}
            </>
          )}
        </div>
      )}
      {latest?.status === "completed" && latest.findings.length > 0 && (
        <ul className="mt-1 divide-y divide-border/60" aria-label="Findings">
          {latest.findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              review={latest}
              creating={creating.has(finding.id)}
              onComment={() => onComment(finding)}
              onIssue={projectId ? () => void createIssue(latest, finding) : null}
              onRemember={projectId ? () => setRemembering({ review: latest, finding }) : null}
              onJump={() => onJump(finding)}
            />
          ))}
        </ul>
      )}
      {projectId && (
        <Dialog open={remembering !== null} onOpenChange={(open) => { if (!open) setRemembering(null) }}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Remember for later runs</DialogTitle>
              <DialogDescription>Write it as a general rule; every agent run in this project will get it. The finding is kept as its source.</DialogDescription>
            </DialogHeader>
            {remembering && (
              <KnowledgeForm
                projectId={projectId}
                initial={{
                  kind: "convention",
                  title: remembering.finding.title,
                  body: remembering.finding.body || remembering.finding.title,
                  sourceRef: { taskId, reviewId: remembering.review.id, findingId: remembering.finding.id, commit: remembering.review.commit },
                }}
                onCancel={() => setRemembering(null)}
                onSaved={() => {
                  setRemembering(null)
                  toast.success("Saved as project knowledge", { description: "Agents get it from their next run in this project." })
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
