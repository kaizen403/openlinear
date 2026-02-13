# Task Execution (Single)

Running a single task through an AI agent. This is the core feature of KazCode.

## Execution Flow

1. **Clone** -- shallow clone (`git clone --depth 1`) of the active repository into `{REPOS_DIR}/{repoName}/{taskId}`
2. **Branch** -- create and checkout `openlinear/{taskId}`
3. **Session** -- create an OpenCode session scoped to the cloned directory via `client.session.create()`
4. **Prompt** -- send the task's title + description + labels as a text prompt via `client.session.prompt()`
5. **Stream** -- subscribe to OpenCode events and relay progress to the UI in real time
6. **Commit** -- when the agent finishes, run `git add -A && git commit`
7. **Push** -- `git push -u origin {branch}`
8. **PR** -- create a pull request via the GitHub API (or return a compare URL if no token)

## Starting Execution

**API:** `POST /api/tasks/:id/execute`

The endpoint checks:
- Task is not already running
- Active executions have not reached the `parallelLimit` setting
- An active repository is selected

If any check fails, returns a 400 error.

## Progress Stages

The execution broadcasts progress updates via SSE (`execution:progress`):

| Stage | Description |
|-------|-------------|
| `cloning` | Shallow-cloning the repository |
| `executing` | Agent is working (thinking, running tools, editing files) |
| `committing` | Staging and committing changes |
| `creating_pr` | Pushing branch and creating pull request |
| `done` | Execution complete |
| `error` | Execution failed |
| `cancelled` | Execution cancelled by user |

## Execution Logs

Every significant event is recorded as a log entry and broadcast via `execution:log`:

| Type | Icon | Examples |
|------|------|----------|
| `info` | arrow | "Repository cloned", "Branch created", "Task prompt sent" |
| `agent` | robot | "Agent is thinking..." |
| `tool` | wrench | "Running: file_edit", "Starting: bash" |
| `success` | check | "Completed: file_edit", "Pull request created" |
| `error` | x | "Failed: bash", "Execution failed" |

Logs are persisted to the database (`executionLogs` JSON column) when execution completes.

## Progress Estimation

While the agent is working, progress is estimated from three signals:
- Tools executed (5% each, up to 40%)
- Files changed (10% each, up to 30%)
- Elapsed time (3% per minute, up to 20%)

Maximum estimated progress is capped at 95%. It jumps to 100% only on completion.

## Timeout

Each task has a 30-minute timeout. If the agent hasn't finished by then, the task is automatically cancelled.

## Cancellation

**API:** `POST /api/tasks/:id/cancel`

Cancelling a task:
1. Calls `client.session.abort()` to stop the OpenCode session
2. Marks the task as `cancelled` in the database
3. Persists any collected logs
4. Cleans up the execution state

## Pull Request

On completion with changes:
- If a GitHub access token is available, creates a real PR via `POST https://api.github.com/repos/:owner/:repo/pulls`
- If no token or the API call fails, returns a GitHub compare URL for manual PR creation

**Refresh PR:** `POST /api/tasks/:id/refresh-pr` -- checks if a PR has been created for a compare-URL branch and updates the task's `prUrl` if found.

## Execution Drawer

The UI shows a slide-out drawer with:
- Current execution stage
- Live scrolling log entries with colored icons
- Elapsed time
- PR link on completion

## Task Outcome

After execution completes, the system generates a brief outcome summary stored on the task. The outcome is a short description of what happened:

- If there were code changes: `"{N} file(s) changed, {M} tools executed"`
- If there were no changes: `"Completed with no changes"`

The outcome is displayed in the task detail view, giving a quick summary of what the AI agent accomplished without opening the full log.

## Container Isolation

Task execution runs inside per-user Docker containers. Each user's OpenCode instance is isolated with its own filesystem, resources, and provider credentials. See [OpenCode Integration](opencode-integration.md) for details on the container-per-user architecture.
