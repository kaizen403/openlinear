import type { AgentReviewFinding } from "@/lib/api/agent-reviews"
import type { NewCommentInput } from "./drafts"

/**
 * W19a / FE-12: turning an agent review finding into something the user
 * owns — a draft comment for the next follow-up, or a sub-issue — with its
 * evidence (file, lines, reviewed commit, quoted code). Pure.
 */

export const SEVERITY_LABEL: Record<AgentReviewFinding["severity"], string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
  nit: "Nit",
}

export function findingLocation(finding: Pick<AgentReviewFinding, "file" | "startLine" | "endLine">): string {
  return finding.endLine > finding.startLine ? `${finding.file}:${finding.startLine}–${finding.endLine}` : `${finding.file}:${finding.startLine}`
}

/** What the badge says about the finding's evidence. */
export function evidenceLabel(finding: Pick<AgentReviewFinding, "evidence" | "stale">): { text: string; tone: "ok" | "warning" | "muted" } {
  if (finding.stale === true) return { text: "Stale", tone: "muted" }
  if (finding.evidence === "verified") return { text: "Checked", tone: "ok" }
  if (finding.evidence === "relocated") return { text: "Lines corrected", tone: "ok" }
  return { text: "Quote not found", tone: "warning" }
}

/** A draft comment on the finding's last line (the side the reviewer read: the new code). */
export function findingComment(finding: AgentReviewFinding, revision: string | null): NewCommentInput {
  const body = [`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`, finding.body.trim()].filter(Boolean).join("\n\n")
  const excerpt = finding.quote.split("\n").find((line) => line.trim()) ?? ""
  return { path: finding.file, line: finding.endLine, side: "new", body, revision, ...(excerpt ? { excerpt: excerpt.slice(0, 200) } : {}) }
}

function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const marks = "`".repeat(Math.max(3, longest + 1))
  return `${marks}\n${text}\n${marks}`
}

export function findingIssue(finding: AgentReviewFinding, context: { identifier: string | null; commit: string }): { title: string; description: string } {
  const title = `${finding.title}`.slice(0, 200)
  const description = [
    `From an agent review${context.identifier ? ` of ${context.identifier}` : ""} (${SEVERITY_LABEL[finding.severity].toLowerCase()}).`,
    "",
    finding.body.trim(),
    "",
    `**Where:** \`${findingLocation(finding)}\` at commit \`${context.commit.slice(0, 12)}\``,
    "",
    fence(finding.quote),
  ].join("\n").trim()
  return { title, description }
}

/** Idempotency key: one issue per finding (a double click creates it once). */
export function findingIssueKey(reviewId: string, finding: Pick<AgentReviewFinding, "id">): string {
  return `agent-review:${reviewId}:${finding.id}`
}
