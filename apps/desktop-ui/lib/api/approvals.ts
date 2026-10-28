import { apiFetch } from './fetch';

/**
 * FE-04: permission requests an agent run is waiting on (sidecar
 * `/api/tasks/:id/approvals`). Decisions quote the operation digest shown,
 * so a changed or replayed approval fails on the sidecar.
 */

export interface PendingApproval {
  id: string;
  runId: string;
  taskId: string;
  /** The task's title, for lists across tasks (absent on older sidecars). */
  taskTitle?: string | null;
  tool: string;
  detail: string;
  digest: string;
  requestedAt: number;
  expiresAt: number;
}

export async function fetchApprovals(taskId: string): Promise<PendingApproval[]> {
  const data = await apiFetch<{ approvals: PendingApproval[] }>(`/api/tasks/${encodeURIComponent(taskId)}/approvals`, { sidecar: true });
  return data.approvals;
}

/** Every request waiting on the signed-in user, across tasks (approval inbox). */
export async function fetchMyApprovals(): Promise<PendingApproval[]> {
  const data = await apiFetch<{ approvals: PendingApproval[] }>('/api/approvals', { sidecar: true });
  return data.approvals;
}

/** `scope: 'run'` allows that tool for the rest of the run (ignored for a deny). */
export type ApprovalScope = 'once' | 'run';

export function decideApproval(taskId: string, approvalId: string, body: { decision: 'allow' | 'deny'; scope?: ApprovalScope; digest: string }): Promise<{ decision: 'allow' | 'deny'; scope?: ApprovalScope; by: string }> {
  return apiFetch<{ decision: 'allow' | 'deny'; scope?: ApprovalScope; by: string }>(`/api/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    sidecar: true,
    body: JSON.stringify(body),
  });
}

/** "expires in 14 min" / "expires in 40 s" / "expired". */
export function expiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  if (ms < 60_000) return `expires in ${Math.ceil(ms / 1000)} s`;
  return `expires in ${Math.ceil(ms / 60_000)} min`;
}
