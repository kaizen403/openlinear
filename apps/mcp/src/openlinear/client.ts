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

  listProjects(params?: { workspaceId?: string }) {
    const qs = params?.workspaceId ? `?workspaceId=${encodeURIComponent(params.workspaceId)}` : "";
    return this.request("GET", `/api/projects${qs}`);
  }

  createProject(data: unknown) {
    return this.request<{ id: string; key?: string | null; name: string }>("POST", "/api/projects", data);
  }

  getProject(id: string) {
    return this.request("GET", `/api/projects/${encodeURIComponent(id)}`);
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

  listLabels(params?: { teamId?: string }) {
    const qs = params?.teamId ? `?teamId=${encodeURIComponent(params.teamId)}` : "";
    return this.request("GET", `/api/labels${qs}`);
  }
}
