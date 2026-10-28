import { apiFetch } from './fetch';

/**
 * FE-03: project trust grants on this device (sidecar `/api/sandbox/grants`).
 * A grant lets one project's runs proceed without the OS sandbox, only while
 * no verified sandbox is available, for at most 7 days. Shapes mirror
 * `apps/sidecar/src/routes/sandbox-grants.ts`.
 */

export type SandboxGrantState = 'verified' | 'unavailable' | 'unknown' | 'env-grant' | 'invalid' | 'disabled';

export interface SandboxGrantStatus {
  state: SandboxGrantState;
  provider: string | null;
  blockers: string[];
  checkedAt: string | null;
  /** Stored grants are in effect for runs on this device right now. */
  grantsApply: boolean;
}

export interface SandboxTrustGrant {
  id: string;
  projectId: string;
  projectName: string | null;
  reason: string;
  paths: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

export type SandboxGrantAuditEvent = 'created' | 'revoked' | 'used' | 'expired';

export interface SandboxGrantAuditEntry {
  id: string;
  at: string;
  event: SandboxGrantAuditEvent;
  grantId: string;
  projectId: string;
  projectName: string | null;
  actor: string | null;
  runId: string | null;
  kind: 'agent' | 'verification' | null;
  path: string | null;
}

export interface SandboxGrantsResponse {
  sandbox: SandboxGrantStatus;
  maxHours: number;
  durations: number[];
  grants: SandboxTrustGrant[];
  audit: SandboxGrantAuditEntry[];
  problem: string | null;
}

export interface CreateSandboxGrantInput {
  projectId: string;
  projectName?: string;
  reason: string;
  hours: number;
}

export const SANDBOX_GRANT_DURATIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 168, label: '7 days' },
];

export const SANDBOX_GRANT_REASON_MIN = 10;
export const SANDBOX_GRANT_REASON_MAX = 500;

export function fetchSandboxGrants(): Promise<SandboxGrantsResponse> {
  return apiFetch<SandboxGrantsResponse>('/api/sandbox/grants');
}

export async function createSandboxGrant(input: CreateSandboxGrantInput): Promise<SandboxTrustGrant> {
  const body = await apiFetch<{ grant: SandboxTrustGrant }>('/api/sandbox/grants', { method: 'POST', body: JSON.stringify(input) });
  return body.grant;
}

export async function revokeSandboxGrant(id: string): Promise<SandboxTrustGrant> {
  const body = await apiFetch<{ grant: SandboxTrustGrant }>(`/api/sandbox/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  return body.grant;
}
