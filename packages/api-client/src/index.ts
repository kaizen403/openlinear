import type {
  ExecutionLogEntry,
  ExecutionPrincipal,
  ExecutionTaskAccess,
  StartedExecutionAttempt,
} from "./executions";
import { type HttpTransport, normalizeBaseUrl, type RequestOptions, sendJson, type TokenSource } from "./http";

export { OpenLinearApiError, OpenLinearNetworkError, type RequestOptions, type TokenSource } from "./http";
export * from "./executions";

export interface OpenLinearClientOptions {
  baseUrl: string;
  token: TokenSource;
  fetch?: typeof fetch;
  /** Default per-request deadline (ms). */
  timeoutMs?: number;
}

/**
 * Typed HTTP client for the cloud API, authenticated as one principal (a
 * session access token or a PAT). The sidecar builds one per request
 * principal; attempt callbacks use `ExecutionAttemptClient` instead.
 */
export class OpenLinearClient {
  private readonly transport: HttpTransport;
  private readonly token: TokenSource;

  constructor(baseUrlOrOptions: string | OpenLinearClientOptions, token?: string) {
    if (typeof baseUrlOrOptions === "string") {
      this.transport = { baseUrl: normalizeBaseUrl(baseUrlOrOptions), fetchImpl: fetch };
      this.token = token ?? "";
    } else {
      this.transport = {
        baseUrl: normalizeBaseUrl(baseUrlOrOptions.baseUrl),
        fetchImpl: baseUrlOrOptions.fetch ?? fetch,
        defaultTimeoutMs: baseUrlOrOptions.timeoutMs,
      };
      this.token = baseUrlOrOptions.token;
    }
  }

  request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return sendJson<T>(this.transport, this.token, method, path, body, options);
  }

  // --- W03a execution control (user-authenticated half) ---------------------

  getExecutionPrincipal(options?: RequestOptions) {
    return this.request<ExecutionPrincipal>("GET", "/api/executions/principal", undefined, options);
  }

  getExecutionTaskAccess(taskId: string, options?: RequestOptions) {
    return this.request<ExecutionTaskAccess>(
      "GET",
      `/api/executions/tasks/${encodeURIComponent(taskId)}/access`,
      undefined,
      options,
    );
  }

  getExecutionTaskLogs(taskId: string, options?: RequestOptions) {
    return this.request<{ logs: ExecutionLogEntry[] }>(
      "GET",
      `/api/executions/tasks/${encodeURIComponent(taskId)}/logs`,
      undefined,
      options,
    );
  }

  requestExecutionCancellation(taskId: string, options?: RequestOptions) {
    return this.request<{ attemptId: string; status: string; cancelRequestedAt: string }>(
      "POST",
      `/api/executions/tasks/${encodeURIComponent(taskId)}/cancellation`,
      {},
      options,
    );
  }

  refreshExecutionPullRequest(taskId: string, options?: RequestOptions) {
    return this.request<{ prUrl: string | null; refreshed: boolean; message?: string }>(
      "POST",
      `/api/executions/tasks/${encodeURIComponent(taskId)}/refresh-pr`,
      {},
      options,
    );
  }

  /** `allowBlocked` (W17a): start although blockers are open; otherwise 409 TASK_BLOCKED. */
  startExecutionAttempt(taskId: string, options?: RequestOptions & { allowBlocked?: boolean }) {
    const { allowBlocked, ...requestOptions } = options ?? {};
    return this.request<StartedExecutionAttempt>(
      "POST",
      "/api/executions/attempts",
      allowBlocked ? { taskId, allowBlocked: true } : { taskId },
      requestOptions,
    );
  }

  /** W17a: "blocked by" edges among these tasks (all must be viewable). */
  listDependencyEdges(taskIds: readonly string[], options?: RequestOptions) {
    const qs = new URLSearchParams({ taskIds: taskIds.join(",") });
    return this.request<{ edges: Array<{ taskId: string; dependsOnTaskId: string }> }>("GET", `/api/tasks/dependencies?${qs.toString()}`, undefined, options);
  }

  // --- Existing surface ------------------------------------------------------

  listWorkspaces() {
    return this.request("GET", "/api/workspaces");
  }

  listProjects(params?: { workspaceId?: string; teamId?: string }) {
    const qs = new URLSearchParams();
    if (params?.workspaceId) qs.set("workspaceId", params.workspaceId);
    if (params?.teamId) qs.set("teamId", params.teamId);
    const query = qs.toString();
    return this.request("GET", `/api/projects${query ? `?${query}` : ""}`);
  }

  createProject(data: unknown) {
    return this.request<{ id: string; key?: string | null; name: string }>("POST", "/api/projects", data);
  }

  getProject(id: string) {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}`);
  }

  listTeams(params?: { workspaceId?: string; projectId?: string }) {
    const qs = new URLSearchParams();
    if (params?.workspaceId) qs.set("workspaceId", params.workspaceId);
    if (params?.projectId) qs.set("projectId", params.projectId);
    const query = qs.toString();
    return this.request("GET", `/api/teams${query ? `?${query}` : ""}`);
  }

  createTeam(data: unknown) {
    return this.request<{ id: string; key: string; name: string }>("POST", "/api/teams", data);
  }

  createTask(data: unknown) {
    return this.request("POST", "/api/tasks", data);
  }

  getTask(id: string) {
    return this.request("GET", `/api/tasks/${encodeURIComponent(id)}`);
  }

  updateTask(id: string, data: unknown) {
    return this.request("PATCH", `/api/tasks/${encodeURIComponent(id)}`, data);
  }

  patchTaskExecution(id: string, data: unknown) {
    return this.request("PATCH", `/api/tasks/${encodeURIComponent(id)}/execution`, data);
  }

  getSettings() {
    return this.request("GET", "/api/settings");
  }

  getRepository(id: string) {
    return this.request("GET", `/api/repos/${encodeURIComponent(id)}`);
  }

  getActiveRepository() {
    return this.request("GET", "/api/repos/active");
  }

  getScmToken() {
    return this.request<{ token: string }>("GET", "/api/users/me/scm-token");
  }

  createAgentRun(data: {
    taskId: string;
    agent: string;
    model: string;
    runner?: string;
    externalSessionId?: string;
  }) {
    return this.request<{ id: string }>("POST", "/api/agent-runs", data);
  }

  updateAgentRun(id: string, data: unknown) {
    return this.request("PATCH", `/api/agent-runs/${encodeURIComponent(id)}`, data);
  }

  listAgentRuns(params: { taskId?: string; userId?: string }) {
    const qs = new URLSearchParams();
    if (params.taskId) qs.set("taskId", params.taskId);
    if (params.userId) qs.set("userId", params.userId);
    const query = qs.toString();
    return this.request("GET", `/api/agent-runs${query ? `?${query}` : ""}`);
  }

  progress(input: {
    runId: string;
    events: Array<{ seq: number; type: string; at?: string; payload?: unknown }>;
  }) {
    return this.request("POST", "/api/agent-runs/progress", input);
  }

  listModels() {
    return this.request("GET", "/api/models");
  }

  bulkCreateTasks(data: unknown) {
    return this.request<{ created: Array<{ id: string }>; failed: Array<{ index: number; error: string }> }>(
      "POST",
      "/api/tasks/bulk",
      data,
    );
  }

  bulkUpdateTaskStatus(data: { ids: string[]; status: string }) {
    return this.request("PATCH", "/api/tasks/bulk-status", data);
  }

  createLabel(data: unknown) {
    return this.request<{ id: string; name: string }>("POST", "/api/labels", data);
  }

  listLabels(params: { projectId: string }) {
    const qs = new URLSearchParams({ projectId: params.projectId });
    return this.request("GET", `/api/labels?${qs.toString()}`);
  }

  logMcpToolCall(toolName: string, success: boolean, error?: string) {
    return this.request<void>("POST", "/api/mcp/log", { toolName, success, error });
  }

  createSseTicket() {
    return this.request<{ ticket: string; expiresIn: number }>("POST", "/api/events/ticket");
  }
}
