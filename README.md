# KazCode

A desktop kanban board for managing and executing coding tasks through AI agents.

## Architecture

<p align="center">
  <img src="docs/diagrams/architecture.svg" alt="KazCode Architecture" width="100%"/>
</p>

## Task Execution

KazCode supports two execution modes for running coding tasks: **parallel** and **queue**. Both modes use git worktrees to isolate each task in its own branch and working directory, and merge results into a single batched PR.

### Parallel Execution

Run multiple tasks simultaneously, up to a configurable concurrency limit. When a slot frees up, the next queued task starts automatically.

<p align="center">
  <img src="docs/diagrams/parallel-execution.svg" alt="Parallel Execution" width="100%"/>
</p>

- Tasks run in isolated git worktrees with independent agent sessions
- Concurrency limit is configurable via settings (default: 3)
- When a task finishes, the next queued task fills the open slot
- All completed branches merge into a single batch branch
- Merge conflicts are handled gracefully — conflicting tasks are skipped, the rest are included

### Queue Execution

Run tasks one at a time, sequentially. Optionally require user approval before starting the next task.

<p align="center">
  <img src="docs/diagrams/queue-execution.svg" alt="Queue Execution" width="100%"/>
</p>

- Tasks execute strictly in order, one after another
- **Auto-approve** mode starts the next task immediately on completion
- **Manual approval** mode waits for user confirmation before proceeding
- Individual tasks can be cancelled without stopping the whole queue
- Same merge + PR flow as parallel mode

### Execution Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Parallel Limit | Max concurrent tasks in parallel mode | `3` |
| Max Batch Size | Max tasks per batch | `3` |
| Auto-Approve | Auto-start next task in queue mode | `off` |
| Stop on Failure | Halt queue/batch if a task fails | `off` |
| Conflict Behavior | `skip` conflicting merges or `fail` the batch | `skip` |

## Agent Integration

Each task follows a complete lifecycle: clone → branch → agent session → commit → PR.

<p align="center">
  <img src="docs/diagrams/agent-integration.svg" alt="Agent Integration Flow" width="100%"/>
</p>

The execution engine streams real-time events (SSE) to the UI — you see every tool call, file edit, and status change as it happens.

Each user gets a dedicated Docker container running OpenCode for isolated task execution. The agent layer is designed to support multiple providers:

| Agent | Status |
|-------|--------|
| OpenCode | Integrated |
| Claude Code | Planned |
| Codex | Planned |
| Aider | Planned |

## Authentication

KazCode supports two authentication methods:

- **Email/password** — register with name, email, and password
- **GitHub OAuth** — sign in with GitHub for repo access and PR creation

## Quick Start

```bash
# Install dependencies
pnpm install

# Start database
docker compose up -d

# Set database URL and push schema
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
pnpm db:push

# Start the API sidecar
pnpm --filter @openlinear/api dev

# Start the desktop app
pnpm --filter @openlinear/desktop dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | - |
| `OPENCODE_URL` | OpenCode server URL | `http://localhost:4096` |
| `REPOS_DIR` | Local path for cloned repos | `/tmp/openlinear-repos` |

## Distribution

### GitHub Releases (binary assets)

This repo includes a release workflow that builds Linux AppImage + .deb bundles and a Linux sidecar binary on tag push (`v*`).

```
git tag v0.1.0
git push origin v0.1.0
```

Artifacts are uploaded to the GitHub release:

- `openlinear-<version>-x86_64.AppImage`
- `openlinear-<version>-x86_64.deb`
- `openlinear-api-<version>-x86_64`

### AUR (yay/pacman)

The AUR package lives in `packaging/aur/openlinear-bin`. It installs the AppImage and a desktop entry.

Release steps:

1. Update `pkgver` and `source` URLs in `PKGBUILD`.
2. Regenerate `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`.
3. Push to the AUR repo (no keys are stored in this repo).

### GitHub Packages (npm)

`packages/openlinear-cli` publishes to GitHub Packages. It downloads the AppImage on install and runs it via the `openlinear` CLI.

Local publish (kept in your user config, not the repo):

```
npm config set @kaizen403:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken $GITHUB_TOKEN
pnpm --filter @openlinear/openlinear-cli publish --access public
```

For forks, set `OPENLINEAR_RELEASE_BASE_URL` to point to your GitHub releases when installing the CLI:

```
OPENLINEAR_RELEASE_BASE_URL=https://github.com/kaizen403/openlinear/releases/download/v0.1.0
```
