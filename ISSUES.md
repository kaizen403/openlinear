# OpenLinear — Work Log

> Agents: append an entry here at the end of every session. Format is at the bottom of `AGENTS.md`.
> Read this file at the **start** of every session to know what's in progress and what's broken.

---

## [2026-05-21] — Refine Codex provider presentation

**Status:** Done
**Agent:** Codex

### What was done
- Replaced the square favorite-model tiles with compact model rows that do not reserve image space.
- Added a local OpenAI mark asset for the Codex connection heading and removed the key icon and `Featured` eyebrow.
- Reworked the Codex connected state into quiet neutral status text instead of a colored status pill.
- Captured the AI Providers settings view twice during the visual pass and recorded the visual verdict state for the iteration.

### Files changed
- `apps/desktop-ui/components/settings/ai-providers-section.tsx` — flattened favorite model presentation and refined Codex card branding/state treatment.
- `apps/desktop-ui/public/brand/openai-mark.svg` — added the monochrome provider mark used beside `Connect to Codex`.
- `ISSUES.md` — recorded this follow-up session.

### Issues encountered
- The local preview had no provider data from the sidecar/API session, so the screenshot pass could verify the Codex empty state but not a live populated favorite-model list.

### Next steps / blockers
- Recheck the compact favorite-model rows in a provider-populated settings session.

## [2026-05-21] — Featured Codex auth in AI Providers

**Status:** Done
**Agent:** Codex

### What was done
- Added a featured `Connect to Codex` card above the existing AI provider controls.
- Reused OpenCode's `openai` provider auth methods so Codex connect actions preserve reported OAuth labels and method indexes.
- Expanded generic provider setup to render every reported OAuth login method instead of collapsing to the first method.
- Reused the existing OAuth callback, paste-completion, storage handoff, model refresh, and setup-status refresh paths.
- Cleared the shared OAuth waiting state when a pending provider login is cancelled.

### Files changed
- `apps/desktop-ui/components/settings/ai-providers-section.tsx` — added the featured Codex card and shared multi-method OAuth rendering.
- `ISSUES.md` — recorded this session.

### Issues encountered
- `apps/desktop-ui` does not currently have a component-level UI test harness for the AI Providers section; verification used desktop diagnostics, typecheck, package test script, and production build.

### Next steps / blockers
- Manually verify browser and headless/device-style Codex OAuth methods on a machine where OpenCode reports both `openai` OAuth options.

## [2026-05-22] — MCP compatibility and landing page updates

**Status:** Done
**Agent:** Claude (OpenCode)

### What was done
- Fixed `openlinear_bulk_create_plan` MCP tool to auto-resolve or create a team when `teamId` is omitted, preventing bulk task creation failures.
- Updated MCP docs in `kaizen403/docs` repo to reflect the current 12-tool surface, project-scoped labels, and optional teamId behavior.
- Added MCP integration node to the landing page orbit visual and updated integration description text.
- Added a direct "MCP docs →" button linking to `https://docs.openlinear.tech/integrations/mcp`.
- Deployed updated MCP worker to `mcp.openlinear.tech` with auto-team fallback.

### Files changed
- `apps/mcp/src/mcp/tools/plan.ts` — auto-team resolution logic
- `apps/landing/components/integrations-section.tsx` — MCP node, updated text, MCP docs CTA
- `kaizen403/docs/integrations/mcp.mdx` — updated tool list, auto-team docs, project-scoped labels

### Issues encountered
- PAT smoke-test token invalidated in production DB; needs fresh PAT for live e2e testing.

### Next steps / blockers
- Generate new PAT via Settings → API Keys and run a full `bulk_create_plan` end-to-end test.

---

## Active / Known Issues

| # | Issue | Status |
|---|---|---|
| 5 | Invite flow — proper domain, accept page, OAuth on web | ⏳ Planned (see `.sisyphus/plans/openlinear-issues.md`) |
| 12 | Remove duplicate "Add Task" button at bottom of Kanban columns | ✅ Done |
| 13 | Remove blue accent focus outline from input elements | ✅ Done |
| 17 | Add "+" button and "Add More Projects" hint to project selector | ✅ Done |
| — | API deployed to `api.openlinear.tech` via Azure Container Apps | ✅ Done |
| — | MCP redeployed to `mcp.openlinear.tech` pointing to `api.openlinear.tech` | ✅ Done |
| — | MCP `bulk_create_plan` auto-team fallback when `teamId` omitted | ✅ Done (deployed) |

---

## [2026-05-21] — MCP Server: full build, deployment, and live smoke test

**Status:** Done (MCP live; API deployment deferred to Azure)
**Agent:** Claude (OpenCode)

### What was done
- Designed full MCP architecture: Cloudflare Worker + Express + `@modelcontextprotocol/node`
- Added `PersonalAccessToken` Prisma model + migration (`20260521000100_add_personal_access_tokens`)
- Added PAT auth middleware to `apps/api/src/middleware/auth.ts` (detects `ol_pat_` prefix, SHA-256 hash lookup)
- Added `apps/api/src/routes/pats.ts` — PAT create/list/revoke endpoints
- Added `apps/api/src/services/pats.ts` — PAT service logic
- Added `POST /api/tasks/bulk` to `apps/api/src/routes/tasks.ts` (max 100 tasks, Prisma transaction, SSE event `tasks:bulk-created`)
- Added PAT settings UI: `apps/desktop-ui/components/settings/personal-access-tokens-section.tsx`
- Scaffolded full `apps/mcp/` Cloudflare Worker app with 7 MCP tools
- Applied production DB migration to Neon — `personal_access_tokens` table confirmed created
- Deployed MCP Worker to `mcp.openlinear.tech` (Cloudflare custom domain, zone active)
- Fixed `plan.ts` schema: removed `.uuid()` validators (OpenLinear IDs are `workspace-<hex>` not UUIDs)
- Fixed stateless transport in `apps/mcp/src/mcp/transport.ts` (fresh transport per POST, no in-memory sessions)
- Created `project_teams` table in production Neon (was missing — DB predated Prisma migration system)
- Full end-to-end smoke test passed: `bulk_create_plan` created project MCPS with 2 phases, 5 tasks in production Neon
- Wrote 19 Mintlify docs pages and pushed to `kaizen403/docs` repo (commit `b722efb`)
- Rotated `DEPLOY_SSH_KEY` GitHub secret (old key no longer works; new key generated at `/tmp/openlinear_deploy`)

### Files changed
- `packages/db/prisma/schema.prisma` — added `PersonalAccessToken` model
- `packages/db/prisma/migrations/20260521000100_add_personal_access_tokens/` — new migration
- `apps/api/src/middleware/auth.ts` — PAT detection + hash-lookup
- `apps/api/src/routes/pats.ts` — new file
- `apps/api/src/services/pats.ts` — new file
- `apps/api/src/routes/tasks.ts` — added `POST /api/tasks/bulk`
- `apps/api/src/schemas/tasks.ts` — bulk task schema
- `apps/desktop-ui/components/settings/personal-access-tokens-section.tsx` — new file
- `apps/mcp/` — entire new package (Cloudflare Worker)
- `apps/mcp/wrangler.toml` — `OPENLINEAR_API_URL=https://openlinear.tech`, routes `mcp.openlinear.tech`
- `apps/mcp/src/mcp/transport.ts` — stateless mode (no sessions Map)
- `apps/mcp/src/mcp/tools/plan.ts` — removed `.uuid()` validators
- `.sisyphus/plans/mcp-phase-*.md` — 5 plan files created

### Issues encountered
- Neon prod DB had no `_prisma_migrations` table — baselined all 7 prior migrations manually
- `project_teams` table was missing from prod DB — applied `CREATE TABLE IF NOT EXISTS` directly
- CF Worker `[[routes]]` custom_domain requires `openlinear.tech` zone to be in the CF account; zone was moved to CF mid-session
- `DEPLOY_SSH_KEY` GitHub secret was stale — rotated. New public key: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIECnlEB1EUQZAFjZmvqxa60x9kZmTdf4UuMX+sNgx48Z openlinear-deploy-2026`

### Next steps / blockers
- **API deployment to Azure** — `openlinear.tech` currently serves the landing page only (Vercel). Once API is on Azure:
  1. Verify `OPENLINEAR_API_URL` in `apps/mcp/wrangler.toml` matches the Azure URL
  2. Run `cd apps/mcp && wrangler deploy` to redeploy Worker
  3. Update `.github/workflows/deploy.yml` for Azure (current workflow is SSH + PM2, VPS-style)
- Smoke test PAT in production DB: `ol_pat_25897b3edab3886a9601658071a9dac5` (userId `8802cd83`, kaizen403)
- Test workspace: `workspace-aeb35ae41ef68718e82d59f45ad0c447`
- Test team: `671dc3cb-c8dc-4922-b355-bc842ed1010b` (kaizen403's Team, key=KT)

---

## [Prior Sessions] — Bug fixes and UI improvements

**Status:** Done
**Agent:** Claude (OpenCode)

### Completed
1. ✅ Hardcoded branch list → dynamic branch fetching from GitHub API
2. ✅ Thin fonts unreadable on Linux — restricted Tailwind font weights 300–800, better fallback stack
3. ✅ Team name/key not editable in onboarding "Team Ready" step
4. ✅ Onboarding timeline redesign (slider → minimal branded timeline)
5. ✅ Kanban drag-and-drop cards disappearing/misplacing
6. ✅ Pages not scrollable (team settings, etc.)
7. ✅ Show assignee/creator avatar badge on task cards
8. ✅ macOS auth deep-link & repo loading broken — browser bridge fallback added
9. ✅ `User.githubId` changed `Int?` → `String?` (GitHub IDs exceed 32-bit int range)
10. ✅ Validation error showing in comments section on task detail
11. ✅ Onboarding wizard flashes before project selector — added `isProjectsLoading` guard
12. ✅ Sidebar collapsed by default → now defaults to open (localStorage persistence)
13. ✅ Replace project color dots & team badges with user avatars
14. ✅ Remove duplicate "Add Task" button at bottom of Kanban columns — `onInlineCreate` prop removed

### Detailed issue descriptions
See `.sisyphus/plans/openlinear-issues.md` for full root-cause analysis and file-level change details on each issue.

---

## [2026-05-21] — Implement home chat backend engine

**Status:** Done
**Agent:** Codex

### What was done
- Added chat session/message/tool-call persistence with Prisma schema changes, migration SQL, and regenerated Prisma client.
- Added an OpenAI-compatible, Fireworks-default chat LLM adapter, anti-hallucination system prompts, and automatic session title generation.
- Added `/api/chat` session CRUD plus SSE message streaming with auth, scope checks, rate limiting, abort handling, and real-time chat broadcast support.
- Added a service-backed registry of 31 tools over real OpenLinear workspace, project, team, issue, label, member, comment, and search data.
- Added safe write paths, bulk issue dry-run support, tool-call telemetry, and idempotency keyed by session/tool call.
- Promoted reusable project membership checks and extracted chat-facing domain services for tasks, projects, teams, labels, members, search, and workspaces.
- Fixed stale bulk-task code/tests that still referenced the removed `projectTeams` relation and old label team ownership.
- Added API tests for chat sessions, streaming, tool schemas, orchestration, idempotency, dry-run behavior, and permission-denied paths.
- Documented chat environment variables and the API chat module.

### Files changed
- `.env.example` — added chat LLM and rate-limit environment variables.
- `apps/api/README.md` — documented the Home Chat backend module.
- `apps/api/src/app.ts` — mounted the chat routes.
- `apps/api/src/lib/chat-llm.ts` — added provider adapter and test injection hook.
- `apps/api/src/lib/chat-prompts.ts` — added grounding-focused prompts.
- `apps/api/src/routes/chat.ts` — added chat API and streaming endpoints.
- `apps/api/src/routes/labels.ts` — switched to shared project membership guard.
- `apps/api/src/routes/tasks.ts` — fixed project/team/label validation against current schema.
- `apps/api/src/schemas/chat.ts` — added chat request validation.
- `apps/api/src/services/chat.ts` — added chat orchestration and persistence.
- `apps/api/src/services/chat-tools/` — added the 31-tool registry, schemas, and dispatcher.
- `apps/api/src/services/{tasks,projects,teams,labels,members,search}.ts` — added chat-facing domain services.
- `apps/api/src/services/workspaces.ts` — added reusable workspace list/get/update helpers.
- `apps/api/src/services/ownership.ts` — added reusable project membership assertion.
- `apps/api/src/sse.ts` — added chat-session broadcast helper.
- `apps/api/src/__tests__/chat.*.test.ts` — added chat backend coverage.
- `apps/api/src/__tests__/tasks.test.ts` — updated fixtures for current schema.
- `packages/db/prisma/schema.prisma` — added chat session, message, and tool-call models/enums.
- `packages/db/prisma/migrations/20260521000200_chat_sessions/` — added chat persistence migration.

### Issues encountered
- Local `openlinear_test` was stale and unbaselined for the current Prisma schema; reset only the local test DB and applied migrations before running the API suite.
- Initial environment restrictions blocked local listener/database setup; after the session continued with full filesystem/network access, tests ran normally.
- Existing unrelated desktop-ui and sidecar files were already dirty and were left untouched.

### Next steps / blockers
- Configure production `CHAT_LLM_API_KEY` and run the new migration before enabling Home Chat in production.
- Wire or verify the desktop-ui Home Chat frontend against `/api/chat` if the parallel frontend changes are intended.

## [2026-05-21] — Fix local startup and GitHub OAuth flow

**Status:** Done
**Agent:** Codex

### What was done
- Stopped stale OpenLinear dev processes that were occupying ports 3000, 3001, and 1455.
- Reconciled Neon Prisma migration drift by marking already-applied physical migrations as applied, then deployed the remaining label-scope migration.
- Added `pnpm dev-live` as an alias for the existing `pnpm dev:live` workflow.
- Updated `pnpm start` and `pnpm dev-live` startup scripts to run Prisma migrations instead of `db push`.
- Verified GitHub OAuth environment shape without printing secrets, completed local desktop OAuth, and confirmed `/api/auth/me` returned the signed-in GitHub user.
- Added Home Chat LLM compatibility with the existing `FIREWORKS_API_KEY` env var when `CHAT_LLM_API_KEY` is empty.
- Ran the Tauri app through `pnpm dev-live`, verified API health, authenticated app loading, SSE connection, and chat route activity, then stopped the dev stack.

### Files changed
- `package.json` — added the `dev-live` script alias.
- `scripts/dev-live.sh` — added Prisma generate and migration deploy before booting services.
- `scripts/start-prod-preview.sh` — replaced `db push` with migration deploy for safer startup.
- `.env.example` — documented Home Chat env vars and Fireworks key fallback.
- `apps/api/src/lib/chat-llm.ts` — allowed `FIREWORKS_API_KEY` fallback for the chat provider.
- `ISSUES.md` — recorded the startup and OAuth repair session.

### Issues encountered
- Neon already had some schema changes physically present but not recorded in `_prisma_migrations`; Prisma deploy initially failed on an existing `teams.project_id` column.
- A stale API process and old Tauri sidecar were occupying the ports needed by a clean `pnpm dev-live` start.
- Firefox completed GitHub OAuth but did not automatically hand the deep link to the dev Tauri instance, so the local callback was dispatched from the copied JWT after verifying it looked like a JWT.

### Next steps / blockers
- Keep using `pnpm dev-live` or `pnpm dev:live`; both now point to the same clean live development script.
- If the browser does not return to the app automatically, use the callback token fallback on the login screen.

## [2026-05-21] — Refine home chat project scope UI

**Status:** Done
**Agent:** Codex

### What was done
- Removed generic AI controls from the Home Chat composer: model chip, effort chip, permission badge, and voice/file-style controls.
- Added a top-right New chat action to the Home Chat header.
- Replaced workspace/project scope pills with a project-only dropdown because workspace is already selected globally in the sidebar.
- Reworked the project dropdown from a browser/system `<select>` into an OpenLinear-native dropdown menu.
- Lowercased displayed project names in Home Chat and removed the heavier weight from the empty-state project name.
- Set the empty-state project-name color to the configured app accent color from Settings.
- Changed new chat session creation to attach the selected project ID.
- Updated empty chat suggestions to be project-focused instead of generic integration prompts.

### Files changed
- `apps/desktop-ui/app/(app)/page.tsx` — added chat header, project dropdown, new chat button, and project-scoped session creation.
- `apps/desktop-ui/components/chat/scope-picker.tsx` — replaced scope pills/system select with a custom project dropdown.
- `apps/desktop-ui/components/chat/chat-composer.tsx` — removed fake/sloppy controls and simplified the composer footer.
- `apps/desktop-ui/components/chat/chat-empty-state.tsx` — matched project-name weight to surrounding text, rendered the name in lowercase, and set it to the configured accent color.
- `apps/desktop-ui/components/chat/chat-suggestions.tsx` — replaced generic suggestions with project-native prompts.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The first project dropdown pass used a browser `<select>`, which felt too system-native for the app; replaced it with the app's dropdown UI.

### Next steps / blockers
- Run `pnpm dev-live` and visually inspect the Home Chat header/dropdown in the Tauri shell if further visual tuning is wanted.

## [2026-05-22] — Orient on codebase for future assistance

**Status:** Done
**Agent:** Codex

### What was done
- Read the workspace guidance and active work log before inspecting the repo.
- Mapped the monorepo entry points, package boundaries, API routing, desktop UI task and chat flows, sidecar execution lifecycle, MCP worker surface, SSE plumbing, and Prisma domain model.
- Noted the existing dirty worktree so future changes can avoid overwriting unrelated in-progress edits.

### Files changed
- `ISSUES.md` — recorded this orientation pass.

### Issues encountered
- Semantic `codebase_search` calls returned HTTP 429, so the repo map was built from targeted local file inspection instead.

### Next steps / blockers
- Ready to inspect a specific feature, bug, or implementation path when requested.

## [2026-05-21] — Add ElevenLabs voice dictation to Home Chat

**Status:** Done
**Agent:** Codex

### What was done
- Added the official ElevenLabs TypeScript SDK to the sidecar.
- Replaced the existing Whisper/OpenAI transcription path with ElevenLabs Scribe speech-to-text via `client.speechToText.convert`.
- Added server-side ElevenLabs STT environment configuration and kept the API key sidecar-only.
- Added a Home Chat microphone control with recording, transcribing, blocked-mic, and failure states.
- Added a restrained recording animation and automatic transcript insertion into the chat composer after recording stops.
- Reverted the custom project-name gradient so the empty-state project name follows the configured app accent color.

### Files changed
- `apps/sidecar/src/routes/transcribe.ts` — switched `/api/transcribe` to ElevenLabs Scribe and added safer upload/model/timeout handling.
- `apps/sidecar/package.json` / `pnpm-lock.yaml` — added `@elevenlabs/elevenlabs-js`.
- `apps/desktop-ui/components/chat/chat-composer.tsx` — added voice recording UI, MediaRecorder capture, transcription flow, and transcript insertion.
- `apps/desktop-ui/lib/api/chat.ts` — added Home Chat transcription client helper.
- `apps/desktop-ui/components/chat/chat-empty-state.tsx` — keeps the project name aligned to the configured accent color.
- `.env.example` — documented ElevenLabs STT configuration.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The ElevenLabs SDK exposes `statusCode` as optional on errors, so the sidecar route now normalizes missing SDK statuses to a 502 before returning the shared JSON error envelope.

### Next steps / blockers
- Run `pnpm dev-live` on a machine with `ELEVENLABS_API_KEY` set and verify microphone permission, record/stop animation, and transcript insertion in the Tauri shell.

<!-- 
AGENTS: Add new entries above this comment. Format:

## [YYYY-MM-DD] — Brief title

**Status:** Done / In Progress / Blocked
**Agent:** Claude / OpenCode / Codex / etc.

### What was done
- ...

### Files changed
- `path/to/file.ts` — what changed

### Issues encountered
- ...

### Next steps / blockers
- ...
-->

## [2026-05-22] — Fix Home Chat silent streaming failure

**Status:** Done
**Agent:** Codex

### What was done
- Reproduced the Home Chat failure through the authenticated `/api/chat/sessions/:id/messages` stream and confirmed user messages were saving while assistant replies were not visible.
- Found the running dev stack was stale and still using the inaccessible old Fireworks model config; restarted `pnpm dev-live` cleanly with the current `kimi-k2p6` Fireworks settings.
- Updated the desktop chat stream client to understand the backend's flat SSE chunk shape for `tool_call_start`, `tool_result`, `assistant_final`, and `error` events.
- Added visible assistant-side error messages so provider/config failures no longer look like the composer did nothing.
- Rendered in-flight tool calls while the model is working, so tool-first answers show progress before text starts streaming.
- Removed the duplicate terminal `done` SSE event from the chat route.
- Cleared a stale Prisma migrate advisory lock left by the failed startup attempt, then relaunched the Tauri live app.
- Verified the live stream against real project data; the endpoint loaded the selected project and answered `Memolane` from persisted OpenLinear data.

### Files changed
- `apps/desktop-ui/lib/api/chat.ts` — aligned chat stream types/error parsing with backend SSE chunks.
- `apps/desktop-ui/hooks/use-chat-stream.tsx` — normalized stream chunks, surfaced provider failures, and preserved in-flight tool state.
- `apps/desktop-ui/components/chat/chat-message-list.tsx` — displays active tool calls while streaming.
- `apps/desktop-ui/app/(app)/page.tsx` — passes active streaming tool calls into the message list.
- `apps/api/src/routes/chat.ts` — avoids writing a second `done` event after the orchestrator already emitted one.
- `ISSUES.md` — recorded this session.

### Issues encountered
- `pnpm dev-live` initially failed because Prisma could not acquire its advisory migration lock; a previous dead connection still held lock `72707369` and was terminated safely.
- A direct smoke test that piped through `sed` aborted one stream early; reran without truncating and confirmed a clean final response.

### Next steps / blockers
- Keep the current `pnpm dev-live` session open; sidecar is healthy on `127.0.0.1:3001`, Next is healthy on `127.0.0.1:3000`, and Tauri has launched.

## [2026-05-22] — Fix historical Home Chat tool-call crash

**Status:** Done
**Agent:** Codex

### What was done
- Fixed the runtime `name.replace` crash in the Home Chat tool-call card.
- Normalized historical/persisted tool calls from both the flat UI shape and the OpenAI-compatible nested `function.name` / `function.arguments` shape.
- Added a defensive fallback label so malformed or old tool-call records render as `Tool` instead of crashing the chat page.
- Verified the desktop UI typecheck and confirmed the live sidecar and Next dev server are still healthy.

### Files changed
- `apps/desktop-ui/lib/api/chat.ts` — widened persisted tool-call types to include nested OpenAI-compatible function metadata.
- `apps/desktop-ui/hooks/use-chat-stream.tsx` — normalized loaded history tool calls before rendering.
- `apps/desktop-ui/components/chat/tool-call-card.tsx` — made tool-name formatting defensive.
- `ISSUES.md` — recorded this fix.

### Issues encountered
- The crash was triggered by historical assistant messages whose `toolCalls` JSON was stored as `{ function: { name, arguments } }`, while the UI expected `{ name, arguments }` directly.

### Next steps / blockers
- Refresh or reopen the Home Chat page; the dev server is still running and should hot-reload the fix.

## [2026-05-22] — Render Markdown in Home Chat assistant messages

**Status:** Done
**Agent:** Codex

### What was done
- Updated Home Chat assistant bubbles to render Markdown instead of showing raw syntax like `**bold**` and pipe tables.
- Reused the app's existing safe Markdown renderer with GFM support, so assistant messages can show bold, italic, lists, inline code, links, and tables.
- Kept user messages as plain text so user-entered content is not unexpectedly formatted.
- Added prompt guidance so the model uses Markdown sparingly for meaningful emphasis rather than decorative asterisks.
- Verified desktop UI and API typechecks, plus live Next/sidecar health.

### Files changed
- `apps/desktop-ui/components/chat/chat-message.tsx` — renders assistant messages through `MarkdownView` while leaving user messages plain.
- `apps/api/src/lib/chat-prompts.ts` — added restrained Markdown guidance for model answers.
- `ISSUES.md` — recorded this fix.

### Issues encountered
- None.

### Next steps / blockers
- Refresh Home Chat if the current page has not hot-reloaded yet; assistant Markdown tables should render as tables.

## [2026-05-22] — Fix aborted Home Chat bulk status updates

**Status:** Done
**Agent:** Codex

### What was done
- Added a dedicated `bulk_update_issues` Home Chat tool so commands like “move all issues to completed” update the selected project in one database-backed operation instead of asking the model to loop individual issue moves.
- Mapped user-facing `completed` wording to the persisted `done` issue status.
- Compacted historical tool outputs before sending them back to the model, reducing oversized chat context from large issue lists.
- Fixed chat stream cancellation so normal POST request completion no longer aborts the provider fetch; cancellation now tracks actual client disconnect/response close.
- Verified the live chat command against Memolane; the model called `bulk_update_issues`, updated 5 remaining issues, and the project now has 15/15 non-archived issues in `done`.

### Files changed
- `apps/api/src/services/tasks.ts` — added atomic bulk task-status update service with permission checks, broadcasts, and activity logs.
- `apps/api/src/services/chat-tools/domain.ts` — registered the `bulk_update_issues` tool and completed→done status mapping.
- `apps/api/src/services/chat-tools/types.ts` — added the new chat tool name.
- `apps/api/src/lib/chat-prompts.ts` — instructed the model to use bulk updates for many issue status changes.
- `apps/api/src/services/chat.ts` — compacted large tool history payloads before replaying them to the model.
- `apps/api/src/routes/chat.ts` — fixed stream abort handling to avoid aborting valid in-flight model calls.
- `apps/api/src/__tests__/chat.tools.test.ts` — updated registry coverage and added a bulk status update regression test.

### Issues encountered
- The original failed chat turn saved only the user message and no tool call; the model request was likely being aborted before it could act, and large prior tool history made the next turn more fragile.

### Next steps / blockers
- None for this command path. API typecheck, API tests, diff check, API health, and Next health all passed.

## [2026-05-22] — Add Home Chat issue archive/delete action

**Status:** Done
**Agent:** Codex

### What was done
- Added an `archive_issues` Home Chat tool so delete/remove/clear issue requests can move active issues out of the board instead of refusing.
- Kept the action aligned with the existing API behavior: deleting active issues archives them first; it does not permanently purge records from the database.
- Supported archiving all active issues in the selected project, or targeted issues by UUID/identifier.
- Updated the Home Chat system prompt so the model uses the archive tool for issue delete/remove requests and explains the soft-delete behavior honestly.
- Added regression coverage for archiving all active project issues through the chat tool registry.

### Files changed
- `apps/api/src/services/tasks.ts` — added bulk archive service with full-access checks, team role checks, broadcasts, and activity logs.
- `apps/api/src/services/chat-tools/domain.ts` — registered `archive_issues` and updated tool drift count.
- `apps/api/src/services/chat-tools/types.ts` — added the new chat tool name.
- `apps/api/src/lib/chat-prompts.ts` — replaced the previous “no delete tools” instruction with archive/delete guidance.
- `apps/api/src/services/chat.ts` — compacted archive tool results in model history.
- `apps/api/src/__tests__/chat.tools.test.ts` — updated registry count and added archive regression coverage.

### Issues encountered
- Home Chat previously had no delete/archive tool, so the model correctly refused even though the REST API already supports soft-delete via archive.

### Next steps / blockers
- None. API typecheck, API tests, diff check, API health, and Next health passed.

## [2026-05-22] — Fix Kanban column task scrolling

**Status:** Done
**Agent:** Codex

### What was done
- Fixed the board layout so each Kanban column has a bounded height and its task list can scroll independently.
- Added the missing `min-h-0` and `overflow-hidden` constraints around the board and column containers.
- Kept column bodies vertically scrollable during drag operations instead of switching them to visible overflow.
- Matched the loading skeleton layout to the real board so the page does not jump between loading and loaded states.

### Files changed
- `apps/desktop-ui/components/board/column.tsx` — made the column and task lane shrinkable/scrollable.
- `apps/desktop-ui/components/board/kanban-board.tsx` — bounded the board/grid container height and prevented vertical overflow leakage.
- `apps/desktop-ui/components/board/dashboard-loading.tsx` — mirrored the fixed scroll layout in the skeleton state.

### Issues encountered
- The column body already had `overflow-y-auto`, but parent flex/grid items did not have `min-h-0`, so the child expanded instead of becoming the scroll container.

### Next steps / blockers
- None. Desktop UI typecheck, diff check, and Next dev server health passed.

## [2026-05-22] — Add generic Home Chat project setup operation

**Status:** Done
**Agent:** Codex

### What was done
- Added a generic `setup_project_plan` Home Chat tool so the agent can set a project deadline, create/update labels, and create many labeled issues in one grounded operation.
- Kept the implementation domain-agnostic: no Gmail/DLP templates or hardcoded project content; the model must still derive the actual task plan from the user's request and tool-visible workspace/project context.
- Made the project setup service resolve labels by name, validate dates, skip duplicate active issue titles, and return structured created/skipped/failed records.
- Strengthened Home Chat prompt rules so the model uses the one-shot setup operation for multi-issue setup requests and never claims records changed until a mutating tool returns `ok=true`.
- Improved LLM request abort/timeout handling so provider aborts are surfaced as structured chat errors instead of raw “operation was aborted” messages, and raised the default provider timeout to 60 seconds.
- Added regression coverage for the new operation creating labels, assigning colors, setting a deadline, and creating labeled issues.

### Files changed
- `apps/api/src/services/project-plan.ts` — new generic project setup service for labels, target date, and bulk issue creation.
- `apps/api/src/services/chat-tools/domain.ts` — registered `setup_project_plan` and added argument coercion for labels/tasks by name.
- `apps/api/src/services/chat-tools/types.ts` — added the new chat tool name.
- `apps/api/src/lib/chat-prompts.ts` — taught the agent when to use setup operations and to only report successful mutations after tool success.
- `apps/api/src/lib/chat-llm.ts` — added structured timeout/abort mapping and a longer default Fireworks request timeout.
- `.env.example` — updated `CHAT_LLM_TIMEOUT_MS` default documentation to 60000.
- `apps/api/src/__tests__/chat.tools.test.ts` — updated tool count and added setup operation regression coverage.

### Issues encountered
- The previous chat flow could get stuck after creating labels because the model had to perform several separate write calls and then continue generating a large plan under the provider timeout.
- I did not manually create real project tasks during this fix; the goal was to add the capability so Home Chat can do it through its own grounded tool path.

### Next steps / blockers
- Retry the same Home Chat command or send “Continue” in that chat; it should now prefer the single setup operation instead of the fragile label-by-label flow.
- API typecheck, full API test suite, targeted chat tool test, and diff check passed.

## [2026-05-22] — Stop local dev services for the day

**Status:** Done
**Agent:** Codex

### What was done
- Stopped the local OpenLinear development stack, including the Next desktop UI, API/sidecar process, Tauri sidecar listener, and related pnpm dev-live processes.
- Stopped the additional local Vite dev service that was listening on port 5173.
- Verified the usual OpenLinear/local dev ports are no longer listening: 3000, 3001, 3002, 3003, 1455, 45678, and 5173.

### Files changed
- `ISSUES.md` — recorded service shutdown.

### Issues encountered
- A Codex multi-auth helper remains listening on an internal localhost port; I left it running because it belongs to the active Codex session rather than the OpenLinear app/dev stack.

### Next steps / blockers
- Restart tomorrow with `pnpm start` or `pnpm dev-live` when ready.

## [2026-05-22] — Repair Kanban board task creation and selection flow

**Status:** Done
**Agent:** Codex

### What was done
- Fixed board-local task insertion so tasks created from column buttons appear immediately in the right filtered view instead of waiting for an unrelated refresh.
- Added shared board state helpers for task upsert/deduplication, optimistic task replacement, and active batch lock detection.
- Dedupe SSE-created tasks and optimistic creates by id so a task does not appear twice after realtime events arrive.
- Added support for `tasks:bulk-created` SSE events so generated queues can refresh the board consistently.
- Made selection/delete callbacks read current state through refs so memoized task cards do not use stale task lists or deletion mode.
- Removed the completed-batch wrapper from the Done column so finished batch tasks behave like normal draggable/selectable/archiveable cards.
- Fixed permanent delete activity logging so the delete audit row is written before the task row is removed.
- Added regression coverage for task upsert, optimistic replacement, and locked batch task ids.

### Files changed
- `apps/desktop-ui/components/board/board-state.ts` — new board state helpers for upsert, optimistic replacement, and batch lock detection.
- `apps/desktop-ui/components/board/board-state.test.mjs` — regression coverage for the new helper behavior.
- `apps/desktop-ui/components/board/board-state.test.ts` — removed the TS Vitest file so desktop `tsc` does not require Vitest globals.
- `apps/desktop-ui/components/board/use-kanban-board.ts` — repaired create/SSE/delete/selection state flow and active batch locking.
- `apps/desktop-ui/components/board/kanban-board.tsx` — wired task form creation into board state and aligned selection bar deletion mode.
- `apps/desktop-ui/components/board/done-column-content.tsx` — simplified Done column rendering by deleting the completed-batch drag wrapper.
- `apps/desktop-ui/components/board/unified-selection-bar.tsx` — labels bulk remove as Archive or Delete based on user setting.
- `apps/desktop-ui/components/board/task-card.tsx` — included deletion mode in memo comparison.
- `apps/desktop-ui/components/task-form.tsx` — returns the created task to callers instead of only triggering a blind refresh.
- `apps/desktop-ui/providers/sse-provider.tsx` — registered `tasks:bulk-created`.
- `apps/desktop-ui/types/task.ts` — added optional `projectId` for board task events.
- `apps/api/src/routes/tasks.ts` — logs permanent delete activity before deleting the task.
- `apps/api/src/__tests__/tasks.test.ts` — added permanent-delete regression coverage.

### Issues encountered
- `pnpm --filter @openlinear/api test -- tasks.test.ts` is blocked before tests run because the current local database is missing the `teams.project_id` column expected by Prisma.
- The sidecar dev smoke path is blocked by missing package `@elevenlabs/elevenlabs-js` imported from `apps/sidecar/src/routes/transcribe.ts`; the plain API server is healthy on port 3001.

### Next steps / blockers
- Sync the local test database schema before relying on the full API task test suite.
- Either add/install the ElevenLabs dependency or make the transcribe route lazy/optional before using the sidecar dev server.

## [2026-05-22] — Clear Kanban verification environment blockers

**Status:** Done
**Agent:** Codex

### What was done
- Restored the already-declared `@elevenlabs/elevenlabs-js` package into `node_modules` with `pnpm install`.
- Synced the local `openlinear_test` database to the current Prisma migrations, including the `teams.project_id` migration that had blocked `tasks.test.ts`.
- Fixed root database helper scripts so `pnpm db:push` and `pnpm db:studio` target the real `@openlinear/db` workspace package.
- Verified the sidecar starts successfully on port 3003 and returns a healthy `/health` response.
- Re-ran the previously blocked task API test and the full API test suite.

### Files changed
- `package.json` — corrected root `db:push` and `db:studio` workspace filters.
- `ISSUES.md` — recorded the blocker cleanup.

### Issues encountered
- `prisma db push` refused to continue without data-loss acknowledgement because the local test DB was behind several migrations; I applied the missing team-project migration and then deployed the remaining migrations normally.
- Sidecar startup runs its recovery sweep; during the smoke test it marked one stale orphan in-progress task as cancelled, which is the sidecar's boot-time recovery behavior.

### Next steps / blockers
- None for these blockers. API tests and sidecar health now pass locally.

## [2026-05-22] — Align batch execution modes with board activity display

**Status:** Done
**Agent:** Codex

### What was done
- Made Parallel Execution launch every selected issue at once instead of limiting the first wave by `maxBatchSize`.
- Routed Combined Execution activity to one virtual batch activity stream (`batch:<id>`) instead of broadcasting identical progress/log events to every selected issue.
- Kept per-issue activity for Parallel Execution and only the currently running issue in Queue Execution.
- Updated the board progress panel to use explicit labels: Parallel Execution, Queue Execution, and Combined Execution.
- Added queue step numbering, parallel lane numbering, and combined issue numbering in the In Progress grouped card.
- Added a combined activity/log preview in the top batch progress panel so combined mode has one visible activity surface.
- Suppressed stale per-card activity for queued queue items and all combined items.
- Added regression coverage for batch mode labels and combined batch activity ids.

### Files changed
- `apps/sidecar/src/services/batch.ts` — corrected parallel launch semantics and combined batch-level activity/log routing.
- `apps/desktop-ui/components/board/batch-mode.ts` — added explicit execution labels and virtual batch activity id helper.
- `apps/desktop-ui/components/board/batch-mode.test.mjs` — covered execution labels and batch activity ids.
- `apps/desktop-ui/components/board/batch-progress.tsx` — made the top progress panel mode-aware and added combined log preview.
- `apps/desktop-ui/components/board/in-progress-batch-group.tsx` — added mode headings, queue/parallel numbering, and per-item status markers.
- `apps/desktop-ui/components/board/task-card.tsx` — allowed batch groups to suppress per-card activity where mode semantics require it.
- `apps/desktop-ui/components/board/kanban-board.tsx` — showed explicit execution mode names in board workflow metadata.

### Issues encountered
- The previous Combined Execution path reused task-scoped execution events, which made every selected issue card show the same activity. That was the root cause of duplicated combined activity.
- An old sidecar smoke process was still holding port 3003; I cleaned it up and reran the smoke on clean ports.
- `apps/api/Dockerfile` is dirty in the worktree but unrelated to this execution-mode pass, so I left it untouched.

### Next steps / blockers
- None. Desktop helper tests, desktop typecheck, sidecar typecheck, API typecheck, MCP typecheck, full API tests, diff check, and sidecar health smoke passed.

## [2026-05-22] — Stabilize board dragging, stale execution state, and startup preview

**Status:** Done
**Agent:** Codex

### What was done
- Reworked single-card drag state updates so dropping a Done card back into All Issues preserves the destination order instead of appending and overlapping stale rendered cards.
- Cleared live execution progress when tasks leave In Progress or are deleted, including API-side cleanup of session, elapsed timer, progress, and batch linkage on manual terminal/todo transitions.
- Restricted card timers/activity to real active In Progress execution so Done/All Issues cards do not keep running stale timers after being moved.
- Added regression coverage for same-column reorder, cross-column insertion order, and execution state cleanup when moving out of In Progress.
- Repaired `pnpm start` production preview by serving the static export on the requested port with a local Node server, avoiding `serve` random-port fallback, making shutdown idempotent, cleaning stale OpenLinear-owned ports, retrying transient Prisma migrate locks, and running the sidecar without `tsx watch`.
- Fixed sidecar graceful shutdown so already-closed servers do not surface noisy `ERR_SERVER_NOT_RUNNING` failures.

### Files changed
- `apps/desktop-ui/components/board/board-state.ts` — added status-change and ordered drag-move helpers.
- `apps/desktop-ui/components/board/board-state.test.mjs` — added drag ordering and stale execution cleanup regressions.
- `apps/desktop-ui/components/board/use-kanban-board.ts` — wired ordered drag destination updates and live progress cleanup.
- `apps/desktop-ui/components/board/task-card.tsx` — stopped stale timers/activity from rendering outside active execution states.
- `apps/desktop-ui/lib/execution-state-store.ts` — added execution progress removal support.
- `apps/api/src/routes/tasks.ts` — clears execution and batch state when tasks are manually moved out of active execution.
- `apps/api/src/__tests__/tasks.test.ts` — covers API-side execution state cleanup.
- `scripts/start-prod-preview.sh` — made startup, port handling, migration retry, static serving, and shutdown robust.
- `scripts/serve-static.mjs` — added exact-port static export server.
- `apps/sidecar/package.json` — added one-shot dev command for preview startup.
- `apps/sidecar/src/index.ts` — hardened graceful shutdown.

### Issues encountered
- Real multi-issue agent execution was not run end-to-end because it would launch external agent work and mutate task execution state; helper tests and sidecar service tests cover the execution-mode logic.

### Next steps / blockers
- None for the pnpm startup path. API Docker image verification is intentionally out of scope for local `pnpm start` / `pnpm dev` usage.

## [2026-05-22] — Keep Docker scoped to Postgres for pnpm flows

**Status:** Done
**Agent:** Codex

### What was done
- Reverted the API Dockerfile change from this task so API image build work is no longer part of the current fix.
- Kept Docker usage in `pnpm dev`, `pnpm dev:web`, `pnpm dev-live`, `pnpm start`, and live deploy scoped to the Postgres database only.
- Changed local database startup to use the explicit `postgres` compose service instead of an unconstrained compose startup.
- Left API, sidecar, UI, static preview, and Tauri startup as direct `pnpm`/Node processes.
- Remote `DATABASE_URL` flows now skip Docker entirely.

### Files changed
- `scripts/dev.sh` — starts only the Postgres container when `DATABASE_URL` is local.
- `scripts/dev-web.sh` — starts only the Postgres container when `DATABASE_URL` is local.
- `scripts/dev-live.sh` — starts only the Postgres container when `DATABASE_URL` is local.
- `scripts/start-prod-preview.sh` — keeps preview runtime on pnpm/Node while allowing DB-only Docker fallback.
- `scripts/deploy.sh` — starts or skips only the database container based on `DATABASE_URL`.
- `ISSUES.md` — corrected the previous Docker verification note.

### Issues encountered
- No API/UI Docker build was run. That is intentional for this task because it is slow and unrelated to the reported pnpm startup and board behavior.

### Next steps / blockers
- None for Docker scope. Use Docker only for local Postgres; do not use Docker to run the API/UI for these pnpm workflows.

## [2026-05-22] — Built standalone MCP docs site + landing nav swap

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Built a brand-new MCP-only docs site at `apps/mcp-docs/` (Next.js 16 App Router, port 3004) that replicates the landing-page theme exactly: HSL CSS vars, Space Grotesk + DM Sans + EB Garamond + DM Mono fonts, glass-card / hero-reveal / section-divider, custom scrollbar, focus ring, `tailwindcss-animate`, `next-themes` with `forcedTheme=dark`.
- App shell with fixed pill header, sticky sidebar nav (4 sections, 18 routes), footer, prev/next pager, copy-button code blocks, callouts, tool cards.
- Wrote 19 MCP-only content pages covering: intro, quickstart, authentication (PAT format `ol_pat_<32hex>`, SHA-256 hashing, scopes), client setup for Claude Desktop / OpenCode / Cursor+Continue+custom SDK, full tool reference for the actual 12-tool surface (workspaces / projects / teams / labels / phases / issues / `bulk_create_plan`), and 3 guides (plan-from-prompt, phase-naming, troubleshooting).
- Updated `apps/landing/components/header.tsx`: replaced `/docs Docs` link with an `MCP` link (both desktop NavLink and mobile MobileNavLink, opens in a new tab) pointing at the new docs site.
- Deployed `apps/mcp-docs` to Vercel production: `https://mcp-docs-gqyo74qsn-kaizen403s-projects.vercel.app`, aliased to `https://mcp-docs-one.vercel.app`.
- Redeployed `apps/landing` so the new MCP header link is live; aliased to `https://rixie.in`.

### Files changed
- `apps/mcp-docs/` — new app (package.json, tsconfig.json, next.config.mjs, postcss.config.js, tailwind.config.ts, app/globals.css, app/layout.tsx, app/not-found.tsx, lib/cn.ts, lib/nav.ts, components/{header,sidebar,footer,page-nav,code-block,callout,tool-card,theme-provider}.tsx, plus content pages under app/, app/quickstart, app/authentication, app/clients/*, app/tools/* (index + 7 tool pages including bulk-create-plan), app/guides/*)
- `apps/landing/components/header.tsx` — replaced `/docs` Docs nav link with an MCP link pointing to `https://mcp-docs-one.vercel.app` (desktop + mobile)

### Issues encountered
- Mintlify docs site (`docs.openlinear.tech`) was abandoned in favor of an in-monorepo Next.js app per user request. Mintlify repo is no longer the source of truth for MCP docs.
- `mcp.openlinear.tech` custom domain on Cloudflare is reserved for the MCP Worker, not docs. Header link uses the Vercel alias for now; no DNS work needed.

### Next steps / blockers
- Optional: wire `docs.openlinear.tech` or `mcp-docs.openlinear.tech` as a Vercel custom domain when desired and update the landing header href.
- Optional: add automated build to `turbo.json`/CI for `@openlinear/mcp-docs` so content changes ship via standard pipeline.

## [2026-05-22] — Extract execution batch core package

**Status:** Done
**Agent:** Codex

### What was done
- Added `@openlinear/execution-core` as a pure workspace package for batch execution types, mode labels, branch/state construction, prompt builders, progress summaries, and API response shaping.
- Rewired sidecar batch routes and runtime service to import deterministic batch rules from the package while keeping Prisma, SSE, worktree, Git, OpenCode, and PR side effects in the sidecar.
- Moved the old sidecar batch-mode regression coverage into the package and expanded it to cover task state, combined prompt ordering, progress summaries, and serializable responses.
- Verified the sidecar still typechecks and builds against the workspace package import.

### Files changed
- `packages/execution-core/` — new pure package with batch helpers, types, tests, and typecheck config.
- `apps/sidecar/package.json` — depends on `@openlinear/execution-core`.
- `apps/sidecar/src/services/batch.ts` — uses extracted mode, state, prompt, and status helpers.
- `apps/sidecar/src/routes/batches.ts` — uses shared response serializers.
- `apps/sidecar/src/types/batch.ts` — re-exports shared batch types.
- `apps/sidecar/src/services/batch-mode.ts` — removed after extraction.
- `apps/sidecar/src/services/batch-mode.test.mjs` — removed after coverage moved to execution-core.
- `pnpm-lock.yaml` — links the new workspace package for sidecar.

### Issues encountered
- Sidecar typecheck initially could not resolve `@openlinear/execution-core` until pnpm linked the new workspace package.
- The lockfile already contained unrelated dirty workspace changes for `apps/mcp-docs`; those were left in place.

### Next steps / blockers
- None for this refactor. `@openlinear/execution-core` typecheck, focused Vitest coverage, sidecar typecheck, sidecar build, and diff whitespace checks passed.

## [2026-05-22] — Expand execution-core test coverage

**Status:** Done
**Agent:** Codex

### What was done
- Added a package-local `test` script for `@openlinear/execution-core`.
- Expanded execution-core coverage so every exported runtime helper is exercised directly: execution labels, activity ids, launch indexes, branch naming, batch task construction, batch state construction, terminal/queued status helpers, progress summaries, response serializers, and prompt builders.
- Hardened combined prompt title fallback so nullable task-record titles do not render as `null` or `undefined`.

### Files changed
- `packages/execution-core/package.json` — added package-local test command and Vitest dev dependency.
- `packages/execution-core/src/batch/core.test.mjs` — expanded helper and serializer coverage.
- `packages/execution-core/src/batch/prompts.ts` — fixed combined prompt fallback title handling.
- `pnpm-lock.yaml` — records the package-local Vitest dev dependency.

### Issues encountered
- The semantic code search MCP was rate-limited, so direct repo search was used instead.
- `pnpm add` ran the existing `packages/openlinear-cli` postinstall hook; its AppImage download returned 404 but the pnpm command completed successfully.

### Next steps / blockers
- None. `@openlinear/execution-core` tests, `@openlinear/execution-core` typecheck, sidecar typecheck, sidecar build, and diff whitespace checks passed.

## [2026-05-22] — Add sidecar execution workflow tests

**Status:** Done
**Agent:** Codex

### What was done
- Added a sidecar-local `test` script and Vitest dev dependency.
- Added execution workflow tests for task execution lifecycle, event stream handling, recovery, agent run persistence, execution state, git execution helpers, subprocess execution, execution settings, and public exports.
- Added route-level tests for execute, running, logs, cancel, and refresh-PR behavior using an in-memory Express app with mocked services.
- Added adjacent workflow helper tests for delta buffering, git credentials, git identity, repo path safety, and worktree operations.
- Kept tests isolated from real OpenCode, real GitHub, real Prisma, and real worktree mutation by mocking those boundaries.

### Files changed
- `apps/sidecar/package.json` — added `test` script and Vitest dev dependency.
- `apps/sidecar/src/services/execution/*.test.mjs` — new coverage for execution service files.
- `apps/sidecar/src/services/execution-settings.test.mjs` — new settings lookup coverage.
- `apps/sidecar/src/routes/execution.test.mjs` — new route wrapper coverage.
- `apps/sidecar/src/services/delta-buffer.test.mjs` — new stream buffer coverage.
- `apps/sidecar/src/services/git-credentials.test.mjs` — new credential helper coverage.
- `apps/sidecar/src/services/git-identity.test.mjs` — new git identity coverage.
- `apps/sidecar/src/services/repo-storage.test.mjs` — new repository path safety coverage.
- `apps/sidecar/src/services/worktree.test.mjs` — new worktree operation coverage.
- `pnpm-lock.yaml` — records sidecar Vitest dev dependency.

### Issues encountered
- The first test run exposed that mocked SSE functions needed to return promises, matching the real broadcaster contract.
- Negative-path worktree and git tests intentionally exercise error logging; the suite passes with expected stderr output from those paths.

### Next steps / blockers
- None. Sidecar tests, sidecar typecheck, sidecar build, execution-core tests, execution-core typecheck, and diff whitespace checks passed.
