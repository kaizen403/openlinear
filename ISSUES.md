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

## Active / Known Issues

| # | Issue | Status |
|---|---|---|
| 5 | Invite flow — proper domain, accept page, OAuth on web | ⏳ Planned (see `.sisyphus/plans/openlinear-issues.md`) |
| 12 | Remove duplicate "Add Task" button at bottom of Kanban columns | ⏳ Planned |
| 13 | Remove blue accent focus outline from input elements | ⏳ Planned |
| 17 | Add "+" button and "Add More Projects" hint to project selector | ⏳ Planned |
| — | API not deployed — `openlinear.tech` still serves landing page only | ⏳ Blocked (Azure deployment planned) |

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
