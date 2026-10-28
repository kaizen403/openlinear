import type { DraftComment } from "./drafts"

/**
 * FE-12: a review comment turned into its own issue — a sub-issue of the
 * reviewed task that keeps the evidence: the file, the line, the commit the
 * comment was written against and the quoted code. The user decides (one
 * click per comment); nothing is created automatically.
 */

export const MAX_FOLLOW_UP_TITLE = 120

export function followUpIssueTitle(body: string): string {
  const first = body.split("\n").map((line) => line.replace(/^[\s>#*\-+]+/, "").trim()).find((line) => line.length > 0) ?? "Follow-up from review"
  return first.length > MAX_FOLLOW_UP_TITLE ? `${first.slice(0, MAX_FOLLOW_UP_TITLE - 1).trimEnd()}…` : first
}

export function followUpIssueFrom(comment: DraftComment, context: { identifier: string | null; headSha: string | null }): { title: string; description: string } {
  const where = comment.line === undefined
    ? `\`${comment.path}\``
    : `\`${comment.path}\` ${comment.side === "old" ? "removed line" : "line"} ${comment.line}`
  const commit = context.headSha ? ` at commit \`${context.headSha.slice(0, 12)}\`` : ""
  const source = context.identifier ? `the review of ${context.identifier}` : "a review of the parent issue"
  const parts = [comment.body.trim(), "---", `From ${source}: ${where}${commit}.`]
  if (comment.excerpt) parts.push(["```", comment.excerpt, "```"].join("\n"))
  return { title: followUpIssueTitle(comment.body), description: parts.join("\n\n") }
}

/** A stable Idempotency-Key per comment: retries never create the issue twice. */
export function followUpIssueKey(comment: DraftComment): string {
  return `review-issue-${comment.id}`.replace(/[^A-Za-z0-9._:~+/=-]/g, "-").slice(0, 128)
}
