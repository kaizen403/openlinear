# OpenLinear MCP Worker

Cloudflare Worker that exposes OpenLinear tools over MCP Streamable HTTP.

## Local Development

```bash
pnpm --filter @openlinear/api dev
pnpm --filter @openlinear/mcp dev
```

Create `apps/mcp/.dev.vars` for local API routing:

```bash
OPENLINEAR_API_URL=http://localhost:3001
```

Connect an MCP client to `http://localhost:8787/mcp` with:

```json
{
  "Authorization": "Bearer ol_pat_xxxxx"
}
```

## Tools

- `openlinear_list_workspaces`
- `openlinear_list_projects`
- `openlinear_create_project`
- `openlinear_get_project`
- `openlinear_create_phase`
- `openlinear_create_issue`
- `openlinear_update_issue`
- `openlinear_bulk_create_plan`
