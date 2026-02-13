# Teams

Teams group users and scope task numbering with identifiers like `ENG-1`.

## Creating a Team

| Field | Required | Constraints | Example |
|-------|----------|-------------|---------|
| name | yes | 1-50 chars | "Engineering" |
| key | yes | 1-10 chars, uppercase alphanumeric, starts with letter | "ENG" |
| description | no | max 500 chars | "Backend and infra" |
| color | no | hex color | "#6366f1" |
| icon | no | string | -- |
| private | no | boolean | false |

The `key` must be unique across all teams. It is used in task identifiers.

## Issue Numbering

Each team maintains a `nextIssueNumber` counter. When a task is created with a `teamId`:
1. The counter is atomically incremented in a transaction
2. The task receives `number` (e.g. 3) and `identifier` (e.g. `ENG-3`)

This gives tasks team-scoped, human-readable identifiers.

## Members

Team members have one of three roles:

| Role | Description |
|------|-------------|
| `owner` | Full control, auto-assigned to team creator |
| `admin` | Management permissions |
| `member` | Standard access |

Members are added by email or userId. A user cannot be added to the same team twice.

## Invite Codes

Every team has an `inviteCode` -- a 10-character alphanumeric string generated automatically when the team is created. Users can join a team by submitting its invite code via `POST /api/teams/join`.

The invite code is displayed in the team detail view and in the teams list UI. It cannot be changed after creation.

### Joining a Team

`POST /api/teams/join` (requires auth)

Body: `{ "inviteCode": "aBcDeFgHiJ" }`

The endpoint looks up the team by invite code, verifies the user is not already a member, and adds them with the `member` role. Returns the full team object with members.

| Status | Condition |
|--------|-----------|
| 200 | Successfully joined |
| 400 | Missing invite code |
| 404 | Invalid invite code |
| 409 | Already a member |

## Deletion

Deleting a team:
1. Removes all team memberships
2. Removes all project-team associations
3. Sets `teamId` to null on all associated tasks
4. Deletes the team record

All operations happen in a single transaction.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/teams` | List all teams with member counts |
| `POST` | `/api/teams` | Create team (creator becomes owner) |
| `GET` | `/api/teams/:id` | Get team with members and project associations |
| `PATCH` | `/api/teams/:id` | Update team |
| `DELETE` | `/api/teams/:id` | Delete team (cascading) |
| `POST` | `/api/teams/join` | Join a team via invite code (requires auth) |
| `GET` | `/api/teams/:id/members` | List team members |
| `POST` | `/api/teams/:id/members` | Add member (requires auth) |
| `DELETE` | `/api/teams/:id/members/:userId` | Remove member |
