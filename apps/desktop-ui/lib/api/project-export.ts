import { apiFetchRaw } from './fetch';
import { downloadJson, fileNameFromDisposition } from '../download';

/** FE-16: download `GET /api/projects/:id/export` as a JSON file. */
export async function downloadProjectExport(projectId: string): Promise<{ fileName: string; taskCount: number; truncated: boolean }> {
  const response = await apiFetchRaw(`/api/projects/${encodeURIComponent(projectId)}/export`);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new Error(body?.error ?? `Export failed (HTTP ${response.status})`);
  }
  const data = await response.json() as { taskCount?: number; truncated?: boolean };
  const fileName = fileNameFromDisposition(response.headers.get('content-disposition'), `openlinear-project-${projectId.slice(0, 8)}.json`);
  if (!downloadJson(fileName, data)) throw new Error('This environment cannot save files');
  return { fileName, taskCount: typeof data.taskCount === 'number' ? data.taskCount : 0, truncated: data.truncated === true };
}
