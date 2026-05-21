# Settings

Execution behavior is configured through the Settings page. Settings are stored in a singleton database record.

## Available Settings

| Setting | Type | Range | Default | Description |
|---------|------|-------|---------|-------------|
| `parallelLimit` | integer | 1-5 | 3 | Maximum number of tasks that can execute simultaneously (single-task mode) |
| `maxBatchSize` | integer | 1-10 | 3 | Maximum concurrent tasks in parallel batch mode |
| `queueAutoApprove` | boolean | -- | false | Automatically start the next task in queue mode without manual approval |
| `stopOnFailure` | boolean | -- | false | Cancel remaining tasks in a batch if any task fails |
| `conflictBehavior` | string | skip, fail | skip | How to handle merge conflicts during batch merge phase |

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/settings` | Get current settings (auto-creates defaults if not present) |
| `PATCH` | `/api/settings` | Update one or more settings |

The PATCH endpoint validates all fields with Zod and requires at least one field in the body.

## Personal Access Tokens

Settings also includes an API Keys section for personal access tokens (PATs).
PATs authenticate MCP clients and API integrations without exposing the desktop
session JWT.

OpenLinear shows a new token once and stores only its hash. The token list keeps
metadata such as prefix, scopes, creation time, expiration time, last use, and
revocation status.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pats` | List PAT metadata for the authenticated user |
| `POST` | `/api/pats` | Create a PAT and return the token once |
| `DELETE` | `/api/pats/:id` | Revoke a PAT |

See [MCP Integration](mcp-integration.md) for the MCP connection flow.

## Real-Time Updates

When settings are updated, a `settings:updated` SSE event is broadcast to all connected clients. The UI picks up the new values without requiring a refresh.
