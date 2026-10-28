import { apiFetch } from './fetch';
import { idempotencyHeaders } from './idempotency';

/**
 * W19b / FE-13 project knowledge (apps/api `/api/projects/:id/knowledge`,
 * `/api/knowledge/:id`): what the team wants every agent run in a project to
 * know. Entries people write are active at once; agents only propose, and a
 * person approves. Every change is a revision; retracting keeps the history.
 */

export type KnowledgeKind = 'note' | 'convention' | 'procedure';
export type KnowledgeStatus = 'proposed' | 'active' | 'retracted';

export interface KnowledgeSourceRef {
  taskId?: string;
  runId?: string;
  reviewId?: string;
  findingId?: string;
  commit?: string;
  chatSessionId?: string;
}

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  status: KnowledgeStatus;
  source: 'user' | 'agent' | 'review_finding';
  sourceRef: KnowledgeSourceRef | null;
  version: number;
  expiresAt: string | null;
  /** Past its expiry: kept, but no longer given to runs. */
  expired: boolean;
  createdById: string;
  updatedById: string;
  approvedById: string | null;
  approvedAt: string | null;
  retractedById: string | null;
  retractedAt: string | null;
  retractReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRevision {
  version: number;
  kind: string;
  title: string;
  body: string;
  status: string;
  change: 'created' | 'edited' | 'approved' | 'retracted' | 'restored';
  note: string | null;
  editedById: string;
  createdAt: string;
}

export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeKind, string> = {
  convention: 'Convention',
  procedure: 'Procedure',
  note: 'Note',
};

export async function fetchProjectKnowledge(projectId: string): Promise<KnowledgeEntry[]> {
  const data = await apiFetch<{ entries: KnowledgeEntry[] }>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`);
  return data.entries;
}

export function fetchKnowledgeEntry(entryId: string): Promise<KnowledgeEntry & { versions: KnowledgeRevision[] }> {
  return apiFetch<KnowledgeEntry & { versions: KnowledgeRevision[] }>(`/api/knowledge/${encodeURIComponent(entryId)}`);
}

export interface KnowledgeDraft {
  kind: KnowledgeKind;
  title: string;
  body: string;
  expiresAt?: string | null;
  sourceRef?: KnowledgeSourceRef;
}

/** Keyed: a retried click creates one entry. */
export function createKnowledge(projectId: string, draft: KnowledgeDraft, idempotencyKey: string): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, {
    method: 'POST',
    body: JSON.stringify(draft),
    headers: idempotencyHeaders(idempotencyKey),
  });
}

export function updateKnowledge(entryId: string, body: { baseVersion: number } & Partial<Omit<KnowledgeDraft, 'sourceRef'>>): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(entryId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function approveKnowledge(entryId: string, version: number): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(entryId)}/approve`, { method: 'POST', body: JSON.stringify({ version }) });
}

export function retractKnowledge(entryId: string, reason: string): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(entryId)}/retract`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function restoreKnowledge(entryId: string): Promise<KnowledgeEntry> {
  return apiFetch<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(entryId)}/restore`, { method: 'POST' });
}
