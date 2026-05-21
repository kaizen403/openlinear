# MCP Integration

OpenLinear exposes an MCP server from `apps/mcp`. The server runs as a stateless
Cloudflare Worker, accepts Streamable HTTP requests at `/mcp`, and forwards each
tool call to the OpenLinear API with the caller's personal access token (PAT).

Use the MCP server when an agent needs to read workspace or project context,
create project structure, or turn a multi-phase implementation plan into
OpenLinear issues.

## Connection

Run the API and worker locally:

```bash
pnpm --filter @openlinear/api dev
pnpm --filter @openlinear/mcp dev
```

Set the API target for the local worker in `apps/mcp/.dev.vars`:

```bash
OPENLINEAR_API_URL=http://localhost:3001
```

Connect an MCP client to `http://localhost:8787/mcp` during local development.
For a deployed worker, use its deployment URL with the same `/mcp` path.

The worker implements stateless Streamable HTTP:

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/mcp` | Handles MCP requests |
| `GET` | `/mcp` | Returns 405 because SSE sessions are not supported |
| `DELETE` | `/mcp` | Returns 204 |

## Authentication

Create a PAT from Settings > API Keys before connecting a client. OpenLinear
shows the token once, stores only its hash, and lists token metadata after
creation.

Send the token on every MCP request:

```json
{
  "Authorization": "Bearer ol_pat_0123456789abcdef0123456789abcdef"
}
```

The worker only accepts PATs in the `ol_pat_<32 lowercase hex characters>`
format. The API rejects revoked or expired PATs when the worker forwards a tool
call. The token UI creates wildcard `*` tokens today; wildcard tokens satisfy
scoped API checks such as the `tasks:write` requirement on bulk task creation.

## Tools

| Tool | Purpose |
|------|---------|
| `openlinear_list_workspaces` | List workspaces visible to the authenticated user |
| `openlinear_list_projects` | List accessible projects, optionally within a workspace |
| `openlinear_create_project` | Create a project in a workspace and optionally attach one team |
| `openlinear_get_project` | Read one project by ID |
| `openlinear_create_phase` | Create a team label that follows the phase naming convention |
| `openlinear_create_issue` | Create one issue in a project |
| `openlinear_update_issue` | Update issue fields such as title, status, labels, or due date |
| `openlinear_bulk_create_plan` | Create a project, phase labels, and phase tasks from one plan payload |

## Bulk Plan Flow

`openlinear_bulk_create_plan` is the preferred tool for a plan with several
phases. It:

1. Creates a project with status `planned`.
2. Creates one phase label per phase when `teamId` is provided.
3. Calls the bulk task API once per phase to create tasks in the new project.
4. Returns the project ID, project key, created task IDs, and per-phase failures.

Pass `teamId` for the complete project, phase, and task workflow. The bulk task
API needs a project linked to a team, and phase labels are team labels. Without a
team-backed project, the tool can create project metadata while later phase task
creation reports errors.

Bulk creation can be partially successful. Inspect the tool result for phase
`failed` entries and phase `error` fields before treating the plan as complete.

## Related API Surfaces

The MCP worker depends on these cloud API capabilities:

- PAT management at `/api/pats`
- Project and workspace reads plus project creation
- Label creation for phase labels
- Single-task create/update endpoints
- `POST /api/tasks/bulk` for plan expansion

See [API Reference](api-reference.md) for the PAT and bulk task contracts.
