import { apiFetch } from './fetch';

/**
 * FE-11 / W16b: files of the task's project repository on this device that
 * look related to the task (`GET /api/tasks/:id/related-files`, sidecar) —
 * the same lexical ranking a run's prompt uses. Citations only: path, line
 * range, score and why it matched; no file content. Shapes mirror
 * `apps/sidecar/src/routes/repo-context.ts`.
 */

export interface RelatedFile {
  path: string;
  /** Null when only the path is known (no local copy of the file's content). */
  startLine: number | null;
  endLine: number | null;
  score: number;
  reasons: string[];
  /** Task words the file matched, strongest first. */
  matched: string[];
}

/**
 * - `ready`: `files` is the answer (may be empty, with `reason`);
 * - `indexing`: the repository is being indexed — ask again after `retryAfterMs`;
 * - `unavailable`: no repository for the project on this device (`reason` says why);
 * - `disabled`: turned off on this device (OPENLINEAR_REPO_CONTEXT=0).
 */
export type RelatedFilesStatus = 'ready' | 'indexing' | 'unavailable' | 'disabled';

export interface RelatedFilesResponse {
  status: RelatedFilesStatus;
  reason: string | null;
  repository: { source: 'local-folder' | 'mirror'; commit: string | null } | null;
  files: RelatedFile[];
  receipt: {
    sha: string | null;
    indexedFiles: number;
    contentFiles: number;
    cacheHit: boolean;
    reusedBlobs: number;
    ms: number;
  } | null;
  retryAfterMs?: number;
}

export function fetchRelatedFiles(taskId: string, options: { signal?: AbortSignal } = {}): Promise<RelatedFilesResponse> {
  return apiFetch<RelatedFilesResponse>(`/api/tasks/${encodeURIComponent(taskId)}/related-files`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
