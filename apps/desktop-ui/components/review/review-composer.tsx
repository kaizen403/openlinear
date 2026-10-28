"use client"

import { memo, useId, type KeyboardEvent } from "react"
import { Loader2, Send, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { commentLocation, MAX_MESSAGE_CHARS, sortComments, type DraftComment } from "./model/drafts"
import type { ReviewErrorView } from "./review-errors"
import { TEXT, TONE } from "./diff-colors"

interface ReviewComposerProps {
  message: string
  comments: readonly DraftComment[]
  revision: string | null
  sending: boolean
  /** Why sending is not possible right now (agent busy, …), or null. */
  blockedReason: string | null
  error: ReviewErrorView | null
  persisted: boolean
  onMessageChange: (message: string) => void
  onRemoveComment: (id: string) => void
  onJumpToComment: (comment: DraftComment) => void
  onSend: () => void
}

/**
 * Collects every draft comment plus a message and sends them to the agent as
 * a follow-up run. Drafts stay in localStorage until the sidecar accepts
 * them, so a failed or unsupported send loses nothing.
 */
export const ReviewComposer = memo(function ReviewComposer({
  message,
  comments,
  revision,
  sending,
  blockedReason,
  error,
  persisted,
  onMessageChange,
  onRemoveComment,
  onJumpToComment,
  onSend,
}: ReviewComposerProps) {
  const id = useId()
  const ordered = sortComments(comments)
  const outdated = revision ? ordered.filter((comment) => comment.revision !== revision).length : 0
  const nothingToSend = !message.trim() && ordered.length === 0
  const disabled = sending || nothingToSend || blockedReason !== null
  const count = ordered.length

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (!disabled) onSend()
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="border-t border-border bg-card px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 id={`${id}-title`} className="text-[12px] font-medium uppercase tracking-wide text-linear-text-secondary">
          Send back to the agent
        </h3>
        <span className={cn("text-[12px]", TEXT.muted)}>
          {count === 0 ? "No comments yet — press c on a line to add one" : `${count} comment${count === 1 ? "" : "s"}`}
          {outdated > 0 ? ` · ${outdated} on an older diff` : ""}
        </span>
        {!persisted && <span className={cn("text-[11px]", TONE.warning.text)}>Drafts can't be saved on this device; they'll be lost if you close the app.</span>}
      </div>

      {count > 0 && (
        <ul aria-label="Draft comments" className="mb-2 max-h-28 space-y-0.5 overflow-y-auto pr-1">
          {ordered.map((comment) => (
            <li key={comment.id} className="flex items-center gap-2 text-[12px]">
              <button
                type="button"
                onClick={() => onJumpToComment(comment)}
                className={cn("min-w-0 flex-1 truncate rounded-sm text-left hover:text-foreground", TEXT.secondary, focusRing)}
                title={comment.body}
              >
                <span className="font-mono text-foreground">{commentLocation(comment)}</span>
                <span> — {comment.body}</span>
              </button>
              <button
                type="button"
                onClick={() => onRemoveComment(comment.id)}
                aria-label={`Remove comment on ${commentLocation(comment)}`}
                className={cn("shrink-0 rounded-sm p-0.5 text-linear-text-secondary hover:text-destructive", focusRing)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label htmlFor={`${id}-message`} className="sr-only">Message to the agent</label>
      <div className="flex items-end gap-2">
        <textarea
          id={`${id}-message`}
          value={message}
          maxLength={MAX_MESSAGE_CHARS}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={count > 0 ? "Optional: anything else the agent should know" : "Tell the agent what to change"}
          className={cn(
            "min-h-[52px] flex-1 resize-y rounded-sm border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground",
            focusRing,
          )}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled}
          aria-describedby={blockedReason || error ? `${id}-status` : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
            focusRing,
          )}
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          {sending ? "Sending…" : "Send to agent"}
        </button>
      </div>
      <div id={`${id}-status`} role="status" aria-live="polite" className="mt-1 min-h-4 text-[12px] leading-4">
        {error ? (
          <p className="text-destructive">
            <span className="font-medium">{error.title}.</span>
            {error.hint ? <span className="text-linear-text-secondary"> {error.hint}</span> : null}
          </p>
        ) : blockedReason ? (
          <p className={TEXT.secondary}>{blockedReason}</p>
        ) : (
          <p className={TEXT.muted}>⌘/Ctrl+Enter sends · the agent starts a new attempt on the same task</p>
        )}
      </div>
    </section>
  )
})
