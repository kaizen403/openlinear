import { apiFetch } from './fetch';

/**
 * W19a / FE-12: independent agent reviews of a task's newest finished run
 * (sidecar `/api/tasks/:id/reviews`). A review is advisory: its findings
 * only become follow-up comments or issues when the user chooses so.
 */

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export interface AgentReviewFinding {
  id: string;
  severity: ReviewSeverity;
  file: string;
  startLine: number;
  endLine: number;
  quote: string;
  title: string;
  body: string;
  /** `verified`: the quoted code is at those lines at the reviewed commit; `relocated`: found elsewhere (lines corrected); `unverified`: not found. */
  evidence: 'verified' | 'relocated' | 'unverified';
  inDiff: boolean;
  /** A later commit no longer contains the quoted code (null: can't tell). */
  stale: boolean | null;
}

export interface AgentReview {
  id: string;
  taskId: string;
  runId: string;
  runner: string;
  commit: string;
  baseCommit: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  findings: AgentReviewFinding[];
  dropped: number;
  diffTruncated: boolean;
  usage: { usd: number; inputTokens: number; outputTokens: number };
  error: string | null;
  /** The task's checkout has moved past the reviewed commit (findings re-checked against it). */
  headCommit: string | null;
}

export async function fetchAgentReviews(taskId: string): Promise<{ reviews: AgentReview[]; reviewing: boolean }> {
  return apiFetch<{ reviews: AgentReview[]; reviewing: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/reviews`, { sidecar: true });
}

export async function startAgentReview(taskId: string): Promise<AgentReview> {
  const data = await apiFetch<{ review: AgentReview }>(`/api/tasks/${encodeURIComponent(taskId)}/reviews`, { method: 'POST', sidecar: true });
  return data.review;
}

export function cancelAgentReview(taskId: string, reviewId: string): Promise<{ cancelled: boolean }> {
  return apiFetch<{ cancelled: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/reviews/${encodeURIComponent(reviewId)}/cancel`, { method: 'POST', sidecar: true });
}
