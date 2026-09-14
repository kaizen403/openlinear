export class OpenLinearApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(`OpenLinear API ${status}: ${responseText}`);
    this.name = "OpenLinearApiError";
  }
}

export interface OpenLinearClientOptions {
  baseUrl: string;
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
}

/**
 * Typed HTTP client for the cloud API. Sidecar and MCP must go through this
 * (or a wrapper) instead of Prisma so Phase 2 can drop DATABASE_URL on the
 * sidecar.
 */
export class OpenLinearClient {
  private readonly baseUrl: string;
  private readonly token: string | (() => string | Promise<string>);
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrlOrOptions: string | OpenLinearClientOptions, token?: string) {
    if (typeof baseUrlOrOptions === "string") {
      this.baseUrl = baseUrlOrOptions.replace(/\/$/, "");
      this.token = token ?? "";
      this.fetchImpl = fetch;
    } else {
      this.baseUrl = baseUrlOrOptions.baseUrl.replace(/\/$/, "");
      this.token = baseUrlOrOptions.token;
      this.fetchImpl = baseUrlOrOptions.fetch ?? fetch;
    }
  }

  private async authHeader(): Promise<string> {
    const value = typeof this.token === "function" ? await this.token() : this.token;
    return `Bearer ${value}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: await this.authHeader(),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      throw new OpenLinearApiError(res.status, await res.text());
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

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
