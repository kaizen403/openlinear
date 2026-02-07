# OpenLinear

A desktop kanban board for managing and executing coding tasks through AI agents.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Desktop Application                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────┐      ┌──────────────────┐      ┌──────────────┐  │
│   │   Desktop Shell  │◄────►│   Renderer (UI)  │◄────►│  Local API   │  │
│   │                  │      │                  │      │   Sidecar    │  │
│   └──────────────────┘      └──────────────────┘      └──────┬───────┘  │
│                                                               │          │
└───────────────────────────────────────────────────────────────┼──────────┘
                                                                │
                                                                ▼
                                              ┌─────────────────────────────┐
                                              │     Coding Agent Layer      │
                                              │                             │
                                              │  ┌─────────┐  ┌─────────┐   │
                                              │  │OpenCode │  │ Codex   │   │
                                              │  └─────────┘  └─────────┘   │
                                              │  ┌─────────┐  ┌─────────┐   │
                                              │  │Claude   │  │  ...    │   │
                                              │  │ Code    │  │         │   │
                                              │  └─────────┘  └─────────┘   │
                                              └─────────────────────────────┘
```

## Parallel Task Execution

OpenLinear executes multiple coding tasks concurrently:

```
                    ┌──────────────────────────────────┐
                    │        Execution Manager         │
                    │                                  │
                    │  ┌─────────────────────────────┐ │
                    │  │     Active Execution Pool   │ │
                    │  │                             │ │
                    │  │  Task A ──► Agent Session   │ │
                    │  │  Task B ──► Agent Session   │ │
                    │  │  Task C ──► Agent Session   │ │
                    │  │                             │ │
                    │  │     (Configurable Limit)    │ │
                    │  └─────────────────────────────┘ │
                    └──────────────────────────────────┘
```

- Tasks run in isolated sessions with independent repo clones
- Parallel limit is user-configurable via settings
- Each execution tracks its own lifecycle: clone → execute → commit → PR
- Real-time progress via event streaming

## Agent Integration

Currently integrated with the OpenCode SDK:

```
Execute Task
     │
     ▼
Clone Repository ──► Create Branch ──► Start Agent Session
                                              │
                                              ▼
                                    Agent works on codebase
                                    (reads, edits, runs tools)
                                              │
                                              ▼
                                    Commit Changes ──► Create PR
```

The agent layer is designed to support multiple providers:

| Agent | Status |
|-------|--------|
| OpenCode | Integrated |
| Claude Code | Planned |
| Codex | Planned |
| Aider | Planned |

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
