# OpenCode Integration

OpenCode is the AI coding agent that executes tasks. OpenLinear manages its lifecycle, creates sessions, sends prompts, and streams events.

## SDK

OpenLinear uses `@opencode-ai/sdk` which provides:
- `createOpencode()` -- spawns an OpenCode server process
- `createOpencodeClient()` -- creates a client for an existing server
- `OpencodeClient` -- type for session management, event subscription

## Server Lifecycle

On API startup, `ensureOpenCodeServer()` runs:

1. Try connecting to an existing server at `{OPENCODE_HOST}:{OPENCODE_PORT}` (default `127.0.0.1:4096`)
2. If found, reuse it
3. If not found, spawn a new one via `createOpencode()`
4. Retry up to 3 times with 2-second delays
5. Startup timeout: 30 seconds (configurable via `OPENCODE_STARTUP_TIMEOUT`)

The server runs for the lifetime of the API process. Shutdown handlers on SIGINT/SIGTERM call `stopOpenCodeServer()`.

## Health Checks

Every 10 seconds, the health check calls `client.session.list()`. If it fails:
1. The server is marked unhealthy
2. `opencode:status` SSE event is broadcast with `unhealthy`
3. The server is stopped and restarted

## Directory-Scoped Clients

OpenCode is project-scoped. Sessions created in a directory need a client that references that directory. `getClientForDirectory(path)` creates a fresh client pointing at the cloned repo path. This is used for both single-task and batch execution.

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

Text and reasoning arrive as small character-by-character deltas. The delta buffer system accumulates them and flushes complete messages to the log at sentence boundaries or after a timeout.

## Model Configuration

OpenLinear does not configure which model or provider OpenCode uses. That comes from OpenCode's own config files (typically `~/.config/opencode/config.json` or a project-level `.opencode/config.json`).

## Desktop Detection

The Tauri desktop app runs a `check_opencode` command to verify the binary is installed. If not found, it shows a setup dialog with:
- Platform-specific install instructions (Homebrew on macOS, binary download on Linux)
- Link to the [OpenCode releases page](https://github.com/opencode-ai/opencode/releases)
- "Check Again" button to re-verify
- "Skip for now" to proceed without it (execution will fail)

## Status Endpoint

`GET /api/opencode/status` returns the current server state:

```json
{
  "status": "running",
  "url": "http://127.0.0.1:4096",
  "error": null,
  "startedAt": "2024-01-15T10:30:00.000Z"
}
```

Possible statuses: `stopped`, `starting`, `running`, `error`.
