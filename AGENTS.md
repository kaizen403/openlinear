# OpenLinear — Agent Context

> **Every agent, every session**: Read this file first. Then read `ISSUES.md` to see active work and known problems. Before you close a session, append what you did to `ISSUES.md`.

---

## What Is OpenLinear

AI-powered project management that writes code. Users manage tasks on a kanban board; the AI executes them, clones repos, creates branches, writes code, and opens PRs — all in one click.

**Production URL:** `https://openlinear.tech`

---

## Monorepo Layout

```
/home/kaizen/openlinear          ← repo root
├── apps/
│   ├── api/                     ← Express 5.2.1 REST API, port 3001
│   ├── desktop-ui/              ← Next.js 16 web/desktop UI, port 3000
│   ├── desktop/                 ← Tauri v2 (Rust shell wrapping desktop-ui)
│   ├── sidecar/                 ← Express 5.2.1 AI execution engine, port 3003 (env: `API_PORT`)
│   ├── mcp/                     ← Cloudflare Worker MCP server
│   ├── mcp-docs/                ← Next.js documentation site for MCP tools
│   ├── landing/                 ← Next.js 16 marketing site, port 3002
│   └── intro-video/             ← Intro video generation app
├── packages/
│   ├── db/                      ← Prisma 7.4.0 + Postgres schema
│   ├── execution-core/          ← Shared execution logic (batch, state, types)
│   ├── types/                   ← Shared TypeScript types
│   ├── openlinear/              ← Shared utilities and helpers
│   └── openlinear-cli/          ← CLI package
├── scripts/deploy.sh            ← VPS deploy script (PM2 + git pull)
├── .github/workflows/deploy.yml ← CI: typecheck → build → test → SSH deploy
├── .sisyphus/plans/             ← Detailed implementation plans per feature
└── ISSUES.md                    ← ← ← WORK LOG — agents write here
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| API | Express 5.2.1, TypeScript, Zod validation, Vitest |
| Database | PostgreSQL via Prisma 7.4.0 (Neon in prod) |
| Web UI | Next.js 16, Tailwind CSS, shadcn/ui, Framer Motion |
| Desktop | Tauri v2 (Rust), webview pointing at desktop-ui |
| MCP Server | Cloudflare Worker + Express + `@modelcontextprotocol/node` |
| Package manager | pnpm 9 (workspaces) |
| Build | Turborepo |

---

## Key Commands

```bash
# Dev
pnpm --filter @openlinear/api dev          # API on :3001
pnpm --filter @openlinear/desktop-ui dev   # UI on :3000
pnpm --filter @openlinear/sidecar dev      # Sidecar on :3003
pnpm dev-live                              # Alias for pnpm dev:live — starts API + UI + sidecar
pnpm start                                 # Production preview with static export

# Type check (run before marking any work done)
pnpm --filter @openlinear/api typecheck
pnpm --filter @openlinear/desktop-ui typecheck
pnpm --filter @openlinear/mcp typecheck

# Test
pnpm --filter @openlinear/api test

# DB
pnpm --filter @openlinear/db db:generate   # regenerate Prisma client
pnpm --filter @openlinear/db db:migrate:deploy  # apply migrations in prod
pnpm --filter @openlinear/db db:push       # sync schema in dev (no migration)

# MCP deploy
cd apps/mcp && wrangler deploy
```

---

## Auth System

Two auth methods co-exist in `apps/api/src/middleware/auth.ts`:

1. **GitHub OAuth + JWT** (primary, for humans)
   - Login: `GET /api/auth/github` → GitHub OAuth → JWT (7-day, signed with `JWT_SECRET`)
   - Header: `Authorization: Bearer <jwt>`
   - JWT payload: `{ userId, username }`

2. **Personal Access Token / PAT** (for MCP + API clients)
   - Format: `ol_pat_<32-char-lowercase-hex>` (e.g. `ol_pat_25897b3edab3886a9601658071a9dac5`)
   - Stored: SHA-256 hash only (`PersonalAccessToken.tokenHash`), never plaintext
   - Middleware detects `ol_pat_` prefix → hash-lookup → validates not revoked/expired
   - Create/manage via Settings → Personal Access Tokens in the UI, or `POST /api/pats`

---

## Core Data Models (`packages/db/prisma/schema.prisma`)

| Model | Table | Notes |
|---|---|---|
| `Task` | `tasks` | The "issue". Has `parentId` for subtasks, `projectId`/`teamId`, `status`, `priority`, `batchId` |
| `Project` | `linear_projects` | Requires exactly 1 `teamId`. Has `workspaceId`, `key` (e.g. "KT"), `status` |
| `Workspace` | `workspaces` | Top-level tenant. Auto-created for new users |
| `Team` | `teams` | Atomic issue numbering per team (`nextIssueNumber`) |
| `Label` | `labels` | m:m with Task via `TaskLabel`. Phase convention: `phase:N — Name` |
| `PersonalAccessToken` | `personal_access_tokens` | `tokenHash`, `tokenPrefix`, `scopes[]`, `lastUsedAt`, `expiresAt`, `revokedAt` |
| `Comment` | `comments` | Threaded comments on tasks |
| `AgentRun` | `agent_runs` | Execution history per task |
| `Notification` | `notifications` | Inbox events |
| `ChatSession` | `chat_sessions` | Home Chat sessions with project scope |
| `ChatMessage` | `chat_messages` | Messages within a chat session (user/assistant/tool) |
| `ChatToolCall` | `chat_tool_calls` | Persisted tool calls from assistant turns |

**No Phase/Sprint/Milestone model exists.** Phases are represented as Labels with the naming convention `phase:N — Name`.

---

## API Routes (`apps/api/src/routes/`)

All routes under `/api/` prefix. Auth required unless noted.

| Prefix | File | Key endpoints |
|---|---|---|
| `/api/auth` | `auth.ts` | GitHub OAuth, JWT refresh, logout |
| `/api/tasks` | `tasks.ts` | CRUD + `POST /api/tasks/bulk` (max 100, atomic) |
| `/api/projects` | `projects.ts` | CRUD + access management |
| `/api/teams` | `teams.ts` | CRUD + member management |
| `/api/workspaces` | `workspaces.ts` | CRUD + member management |
| `/api/labels` | `labels.ts` | CRUD |
| `/api/pats` | `pats.ts` | PAT create/list/revoke |
| `/api/chat` | `chat.ts` | Home Chat session CRUD + SSE message streaming |
| `/api/brainstorm` | (sidecar) | AI task generation, streams NDJSON |
| `/api/events` | (app.ts:222) | SSE real-time stream (`?token=<jwt>`) |
| `/api/inbox` | `inbox.ts` | Done/cancelled task feed |

---

## MCP Server (`apps/mcp/`)

**Live at:** `https://mcp.openlinear.tech`

Stateless Cloudflare Worker. Creates a fresh `NodeStreamableHTTPServerTransport` per POST request.

**8 registered tools:**
| Tool | Purpose |
|---|---|
| `openlinear_list_workspaces` | List all workspaces for authenticated user |
| `openlinear_list_projects` | List projects in a workspace |
| `openlinear_create_project` | Create a new project |
| `openlinear_get_project` | Get project details + tasks |
| `openlinear_create_phase` | Create a phase Label (`phase:N — Name`) |
| `openlinear_create_issue` | Create a single task/issue |
| `openlinear_update_issue` | Update task status, priority, etc. |
| `openlinear_bulk_create_plan` | 🚀 Create project + phases + tasks in one call |

**Client config:**
```json
{
  "mcpServers": {
    "openlinear": {
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": { "Authorization": "Bearer ol_pat_xxxxx" }
    }
  }
}
```

Key files:
- `apps/mcp/wrangler.toml` — CF Worker config, `OPENLINEAR_API_URL=https://openlinear.tech`
- `apps/mcp/src/mcp/transport.ts` — stateless transport setup
- `apps/mcp/src/mcp/tools/plan.ts` — `bulk_create_plan` implementation
- `apps/mcp/src/openlinear/client.ts` — typed HTTP client for apps/api

---

## Deployment State

| Service | URL | Status |
|---|---|---|
| MCP Worker | `https://mcp.openlinear.tech` | ✅ Live (Cloudflare Worker) |
| API + Web UI | `https://openlinear.tech` | ✅ Done |
| Database | Neon (Postgres, `ap-southeast-1`) | ✅ Live |
| Docs | `https://mintlify.com` (kaizen403/docs) | ✅ Pushed |

**CF Worker account:** `rishivhavle21@gmail.com`, account `37fe66534312238914af0ff34d128ac3`

**Production Neon DB:**
```
ep-muddy-butterfly-a1ano1t9-pooler.ap-southeast-1.aws.neon.tech/neondb
```

**When API is deployed to Azure:**
1. Update `OPENLINEAR_API_URL` in `apps/mcp/wrangler.toml` if the URL differs from `https://openlinear.tech`
2. Run `cd apps/mcp && wrangler deploy`
3. Update GitHub Actions workflow for Azure deployment (current workflow uses SSH + PM2 which is VPS-style)

**API deployment notes:**
- Production API runs on Azure Container Apps (`api.openlinear.tech`)
- MCP Worker redeployed pointing to `api.openlinear.tech`
- Current `.github/workflows/deploy.yml` uses SSH + PM2 (VPS-style) for the droplet

---

## Code Conventions

- **TypeScript strict** throughout — never use `as any`, `@ts-ignore`, `@ts-expect-error`
- **Zod schemas** for all request validation in `apps/api/src/schemas/`
- **Vitest** for tests in `apps/api/src/__tests__/` — run before marking work done
- **Prisma transactions** for multi-row writes — see `POST /api/tasks/bulk` as example
- **SSE events** for real-time — event types in `apps/api/src/app.ts:222-314`
- **Error format:** `{ error: string, code: string, details?: object }` — never raw stack traces

---

## Agent Protocol (MANDATORY)

### At the start of every session:
1. Read `ISSUES.md` — know what's in progress, what's broken, what's planned
2. Check `.sisyphus/plans/` if working on a feature that has a plan file

### While working:
3. Run `pnpm --filter @openlinear/<app> typecheck` after any file edits
4. Run tests if you changed API logic: `pnpm --filter @openlinear/api test`
5. Never commit unless user explicitly asks

### When committing and pushing:
6. Read `ISSUES.md` and reference relevant issue entries in commit messages
7. If your work resolves or progresses an issue logged in `ISSUES.md`, mention it in the commit body (e.g. "Resolves: [2026-05-21] — Refine Codex provider presentation")
8. Use ISSUES.md entries as context to write meaningful commit messages that tie back to tracked work

### Before closing a session:
9. Append a log entry to `ISSUES.md` using this format:

```markdown
## [YYYY-MM-DD] — Brief description of work done

**Status:** Done / In Progress / Blocked
**Agent:** Claude / OpenCode / Codex / etc.

### What was done
- ...

### Files changed
- `path/to/file.ts` — what changed

### Issues encountered
- ...

### Next steps / blockers
- ...
```

---
