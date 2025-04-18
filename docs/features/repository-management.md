# Repository Management

## Overview

Repository management lets users connect GitHub repositories (or local folders) to OpenLinear projects. The system supports two modes: authenticated import for private repos and unauthenticated URL-based import for public repos. Only one repository can be active at a time per user; the active repo is the default target for task execution.

---

## Architecture

```
Desktop UI
    │
    ▼
apps/api/src/routes/repos.ts          ← HTTP layer
    │
    ▼
apps/api/src/services/github.ts       ← GitHub API + DB operations
    │
    ▼
packages/db/prisma/schema.prisma      ← Repository model
    │
    ▼
PostgreSQL (projects table)
```

The API layer is thin: it validates inputs, resolves the GitHub access token from multiple sources, and delegates to the `github.ts` service for all GitHub API calls and database writes.

---

## Data Model

Defined in `packages/db/prisma/schema.prisma`:

```prisma
model Repository {
  id            String    @id @default(uuid())
  githubRepoId  Int
  name          String
  fullName      String        // e.g. "owner/repo"
  cloneUrl      String
  defaultBranch String    @default("main")
  userId        String?       // null = public/anonymous repo
  user          User?     @relation(...)
  isActive      Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  projects      Project[]

  @@unique([userId, githubRepoId])
  @@map("projects")           // stored in the "projects" table
}
```

Key design decisions:
- `userId: null` marks a repository as public/anonymous (no auth required).
- The `@@unique([userId, githubRepoId])` constraint prevents duplicate imports per user.
- `isActive` is a boolean flag; only one repo per user can be active. Activation deactivates all others via `updateMany`.
- The `defaultBranch` field is user-editable and controls which branch execution clones from.

---

## API Endpoints

All routes are mounted at `/api/repos` in `apps/api/src/routes/repos.ts`.

### Public routes (no authentication)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/repos/url` | Import a public repo by GitHub URL |
| `GET` | `/api/repos/active/public` | Get the active public (anonymous) repo |
| `GET` | `/api/repos/public` | List all public repos |
| `POST` | `/api/repos/:id/activate/public` | Activate a public repo |

### Authenticated routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/repos/` | List all repos for the authenticated user |
| `GET` | `/api/repos/github` | Fetch repos from GitHub API |
| `POST` | `/api/repos/import` | Import a GitHub repo into the user's account |
| `POST` | `/api/repos/:id/activate` | Set a repo as active |
| `GET` | `/api/repos/active` | Get the user's active repo |
| `PATCH` | `/api/repos/active/base-branch` | Update the default branch of the active repo |

---

## Implementation Details

### Token resolution for `GET /api/repos/github`

The endpoint resolves a GitHub access token from three sources in priority order:

1. **`x-github-token` header** — sent directly by the desktop client.
2. **Legacy DB token** — retrieved via `getLegacyTokenForOperation(userId, 'repos.list-github')` from `apps/api/src/services/auth-migration.ts`.
3. **Desktop auth source** — calls `getDesktopGitHubAuthSource()` which tries:
   - `gh auth token` via the GitHub CLI (`spawnSync('gh', ['auth', 'token'])`)
   - `OPENLINEAR_GITHUB_TOKEN` or `GITHUB_TOKEN` environment variables

```typescript
// apps/api/src/services/github.ts
export function getDesktopGitHubAuthSource(): DesktopGitHubAuthSource | null {
  const ghToken = tryGitHubCliToken();   // tries `gh auth token`
  if (ghToken) return { accessToken: ghToken, source: 'gh' };

  const envToken = process.env.OPENLINEAR_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken?.trim()) return { accessToken: envToken.trim(), source: 'env' };

  return null;
}
```

### Public repo import via URL (`POST /api/repos/url`)

No authentication required. Flow:

1. Parse the URL with `parseGitHubUrl(url)` — supports HTTPS, SSH, and `owner/repo` shorthand.
2. Call `fetchPublicRepo(owner, repo)` which hits `https://api.github.com/repos/{owner}/{repo}`.
3. Reject private repos with a 400 error.
4. Upsert into the database: if the repo already exists (matched by `githubRepoId` with `userId: null`), reactivate it; otherwise deactivate all public repos and create a new record.

```typescript
// apps/api/src/services/github.ts
export async function addRepositoryByUrl(url: string) {
  const parsed = parseGitHubUrl(url);
  const repo = await fetchPublicRepo(parsed.owner, parsed.repo);
  if (repo.private) throw new Error('Private repositories require authentication');

  const existing = await prisma.repository.findFirst({
    where: { githubRepoId: repo.id, userId: null },
  });

  if (existing) {
    return prisma.repository.update({ where: { id: existing.id }, data: { isActive: true } });
  }

  await prisma.repository.updateMany({ where: { userId: null }, data: { isActive: false } });
  return prisma.repository.create({ data: { githubRepoId: repo.id, ... isActive: true } });
}
```

### Authenticated import (`POST /api/repos/import`)

Requires a `GitHubRepo` object in the request body (obtained from `GET /api/repos/github`). Calls `addRepository(userId, repo, isActive=true)` which does a Prisma `upsert` on the `[userId, githubRepoId]` unique key.

### Activation (`POST /api/repos/:id/activate`)

Calls `setActiveRepository(userId, projectId)`:

```typescript
export async function setActiveRepository(userId: string, projectId: string) {
  await prisma.repository.updateMany({ where: { userId }, data: { isActive: false } });
  return prisma.repository.update({ where: { id: projectId }, data: { isActive: true } });
}
```

This is a two-step operation (deactivate all, then activate one) rather than a single atomic update. There is no transaction wrapping these two calls.

### Base branch update (`PATCH /api/repos/active/base-branch`)

Validates the branch name against a strict regex before writing:

```
/^(?![/.])(?!.*\.\.)(?!.*\/\.)(?!.*\.$)(?!.*\/$)[A-Za-z0-9._/-]+$/
```

This prevents path traversal patterns and invalid git ref names.

### GitHub OAuth flows

`apps/api/src/services/github.ts` implements two OAuth flows:

- **Authorization code flow** — `getAuthorizationUrl()` + `exchangeCodeForToken()`. Used by the web callback.
- **Device flow** — `startGitHubDeviceFlow()` + `pollGitHubDeviceFlow()`. Used by the desktop app where a browser redirect isn't practical.

The device flow polls `https://github.com/login/oauth/access_token` and handles `authorization_pending` and `slow_down` responses.

---

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/repos.ts` | HTTP route handlers |
| `apps/api/src/services/github.ts` | GitHub API calls, DB operations, OAuth flows |
| `apps/api/src/services/auth-migration.ts` | Legacy token retrieval |
| `packages/db/prisma/schema.prisma` | `Repository` model definition |

---

## Local Folder Support

The `Project` model (not `Repository`) has a `localPath` field for local folder connections:

```prisma
model Project {
  localPath    String?   // Absolute path to local folder
  repositoryId String?   // OR a linked Repository
  repository   Repository?
}
```

During task execution (`apps/sidecar/src/services/execution/lifecycle.ts`), the sidecar checks `task.project.localPath` first. If set, it skips cloning entirely and creates a branch directly in the local directory. If not set, it falls back to the linked `Repository.cloneUrl`.
