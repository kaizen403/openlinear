<div align="center">

# OpenLinear

**AI-powered project management that actually writes the code.**

Drag tasks on a kanban board. Click execute. Get a pull request.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9-orange)](https://pnpm.io)
[![Deploy](https://img.shields.io/badge/production-openlinear.tech-purple)](https://openlinear.tech)

</div>

---

<p align="center">
<img src="docs/diagrams/architecture.svg" alt="OpenLinear Architecture" width="100%"/>
</p>

## What is OpenLinear?

OpenLinear is a desktop app (and web app) that combines a Linear-style kanban board with AI coding agents. You manage tasks visually, and when you're ready, the AI clones your repo, creates a branch, writes the code, and opens a pull request — all in one click.

The OpenCode AI agent runs directly on your machine as a bundled Tauri sidecar. No containers, no isolation overhead — just the agent working with your local copy of the code.

## Features

- **Kanban Board** — drag-and-drop task management with priorities, labels, and status tracking
- **One-Click Execution** — select a task, hit execute, get a PR with real code changes
- **Batch Execution** — run multiple tasks in parallel or queue mode, merged into a single PR
- **Real-Time Streaming** — watch the AI work live via SSE (tool calls, file edits, progress)
- **GitHub Integration** — OAuth login, repo management, automatic PR creation
- **Brainstorm Mode** — describe a goal in natural language, get actionable tasks generated
- **Teams & Projects** — organize work with teams, projects, and scoped issue numbering
- **Desktop + Web** — runs as a Tauri desktop app or a standard web app

## Agent Support

| Agent | Status |
|-------|--------|
| [OpenCode](https://opencode.ai) | Integrated |
| Claude Code | Planned |
| Codex | Planned |
| Aider | Planned |

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- A GitHub OAuth app (for login and repo access)

### Setup

```bash
# Clone and install
git clone https://github.com/openlinear/openlinear.git
cd openlinear
pnpm install

# Start PostgreSQL
docker compose up -d

# Configure environment
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear

# Push database schema
pnpm db:push

# Start the API
pnpm --filter @openlinear/api dev

# Start the desktop app (in another terminal)
pnpm --filter @openlinear/desktop dev
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing auth tokens (REQUIRED in production) |
| `TOKEN_ENCRYPTION_KEY` | Secret used to AES-256-GCM encrypt stored GitHub access tokens at rest (REQUIRED in production, ≥16 chars). Run `pnpm --filter @openlinear/db db:encrypt-tokens` once after deploy to backfill existing rows. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GITHUB_REDIRECT_URI` | OAuth callback URL (e.g. `http://localhost:3001/api/auth/github/callback` for dev, `https://openlinear.tech/api/auth/github/callback` for prod). The same URL handles both web and desktop logins; desktop callbacks are auto-detected by the `?client=desktop` state and redirected to the `openlinear://` deep link. |
| `REPOS_DIR` | Host path for cloned repos (default: `<tmp>/openlinear-repos`) |
| `API_PORT` | API server port (default: `3001`; ignored in the bundled desktop app, which picks a free ephemeral port) |
| `CORS_ORIGIN` | Comma-separated allowed origins (default: `http://localhost:3000`). Tauri origins (`tauri://localhost`, `https://tauri.localhost`) are always added implicitly. |
| `OAUTH_INTERCEPTOR_PORT` | Sidecar OAuth interceptor port for OpenCode AI provider OAuth (default: `1455`) |
| `NEXT_PUBLIC_CLOUD_API_URL` | Cloud API base URL baked into the desktop UI build (default: `https://openlinear.tech`) |

## How It Works

1. **You create tasks** on the kanban board with descriptions of what you want built
2. **You click execute** — the API clones your repo and creates a branch
3. **The agent writes code** with OpenCode running directly on your machine in its own worktree
4. **You watch it work** — real-time SSE streams every tool call, file edit, and decision
5. **You get a PR** — changes are committed, pushed, and a pull request is created automatically

For batch execution, multiple tasks run in parallel (or queued), each in isolated worktrees, merged into a single PR.

> For the full architecture deep dive, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project Structure

```
openlinear/
  apps/
    desktop-ui/     Next.js frontend (Tauri webview)
    api/            Express API sidecar
  packages/
    db/             Prisma schema + client
  docs/
    features/       Feature documentation (18 guides)
    diagrams/       Architecture SVGs
    ARCHITECTURE.md Full system design
```

## Distribution

| Format | Platform | Install |
|--------|----------|---------|
| .dmg | macOS (Apple Silicon) | [GitHub Releases](https://github.com/openlinear/openlinear/releases) |
| AppImage | Linux | [GitHub Releases](https://github.com/openlinear/openlinear/releases) |
| .deb | Debian/Ubuntu | [GitHub Releases](https://github.com/openlinear/openlinear/releases) |
| AUR | Arch Linux | `yay -S openlinear-bin` |
| npm CLI | Any | `npm install @openlinear/openlinear-cli` |

> **macOS note**: The app currently ships ad-hoc signed (`signingIdentity: "-"`). On first launch macOS will warn that "Apple cannot verify" the app — right-click → Open, or run `xattr -cr /Applications/OpenLinear.app` to bypass Gatekeeper. To produce a properly signed/notarized build, add a Developer ID certificate and set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` in the release workflow and replace `signingIdentity: "-"` in `apps/desktop/src-tauri/tauri.conf.json` with your identity name.

Release builds are triggered automatically on tag push (`v*`).

## Documentation

- [Getting Started](docs/features/getting-started.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/features/api-reference.md)
- [Task Execution](docs/features/task-execution.md)
- [Batch Execution](docs/features/batch-execution.md)
- [OpenCode Integration](docs/features/opencode-integration.md)
- [All Features](docs/features/README.md)

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
# Development
pnpm dev          # Start everything
pnpm lint         # Lint
pnpm typecheck    # Type check
pnpm test         # Run tests
```

## License

[MIT](LICENSE)
