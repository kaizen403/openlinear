import type { FollowUpComment, FollowUpRequest } from "@/lib/api/review"
import { sortComments, type ReviewDraftState } from "./drafts"

/** Sent when the reviewer only left inline comments. */
export const DEFAULT_FOLLOW_UP_MESSAGE = "Please address the review comments below."

export interface FollowUpPlan {
  request: FollowUpRequest
  /** Draft ids included in the request (removed once it was accepted). */
  commentIds: string[]
  /** Comments written against an older diff revision. */
  outdated: number
  /** The message was typed (as opposed to the default). */
  hasMessage: boolean
}

export type FollowUpPlanResult = { ok: true; plan: FollowUpPlan } | { ok: false; error: string }

/** Turns the drafts into the follow-up contract body; comments in file/line order. */
export function planFollowUp(drafts: ReviewDraftState, currentRevision: string | null): FollowUpPlanResult {
  const typed = drafts.message.trim()
  const ordered = sortComments(drafts.comments).filter((comment) => comment.body.trim().length > 0)
  if (!typed && ordered.length === 0) return { ok: false, error: "Write a message or add a comment on the diff first." }
  const comments: FollowUpComment[] = ordered.map((comment) => ({
    path: comment.path,
    ...(comment.line !== undefined ? { line: comment.line, side: comment.side ?? "new" } : {}),
    body: comment.body.trim(),
  }))
  const outdated = currentRevision === null ? 0 : ordered.filter((comment) => comment.revision !== currentRevision).length
  return {
    ok: true,
    plan: {
      request: { message: typed || DEFAULT_FOLLOW_UP_MESSAGE, ...(comments.length > 0 ? { comments } : {}) },
      commentIds: ordered.map((comment) => comment.id),
      outdated,
      hasMessage: typed.length > 0,
    },
  }
}
