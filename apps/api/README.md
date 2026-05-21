# OpenLinear API

## Home Chat backend

The `/api/chat` module powers the workspace home chat. It is intentionally data-grounded: the system prompt tells the model to call tools for every workspace, project, team, issue, label, comment, member, count, or status answer, and the tools re-check the same database permissions used by the REST API. The model is configured only on the server with `CHAT_LLM_BASE_URL`, `CHAT_LLM_API_KEY` (or the legacy `FIREWORKS_API_KEY`), `CHAT_LLM_MODEL`, `CHAT_LLM_TIMEOUT_MS`, and `CHAT_RATE_LIMIT_PER_MIN`; the client never sends model names or provider keys.

Tool surface: 31 registered tools cover read access for workspaces, projects, teams, issues, comments, labels, members, and search, plus safe write actions for creating/updating issues, projects, teams, labels, comments, access grants, and member roles. There are deliberately no delete or remove tools. Bulk issue generation uses a preview-first `dryRun` pattern so brainstormed plans can be rendered before commit.

`POST /api/chat/sessions/:id/messages` returns Server-Sent Events. Chunks use event types such as `assistant_delta`, `tool_call_start`, `tool_result`, `assistant_final`, `error`, and `done`. Sessions are scoped to one workspace and optionally one project, and every session query filters by the authenticated user plus workspace membership to prevent cross-workspace leakage.
