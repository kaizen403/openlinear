# OpenLinear MCP Server — Full Build Plan

## Decisions (Locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Phase representation | Labels only — `phase:N — name`, zero schema change |
| 2 | PAT management | Settings UI in PR 1 — full create/list/revoke page in desktop-ui |
| 3 | Domain | `mcp.openlinear.tech` — Cloudflare custom domain |
| 4 | Workspace defaulting | Auto-pick default workspace — mirrors `ensureDefaultWorkspaceForUser` |

---

## Architecture Overview

```
┌──────────────────────────┐
│  AI Client (OpenCode)    │
│  "openlinear: plan X"    │
└────────────┬─────────────┘
             │ Streamable HTTP + Bearer PAT
             ▼
┌──────────────────────────────────────┐
│  mcp.openlinear.tech                 │
│  Cloudflare Worker (free tier)       │
│  ┌────────────────────────────────┐  │
│  │ httpServerHandler (bridge)     │  │
│  │  └─ Express 5                  │  │
│  │     ├─ POST /mcp              │  │
│  │     ├─ GET  /mcp   (SSE)     │  │
│  │     └─ DELETE /mcp            │  │
│  │     NodeStreamableHTTPTransport│  │
│  │  Tools: 7 registered tools    │  │
│  └────────────────────────────────┘  │
└────────────┬─────────────────────────┘
             │ HTTPS + Authorization: Bearer <PAT>
             ▼
┌──────────────────────────────────────┐
│  apps/api (existing Express 5 API)   │
│  + NEW: PAT validation middleware    │
│  + NEW: POST /api/tasks/bulk         │
│  + NEW: /api/pats CRUD              │
└────────────┬─────────────────────────┘
             ▼
        Postgres (Prisma 7.4.0)
```

Key principles:
- MCP server is a **thin stateless proxy**. All business logic stays in apps/api.
- If MCP server dies, OpenLinear keeps working.
- Adding tools = adding a function, no DB migration.
- Phase = Label (convention: `phase:N — Name`). Zero schema change. Upgradeable later.

---

## Phase Representation

OpenLinear has NO Phase/Milestone/Cycle/Sprint/Epic model. Only:
- Task.parentId (self-referential hierarchy)
- Labels (m:m with Tasks via TaskLabel junction)

**Mapping:** A "phase" = a Label with naming convention `phase:1 — Foundation`.
- Dashboard filters by label to show phase grouping.
- Colors passed by AI or auto-cycled from a palette.
- Future: can add a real Phase model without breaking anything.

---

## PR 1: PAT Auth System + Settings UI (~2 days)

### 1.1 Prisma Schema Addition

**File:** `packages/db/prisma/schema.prisma`

```prisma
model PersonalAccessToken {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String    // user-given label, e.g. "OpenCode MCP"
  tokenHash   String    @unique // sha256 of the actual token
  tokenPrefix String    // first 8 chars for display: "ol_pat_a1b2..."
  scopes      String[]  // e.g. ["projects:write", "tasks:write"]
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
  revokedAt   DateTime?

  @@index([userId])
  @@index([tokenHash])
  @@map("personal_access_tokens")
}
```

Add to User model:
```prisma
personalAccessTokens PersonalAccessToken[]
```

Token format: `ol_pat_<32-char-random-hex>` (total 40 chars with prefix).

### 1.2 PAT Auth Middleware

**File:** `apps/api/src/middleware/auth.ts`

Extend existing `requireAuth` (lines 47-64):
```typescript
// Before JWT check, add:
// 1. Extract token from Authorization: Bearer <token>
// 2. If token starts with "ol_pat_" →
//    a. Hash with sha256
//    b. Look up PersonalAccessToken by tokenHash
//    c. Verify: not revoked (revokedAt is null), not expired (expiresAt > now OR null)
//    d. Check scopes if endpoint requires specific scope
//    e. Set req.userId = pat.userId, req.authSource = 'pat'
//    f. Fire-and-forget: update lastUsedAt
// 3. Else: fall through to existing JWT logic
```

### 1.3 PAT CRUD Endpoints

**File:** `apps/api/src/routes/pats.ts` (new)

| Method | Path | Description |
|---|---|---|
| POST | `/api/pats` | Create PAT. Returns full token ONCE. Stores sha256 hash only. |
| GET | `/api/pats` | List user's PATs (prefix, name, scopes, lastUsedAt, createdAt). Never returns full token. |
| DELETE | `/api/pats/:id` | Revoke (sets revokedAt = now). Does NOT hard delete. |

Zod schema for create:
```typescript
z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(), // default: all scopes
  expiresAt: z.string().datetime().optional(), // default: never
})
```

Response on create:
```json
{
  "id": "uuid",
  "name": "OpenCode MCP",
  "token": "ol_pat_a1b2c3d4e5f6...", // SHOWN ONCE
  "prefix": "ol_pat_a1",
  "scopes": ["*"],
  "expiresAt": null,
  "createdAt": "2026-05-21T..."
}
```

### 1.4 Settings UI — Personal Access Tokens Page

**File:** `apps/desktop-ui/src/app/settings/tokens/page.tsx` (new)

Features:
- **Create flow:** Name input + optional expiry picker → POST /api/pats → modal with one-time token reveal + copy button + "You won't see this again" warning.
- **List view:** Table showing name, prefix (`ol_pat_a1b2...`), scopes, last used (relative time), created date.
- **Revoke:** Confirmation dialog → DELETE /api/pats/:id → row shows "Revoked" badge.

Follows existing desktop-ui patterns (Next.js 16, likely using shadcn components from the existing setup).

### 1.5 Mount Route

**File:** `apps/api/src/app.ts` (around line 181-195 where routes are mounted)

```typescript
app.use('/api/pats', requireAuth, patsRouter);
```

### 1.6 Migration

```bash
cd packages/db && npx prisma migrate dev --name add-personal-access-tokens
```

---

## PR 2: Bulk Task Creation Endpoint (~0.5 day)

### 2.1 Endpoint

**File:** `apps/api/src/routes/tasks.ts`

```
POST /api/tasks/bulk
Authorization: Bearer <JWT or PAT>
Content-Type: application/json
```

Zod schema:
```typescript
z.object({
  projectId: z.string().uuid(),
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).default('todo'),
    labelIds: z.array(z.string().uuid()).optional(),
    parentId: z.string().uuid().optional(),
    dueDate: z.string().datetime().optional(),
  })).min(1).max(100),
})
```

### 2.2 Implementation Logic

```typescript
// 1. Validate projectId exists and user has access (assertProjectAccess)
// 2. Resolve teamId from project (project must have at least one team via ProjectTeam)
// 3. prisma.$transaction():
//    - For each task in array:
//      - Assign teamId from project
//      - Generate next identifier (team.key-number)
//      - Create task
//    - Return all created tasks
// 4. Emit SSE event: { type: 'tasks:bulk-created', projectId, count, taskIds }
// 5. Return: { created: Task[], failed: { index, error }[] }
```

### 2.3 Identifier Generation

Existing pattern (from tasks.ts POST handler around line 280-300):
- Get team's `nextIssueNumber`
- Increment atomically in transaction
- Format as `TEAM_KEY-NUMBER` (e.g. `ENG-42`)

For bulk: increment by N in one atomic update, then assign sequentially.

### 2.4 Tests

Integration tests covering:
- Happy path: 5 tasks created, all returned with identifiers
- Exceeds cap: 101 tasks → 400 error
- Invalid projectId → 404
- Mixed valid/invalid labelIds → partial success with failed array
- Auth: PAT with insufficient scopes → 403

---

## PR 3: MCP Server Scaffold + Simple Tools (~1.5 days)

### 3.1 Repo Structure

New repo or new directory (TBD — likely `apps/mcp` in the monorepo OR separate repo):

```
openlinear-mcp/
├── src/
│   ├── index.ts              # Worker entry: httpServerHandler bridge
│   ├── app.ts                # Express app factory
│   ├── mcp/
│   │   ├── server.ts         # McpServer instance + all tool registrations
│   │   ├── transport.ts      # NodeStreamableHTTPServerTransport + route mounting
│   │   └── tools/
│   │       ├── workspaces.ts # openlinear_list_workspaces
│   │       ├── projects.ts   # openlinear_list_projects, create_project, get_project
│   │       ├── issues.ts     # openlinear_create_issue, openlinear_update_issue
│   │       └── phases.ts     # openlinear_create_phase
│   ├── openlinear/
│   │   └── client.ts         # Typed HTTP client wrapping api.openlinear.tech
│   ├── auth.ts               # Extract PAT from Authorization header
│   └── env.ts                # Cloudflare env bindings type
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .dev.vars                 # OPENLINEAR_API_URL=http://localhost:3001 (gitignored)
└── README.md
```

### 3.2 Worker Entry — `src/index.ts`

```typescript
import { httpServerHandler } from "cloudflare:node";
import { createApp } from "./app.js";

const app = createApp();
app.listen(3000);

export default httpServerHandler({ port: 3000 });
```

### 3.3 Express App — `src/app.ts`

```typescript
import express from "express";
import { mountMcpRoutes } from "./mcp/transport.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Health check
  app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // MCP Streamable HTTP endpoint
  mountMcpRoutes(app);

  return app;
}
```

### 3.4 MCP Transport — `src/mcp/transport.ts`

```typescript
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import type { Express, Request, Response } from "express";
import { createMcpServer } from "./server.js";
import { extractPat } from "../auth.js";

// In-memory session store (Worker is short-lived, sessions are per-request-chain)
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

export function mountMcpRoutes(app: Express) {
  // POST /mcp — main JSON-RPC handler
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

  // GET /mcp — SSE stream (server → client notifications)
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete("/mcp", (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) sessions.delete(sessionId);
    res.status(204).end();
  });
}
```

### 3.5 MCP Server + Tool Registration — `src/mcp/server.ts`

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

### 3.6 OpenLinear API Client — `src/openlinear/client.ts`

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

  // Workspaces
  listWorkspaces() { return this.request("GET", "/api/workspaces"); }

  // Projects
  listProjects(params?: { workspaceId?: string }) {
    const qs = params?.workspaceId ? `?workspaceId=${params.workspaceId}` : "";
    return this.request("GET", `/api/projects${qs}`);
  }
  createProject(data: CreateProjectInput) { return this.request("POST", "/api/projects", data); }
  getProject(id: string) { return this.request("GET", `/api/projects/${id}`); }

  // Tasks
  createTask(data: CreateTaskInput) { return this.request("POST", "/api/tasks", data); }
  updateTask(id: string, data: UpdateTaskInput) { return this.request("PATCH", `/api/tasks/${id}`, data); }
  bulkCreateTasks(data: BulkCreateInput) { return this.request("POST", "/api/tasks/bulk", data); }

  // Labels
  createLabel(data: CreateLabelInput) { return this.request("POST", "/api/labels", data); }
  listLabels(params?: { teamId?: string }) {
    const qs = params?.teamId ? `?teamId=${params.teamId}` : "";
    return this.request("GET", `/api/labels${qs}`);
  }
}
```

### 3.7 Tool Definitions

#### `openlinear_list_workspaces`
```typescript
server.registerTool("openlinear_list_workspaces", {
  description: "List all workspaces the authenticated user belongs to.",
  inputSchema: z.object({}),
}, async () => {
  const workspaces = await client.listWorkspaces();
  return { content: [{ type: "text", text: JSON.stringify(workspaces, null, 2) }] };
});
```

#### `openlinear_list_projects`
```typescript
server.registerTool("openlinear_list_projects", {
  description: "List projects in a workspace.",
  inputSchema: z.object({
    workspaceId: z.string().uuid().optional().describe("Filter by workspace. Omit for default workspace."),
  }),
}, async ({ workspaceId }) => {
  const projects = await client.listProjects({ workspaceId });
  return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
});
```

#### `openlinear_create_project`
```typescript
server.registerTool("openlinear_create_project", {
  description: "Create a new project. Omit workspaceId to use default workspace.",
  inputSchema: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    key: z.string().regex(/^[A-Z0-9]{2,12}$/).optional().describe("Auto-generated if omitted."),
    workspaceId: z.string().uuid().optional(),
    teamIds: z.array(z.string().uuid()).max(1).optional(),
    status: z.enum(["planned", "in_progress", "paused", "completed", "cancelled"]).optional(),
  }),
}, async (input) => {
  const project = await client.createProject(input);
  return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
});
```

#### `openlinear_get_project`
```typescript
server.registerTool("openlinear_get_project", {
  description: "Get project details including its tasks.",
  inputSchema: z.object({
    projectId: z.string().uuid(),
  }),
}, async ({ projectId }) => {
  const project = await client.getProject(projectId);
  return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
});
```

#### `openlinear_create_phase`
```typescript
server.registerTool("openlinear_create_phase", {
  description: "Create a phase label (e.g. 'phase:1 — Foundation'). Phases are represented as labels in OpenLinear.",
  inputSchema: z.object({
    teamId: z.string().uuid(),
    phaseNumber: z.number().int().min(1),
    name: z.string().min(1).max(100),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }),
}, async ({ teamId, phaseNumber, name, color }) => {
  const label = await client.createLabel({
    teamId,
    name: `phase:${phaseNumber} — ${name}`,
    color: color || DEFAULT_PHASE_COLORS[phaseNumber % DEFAULT_PHASE_COLORS.length],
  });
  return { content: [{ type: "text", text: JSON.stringify(label, null, 2) }] };
});
```

#### `openlinear_create_issue`
```typescript
server.registerTool("openlinear_create_issue", {
  description: "Create a single task/issue in a project.",
  inputSchema: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    status: z.enum(["todo", "in_progress", "done", "cancelled"]).default("todo"),
    projectId: z.string().uuid(),
    labelIds: z.array(z.string().uuid()).optional(),
    parentId: z.string().uuid().optional(),
    dueDate: z.string().datetime().optional(),
  }),
}, async (input) => {
  const task = await client.createTask(input);
  return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
});
```

#### `openlinear_update_issue`
```typescript
server.registerTool("openlinear_update_issue", {
  description: "Update an existing task/issue.",
  inputSchema: z.object({
    taskId: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
    labelIds: z.array(z.string().uuid()).optional(),
    dueDate: z.string().datetime().nullable().optional(),
  }),
}, async ({ taskId, ...updates }) => {
  const task = await client.updateTask(taskId, updates);
  return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
});
```

### 3.8 Auth Helper — `src/auth.ts`

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

### 3.9 `wrangler.toml`

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

### 3.10 `package.json`

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

### 3.11 Deployment Steps

```bash
# 1. Ensure openlinear.tech zone is in Cloudflare
# 2. Login
wrangler login

# 3. Deploy
wrangler deploy
# First deploy provisions mcp.openlinear.tech custom domain + TLS

# 4. Verify
curl https://mcp.openlinear.tech/healthz
# → {"ok":true,"ts":1716307200000}

# 5. Smoke test with MCP Inspector
npx @modelcontextprotocol/inspector
# Connect to https://mcp.openlinear.tech/mcp with Bearer token
```

---

## PR 4: bulk_create_plan Tool (~1 day)

### 4.1 The Magic Tool — `src/mcp/tools/plan.ts`

```typescript
server.registerTool("openlinear_bulk_create_plan", {
  description: `Create an entire project plan in one call. Creates a project, phase labels, and all tasks organized by phase. This is the primary tool for turning an AI-generated execution plan into OpenLinear issues.`,
  inputSchema: z.object({
    workspaceId: z.string().uuid().optional().describe("Omit to use default workspace."),
    teamId: z.string().uuid().describe("Team to assign all tasks to."),
    project: z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).optional(),
      key: z.string().regex(/^[A-Z0-9]{2,12}$/).optional().describe("Auto-generated if omitted."),
    }),
    phases: z.array(z.object({
      name: z.string().min(1).max(100).describe("Phase name, e.g. 'Foundation'"),
      description: z.string().max(500).optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      tasks: z.array(z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(10000).optional(),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
      })).min(1).max(50),
    })).min(1).max(10),
  }),
}, async ({ workspaceId, teamId, project, phases }) => {
  // Step 1: Create project
  const createdProject = await client.createProject({
    ...project,
    workspaceId, // undefined = API auto-defaults
    teamIds: [teamId],
    status: "planned",
  });

  // Step 2: Create phase labels
  const phaseResults = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const label = await client.createLabel({
      teamId,
      name: `phase:${i + 1} — ${phase.name}`,
      color: phase.color || DEFAULT_PHASE_COLORS[i % DEFAULT_PHASE_COLORS.length],
    });

    // Step 3: Bulk create tasks for this phase
    const bulkResult = await client.bulkCreateTasks({
      projectId: createdProject.id,
      tasks: phase.tasks.map(t => ({
        ...t,
        status: "todo",
        labelIds: [label.id],
      })),
    });

    phaseResults.push({
      name: phase.name,
      labelId: label.id,
      labelName: label.name,
      taskCount: bulkResult.created.length,
      taskIds: bulkResult.created.map((t: any) => t.id),
    });
  }

  // Step 4: Return summary
  const result = {
    projectId: createdProject.id,
    projectKey: createdProject.key,
    projectName: createdProject.name,
    totalTasks: phaseResults.reduce((sum, p) => sum + p.taskCount, 0),
    phases: phaseResults,
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2),
    }],
  };
});
```

### 4.2 Default Phase Colors

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

## Client Configuration

Users paste this into their OpenCode/Claude config:

```json
{
  "mcpServers": {
    "openlinear": {
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": {
        "Authorization": "Bearer ol_pat_xxxxx..."
      }
    }
  }
}
```

---

## End-to-End Usage Example

User in OpenCode:
> "use openlinear to plan the execution workflow for project 'Auth Revamp' with phases: Foundation (setup OAuth providers, add session table), Implementation (login flow, signup flow, password reset), Polish (rate limiting, audit logs, docs)"

AI calls `openlinear_bulk_create_plan`:
```json
{
  "teamId": "uuid-of-eng-team",
  "project": { "name": "Auth Revamp", "description": "Complete authentication system overhaul" },
  "phases": [
    {
      "name": "Foundation",
      "tasks": [
        { "title": "Setup OAuth providers (Google, GitHub)", "priority": "high" },
        { "title": "Add session table to database schema", "priority": "high" }
      ]
    },
    {
      "name": "Implementation",
      "tasks": [
        { "title": "Implement login flow with OAuth", "priority": "high" },
        { "title": "Implement signup flow", "priority": "high" },
        { "title": "Implement password reset flow", "priority": "medium" }
      ]
    },
    {
      "name": "Polish",
      "tasks": [
        { "title": "Add rate limiting to auth endpoints", "priority": "medium" },
        { "title": "Add audit logs for auth events", "priority": "low" },
        { "title": "Write authentication documentation", "priority": "low" }
      ]
    }
  ]
}
```

Result: Project + 3 phase labels + 8 tasks appear in OpenLinear dashboard within ~3 seconds.

---

## Local Development

```bash
# Terminal 1: OpenLinear API
cd apps/api && pnpm dev  # runs on localhost:3001

# Terminal 2: MCP Server
cd openlinear-mcp
echo 'OPENLINEAR_API_URL=http://localhost:3001' > .dev.vars
wrangler dev  # runs on localhost:8787

# Terminal 3: Test with MCP Inspector
npx @modelcontextprotocol/inspector
# URL: http://localhost:8787/mcp
# Header: Authorization: Bearer ol_pat_<your-local-token>
```

---

## Cost

- Cloudflare Workers free tier: 100,000 requests/day, 10ms CPU per invocation
- Custom domain: free (zone must be on Cloudflare)
- TLS: free (auto-provisioned)
- Total: **$0/month** for normal usage

---

## Future (v2+)

- OAuth 2.1 + PKCE for Claude Desktop / ChatGPT plugin installability
- Real Phase model in Prisma (if Labels prove too limited)
- Read tools: search tasks, get task details, list team members
- Execution tools: trigger task execution via sidecar
- Webhook subscriptions: notify AI when tasks complete
- Rate limiting on the Worker (using Cloudflare Rate Limiting rules)
