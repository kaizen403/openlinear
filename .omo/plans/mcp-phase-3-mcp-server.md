# OpenLinear MCP — Phase 3: MCP Server Scaffold + Simple Tools + Deploy

**Effort:** ~1.5 days  
**Depends on:** Phase 1 (PAT auth working on apps/api)  
**Blocks:** Phase 4 (bulk_create_plan needs this scaffold)

---

## 3.1 Repo Structure

New directory: `apps/mcp` (within the monorepo)

```
apps/mcp/
├── src/
│   ├── index.ts              # Worker entry: httpServerHandler bridge
│   ├── app.ts                # Express app factory
│   ├── mcp/
│   │   ├── server.ts         # McpServer instance + tool registration
│   │   ├── transport.ts      # NodeStreamableHTTPServerTransport + Express route mounting
│   │   └── tools/
│   │       ├── workspaces.ts # openlinear_list_workspaces
│   │       ├── projects.ts   # openlinear_list_projects, create_project, get_project
│   │       ├── issues.ts     # openlinear_create_issue, openlinear_update_issue
│   │       └── phases.ts     # openlinear_create_phase
│   ├── openlinear/
│   │   └── client.ts         # Typed HTTP client wrapping apps/api
│   ├── auth.ts               # Extract PAT from Authorization header
│   └── env.ts                # Cloudflare env bindings type
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .dev.vars                 # OPENLINEAR_API_URL=http://localhost:3001 (gitignored)
└── README.md
```

---

## 3.2 Worker Entry — `src/index.ts`

```typescript
import { httpServerHandler } from "cloudflare:node";
import { createApp } from "./app.js";

const app = createApp();
app.listen(3000);

export default httpServerHandler({ port: 3000 });
```

---

## 3.3 Express App — `src/app.ts`

```typescript
import express from "express";
import { mountMcpRoutes } from "./mcp/transport.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  mountMcpRoutes(app);

  return app;
}
```

---

## 3.4 MCP Transport — `src/mcp/transport.ts`

```typescript
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import type { Express, Request, Response } from "express";
import { createMcpServer } from "./server.js";
import { extractPat } from "../auth.js";

const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

export function mountMcpRoutes(app: Express) {
  app.post("/mcp", async (req: Request, res: Response) => {
    const pat = extractPat(req);
    if (!pat) {
      res.status(401).json({ error: "Missing or invalid Bearer token" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ error: "No active session. Send initialize first." });
        return;
      }
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      const server = createMcpServer({
        pat,
        apiUrl: process.env.OPENLINEAR_API_URL || "https://api.openlinear.tech",
      });
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) sessions.delete(sessionId);
    res.status(204).end();
  });
}
```

---

## 3.5 MCP Server — `src/mcp/server.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPhaseTools } from "./tools/phases.js";
import { OpenLinearClient } from "../openlinear/client.js";

interface McpServerOptions {
  pat: string;
  apiUrl: string;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({
    name: "openlinear",
    version: "1.0.0",
  });

  const client = new OpenLinearClient(opts.apiUrl, opts.pat);

  registerWorkspaceTools(server, client);
  registerProjectTools(server, client);
  registerIssueTools(server, client);
  registerPhaseTools(server, client);

  return server;
}
```

---

## 3.6 OpenLinear API Client — `src/openlinear/client.ts`

```typescript
export class OpenLinearClient {
  constructor(private baseUrl: string, private pat: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.pat}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const error = await res.text();
      throw new Error(`OpenLinear API ${res.status}: ${error}`);
    }
    return res.json() as T;
  }

  listWorkspaces() { return this.request("GET", "/api/workspaces"); }

  listProjects(params?: { workspaceId?: string }) {
    const qs = params?.workspaceId ? `?workspaceId=${params.workspaceId}` : "";
    return this.request("GET", `/api/projects${qs}`);
  }
  createProject(data: any) { return this.request("POST", "/api/projects", data); }
  getProject(id: string) { return this.request("GET", `/api/projects/${id}`); }

  createTask(data: any) { return this.request("POST", "/api/tasks", data); }
  updateTask(id: string, data: any) { return this.request("PATCH", `/api/tasks/${id}`, data); }
  bulkCreateTasks(data: any) { return this.request("POST", "/api/tasks/bulk", data); }

  createLabel(data: any) { return this.request("POST", "/api/labels", data); }
  listLabels(params?: { teamId?: string }) {
    const qs = params?.teamId ? `?teamId=${params.teamId}` : "";
    return this.request("GET", `/api/labels${qs}`);
  }
}
```

---

## 3.7 Tool Definitions (6 tools)

### `openlinear_list_workspaces`
- Input: `{}`
- Action: `GET /api/workspaces`
- Returns: array of workspaces

### `openlinear_list_projects`
- Input: `{ workspaceId?: uuid }`
- Action: `GET /api/projects?workspaceId=...`
- Returns: array of projects

### `openlinear_create_project`
- Input: `{ name, description?, key?, workspaceId?, teamIds?, status? }`
- Action: `POST /api/projects`
- Note: workspaceId omitted → API auto-defaults to user's default workspace
- Returns: created project

### `openlinear_get_project`
- Input: `{ projectId: uuid }`
- Action: `GET /api/projects/:id`
- Returns: project with tasks

### `openlinear_create_phase`
- Input: `{ teamId: uuid, phaseNumber: int, name: string, color?: hex }`
- Action: `POST /api/labels` with name = `phase:${phaseNumber} — ${name}`
- Returns: created label

### `openlinear_create_issue`
- Input: `{ title, description?, priority?, status?, projectId, labelIds?, parentId?, dueDate? }`
- Action: `POST /api/tasks`
- Returns: created task

### `openlinear_update_issue`
- Input: `{ taskId, title?, description?, priority?, status?, labelIds?, dueDate? }`
- Action: `PATCH /api/tasks/:id`
- Returns: updated task

---

## 3.8 Auth Helper — `src/auth.ts`

```typescript
import type { Request } from "express";

export function extractPat(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!token || token.length < 10) return null;
  return token;
}
```

---

## 3.9 `wrangler.toml`

```toml
name = "openlinear-mcp"
main = "src/index.ts"
compatibility_date = "2026-05-21"
compatibility_flags = ["nodejs_compat", "enable_nodejs_http_server_modules"]
workers_dev = true

[[routes]]
pattern = "mcp.openlinear.tech"
custom_domain = true

[vars]
OPENLINEAR_API_URL = "https://api.openlinear.tech"
```

---

## 3.10 `package.json`

```json
{
  "name": "openlinear-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/node": "^2.0.0-alpha.2",
    "@modelcontextprotocol/server": "^2.0.0-alpha.2",
    "@modelcontextprotocol/express": "^2.0.0-alpha.2",
    "express": "^5.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.39.0"
  }
}
```

**IMPORTANT:** Pin Wrangler >= 4.39.0 (earlier versions have Express `req.body` bug on Workers).

---

## 3.11 Default Phase Colors

```typescript
const DEFAULT_PHASE_COLORS = [
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#F97316", // orange
  "#6366F1", // indigo
  "#14B8A6", // teal
  "#E11D48", // rose
];
```

---

## 3.12 Deployment Steps

```bash
# 1. Ensure openlinear.tech zone is in Cloudflare
# 2. Login
wrangler login

# 3. Deploy
wrangler deploy
# First deploy provisions mcp.openlinear.tech custom domain + TLS

# 4. Verify health
curl https://mcp.openlinear.tech/healthz
# → {"ok":true,"ts":1716307200000}

# 5. Smoke test with MCP Inspector
npx @modelcontextprotocol/inspector
# Connect to https://mcp.openlinear.tech/mcp
# Header: Authorization: Bearer ol_pat_<token>
# Call openlinear_list_workspaces → should return workspace data
```

---

## 3.13 Local Development

```bash
# Terminal 1: OpenLinear API
cd apps/api && pnpm dev  # localhost:3001

# Terminal 2: MCP Server
cd apps/mcp
echo 'OPENLINEAR_API_URL=http://localhost:3001' > .dev.vars
wrangler dev  # localhost:8787

# Terminal 3: Test
npx @modelcontextprotocol/inspector
# URL: http://localhost:8787/mcp
# Header: Authorization: Bearer ol_pat_<your-local-token>
```

---

## Acceptance Criteria

- [ ] Worker deploys to `mcp.openlinear.tech` successfully
- [ ] `/healthz` returns 200
- [ ] MCP initialize handshake works (POST /mcp with initialize request)
- [ ] All 6 tools listed in MCP tool discovery
- [ ] `openlinear_list_workspaces` returns real data via PAT
- [ ] `openlinear_create_project` creates a project (workspace auto-defaulted)
- [ ] `openlinear_create_phase` creates a label with `phase:N —` prefix
- [ ] `openlinear_create_issue` creates a task in a project
- [ ] `openlinear_update_issue` updates a task
- [ ] Invalid/expired PAT returns 401
- [ ] MCP Inspector can connect and invoke tools end-to-end
