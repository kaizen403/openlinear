# OpenLinear MCP — Phase 0: Overview & Decisions

## Decisions (Locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Phase representation | Labels only — `phase:N — name`, zero schema change |
| 2 | PAT management | Settings UI in PR 1 — full create/list/revoke page in desktop-ui |
| 3 | Domain | `mcp.openlinear.tech` — Cloudflare custom domain |
| 4 | Workspace defaulting | Auto-pick default workspace — mirrors `ensureDefaultWorkspaceForUser` |

---

## Architecture

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
│  Express 5 via httpServerHandler     │
│  MCP SDK NodeStreamableHTTPTransport │
│  7 registered tools                  │
└────────────┬─────────────────────────┘
             │ HTTPS + Authorization: Bearer <PAT>
             ▼
┌──────────────────────────────────────┐
│  apps/api (existing Express 5 API)   │
│  + PAT validation middleware         │
│  + POST /api/tasks/bulk              │
│  + /api/pats CRUD                    │
└────────────┬─────────────────────────┘
             ▼
        Postgres (Prisma 7.4.0)
```

## Key Principles

- MCP server = thin stateless proxy. All business logic stays in apps/api.
- Phase = Label (convention: `phase:N — Name`). Zero schema change.
- PAT format: `ol_pat_<32-char-random-hex>`. Store sha256 hash only.
- Workspace auto-defaulting when omitted.
- Cost: $0/month on Cloudflare free tier.

## Build Order

| Phase | Scope | Effort | Plan File |
|---|---|---|---|
| 1 | PAT auth system + Settings UI | ~2 days | `mcp-phase-1-pat-auth.md` |
| 2 | Bulk task creation endpoint | ~0.5 day | `mcp-phase-2-bulk-tasks.md` |
| 3 | MCP server scaffold + 6 tools + deploy | ~1.5 days | `mcp-phase-3-mcp-server.md` |
| 4 | bulk_create_plan tool + e2e | ~1 day | `mcp-phase-4-bulk-plan-tool.md` |

**Total: ~5 days**

## Client Configuration (end state)

```json
{
  "mcpServers": {
    "openlinear": {
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": { "Authorization": "Bearer ol_pat_xxxxx..." }
    }
  }
}
```
