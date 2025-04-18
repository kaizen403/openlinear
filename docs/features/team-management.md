# Team Management

Teams are the primary organizational unit in OpenLinear. They scope issue numbers, control which tasks and projects a user sees, and carry membership roles. Every user who registers via email/password gets a personal team created automatically. Teams can also be created manually and joined via invite codes.

## Data Model

The `Team` model in `packages/db/prisma/schema.prisma`:

```prisma
model Team {
  id              String        @id @default(uuid())
  name            String
  key             String        @unique  // e.g. "ENG", "DSN"
  description     String?
  color           String        @default("#6366f1")
  icon            String?
  private         Boolean       @default(false)
  inviteCode      String?       @unique
  nextIssueNumber Int           @default(1)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  members         TeamMember[]
  projectTeams    ProjectTeam[]
  tasks           Task[]
}
```

The `key` field is a short uppercase alphanumeric identifier (e.g. `ENG`, `DSN`). It must be unique across all teams and is used as the prefix for issue identifiers like `ENG-1`.

`nextIssueNumber` is an auto-incrementing counter. It is incremented atomically inside a transaction every time a task is created for the team. The counter never resets, so identifiers are stable even after tasks are deleted.

`inviteCode` is a unique string in the format `{KEY}-{8 hex chars uppercase}`, e.g. `ENG-A3F2B1C4`. It is generated at team creation and never changes unless explicitly regenerated.

The `TeamMember` join table:

```prisma
model TeamMember {
  id        String   @id @default(uuid())
  teamId    String
  userId    String
  role      TeamRole @default(member)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  team      Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
}
```

**TeamRole enum**: `owner | admin | member`

The `@@unique([teamId, userId])` constraint prevents duplicate memberships. Both `onDelete: Cascade` relations mean that deleting a team removes all its `TeamMember` records, and deleting a user removes all their memberships.

## API Endpoints

All team routes are mounted at `/api/teams` in `apps/api/src/app.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/teams` | Optional | List teams the current user belongs to |
| `POST` | `/api/teams` | Yes | Create a team |
| `POST` | `/api/teams/join` | Yes | Join a team via invite code |
| `GET` | `/api/teams/:id` | No | Get a single team with members |
| `PATCH` | `/api/teams/:id` | Optional | Update team metadata |
| `DELETE` | `/api/teams/:id` | Optional | Delete a team |
| `GET` | `/api/teams/:id/members` | No | List team members |
| `POST` | `/api/teams/:id/members` | Yes | Add a member by email or userId |
| `DELETE` | `/api/teams/:id/members/:userId` | Optional | Remove a member |

The route file is `apps/api/src/routes/teams.ts`.

## Team Scoping

`apps/api/src/services/team-scope.ts` exports a single function:

```typescript
export async function getUserTeamIds(userId: string): Promise<string[]> {
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    select: { teamId: true },
  });
  return memberships.map((m) => m.teamId);
}
```

This is called by the tasks route (`GET /api/tasks`), the projects route (`GET /api/projects`), and the archived tasks route (`GET /api/tasks/archived`) to scope results to the authenticated user's teams. It is a simple lookup with no caching.

## Creating a Team

`POST /api/teams` validates with Zod:

```typescript
const createTeamSchema = z.object({
  name: z.string().min(1).max(50),
  key: z.string().min(1).max(10).regex(/^[A-Z][A-Z0-9]*$/),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().optional(),
  private: z.boolean().optional(),
});
```

The `key` must start with an uppercase letter and contain only uppercase letters and digits. The regex `/^[A-Z][A-Z0-9]*$/` enforces this.

The handler creates the team with a generated invite code and, if the request is authenticated, immediately adds the requesting user as `owner`:

```typescript
const team = await prisma.team.create({
  data: {
    ...parsed.data,
    inviteCode: generateInviteCode(parsed.data.key),
    ...(req.userId && {
      members: {
        create: { userId: req.userId, role: 'owner' },
      },
    }),
  },
});
```

`generateInviteCode(key)` produces `{KEY}-{crypto.randomBytes(4).toString('hex').toUpperCase()}`.

If the `key` is already taken, Prisma throws a unique constraint error. The handler catches this and returns `409 Conflict`.

After creation, `broadcast('team:created', team)` fires.

## Automatic Team Creation on Registration

When a user registers via `POST /api/auth/register`, a team is created automatically inside the same transaction:

```typescript
const user = await prisma.$transaction(async (tx) => {
  const newUser = await tx.user.create({ data: { username, passwordHash, email } });
  const team = await tx.team.create({
    data: {
      name: `${username}'s Team`,
      key: teamKey,
      inviteCode: generateInviteCode(teamKey),
    },
  });
  await tx.teamMember.create({
    data: { teamId: team.id, userId: newUser.id, role: 'owner' },
  });
  return newUser;
});
```

The team key is derived in `generateUniqueTeamKey(username)`:

1. Takes the username, uppercases it, strips non-alphanumeric characters, and takes the first 5 characters. Falls back to `USR` if the result is empty.
2. Checks if the key already exists in the database. If it does, appends a numeric suffix (`BASE1`, `BASE2`, etc.) until a unique key is found.

This runs in the auth route (`apps/api/src/routes/auth.ts`), not the teams route.

## Joining a Team

`POST /api/teams/join` accepts `{ inviteCode }`. The handler:

1. Looks up the team by `inviteCode` (unique index lookup).
2. Returns `404` if no team matches.
3. Checks for an existing `TeamMember` record for the user. Returns `409` if already a member.
4. Creates a `TeamMember` with `role: 'member'`.
5. Returns the full team with members.

`broadcast('team:updated', result)` fires after a successful join.

## Adding Members Directly

`POST /api/teams/:id/members` accepts either `email` or `userId` (at least one is required, enforced by a Zod `.refine()`). The handler looks up the user by the provided identifier and creates a `TeamMember` record with the specified role (defaults to `member`).

This is an admin-level operation in intent, though the current implementation does not enforce role-based access control on the endpoint itself.

## Removing Members

`DELETE /api/teams/:id/members/:userId` deletes the `TeamMember` record using the composite unique key `{ teamId, userId }`. Returns `404` if the membership doesn't exist.

## Updating a Team

`PATCH /api/teams/:id` accepts updates to `name`, `description`, `color`, `icon`, and `private`. The `key` field is not updatable after creation (it's not in `updateTeamSchema`). This prevents breaking existing issue identifiers.

## Deleting a Team

`DELETE /api/teams/:id` runs a transaction that:

1. Verifies the team exists (throws `NOT_FOUND` if not).
2. Deletes all `TeamMember` records for the team.
3. Deletes all `ProjectTeam` records for the team.
4. Nullifies `teamId` on all tasks belonging to the team (tasks are not deleted).
5. Deletes the team record.

```typescript
await prisma.$transaction(async (tx) => {
  const team = await tx.team.findUnique({ where: { id } });
  if (!team) throw new Error('NOT_FOUND');
  await tx.teamMember.deleteMany({ where: { teamId: id } });
  await tx.projectTeam.deleteMany({ where: { teamId: id } });
  await tx.task.updateMany({ where: { teamId: id }, data: { teamId: null } });
  await tx.team.delete({ where: { id } });
});
```

`broadcast('team:deleted', { id })` fires after the transaction completes.

## Team-Scoped Issue Numbering

When a task is created with a `teamId`, the issue number is assigned atomically:

```typescript
const created = await prisma.$transaction(async (tx) => {
  const team = await tx.team.update({
    where: { id: resolvedTeamId },
    data: { nextIssueNumber: { increment: 1 } },
    select: { key: true, nextIssueNumber: true },
  });
  const number = team.nextIssueNumber - 1;
  const identifier = `${team.key}-${number}`;
  return tx.task.create({ data: { ..., number, identifier } });
});
```

The `update` with `increment: 1` returns the post-increment value, so `number = nextIssueNumber - 1` gives the pre-increment value. This is the task's permanent issue number. The `identifier` string (e.g. `ENG-42`) is stored on the task and never changes.

Because the increment and task creation happen in the same transaction, two concurrent task creations for the same team will serialize at the database level and receive distinct numbers.

## List Response Shape

`GET /api/teams` includes member count and associated projects:

```typescript
const teams = await prisma.team.findMany({
  where: { members: { some: { userId: req.userId } } },
  include: {
    _count: { select: { members: true } },
    projectTeams: {
      include: {
        project: { select: { id, name, status, color, icon } },
      },
    },
  },
  orderBy: { createdAt: 'asc' },
});
```

`GET /api/teams/:id` includes full member details:

```typescript
include: {
  members: { include: { user: true } },
  projectTeams: true,
}
```

## Real-Time Updates

Team mutations broadcast SSE events: `team:created`, `team:updated`, `team:deleted`. The `useSSE` hook in `apps/desktop-ui/hooks/use-sse.ts` registers listeners for all three. These events allow the desktop UI to update team lists and member counts without polling.

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/teams.ts` | All team and member route handlers |
| `apps/api/src/services/team-scope.ts` | `getUserTeamIds` helper used across routes |
| `apps/api/src/routes/auth.ts` | Auto-team creation on registration, `generateUniqueTeamKey` |
| `apps/api/src/routes/tasks.ts` | Atomic issue number assignment in task creation |
| `apps/desktop-ui/hooks/use-sse.ts` | SSE event type definitions including team events |
| `packages/db/prisma/schema.prisma` | `Team`, `TeamMember`, `TeamRole` definitions |
