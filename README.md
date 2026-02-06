# OpenLinear

OpenLinear is a Linear-like kanban board with OpenCode agent execution, built for fast task flow and real-time updates.

## Features

- 4-column kanban board: Todo, In Progress, Done, Cancelled
- Task CRUD with labels and status management
- OpenCode session execution for tasks
- Real-time updates via SSE
- Settings for workspace preferences
- Dark theme inspired by Linear

## Tech Stack

- Turborepo
- Tauri (desktop shell)
- Next.js (desktop renderer)
- Express (API sidecar)
- PostgreSQL with Prisma (Docker)
- shadcn/ui

## Quick Start

```bash
git clone <repo>
cd openlinear
pnpm install
docker compose up -d
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
pnpm db:push
pnpm build:sidecar
pnpm --filter @openlinear/desktop dev
```

- The desktop app window opens automatically.
- Renderer dev server runs at http://localhost:3000 (used by Tauri in dev mode).

## Available Scripts

- `pnpm dev` — run all apps in dev mode (includes desktop renderer)
- `pnpm build` — build all apps
- `pnpm test` — run tests across the repo
- `pnpm typecheck` — run TypeScript checks
- `pnpm lint` — run linting across the repo
- `pnpm db:push` — apply Prisma schema to the database
- `pnpm db:studio` — open Prisma Studio
- `pnpm build:sidecar` — build the API sidecar binary for the desktop app
- `pnpm build:desktop` — build the Tauri desktop app

## Architecture Overview

OpenLinear is a Turborepo monorepo with a Tauri desktop shell, a Next.js renderer, and an Express
API sidecar. The API uses Prisma to manage a PostgreSQL database. The desktop UI communicates
with the sidecar API and listens for server-sent events to update the board in real time.

```
                 ┌──────────────────────┐
                 │  Next.js Renderer   │
                 │ (apps/desktop-ui)   │
                 └──────────┬───────────┘
                            │ HTTP + SSE (sidecar)
                            ▼
                 ┌──────────────────────┐
                 │     Express API      │
                 │  (apps/api sidecar)  │
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

Example for local dev (matches docker-compose defaults):

```
DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
```
