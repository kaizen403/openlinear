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
- Next.js (frontend)
- Express (API)
- PostgreSQL with Prisma
- shadcn/ui

## Quick Start

```bash
git clone <repo>
cd openlinear
pnpm install
docker compose up -d
pnpm db:push
pnpm dev
```

- Frontend: http://localhost:3000
- API: http://localhost:3001

## Available Scripts

- `pnpm dev` — run all apps in dev mode
- `pnpm build` — build all apps
- `pnpm test` — run tests across the repo
- `pnpm typecheck` — run TypeScript checks
- `pnpm lint` — run linting across the repo
- `pnpm db:push` — apply Prisma schema to the database
- `pnpm db:studio` — open Prisma Studio

## Architecture Overview

OpenLinear is a Turborepo monorepo with a Next.js UI and Express API. The API uses Prisma to
manage a PostgreSQL database. The web app consumes API endpoints and listens for server-sent
events to update the board in real time.

```
                 ┌──────────────────────┐
                 │   Next.js Web App    │
                 │  (apps/web, UI/SSE)  │
                 └──────────┬───────────┘
                            │ HTTP + SSE
                            ▼
                 ┌──────────────────────┐
                 │     Express API      │
                 │     (apps/api)       │
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
│   └── web/          # Next.js frontend
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
