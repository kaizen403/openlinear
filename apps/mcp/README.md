# OpenLinear MCP Worker

Cloudflare Worker that exposes OpenLinear to MCP clients (Claude Code, Codex,
Cursor, Claude Desktop via `mcp-remote`, …) over Streamable HTTP at
`https://mcp.openlinear.tech/mcp`.

- SDK: `@modelcontextprotocol/server` 2.4.0 (v2, the stable line). One stateless
  handler (`createMcpHandler`) serves the 2026-07-28 revision per request and
  2025-era clients (initialize handshake, 2024-10-07 … 2025-11-25) through the
  SDK's stateless legacy leg. No sessions: `GET`/`DELETE /mcp` answer 405.
- Auth: `Authorization: Bearer ol_pat_…` on every POST. The worker verifies the
  token with `GET /api/users/me` (cached per isolate for 60 s, evicted on any
  API 401) and answers 401/403 with an RFC 6750 challenge pointing at the
  RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`. A
  `403 INSUFFICIENT_SCOPE` there means a valid token with only W02b family
  scopes (`tasks:*`, `projects:*`, `labels:write`): it is accepted without a
  known owner, and the API scope-checks every tool call.
- Lists use the API's server-side filters and keyset cursors
  (`GET /api/tasks?pagination=cursor&view=compact`); tools never scan pages
  client-side.
- The worker never touches the database: every tool calls the OpenLinear REST
  API with the caller's token (`src/openlinear/`).
- Writes that create issues, plans, projects and teams send a deterministic
  `Idempotency-Key` derived from the tool arguments (`src/mcp/idempotency.ts`),
  so retried calls never duplicate data (the API keeps the records 24 h).

## Layout

```
src/index.ts            Workers entry (env → config, ctx.waitUntil)
src/worker.ts           routing, Origin/CORS, auth gate, MCP handler, PRM, /healthz
src/auth.ts             PAT format check, verification cache, 401/403 challenges
src/openlinear/         HTTP client (timeouts, safe retries, errors) and endpoint wrappers
src/mcp/server.ts       tool list and server instructions
src/mcp/tools/*.ts      the 19 tools
src/mcp/errors.ts       API error → actionable tool error
test/                   vitest suite against a fake OpenLinear API on 127.0.0.1
```

## Development

```bash
pnpm --filter @openlinear/api dev        # API on :3001
pnpm --filter @openlinear/mcp dev        # worker on :8787 (wrangler dev, local workerd)
```

`apps/mcp/.dev.vars` (git-ignored):

```bash
OPENLINEAR_API_URL=http://localhost:3001
```

Optional variables: `MCP_ALLOWED_ORIGINS` (browser Origin hostnames allowed to
call `/mcp`), `MCP_AUTHORIZATION_SERVERS` (OAuth issuers to advertise once one
exists), `MCP_DOCS_URL`.

## Checks

```bash
pnpm --filter @openlinear/mcp typecheck
pnpm --filter @openlinear/mcp test       # no network, no database
pnpm --filter @openlinear/mcp lint
npx wrangler deploy --dry-run --outdir /tmp/mcp-bundle   # bundle only, from apps/mcp
```

The docs site renders its tool reference from
`apps/mcp-docs/lib/tool-catalog.json`; `test/catalog.test.ts` fails when it
drifts. Regenerate with `UPDATE_TOOL_CATALOG=1 pnpm --filter @openlinear/mcp test`.

## Tools

Read: `openlinear_list_workspaces`, `openlinear_list_projects`,
`openlinear_get_project`, `openlinear_list_teams`, `openlinear_list_labels`,
`openlinear_search`, `openlinear_list_issues`, `openlinear_get_issue`.

Write: `openlinear_create_project`, `openlinear_create_team`,
`openlinear_create_label`, `openlinear_create_phase`, `openlinear_create_issue`,
`openlinear_update_issue`, `openlinear_assign_issue`, `openlinear_label_issue`,
`openlinear_bulk_update_status`, `openlinear_add_comment`,
`openlinear_bulk_create_plan`.
