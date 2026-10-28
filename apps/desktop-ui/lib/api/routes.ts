/**
 * Which backend owns an API path.
 *
 * - `cloud`: the OpenLinear API (`apps/api`) — identity, workspaces, teams,
 *   projects, tasks, comments, chat, notifications, search, settings, PATs,
 *   repositories, usage, the domain event stream, ...
 * - `sidecar`: the local execution server (`apps/sidecar`, spawned by the
 *   desktop app or started by the dev scripts) — it mounts only the routes in
 *   `SIDECAR_ROUTES` (see `createSidecarApp` in apps/sidecar/src/app.ts).
 *
 * This table is the only place that decides routing: `apiFetch` consults it
 * for every relative path, and `routes.test.mjs` proves each `lib/api`
 * function lands on the backend that serves it. Add a row here — not a flag
 * at a call site — when the sidecar gains a route.
 *
 * The sidecar's local `/api/events` stream is not listed: event streams are
 * opened per backend by `providers/sse-provider.tsx`, never through apiFetch.
 */

export type ApiTarget = 'cloud' | 'sidecar';

export interface SidecarRoute {
  /** The route as the sidecar declares it (documentation and test labels). */
  readonly route: string;
  readonly pattern: RegExp;
}

const TASK_ID = '[^/?#]+';

export const SIDECAR_ROUTES: readonly SidecarRoute[] = [
  { route: 'POST /api/tasks/:id/execute', pattern: new RegExp(`^/api/tasks/${TASK_ID}/execute$`) },
  { route: 'POST /api/tasks/:id/cancel', pattern: new RegExp(`^/api/tasks/${TASK_ID}/cancel$`) },
  { route: 'GET /api/tasks/:id/logs', pattern: new RegExp(`^/api/tasks/${TASK_ID}/logs$`) },
  { route: 'GET /api/tasks/:id/running', pattern: new RegExp(`^/api/tasks/${TASK_ID}/running$`) },
  { route: 'POST /api/tasks/:id/refresh-pr', pattern: new RegExp(`^/api/tasks/${TASK_ID}/refresh-pr$`) },
  // Review loop (apps/sidecar/src/routes/task-diff.ts, the follow-up route and
  // the v2 run state in routes/execution.ts).
  { route: 'GET /api/tasks/:id/diff', pattern: new RegExp(`^/api/tasks/${TASK_ID}/diff$`) },
  { route: 'POST /api/tasks/:id/follow-up', pattern: new RegExp(`^/api/tasks/${TASK_ID}/follow-up$`) },
  { route: 'POST /api/tasks/:id/redirect', pattern: new RegExp(`^/api/tasks/${TASK_ID}/redirect$`) },
  { route: 'GET /api/tasks/:id/run', pattern: new RegExp(`^/api/tasks/${TASK_ID}/run$`) },
  // FE-11 / W16b: related files from the local repository (apps/sidecar/src/routes/repo-context.ts).
  { route: 'GET /api/tasks/:id/related-files', pattern: new RegExp(`^/api/tasks/${TASK_ID}/related-files$`) },
  { route: '/api/batches/**', pattern: /^\/api\/batches(?:\/|$)/ },
  { route: '/api/opencode/**', pattern: /^\/api\/opencode(?:\/|$)/ },
  { route: 'POST /api/transcribe', pattern: /^\/api\/transcribe$/ },
  // Settings → Agents: the runner catalogue (FE-02) and project trust grants (FE-03).
  { route: 'GET /api/runners', pattern: /^\/api\/runners$/ },
  { route: '/api/sandbox/grants/**', pattern: /^\/api\/sandbox\/grants(?:\/|$)/ },
  // FE-04: permission requests waiting for the user (apps/sidecar/src/routes/approvals.ts).
  { route: 'GET /api/approvals', pattern: /^\/api\/approvals$/ },
  { route: 'GET|POST /api/tasks/:id/approvals[/:approvalId]', pattern: new RegExp(`^/api/tasks/${TASK_ID}/approvals(?:/${TASK_ID})?$`) },
  // W19a: agent reviews of a finished run (apps/sidecar/src/routes/reviews.ts).
  { route: 'GET|POST /api/tasks/:id/reviews[/:reviewId/cancel]', pattern: new RegExp(`^/api/tasks/${TASK_ID}/reviews(?:/${TASK_ID}/cancel)?$`) },
];

/** Strip the query string and fragment so `?projectId=...` never affects routing. */
export function routePath(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/** The backend that serves `path` (a path beginning with `/api/...`). */
export function resolveApiTarget(path: string): ApiTarget {
  const pathname = routePath(path);
  return SIDECAR_ROUTES.some(({ pattern }) => pattern.test(pathname)) ? 'sidecar' : 'cloud';
}
