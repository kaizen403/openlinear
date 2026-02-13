# Getting Started

## Prerequisites

- Node.js 18+
- pnpm
- Docker (for PostgreSQL and OpenCode worker containers)

## Installation

```bash
# Install dependencies
pnpm install

# Start the PostgreSQL database
docker compose up -d

# Set the database URL and push the Prisma schema
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
pnpm db:push
```

## Running the App

Start both the API sidecar and the desktop UI:

```bash
# Terminal 1: API server
pnpm --filter @openlinear/api dev

# Terminal 2: Desktop app
pnpm --filter @openlinear/desktop dev
```

The API runs on `http://localhost:3001` by default. The desktop UI opens a Tauri window pointing at the Next.js dev server.

## Connect a Repository

You have two options:

**Without GitHub login (public repos only):**
Click the repository connector in the sidebar and paste a GitHub URL (e.g. `https://github.com/user/repo`). KazCode fetches the repo metadata from the GitHub API and stores it locally.

**With GitHub login (private repos):**
Click "Sign in with GitHub" in the sidebar. After OAuth, you can browse and import any repo you have access to. Your GitHub token is used for cloning, pushing, and creating PRs.

## Authentication

KazCode supports two authentication methods:

**Username/password:** Register with a username (2--50 chars), password, and optional email via the login screen. This creates a local account with no GitHub access (public repos only).

**GitHub OAuth:** Click "Sign in with GitHub" on the login screen. This grants access to your private repos, push permissions, and PR creation.

After first login, a project selector screen appears where you pick or create a project to start working in.

## Create and Execute a Task

1. Click the **+** button in the Todo column to create a new task.
2. Enter a title and optional description. Set priority and labels as needed.
3. Click the **Execute** button on the task card.
4. The task moves to In Progress. KazCode clones your repo, creates a branch, starts an OpenCode agent session, and streams live progress.
5. When the agent finishes, changes are committed, pushed, and a PR is created. The task moves to Done.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | -- |
| `API_PORT` | API server port | `3001` |
| `OPENCODE_PORT` | OpenCode server port | `4096` |
| `OPENCODE_HOST` | OpenCode server host | `127.0.0.1` |
| `REPOS_DIR` | Local path for cloned repos | `/tmp/openlinear-repos` |
| `JWT_SECRET` | JWT signing secret | dev default |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID | -- |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | -- |
| `GITHUB_REDIRECT_URI` | OAuth callback URL | `http://localhost:3001/api/auth/github/callback` |
| `FRONTEND_URL` | Frontend URL for OAuth redirects | `http://localhost:3000` |
| `GITHUB_TOKEN` | Token for public repo API calls (higher rate limits) | -- |
| `CORS_ORIGIN` | Allowed CORS origin | `http://localhost:3000` |
