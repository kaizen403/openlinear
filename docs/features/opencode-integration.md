# OpenCode Integration

OpenCode is the AI coding agent that executes tasks. KazCode runs each user's OpenCode instance inside a dedicated Docker container, providing isolation between users.

## Architecture

KazCode uses a **container-per-user** model. When a user triggers their first task execution (or explicitly starts a container), the system:

1. Pulls the `opencode-worker` Docker image
2. Creates a container named `opencode-user-{userId}`
3. Binds a dynamically allocated host port (range 30000--31000) to the container's internal port 4096
4. Mounts three named volumes for persistence:
   - `opencode-auth-{userId}` → `/home/opencode/.local/share/opencode` (auth tokens)
   - `opencode-config-{userId}` → `/home/opencode/.config/opencode` (config files)
   - `opencode-repos-{userId}` → `/home/opencode/repos` (cloned repositories)
5. Waits for the OpenCode server inside the container to become healthy
6. Returns the container's base URL for API calls

Each container runs with resource limits: 512 MB memory, 512 CPU shares, 256 max PIDs.

## Container Lifecycle

| Status | Description |
|--------|-------------|
| `starting` | Container created, waiting for OpenCode server to respond |
| `running` | Healthy and accepting requests |
| `stopping` | Shutting down |
| `stopped` | Removed |
| `error` | Failed to start or became unhealthy |

### Idle Cleanup

Containers idle for 2 hours (configurable via `CONTAINER_IDLE_TIMEOUT_MS`) are automatically stopped and removed. The cleanup check runs every 5 minutes.

### Recovery

On API restart, the container manager discovers existing containers by querying Docker for containers with labels `app=openlinear` and `component=opencode-worker`. Running containers are re-adopted; stopped containers are removed.

## SDK

KazCode uses `@opencode-ai/sdk` which provides:
- `createOpencodeClient()` -- creates a client for a running OpenCode server
- `createOpencodeServer()` -- used inside the worker container to start the OpenCode server
- `OpencodeClient` -- type for session management, event subscription, provider configuration

## Session Management

For each task execution:
1. `client.session.create({ title, directory })` -- creates a new agent session
2. `client.session.prompt({ parts: [{ type: 'text', text }] })` -- sends the task as a prompt
3. `client.session.abort()` -- cancels the session on user cancel or timeout

## Event Streaming

`client.event.subscribe()` returns an async iterable stream. Events handled:

| Event | Action |
|-------|--------|
| `session.completed` / `session.idle` | Agent finished -- commit and PR |
| `session.error` | Execution failed |
| `session.status` (busy) | Mark agent as thinking |
| `session.status` (retry) | Log retry reason |
| `message.part.updated` (text) | Accumulate agent text deltas |
| `message.part.updated` (tool) | Log tool start/complete/error |
| `message.part.updated` (reasoning) | Accumulate reasoning deltas |
| `tool.execute.before` | Log tool starting |
| `tool.execute.after` | Log tool finished, increment counter |
| `file.edited` | Log file edit, increment counter |
| `server.heartbeat` | Ignored |

## Delta Buffer

Text and reasoning arrive as small character-by-character deltas. The delta buffer accumulates them and flushes complete messages to the log at sentence boundaries or after a timeout.

## Provider Authentication

Users configure which LLM provider OpenCode uses through the provider auth API. Two methods are supported:

**API Key:** Set a provider's API key directly via `POST /api/opencode/auth`.

**OAuth:** Start an OAuth flow via `POST /api/opencode/auth/oauth/authorize`, then complete it with `POST /api/opencode/auth/oauth/callback`.

Provider credentials are stored inside the container's persistent volume, so they survive container restarts.

## API Endpoints

All endpoints except `/status` require authentication.

### `GET /api/opencode/status`

Returns the overall OpenCode system state.

```json
{
  "mode": "container-per-user",
  "activeContainers": 2,
  "containers": [
    {
      "userId": "...",
      "status": "running",
      "hostPort": 30001,
      "baseUrl": "http://127.0.0.1:30001",
      "lastActivity": "2025-01-15T10:30:00.000Z",
      "createdAt": "2025-01-15T09:00:00.000Z"
    }
  ]
}
```

### `GET /api/opencode/container`

**Auth: required.** Get the authenticated user's container status. Returns `{ status: "none" }` if no container exists, or the container's status, host port, base URL, last activity, and creation time.

### `POST /api/opencode/container`

**Auth: required.** Create or start a container for the authenticated user. Idempotent -- returns the existing container if one is already running.

Response: `{ status, hostPort, baseUrl }`

### `DELETE /api/opencode/container`

**Auth: required.** Stop and remove the authenticated user's container.

Response: `{ success: true }`

### `GET /api/opencode/providers`

**Auth: required.** List available LLM providers from the user's OpenCode instance.

### `GET /api/opencode/providers/auth`

**Auth: required.** Get the authentication status for each provider (which providers have credentials configured).

### `POST /api/opencode/auth`

**Auth: required.** Set an API key for a provider.

Body: `{ "providerId": "anthropic", "apiKey": "sk-..." }`

Response: `{ success: true, providerId: "anthropic" }`

### `POST /api/opencode/auth/oauth/authorize`

**Auth: required.** Start an OAuth authorization flow for a provider.

Body: `{ "providerId": "...", "method": 0 }`

Returns the authorization URL and flow data.

### `POST /api/opencode/auth/oauth/callback`

**Auth: required.** Complete an OAuth authorization flow.

Body: `{ "providerId": "...", "code": "...", "method": 0 }`

Returns the result of the OAuth token exchange.

## Model Configuration

KazCode does not configure which model OpenCode uses. That comes from OpenCode's own config files (stored in the container's persistent config volume at `/home/opencode/.config/opencode`).

## Worker Container

The `opencode-worker` Docker image is defined in `docker/opencode-worker/Dockerfile`. It is based on `node:20-alpine` and includes:

- `git`, `curl`, `openssh-client` for repository operations
- `@opencode-ai/opencode` and `@opencode-ai/sdk` installed globally
- A non-root `opencode` user (UID 1000)
- A health check that pings `http://localhost:4096/` every 30 seconds
- An entrypoint script that starts the OpenCode server on port 4096

The image is built via `docker compose build opencode-worker` (defined in `docker-compose.yml` under the `build-only` profile).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_IMAGE` | Docker image for worker containers | `opencode-worker:latest` |
| `DOCKER_HOST` | Docker daemon socket path | `/var/run/docker.sock` |
| `CONTAINER_IDLE_TIMEOUT_MS` | Idle time before auto-cleanup | `7200000` (2 hours) |
