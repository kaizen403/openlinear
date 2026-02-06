# OpenLinear (Desktop)

OpenLinear is a Linear‑style kanban board with OpenCode‑powered task execution, shipped as a Tauri desktop app.

## What You Get

- 4‑column kanban board (Todo / In Progress / Done / Cancelled)
- Task CRUD with labels and priorities
- Real‑time updates via SSE
- OpenCode task execution (clone → run → commit → PR)
- Desktop‑first UI

## Tech Stack

- Tauri (desktop shell)
- Next.js (desktop renderer)
- Express (API)
- PostgreSQL + Prisma (Docker)
- shadcn/ui

## Quick Start (Desktop Dev)

1) Install deps
```bash
pnpm install
```

2) Start Postgres + set DB URL
```bash
docker compose up -d
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
pnpm db:push
```

3) Start the API
```bash
pnpm --filter @openlinear/api dev
```

4) Start the desktop app
```bash
pnpm --filter @openlinear/desktop dev
```

Notes:
- The renderer dev server runs at http://localhost:3000 and is used by Tauri in dev mode.
- The API listens on http://localhost:3001.

## OpenCode Setup

OpenLinear expects an OpenCode server available at `OPENCODE_URL` (default: `http://localhost:4096`).
Install and run OpenCode, then use the “Execute” action on a task.

Set a custom URL if needed:
```
OPENCODE_URL=http://localhost:4096
```

## Scripts

- `pnpm dev` — run all apps in dev mode
- `pnpm build` — build all apps
- `pnpm test` — run tests across the repo
- `pnpm typecheck` — run TypeScript checks
- `pnpm lint` — run linting across the repo
- `pnpm db:push` — apply Prisma schema to the database
- `pnpm db:studio` — open Prisma Studio
- `pnpm build:sidecar` — build the API sidecar binary for desktop packaging
- `pnpm build:desktop` — build the Tauri desktop app

## Architecture

```
                ┌──────────────────────┐
                │  Next.js Renderer    │
                │   (apps/desktop-ui)  │
                └──────────┬───────────┘
                           │ HTTP + SSE
                           ▼
                ┌──────────────────────┐
                │     Express API      │
                │      (apps/api)      │
                └──────────┬───────────┘
                           │ Prisma
                           ▼
                ┌──────────────────────┐
                │     PostgreSQL       │
                │  (docker-compose)    │
                └──────────────────────┘
```

## Project Structure

```
openlinear/
├── apps/
│   ├── api/          # Express API
│   ├── desktop/      # Tauri shell
│   └── desktop-ui/   # Next.js renderer
├── packages/
│   ├── db/           # Prisma schema
│   └── types/        # Shared types
└── docker-compose.yml
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `OPENCODE_URL` — OpenCode server base URL
- `REPOS_DIR` — local path for cloned repos (default: `/tmp/openlinear-repos`)

## Troubleshooting

- **API won’t start (EADDRINUSE: 3001)**  
  Another process is already using port 3001. Stop it or change the API port.
- **OpenCode tasks won’t run**  
  Ensure the OpenCode server is running and reachable at `OPENCODE_URL`.
