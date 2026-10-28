"use client"

import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { FilePlus2, MessageSquarePlus, Pencil, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { MAX_COMMENT_CHARS, type DraftComment } from "./model/drafts"
import type { CommentTarget } from "./model/rows"
import { DRAFT_BADGE, TEXT, TONE } from "./diff-colors"

/** Marks elements whose Escape belongs to them, not to the surrounding sheet (see reviewConsumesEscape). */
export const REVIEW_ESCAPE_ATTR = "data-review-escape"

/**
 * True when Escape should cancel a review editor instead of closing the
 * surrounding Radix sheet (Radix handles Escape in the capture phase; sheets
 * call this from `onEscapeKeyDown` and `preventDefault()` when true).
 */
export function reviewConsumesEscape(event: { target: EventTarget | null }): boolean {
  const target = event.target
  if (!target || typeof (target as Element).closest !== "function") return false
  return (target as Element).closest(`[${REVIEW_ESCAPE_ATTR}]`) !== null
}

export interface CommentActions {
  start: (target: CommentTarget) => void
  cancel: () => void
  save: (target: CommentTarget, body: string) => void
  edit: (id: string, body: string) => void
  remove: (id: string) => void
  /** FE-12: turn the comment into a sub-issue of the reviewed task (absent when that isn't possible). */
  promote?: (id: string) => void
}

export function describeTarget(target: CommentTarget): string {
  if (target.line === undefined) return `file ${target.path}`
  return `${target.side === "old" ? "removed line" : "line"} ${target.line} of ${target.path}`
}

interface CommentEditorProps {
  label: string
  initial?: string
  submitLabel: string
  onSubmit: (body: string) => void
  onCancel: () => void
}

export function CommentEditor({ label, initial = "", submitLabel, onSubmit, onCancel }: CommentEditorProps) {
  const [body, setBody] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const submit = () => {
    if (body.trim()) onSubmit(body)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
    // Keep j/k/n/p and arrows inside the textarea.
    event.stopPropagation()
  }
  return (
    <div className="space-y-2" {...{ [REVIEW_ESCAPE_ATTR]: "" }}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea
        id={id}
        ref={ref}
        value={body}
        maxLength={MAX_COMMENT_CHARS}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        placeholder="Leave a comment for the agent…"
        className={cn(
          "block w-full resize-y rounded-sm border border-border bg-background px-2 py-1.5 font-sans text-[13px] leading-5 text-foreground placeholder:text-muted-foreground",
          focusRing,
        )}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!body.trim()}
          className={cn("h-7 rounded-sm bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50", focusRing)}
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={cn("h-7 rounded-sm px-2.5 text-xs text-linear-text-secondary hover:bg-foreground/5", focusRing)}>
          Cancel
        </button>
        <span className={cn("ml-auto text-[11px]", TEXT.muted)}>⌘/Ctrl+Enter to save · Esc to cancel</span>
      </div>
    </div>
  )
}

interface CommentThreadProps {
  path: string
  target: CommentTarget
  comments: readonly DraftComment[]
  editing: boolean
  orphaned: boolean
  revision: string | null
  currentText?: string
  actions: CommentActions
}

function isOutdated(comment: DraftComment, revision: string | null, currentText: string | undefined): boolean {
  if (!revision || comment.revision === revision) return false
  if (comment.excerpt === undefined || currentText === undefined) return comment.line !== undefined
  return comment.excerpt !== currentText.slice(0, comment.excerpt.length)
}

/** Draft comments on one line (or file), with inline edit/delete and the new-comment editor. */
export const CommentThread = memo(function CommentThread({ path, target, comments, editing, orphaned, revision, currentText, actions }: CommentThreadProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const label = orphaned ? `Comments on lines no longer in ${path}` : `Comments on ${describeTarget(target)}`
  return (
    <section aria-label={label} className="mx-2 my-1.5 rounded-sm border border-border bg-card px-3 py-2 font-sans">
      {orphaned && (
        <p className={cn("mb-1.5 text-[11px]", TEXT.muted)}>These lines are no longer part of the diff.</p>
      )}
      <ul className="space-y-2">
        {comments.map((comment) => {
          const outdated = orphaned || isOutdated(comment, revision, currentText)
          return (
            <li key={comment.id} className="group">
              {editingId === comment.id ? (
                <CommentEditor
                  label={`Edit comment on ${describeTarget(comment)}`}
                  initial={comment.body}
                  submitLabel="Save"
                  onSubmit={(body) => {
                    actions.edit(comment.id, body)
                    setEditingId(null)
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px]">
                      <span className={cn("rounded-sm border px-1", DRAFT_BADGE)}>Draft</span>
                      {orphaned && comment.line !== undefined && (
                        <span className={TEXT.muted}>{comment.side === "old" ? "removed line" : "line"} {comment.line}</span>
                      )}
                      {outdated && <span className={TONE.warning.text}>Outdated</span>}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">{comment.body}</p>
                  </div>
                  {actions.promote && (
                    <button
                      type="button"
                      onClick={() => actions.promote?.(comment.id)}
                      aria-label="Make an issue from this comment"
                      title="Make an issue from this comment (a sub-issue with the file, line and commit)"
                      className={cn("rounded-sm p-1 text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)}
                    >
                      <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingId(comment.id)}
                    aria-label="Edit draft comment"
                    className={cn("rounded-sm p-1 text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground", focusRing)}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.remove(comment.id)}
                    aria-label="Delete draft comment"
                    className={cn("rounded-sm p-1 text-linear-text-secondary hover:bg-foreground/5 hover:text-destructive", focusRing)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {editing ? (
        <div className={comments.length > 0 ? "mt-2" : undefined}>
          <CommentEditor
            label={`New comment on ${describeTarget(target)}`}
            submitLabel="Add comment"
            onSubmit={(body) => actions.save(target, body)}
            onCancel={actions.cancel}
          />
        </div>
      ) : !orphaned && comments.length > 0 ? (
        <button
          type="button"
          onClick={() => actions.start(target)}
          className={cn("mt-1.5 inline-flex items-center gap-1 rounded-sm px-1 text-[12px] text-linear-text-secondary hover:text-foreground", focusRing)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add another comment
        </button>
      ) : null}
    </section>
  )
})
