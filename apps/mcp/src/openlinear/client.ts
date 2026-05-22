export class OpenLinearApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(`OpenLinear API ${status}: ${responseText}`);
    this.name = "OpenLinearApiError";
  }
}

export class OpenLinearClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly pat: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.pat}`,
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

  updateTask(id: string, data: unknown) {
    return this.request("PATCH", `/api/tasks/${encodeURIComponent(id)}`, data);
  }

  bulkCreateTasks(data: unknown) {
    return this.request<{ created: Array<{ id: string }>; failed: Array<{ index: number; error: string }> }>(
      "POST",
      "/api/tasks/bulk",
      data,
    );
  }

  createLabel(data: unknown) {
    return this.request<{ id: string; name: string }>("POST", "/api/labels", data);
  }

  listLabels(params: { projectId: string }) {
    const qs = new URLSearchParams({ projectId: params.projectId });
    return this.request("GET", `/api/labels?${qs.toString()}`);
  }
}
