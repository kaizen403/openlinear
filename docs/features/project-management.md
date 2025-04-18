# Project Management

Projects group tasks and optionally link to a code repository or local folder. Each project belongs to at most one team (enforced at the application layer). The project's repository connection is what enables AI task execution: the sidecar checks `repositoryId`, `repoUrl`, or `localPath` to determine whether execution is possible.

## Data Model

The `Project` model in `packages/db/prisma/schema.prisma`:

```prisma
model Project {
  id           String        @id @default(uuid())
  name         String
  description  String?
  status       ProjectStatus @default(planned)
  color        String        @default("#6366f1")
  icon         String?
  startDate    DateTime?
  targetDate   DateTime?
  leadId       String?
  lead         User?         @relation("projectLead", fields: [leadId], references: [id], onDelete: SetNull)
  repositoryId String?
  repository   Repository?   @relation(fields: [repositoryId], references: [id], onDelete: SetNull)
  localPath    String?       // Absolute path to local folder (desktop only)
  repoUrl      String?       // Original URL used to connect (for display)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  projectTeams ProjectTeam[]
  tasks        Task[]
}
```

**ProjectStatus enum**: `planned | in_progress | paused | completed | cancelled`

The `ProjectTeam` join table links projects to teams:

```prisma
model ProjectTeam {
  projectId String
  teamId    String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  team      Team    @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@id([projectId, teamId])
}
```

The `Repository` model stores GitHub repository metadata:

```prisma
model Repository {
  id            String    @id @default(uuid())
  githubRepoId  Int
  name          String
  fullName      String
  cloneUrl      String
  defaultBranch String    @default("main")
  userId        String?
  user          User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  isActive      Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  projects      Project[]

  @@unique([userId, githubRepoId])
}
```

Note: the `Repository` table is mapped to `"projects"` in the database (a legacy naming artifact). The `@@unique([userId, githubRepoId])` constraint means a user can only link a given GitHub repo once, but the same repo can be linked without a user (`userId: null`) for anonymous/public use.

## API Endpoints

All project routes are mounted at `/api/projects` in `apps/api/src/app.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/projects` | Optional | List projects |
| `POST` | `/api/projects` | Yes | Create a project |
| `GET` | `/api/projects/:id` | No | Get a single project |
| `PATCH` | `/api/projects/:id` | Yes | Update a project |
| `DELETE` | `/api/projects/:id` | Yes | Delete a project |

The route file is `apps/api/src/routes/projects.ts`.

### Query Parameters for `GET /api/projects`

- `teamId` — return only projects associated with this team

Without `teamId`, authenticated requests return all projects belonging to any team the user is a member of. Unauthenticated requests with no filter return an empty array to prevent data leaking across accounts.

## Creating a Project

`POST /api/projects` validates with Zod:

```typescript
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  status: z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().optional(),
  startDate: z.string().datetime().optional(),
  targetDate: z.string().datetime().optional(),
  leadId: z.string().uuid().optional(),
  teamIds: z.array(z.string().uuid()).min(1).max(1).optional(),
  repoUrl: z.string().optional(),
  localPath: z.string().optional(),
});
```

`teamIds` is an array but capped at one element. The schema enforces the single-team constraint at the API boundary.

**Repository connection**: If `repoUrl` is provided, the handler calls `addRepositoryByUrl(repoUrl)` from `apps/api/src/services/github.ts`. This function:

1. Parses the URL with `parseGitHubUrl`, which handles HTTPS URLs, SSH URLs, and bare `owner/repo` strings.
2. Fetches the repository metadata from `https://api.github.com/repos/{owner}/{repo}`. Uses `GITHUB_TOKEN` if set for higher rate limits (5000/hr vs 60/hr unauthenticated).
3. Rejects private repositories with a 400 error.
4. Upserts the `Repository` record. If a record with the same `githubRepoId` and `userId: null` already exists, it sets `isActive: true` on it. Otherwise it deactivates all other user-less repositories and creates a new active one.

**Local path**: The `localPath` field (an absolute filesystem path) can only be set from the desktop app. The handler checks for the `x-openlinear-client: desktop` header and returns 403 if it's absent.

**Team association**: If `teamIds` is provided, `ProjectTeam` records are created in the same `prisma.project.create` call using a nested `create`:

```typescript
projectTeams: {
  create: teamIds.map((teamId) => ({ teamId })),
}
```

After creation, `broadcast('project:created', result)` fires.

## Updating a Project

`PATCH /api/projects/:id` runs inside a Prisma transaction when `teamIds` is provided:

```typescript
const project = await prisma.$transaction(async (tx) => {
  if (teamIds !== undefined) {
    await tx.projectTeam.deleteMany({ where: { projectId: id } });
    if (teamIds.length > 0) {
      await tx.projectTeam.createMany({
        data: teamIds.map((teamId) => ({ projectId: id, teamId })),
      });
    }
  }
  return tx.project.update({ where: { id }, data: { ... }, include: projectInclude });
});
```

Team associations are fully replaced (delete all, then insert). This is the same pattern used for label updates on tasks.

Updating `repoUrl` to a non-null value triggers `addRepositoryByUrl` again. Setting it to `null` clears `repositoryId` on the project.

`localPath` updates are also gated behind the desktop client check.

After update, `broadcast('project:updated', result)` fires.

## Deleting a Project

`DELETE /api/projects/:id` first nullifies `projectId` on all tasks belonging to the project, then deletes the project record:

```typescript
await prisma.task.updateMany({
  where: { projectId: id },
  data: { projectId: null },
});
await prisma.project.delete({ where: { id } });
```

Tasks are not deleted; they become unassigned. The `ProjectTeam` records are deleted by cascade (defined on the `ProjectTeam` model with `onDelete: Cascade`).

After deletion, `broadcast('project:deleted', { id })` fires.

## Response Shape

All project responses go through `transformProject()`:

```typescript
function transformProject(project) {
  return {
    ...project,
    teams: project.projectTeams.map((pt) => pt.team),
    projectTeams: undefined,
  };
}
```

This flattens the `projectTeams` join table into a `teams` array on the response object.

The full include used for all project queries:

```typescript
const projectInclude = {
  projectTeams: {
    include: { team: true },
  },
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  _count: {
    select: { tasks: true },
  },
};
```

The `_count.tasks` field gives the number of tasks in the project without loading them all.

## Repository Connection and Execution Gating

The kanban board in `apps/desktop-ui/components/board/use-kanban-board.ts` computes `canExecute` as:

```typescript
const canExecute = !!(
  selectedProject?.repositoryId ||
  selectedProject?.repoUrl ||
  selectedProject?.localPath ||
  activeRepository
);
```

`activeRepository` is the globally active repository from the user's account (not tied to a project). If none of these are set, the execute button is disabled and `handleExecute` returns early with an error message.

## Real-Time Updates

Project mutations broadcast SSE events: `project:created`, `project:updated`, `project:deleted`. The `useSSE` hook in `apps/desktop-ui/hooks/use-sse.ts` registers listeners for all three. The kanban board's `handleSSEEvent` in `use-kanban-board.ts` does not directly handle project events; those are handled by higher-level providers that manage the project list state.

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/projects.ts` | All project CRUD route handlers |
| `apps/api/src/services/github.ts` | `addRepositoryByUrl`, `parseGitHubUrl`, `fetchPublicRepo` |
| `apps/desktop-ui/components/board/use-kanban-board.ts` | `canExecute` logic, project selection |
| `apps/desktop-ui/hooks/use-sse.ts` | SSE event type definitions including project events |
| `packages/db/prisma/schema.prisma` | `Project`, `Repository`, `ProjectTeam` models |
