# Development Environment Setup

Guide to setting up the OpenLinear development environment from scratch.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22+ | Runtime |
| pnpm | 9+ | Package manager |
| PostgreSQL | 15+ | Database |
| Rust | latest stable | Tauri desktop app (optional) |
| Docker | 24+ | Database via docker-compose (optional) |

## Quick Start

```bash
# Clone and install
git clone https://github.com/kaizen403/openlinear.git
cd openlinear
pnpm install

# Start database (via Docker)
docker-compose up -d

# Setup database schema
pnpm --filter @openlinear/db db:push
pnpm --filter @openlinear/db db:seed

# Start development servers
pnpm dev
```

## Monorepo Structure

OpenLinear uses pnpm workspaces with Turborepo for build orchestration.

```
openlinear/
├── apps/
│   ├── api/           Express REST API (port 3001)
│   ├── desktop/       Tauri desktop shell
│   ├── desktop-ui/    Next.js desktop webview (port 3000)
│   ├── landing/       Marketing site (port 3002)
│   └── sidecar/       Local execution engine (port 3003)
├── packages/
│   ├── db/            Prisma schema and client
│   ├── openlinear/    npm package / CLI
│   └── types/         Shared TypeScript types
├── turbo.json         Build pipeline config
└── pnpm-workspace.yaml
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/openlinear"

# Auth
JWT_SECRET="your-secret-key"
GITHUB_CLIENT_ID="your-github-oauth-app-id"
GITHUB_CLIENT_SECRET="your-github-oauth-app-secret"

# API
API_URL="http://localhost:3001"
SIDECAR_URL="http://localhost:3003"
```

## Development Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all services |
| `pnpm build` | Build all packages |
| `pnpm --filter @openlinear/api dev` | API server only |
| `pnpm --filter @openlinear/desktop-ui dev` | Desktop UI only |
| `pnpm --filter @openlinear/db db:push` | Push schema to DB |
| `pnpm --filter @openlinear/db db:studio` | Open Prisma Studio |
| `pnpm test` | Run all tests |
| `pnpm --filter @openlinear/api test` | API tests only |

## Database Management

The database schema lives in `packages/db/prisma/schema.prisma`.

```bash
# Apply schema changes
pnpm --filter @openlinear/db db:push

# Generate Prisma client after schema changes
pnpm --filter @openlinear/db db:generate

# Seed with test data
pnpm --filter @openlinear/db db:seed

# Open visual database browser
pnpm --filter @openlinear/db db:studio
```

## Testing

Tests use Vitest with Supertest for API endpoint testing.

```bash
# Run all tests
pnpm test

# Run with watch mode
pnpm --filter @openlinear/api test -- --watch

# Run specific test file
pnpm --filter @openlinear/api test -- auth.test.ts
```

Test files are located in `apps/api/src/__tests__/`.

## Desktop App Development

Building the Tauri desktop app requires Rust:

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build sidecar (required before desktop)
pnpm --filter @openlinear/sidecar build

# Run desktop app in dev mode
pnpm --filter @openlinear/desktop dev
```

## Troubleshooting

**Port conflicts**: Kill existing processes on ports 3000-3003.

**Database connection**: Ensure PostgreSQL is running and `DATABASE_URL` is correct.

**Prisma client stale**: Run `pnpm --filter @openlinear/db db:generate` after schema changes.

**Turbo cache issues**: Run `pnpm turbo clean` to clear build cache.
