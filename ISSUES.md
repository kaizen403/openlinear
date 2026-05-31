# OpenLinear — Work Log

> Agents: append an entry here at the end of every session. Format is at the bottom of `AGENTS.md`.
> Read this file at the **start** of every session to know what's in progress and what's broken.

---

## [2026-05-26] — Fix sidecar startup crash (missing openid-client + otpauth + ALLOW_SHARED_OPENCODE)

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Sidecar was crashing at startup with `ERR_MODULE_NOT_FOUND: Cannot find package 'openid-client'`. Root cause: `apps/api/src/services/sso.ts` imports `openid-client` and `apps/api/src/routes/totp.ts` imports `otpauth` — both declared in `apps/api/package.json` but not installed in `node_modules`.
- Ran `pnpm install` at workspace root to pull the missing packages (`+17` packages installed).
- Sidecar was also immediately exiting after recovery due to multi-user guard (`OPENLINEAR_ALLOW_SHARED_OPENCODE` not set, 4 users in DB). Added `OPENLINEAR_ALLOW_SHARED_OPENCODE=1` to `.env` for the dev machine.
- Verified sidecar now starts cleanly: binds port 3001 + 1455, runs recovery, and stays up.

### Files changed
- `.env` — added `OPENLINEAR_ALLOW_SHARED_OPENCODE=1`
- `pnpm-lock.yaml` — updated by `pnpm install` (openid-client, otpauth, and transitive deps)

### Issues encountered
- None after the fix.

### Next steps / blockers
- None. `pnpm dev-live` / `pnpm start` should now boot the sidecar without crashing.

---

## [2026-05-26] — Model provider onboarding step + execution model-not-configured guard

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Added a 4th onboarding step "AI Model" with Back / Finish setup / Skip buttons. Team creation now advances to the new step instead of completing directly. Both Finish and Skip complete onboarding; Skip shows a toast directing the user to Settings.
- Built `ModelProviderStep` component that shows live provider status fetched from the sidecar, lists connected providers, and links to Settings → AI Providers. Handles sidecar-unavailable gracefully (shows retry + lets user skip).
- Added `pickAutoDetectedModel()` pure helper and `ensureModelConfigured(userId)` service in the sidecar. Auto-detection priority: anthropic → openai → google → openrouter → first connected. When a provider is authenticated but no model is selected, the function picks and persists the provider's default model automatically.
- Updated `GET /api/opencode/setup-status` to run auto-detection and return `hasProvider` + `hasModel`. `ready` is now `hasProvider && hasModel` (previously only `hasProvider`), so it correctly reports false when a provider is connected but no model is selected.
- Added pre-flight `ensureModelConfigured` check to `POST /api/tasks/:id/execute` and `POST /api/batches`. Returns `400 { code: 'MODEL_NOT_CONFIGURED', details: { hasProvider } }` with a human-readable message instead of silently starting a doomed agent.
- Added `isModelNotConfiguredApiError()` helper in `lib/api/model-errors.ts` to detect the new error code on the frontend.
- Updated single-execute path (`use-kanban-board.ts`) and batch-execute path (`use-batch-execution.ts`) to catch `MODEL_NOT_CONFIGURED` — toast the specific message and reopen the provider setup dialog automatically.
- Provider setup dialog now distinguishes "no provider" vs "provider connected but no model selected" in toasts.

### Files changed
- `apps/sidecar/src/services/opencode-model.ts` — new file: `pickAutoDetectedModel`, `ensureModelConfigured`
- `apps/sidecar/src/routes/opencode.ts` — `setup-status` uses auto-detect, exposes `hasProvider`/`hasModel`, stricter `ready`
- `apps/sidecar/src/routes/execution.ts` — pre-flight model check on single execute
- `apps/sidecar/src/routes/batches.ts` — pre-flight model check on batch create
- `apps/desktop-ui/lib/api/opencode.ts` — `SetupStatus` extended with `hasProvider`/`hasModel`
- `apps/desktop-ui/lib/api/model-errors.ts` — new file: `isModelNotConfiguredApiError`, `readModelNotConfiguredDetails`
- `apps/desktop-ui/components/board/use-kanban-board.ts` — MODEL_NOT_CONFIGURED handling in single execute + retry path
- `apps/desktop-ui/hooks/use-batch-execution.ts` — MODEL_NOT_CONFIGURED handling in batch execute; improved provider/model-specific toasts
- `apps/desktop-ui/components/onboarding/steps/onboarding-utils.ts` — added "AI Model" to STEP_LABELS
- `apps/desktop-ui/components/onboarding/steps/model-provider-step.tsx` — new file: onboarding step 3 UI
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — wired step 3, `handleFinishOnboarding`, `handleSkipOnboarding`, step clamp bumped to 3

### Issues encountered
- Pre-existing unrelated typecheck failures in `apps/api/` (`totp.ts`, `invitations.ts`, `sso.ts`, `tasks.ts`) for half-built features missing Prisma models and npm packages. Left untouched per protocol.

### Next steps / blockers
- Manually verify: complete onboarding on a fresh workspace → should land on AI Model step → Finish or Skip both enter the app.
- Manually verify: try executing a task/batch with no model configured → should get clear toast + provider dialog opens.
- Consider adding a "model configured" status indicator somewhere on the board (e.g., a subtle warning badge on the Execute buttons when `!status.ready`).

---

## [2026-05-24] — Add Electron desktop wrapper for Linux (fixing WebKitGTK scroll/font issues)

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Created `apps/desktop-electron/` — a minimal Electron main process that wraps the existing Next.js frontend.
- Electron bundles Chromium, eliminating WebKitGTK flexbox scroll bugs, font rendering issues, and compositor stalls on Linux.
- The Electron wrapper replicates all Tauri native APIs via IPC: sidecar spawning, auth deep-link callbacks, window controls (close/minimize/maximize), file picker, external URL open, and store persistence.
- Patched the frontend (`desktop-ui`) to detect Electron runtime and use `window.electronAPI` for all desktop-native operations, while preserving full Tauri compatibility.
- Added `pnpm build:electron:linux` to produce AppImage and .deb packages via `electron-builder`.
- Existing Tauri desktop app is completely preserved; Electron is an additional build target.

### Files changed
- `apps/desktop-electron/src/main.ts` — Electron main process with IPC handlers
- `apps/desktop-electron/src/preload.ts` — contextBridge exposing `electronAPI`
- `apps/desktop-electron/src/sidecar.ts` — sidecar spawning (same binary discovery as Tauri)
- `apps/desktop-electron/electron-builder.json` — build config for Linux/macOS/Windows
- `apps/desktop-ui/lib/api/client.ts` — Electron runtime detection + sidecar URL resolution
- `apps/desktop-ui/lib/api/auth.ts` — desktop login via Electron `shell.openExternal`
- `apps/desktop-ui/hooks/use-auth.tsx` — auth callback via Electron IPC
- `apps/desktop-ui/components/layout/sidebar.tsx` — window controls via Electron IPC
- `apps/desktop-ui/components/desktop/database-settings.tsx` — store via Electron IPC
- `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx` — opencode check via Electron IPC
- `apps/desktop-ui/app/(app)/projects/page.tsx` — folder picker via Electron dialog
- `apps/desktop-ui/lib/utils.ts` — `openExternal` via Electron API
- `package.json` — added `build:electron` and `build:electron:linux` scripts

### Issues encountered
- WebKitGTK on Linux is fundamentally broken for modern CSS (flexbox scroll, variable fonts, backdrop filters). The only real fix is replacing the webview engine.
- TypeScript strict mode required careful null checks for `window.electronAPI` optional property.

### Next steps / blockers
- Test the Electron build on a real Linux machine. The AppImage should work out of the box.
- Evaluate installer size tradeoff (~150MB Electron vs ~15MB Tauri) for Linux users.

---

## [2026-05-23] — Add onboarding back controls and chat thinking loader

**Status:** Done
**Agent:** Codex

### What was done
- Added a safe Back path from onboarding Team setup, including the teamless-project repair flow.
- Made the previous Project step read-only when backing up from an existing teamless project, preventing duplicate project creation.
- Added a theme-matched chat Thinking loader for the interval after sending a prompt and before assistant text or tool calls stream in.
- Extended the onboarding/chat regression guard to cover the back path and chat thinking state.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — back controls, read-only existing-project step, duplicate-project guard.
- `apps/desktop-ui/components/chat/chat-message-list.tsx` — transient Thinking loader row.
- `apps/desktop-ui/app/(app)/page.tsx` — computes and passes chat thinking state.
- `scripts/verify-onboarding-repo-scroll.mjs` — added source guards for back controls and chat loader.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The worktree still has unrelated dirty API/MCP/schema/lockfile changes; they were left untouched.

### Next steps / blockers
- Manually send a chat message and confirm the Thinking loader disappears when text or tool cards begin streaming.

## [2026-05-23] — Require team setup for teamless onboarding projects

**Status:** Done
**Agent:** Codex

### What was done
- Traced the `Project must have a team` error to task creation resolving a team from the selected project.
- Kept onboarding active when an existing project has no team, so users are sent directly to Team setup instead of entering the app in a broken state.
- Loaded project teams in the shared project context so teamless projects can be detected reliably.
- Prefilled the Team step from the project name and tightened the copy around team keys as issue prefixes.
- Extended the onboarding regression script to guard the teamless-project workflow.

### Files changed
- `apps/desktop-ui/app/(app)/page.tsx` — detects teamless projects and passes them into onboarding.
- `apps/desktop-ui/hooks/use-project.tsx` — includes project teams in the shared project fields.
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — supports existing-project Team setup mode with default team naming.
- `scripts/verify-onboarding-repo-scroll.mjs` — added guards for teamless-project onboarding.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The worktree still has unrelated dirty API/MCP/schema/lockfile changes; they were left untouched.

### Next steps / blockers
- Manually confirm that a project with no team opens onboarding on Team setup and issue creation succeeds after finishing.

## [2026-05-23] — Fix onboarding project Continue and compact the card

**Status:** Done
**Agent:** Codex

### What was done
- Fixed the Project-step Continue no-op when onboarding opens for an existing workspace by passing the active workspace id into the wizard and using it for project creation.
- Persisted created workspace/project ids in the onboarding draft so restored steps keep the ids required by later actions.
- Tightened the onboarding layout: smaller step indicator, icon, inputs, buttons, card padding, repository rows, and repository list height.
- Removed page-level scrolling from the onboarding shell while keeping the bounded repository results list scrollable inside the card.
- Extended the onboarding repo-picker regression script to guard the existing-workspace Continue path and no-page-scroll wrapper.

### Files changed
- `apps/desktop-ui/app/(app)/page.tsx` — passes the existing workspace id into onboarding and hides page-level overflow for the onboarding surface.
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — workspace id fallback for Continue, draft id persistence, compact card sizing.
- `scripts/verify-onboarding-repo-scroll.mjs` — added source guards for the Continue fallback and onboarding wrapper overflow.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The worktree still has unrelated dirty API/MCP/schema/lockfile changes; they were left untouched.

### Next steps / blockers
- Manually try the existing-workspace onboarding path with a connected GitHub account and confirm Continue advances to Team after repo selection.

## [2026-05-23] — Add repo logos and exact search to onboarding picker

**Status:** Done
**Agent:** Codex

### What was done
- Added owner avatars back to onboarding repository results with lazy loading, async decoding, and an inline fallback so the capped search list keeps its performance guardrails.
- Improved the repository search input copy and added a clear-search control.
- Added authenticated exact `owner/repo` lookup ahead of GitHub repository search so direct slugs return a top result even when normal repository search ranking is poor.
- Extended API tests for exact repository lookup and updated the onboarding repo-picker performance guard to allow only lazy/async avatars in the capped result list.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — capped repo avatars, clearer search prompt, clear control.
- `apps/api/src/services/github.ts` — exact authenticated repo lookup for `owner/repo` queries.
- `apps/api/src/__tests__/repos.test.ts` — coverage for exact repo lookup precedence and avatar payload preservation.
- `scripts/verify-onboarding-repo-scroll.mjs` — updated source guard for lazy/async repo logos.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The worktree contains unrelated dirty API/MCP/schema/lockfile changes; they were left untouched.

### Next steps / blockers
- Re-run onboarding, search by repo name or `owner/repo`, and confirm the selected repo shows its owner logo without reintroducing scroll lag.

## [2026-05-23] — Replace onboarding repo browsing with search-only picker

**Status:** Done
**Agent:** Codex

### What was done
- Removed browsing/scrolling through connected GitHub repositories from onboarding.
- Changed the GitHub picker to search-only with a hard cap of 8 results, so opening the connector does not pull repo pages and selection no longer depends on scrolling through a list.
- Removed automatic branch-list fetching after repository selection; onboarding now uses the selected repo default branch and leaves the branch field editable.
- Added a dependency-free Chromium performance regression check that asserts the lightweight repo-picker invariants and measures the capped list scroll path.
- Wired the repo-picker performance check into the desktop UI test script.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — search-only GitHub repo picker, no browse/load-more, no branch fetch, capped result list.
- `apps/desktop-ui/package.json` — runs the onboarding repo-picker performance check during `pnpm --filter @openlinear/desktop-ui test`.
- `scripts/verify-onboarding-repo-scroll.mjs` — source guards plus headless Chromium scroll timing check.
- `ISSUES.md` — recorded this fix.

### Issues encountered
- Existing unrelated worktree changes are present in API files, `next-env.d.ts`, and `pnpm-lock.yaml`; they were left untouched.

### Next steps / blockers
- Re-run onboarding and search for a repo by name instead of scrolling through connected repositories.

## [2026-05-23] — Remove virtualized scrolling from onboarding repo picker

**Status:** Done
**Agent:** Codex

### What was done
- Removed `@tanstack/react-virtual` from the onboarding GitHub repo picker because the picker only loads small pages and the virtualizer was adding React work on every scroll frame.
- Switched the repo picker to a plain browser-native scroll container with contained, lightweight repository rows.
- Kept the reduced row rendering from the previous pass: no avatar image loads, no pushed-date formatting, no star metadata in the hot scroll path.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — replaced virtualized repo scrolling with a native contained scroll list.
- `ISSUES.md` — recorded this follow-up fix.

### Issues encountered
- Could not reproduce with a live GitHub account in this environment, so verification is build/type-level plus code-path inspection.

### Next steps / blockers
- Re-run onboarding with a large connected GitHub account and scroll the repo list; if it still stalls, capture renderer console logs or a performance trace around the stall.

## [2026-05-23] — Fix production preview startup after stale dev server

**Status:** Done
**Agent:** Codex

### What was done
- Diagnosed `pnpm start` hanging at static-server startup as a stale Next dev server still bound to port `3000`.
- Stopped the stale dev-server process that was blocking the production static server.
- Hardened `scripts/start-prod-preview.sh` so port cleanup can discover listeners via `lsof`, `fuser`, or `ss`, avoiding the same startup failure when one tool misses a process.

### Files changed
- `scripts/start-prod-preview.sh` — added fallback listener detection for stale OpenLinear port cleanup.
- `ISSUES.md` — recorded this startup fix.

### Issues encountered
- The stale dev server had also hit a Turbopack cache panic after `.next` was removed during production startup.
- The current failed `pnpm start` attempt had already exited after the static server failed to bind, so it needs to be rerun.

### Next steps / blockers
- Run `pnpm start` again now that port `3000` is clear.

## [2026-05-23] — Reduce onboarding GitHub repo scroll cost

**Status:** Done
**Agent:** Codex

### What was done
- Simplified the onboarding GitHub repo row so scrolling no longer mounts GitHub avatar images for every newly visible repository.
- Removed pushed-date and star metadata from the hot scroll row to avoid extra icon rendering and per-row date formatting during virtualization.
- Reduced virtualized row height and overscan so fewer repo rows render around the viewport.
- Added row-level CSS containment to reduce paint/layout work while scrolling.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — simplified and contained repository rows, reduced virtualizer overscan, and kept the earlier user-initiated repo loading changes.
- `apps/desktop-ui/lib/api/repos.ts` — retained the short GitHub repo page cache from the previous pass.
- `ISSUES.md` — recorded this follow-up fix.

### Issues encountered
- Could not reproduce against a live GitHub account from this environment; fix is based on the reported scroll-only lag and the row render path.

### Next steps / blockers
- Manually verify the onboarding GitHub repo picker against an account with many repositories and organizations.

## [2026-05-23] — Stop onboarding from auto-pulling GitHub repositories

**Status:** Done
**Agent:** Codex

### What was done
- Kept the onboarding repository connector collapsed by default, even when restoring a draft with a previously selected repository.
- Preserved the selected repository as a compact summary in the collapsed connector so onboarding no longer pulls repositories and branches just because the page mounted.
- Added a short browser-side cache for GitHub repository pages and removed hot-path console logging from repo fetches.
- Stopped one-character repository searches from triggering GitHub search requests.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — made repo/branch loading user-initiated on restored onboarding drafts and reduced search request churn.
- `apps/desktop-ui/lib/api/repos.ts` — cached GitHub repo page responses in the desktop UI client and shortened the client timeout.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The codebase search MCP was rate-limited, so investigation used direct repository search.

### Next steps / blockers
- Manually verify onboarding with a GitHub account that has many repos/orgs to confirm the page opens without background GitHub pulls and cached picker reloads feel instant.

## [2026-05-23] — Stabilize onboarding repository list and branch refresh

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Fixed the onboarding repository list so the virtualizer gets an explicit viewport height instead of relying on child layout through containment.
- Cleared stale branch suggestions immediately when the selected repository changes or while the debounced branch request is pending.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — explicit repo-list viewport height and stale branch-name clearing.
- `ISSUES.md` — recorded this follow-up fix.

### Issues encountered
- The previous containment fix made rows visible but still left the virtualized viewport dependent on unstable layout behavior.

### Next steps / blockers
- Manually verify repeated Load more clicks, deep scrolling, and switching between repositories with different branch sets.

---

## [2026-05-23] — Fix onboarding repository list visibility regression

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Fixed the onboarding GitHub repository picker regression where repositories loaded but the virtualized list area collapsed, leaving only the Load more button visible.
- Replaced strict size containment on the repository scroll container with content containment so virtual rows can size the viewport while preserving render isolation.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — changed repo-list container containment from `strict` to `content`.
- `ISSUES.md` — recorded this regression fix.

### Issues encountered
- Morph edit quota was exhausted, so the fix used a native patch.

### Next steps / blockers
- Manually verify the onboarding repository list renders rows and Load more appends visible repositories.

---

## [2026-05-23] — Improve onboarding GitHub repository picker performance

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Reduced onboarding repo-picker render work by using fixed-height virtual rows, lower overscan, stable item keys, CSS containment, and a stable repo-select callback.
- Added cancellation for overlapping GitHub repo-list requests so stale searches/filter changes stop doing useless work.
- Debounced branch lookups and added abortable, timed frontend branch fetches with a short client-side cache.
- Cached GitHub branch lists and organization membership server-side, and capped repository search fan-out to the first five org scopes.
- Added tests for branch caching and capped organization search behavior.

### Files changed
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — optimized repo virtual list rendering and debounced/cancelled branch loading.
- `apps/desktop-ui/lib/api/repos.ts` — added abort support for repo fetches and cached/timeout branch fetches.
- `apps/api/src/services/github.ts` — added token-scoped branch cache, org cache, and org search fan-out cap.
- `apps/api/src/__tests__/repos.test.ts` — added branch cache and org search cap coverage.
- `ISSUES.md` — recorded this session.

### Issues encountered
- Morph edit quota was exhausted, so edits used native patches.
- The first cache test reused a consumed `Response` body; fixed by returning a fresh mocked response per fetch.

### Next steps / blockers
- Manually verify onboarding with a GitHub account that belongs to multiple orgs and has many repositories.

---

## [2026-05-23] — Fetch real onboarding repository branches

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Replaced the hardcoded onboarding default-branch chips with branches fetched from GitHub for the selected repository.
- Added an authenticated API route and GitHub service helper for repository branch listing.
- Wired the desktop API client and onboarding wizard to load branches for GitHub, HTTPS, and SSH repo inputs.
- Added backend tests covering branch service behavior and the authenticated branch route.

### Files changed
- `apps/api/src/services/github.ts` — added `GitHubBranch` and `getGitHubBranches()`.
- `apps/api/src/routes/repos.ts` — added `GET /api/repos/github/:owner/:repo/branches`.
- `apps/api/src/__tests__/repos.test.ts` — added route and service branch-fetch tests.
- `apps/desktop-ui/lib/api/types.ts` — added branch response types.
- `apps/desktop-ui/lib/api/repos.ts` — added `fetchGitHubBranches()`.
- `apps/desktop-ui/lib/api/index.ts` — exported branch types and client helper.
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — loads and renders actual branch chips with loading/error states.
- `ISSUES.md` — recorded this session.

### Issues encountered
- Morph edit quota was exhausted, so edits used native patches.

### Next steps / blockers
- Manually verify onboarding against a linked GitHub account with repositories that have multiple branches.

---

## [2026-05-23] — Harden Kanban board drag/drop and selection logic

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Audited the Kanban board, drag/drop flow, SSE task updates, selection state, and task API expectations.
- Fixed filtered drag/drop so destination indexes from visible search results map back to the full column order before optimistic movement.
- Made column selection actions operate on visible filtered tasks and clear stale selection when project, team, or search scope changes.
- Hardened task SSE handling so archived or moved-out-of-scope tasks are removed, and task metadata such as project, team, assignee, creator, identifier, number, inbox state, model, and archived state stays current.
- Prevented dragging temp, selected, batch-locked, starting, or actively executing tasks.
- Extended frontend task/SSE types with board-relevant metadata returned by the API.

### Files changed
- `apps/desktop-ui/components/board/use-kanban-board.ts` — filtered index mapping, scoped selection cleanup, richer SSE updates, delete-anchor cleanup, and optimistic task metadata.
- `apps/desktop-ui/components/board/kanban-board.tsx` — drag disabling for execution, batch, selection, and optimistic-task states.
- `apps/desktop-ui/types/task.ts` — added optional `model` and `archived` metadata.
- `apps/desktop-ui/providers/sse-provider.tsx` — typed task metadata emitted in SSE payloads.
- `ISSUES.md` — recorded this session.

### Issues encountered
- Morph edit quota was exhausted mid-session, so remaining edits used native patches.
- Existing board diagnostics still report unrelated hints in `batch-progress.tsx` and `dashboard-loading.tsx`.

### Next steps / blockers
- Manually smoke-test drag/drop while searching, column select-all while searching, project switching with selected tasks, and drag attempts on executing tasks.

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

## [2026-05-25] — Stabilize Electron identity for Hyprland window rules

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Set a deterministic Linux Electron app identity so Hyprland can reliably match the window: `openlinear` for X11/XWayland class and `openlinear.desktop` through `CHROME_DESKTOP` for Wayland app id.
- Added Electron package metadata for `productName` and `desktopName`.
- Updated the Hyprland flickering report with the current `windowrule` no-animation syntax, legacy `windowrulev2` fallback, and verification command.

### Files changed
- `apps/desktop-electron/src/main.ts` — Linux app name, desktop identity environment, Chromium class switch, and stable window title.
- `apps/desktop-electron/package.json` — Electron product and desktop identity metadata.
- `docs/electron-hyprland-flickering-report.md` — updated Hyprland no-animation rule instructions.
- `ISSUES.md` — recorded this session.

### Issues encountered
- Electron 35 runtime supports the desktop identity path through `CHROME_DESKTOP`, but its TypeScript `App` type does not expose `app.setDesktopName()`, so the fix uses the environment variable directly instead of an unsafe cast.
- The compositor-side flicker cannot be fully verified from this environment; final confirmation requires running `pnpm start:electron` on Hyprland with the `no_anim` rule.

### Next steps / blockers
- Add `windowrule = match:class openlinear, no_anim on` to `~/.config/hypr/hyprland.conf`, reload Hyprland, run `pnpm start:electron`, and verify with `hyprctl clients | grep -A20 -i openlinear`.

### Follow-up
- The first Hyprland check matched Kitty terminal windows with `openlinear` in their title, not the Electron window, so the compositor rule likely did not match the app.
- Updated `apps/desktop-electron/package.json` to pass `CHROME_DESKTOP=openlinear.desktop` and `--class=openlinear` before `/usr/bin/electron` starts for both `dev` and `start` scripts.
- Re-ran `pnpm --filter @openlinear/desktop-electron typecheck`; it passed.
- Re-test `pnpm start:electron`, then inspect the full Electron client block with `hyprctl clients` instead of grepping only `openlinear` if the result still includes terminal windows.

### Oracle-guided diagnostic follow-up
- After the user confirmed the Electron window only flickers and cannot be focused, Oracle identified immediate renderer/window destruction as more likely than a compositor animation rule issue.
- Added Electron lifecycle diagnostics for window show/hide/close, webContents load failures, and renderer/child-process exits.
- Added `pnpm --filter @openlinear/desktop-electron start:diagnose` with Electron logging and stack dumps enabled.

### Diagnostic run — root cause identified
- The diagnostic log showed NO renderer crash or Hyprland compositor issue. The window was cleanly exiting after ~14 rapid `/login` reload cycles.
- Root cause: `trailingSlash: true` in `next.config.js` caused `/login` (no slash pushed by root page's `router.push('/login')`) to redirect to `/login/` via full page navigation. In Electron's sandboxed renderer, this trailing-slash redirect restarted the page load cycle, leading to a redirect loop. Chromium killed the window after ~14 cycles.
- Fix: Electron now loads `/login/` directly (bypassing root page), root page pushes `/login/` (with slash), auth hook matches both `/login` and `/login/` pathnames.
- Also fixed static server to resolve query-string asset URLs (`.woff2?v=...`) to the correct filesystem path — was previously serving `index.html` for font requests.

### Files changed for trailing-slash fix
- `apps/desktop-electron/src/main.ts` — load `/login/` instead of `/` in Electron
- `apps/desktop-ui/app/(app)/page.tsx` — `router.push('/login/')` with trailing slash
- `apps/desktop-ui/hooks/use-auth.tsx` — match both `/login` and `/login/` pathnames; push `/login/` on auth expiry

### Hyprland rule
- With the redirect loop fixed, the Electron window should become a stable client. The Hyprland no-animation rule can then be tested: `windowrule = match:class openlinear, no_anim on`
- If the window still flickers on creation even after fixing the redirect loop, the Hyprland rule is the remaining fix.

---

## [2026-05-26] — Remove Electron desktop wrapper entirely

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Deleted `apps/desktop-electron/` entirely (main, preload, sidecar, dist, package.json, electron-builder config).
- Deleted `docs/electron-hyprland-flickering-report.md`.
- Deleted `apps/desktop-ui/types/electron.d.ts`.
- Stripped all `electronAPI` / `isElectronRuntime` branches from desktop-ui source files — every file now has Tauri-only paths.
- Removed `build:electron`, `build:electron:linux`, `dev:electron`, `start:electron` scripts from root `package.json`.
- Removed `build:electron` script from `apps/desktop-ui/package.json`.
- `pnpm --filter @openlinear/desktop-ui typecheck` passes clean.

### Files changed
- `apps/desktop-electron/` — deleted
- `docs/electron-hyprland-flickering-report.md` — deleted
- `apps/desktop-ui/types/electron.d.ts` — deleted
- `apps/desktop-ui/lib/api/client.ts` — removed `isElectronRuntime`, electron branches in `readSidecarPort` and `ensureSidecarListener`
- `apps/desktop-ui/lib/api/auth.ts` — removed electron check in `isDesktopRuntime`, electron branch in `startLogin`
- `apps/desktop-ui/lib/utils.ts` — removed electron branch in `openExternal`
- `apps/desktop-ui/hooks/use-auth.tsx` — removed `setupElectron`, electron branch in auth callback setup
- `apps/desktop-ui/components/layout/sidebar.tsx` — removed electron branches from isTauri detection and all window control handlers
- `apps/desktop-ui/components/shared/repo-picker-field.tsx` — removed electron branch in `pickLocalFolder`
- `apps/desktop-ui/components/desktop/database-settings.tsx` — removed electron branches from load/save/test
- `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx` — removed electron branches from `checkOpencode` and `detectPlatform`
- `apps/desktop-ui/app/layout.tsx` — removed `electron` variable from inline runtime-detection script
- `apps/desktop-ui/package.json` — removed `build:electron` script
- `package.json` — removed all electron-related scripts

### Issues encountered
- None. Typecheck clean after all edits.

### Next steps / blockers
- Tauri remains the only desktop wrapper. No further action needed.

---

## [2026-05-26] — Fix all Tauri/WebKitGTK rendering issues

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done

Searched session history and codebase to identify every Tauri/WebKitGTK problem. Found and fixed two root causes:

**1. White flash on startup (`tauri.conf.json`)**
- Added `"backgroundColor": "#0a0a0a"` to the window config so the Tauri webview starts dark, eliminating the white flash before Next.js hydrates.

**2. Scroll broken throughout the app (WebKitGTK `min-height: auto` enforcement)**
- WebKitGTK strictly enforces the CSS spec: a flex item's default `min-height` is `auto`, so `flex-1 overflow-y-auto` alone cannot produce a scrollable area — the item grows to content height instead of scrolling.
- Added `min-h-0` to every `flex-1 overflow-*` scroll container and every `flex flex-1 flex-col` skeleton `<main>` that was missing it.
- Affected: settings, settings/tokens, my-issues, projects/issues, inbox, archived, usage, teams/issues, teams, loading skeleton, home page skeleton, board skeleton, execution-drawer, brainstorm-panel, project-list.

**Already in place (no change needed):**
- `globals.css` fast render profile: strips all `backdrop-filter`, transitions, shadows, and animations on Linux/Tauri to prevent compositor stalls on WebKitGTK.
- Static font masters (4 woff2 files) instead of variable fonts — eliminates WebKitGTK variable-font rendering bugs.
- `height: 100%` on `html`/`body` — already present.
- `overscroll-behavior: none` — already present.

### Files changed
- `apps/desktop/src-tauri/tauri.conf.json` — added `backgroundColor: "#0a0a0a"`
- `apps/desktop-ui/app/(app)/settings/page.tsx` — `min-h-0` on main scroll container
- `apps/desktop-ui/app/(app)/settings/tokens/page.tsx` — `min-h-0` on main
- `apps/desktop-ui/app/(app)/my-issues/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/projects/issues/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/inbox/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/archived/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/usage/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/teams/issues/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/teams/page.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/app/(app)/loading.tsx` — `min-h-0` on skeleton main
- `apps/desktop-ui/app/(app)/page.tsx` — `min-h-0` on skeleton main
- `apps/desktop-ui/app/(app)/projects/board/page.tsx` — `min-h-0` on skeleton main
- `apps/desktop-ui/components/projects/project-list.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/components/execution-drawer.tsx` — `min-h-0` on scroll div
- `apps/desktop-ui/components/quick-capture/brainstorm-panel.tsx` — `min-h-0` on scroll div

### Issues encountered
- None. Typecheck clean after all edits.

### Next steps / blockers
- Rebuild the Tauri app (`pnpm --filter @openlinear/desktop tauri build` or `pnpm dev-live`) and verify scrolling works on all pages on Linux.

---

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

---

## [2026-05-23] — Neon DB dev/prod branch separation and reset

**Status:** Done
**Agent:** Sisyphus (OpenCode)

### What was done
- Reset the Neon development branch to match production.
- Verified the dev branch has its own compute endpoint separate from prod.
- Applied all 12 Prisma migrations to the dev branch (it was missing `_prisma_migrations` tracking after the reset).
- Regenerated the Prisma client against the dev branch.
- Confirmed API typecheck passes with the dev DATABASE_URL.
- Updated `.env` with dev connection string and `.env.production` with prod connection string.
- Created `docs/database-setup.md` documenting branch IDs, endpoints, connection commands, and reset workflow.

### Files changed
- `.env` — updated DATABASE_URL to dev branch pooled endpoint.
- `.env.production` — updated DATABASE_URL to prod branch pooled endpoint.
- `docs/database-setup.md` — new documentation for Neon branch management.

### Issues encountered
- The `neonctl branches reset` command initially hung because `--parent` flag was required; added it.
- `prisma migrate deploy` had to be used after reset because `_prisma_migrations` table was lost during branch reset.
- The `db:push` and `db:studio` root scripts in `package.json` were targeting the wrong workspace filter; fixed in a previous session.

### Next steps / blockers
- None. Dev branch is ready. Use `pnpm dev-live` to start local development against the dev Neon database.

---

## [2026-05-23] — Complete sidecar 100% coverage plan

**Status:** Done
**Agent:** Codex

### What was done
- Finished `.sisyphus/plans/sidecar-100-coverage.md` for `apps/sidecar`.
- Expanded sidecar tests from the previous workflow coverage to 189 passing tests.
- Added missing edge-path coverage across execution routes, delta buffering, execution settings, git credentials, agent-run persistence, git helpers, recovery, state cleanup, lifecycle setup/cancel paths, worktree cleanup/merge paths, OpenCode host management, and event stream handling.
- Added sidecar entrypoint coverage and a Vitest config that enforces 100% coverage thresholds while excluding only the pure execution re-export barrel.
- Simplified a few private execution helpers where earlier defensive branches were unreachable through their callers.

### Files changed
- `apps/sidecar/vitest.config.ts` — 100% coverage thresholds and coverage exclusion for the pure execution re-export barrel.
- `apps/sidecar/src/index.ts` — exported entrypoint helpers for direct tests and added a test-only autostart opt-out while preserving default startup behavior.
- `apps/sidecar/src/index.test.mjs` — entrypoint startup, shutdown, dotenv, recovery, guard, and fatal-path coverage.
- `apps/sidecar/src/routes/execution.test.mjs` — refresh/cancel/log route edge coverage.
- `apps/sidecar/src/services/**/*.test.mjs` — expanded service coverage, including new `opencode.test.mjs`.
- `apps/sidecar/src/services/delta-buffer.ts` — simplified private buffer timer assumptions.
- `apps/sidecar/src/services/execution/events.ts` — simplified private completion/background handling and covered event edge paths.
- `apps/sidecar/src/services/execution/lifecycle.ts` — simplified post-validation user/project assumptions.
- `apps/sidecar/src/services/opencode.ts` — covered process manager edge paths and annotated unreachable restart/race callbacks.
- `.sisyphus/plans/sidecar-100-coverage.md` — recorded completion status and final coverage evidence.

### Issues encountered
- V8 branch coverage reports private race/catch callbacks precisely; a few unreachable process/error callbacks use narrow `v8 ignore` blocks.
- `src/index.ts` needed a narrow V8 ignore for the packaged-snapshot `import.meta.dirname` fallback because Vitest always provides `import.meta.dirname`.
- Existing dirty/deleted files outside this sidecar coverage work predated the task; they were left untouched per repository protocol and are not sidecar coverage blockers.

### Next steps / blockers
- None. `npx vitest run --coverage`, sidecar typecheck, and sidecar build all pass.

---

## [2026-05-23] — Resolve sidecar coverage risk cleanup

**Status:** Done
**Agent:** Codex

### What was done
- Removed the explicit `src/index.ts` exclusion from sidecar coverage configuration.
- Added `src/index.test.mjs` so the sidecar entrypoint appears in the coverage report at 100%.
- Added 100% coverage thresholds to make regressions fail `npx vitest run --coverage`.
- Confirmed the sidecar coverage report shows 100% statements, branches, functions, and lines across 17 test files and 189 tests.
- Left only `src/services/execution/index.ts` excluded because it is a pure re-export barrel with no runtime logic.

### Files changed
- `apps/sidecar/vitest.config.ts` — narrowed coverage exclusion to the pure execution barrel and added 100% thresholds.
- `apps/sidecar/src/index.ts` — exported existing helpers/start and added test-controlled autostart opt-out.
- `apps/sidecar/src/index.test.mjs` — added entrypoint coverage.
- `.sisyphus/plans/sidecar-100-coverage.md` — marked the plan complete with final coverage evidence.
- `ISSUES.md` — corrected the sidecar coverage log and recorded this risk cleanup.

### Issues encountered
- None in sidecar verification.

### Next steps / blockers
- None for the sidecar coverage task.

---

## [2026-05-23] — Build dash.openlinear.tech analytics dashboard

**Status:** Done
**Agent:** Sisyphus

### What was done
- Scaffolded a new Next.js 16 app `apps/dashboard/` for `dash.openlinear.tech` with Tailwind CSS, shadcn/ui, and Recharts.
- Implemented auth layer copying the desktop-ui pattern: `AuthProvider` context with localStorage JWT, login page with GitHub OAuth, and API fetch helpers.
- Extended `apps/api/src/routes/auth.ts` to support `client=dashboard` OAuth flow with `DASHBOARD_URL` env var redirect.
- Built analytics dashboard with cost summary cards, daily cost bar chart, and sortable paginated task table using existing `/api/usage` endpoints.
- Built PAT management section: list tokens, create new PAT with copy-to-clipboard, revoke with confirmation using `/api/pats`.
- Added task/project health metrics with new API routes: `GET /api/dashboard/tasks` (status/priority counts, overdue, unassigned) and `GET /api/dashboard/projects` (completion rates, health scores).
- Extended `GET /api/activity-log` to support user-scoped queries across teams/projects when no specific entity ID provided. Added paginated activity feed UI.
- Added MCP usage tracking: new `McpToolCall` Prisma model, `POST /api/mcp/log` and `GET /api/mcp/usage` routes, proxy-based auto-logging in MCP server, and dashboard chart component.
- Created `apps/dashboard/vercel.json` for static export deployment. Fixed `useAuth` to be SSR-safe for build.
- Dashboard has 4 tabs: Overview (cost + task health + MCP usage), Projects (health table), Activity (feed), Tokens (PAT management).

### Files changed
- `apps/dashboard/` — entire new Next.js app with all components, pages, and config.
- `apps/api/src/routes/auth.ts` — added `dashboard` OAuth client support and `DASHBOARD_URL` redirect.
- `apps/api/src/routes/dashboard.ts` — new task/project health metrics routes.
- `apps/api/src/routes/activity-log.ts` — extended with user-scoped query support.
- `apps/api/src/routes/mcp-usage.ts` — new MCP tool call logging and usage aggregation.
- `apps/api/src/app.ts` — mounted new dashboard and MCP usage routes.
- `packages/db/prisma/schema.prisma` — added `McpToolCall` model.
- `apps/mcp/src/mcp/server.ts` — added Proxy-based auto-logging for all client method calls.
- `apps/mcp/src/openlinear/client.ts` — added `logMcpToolCall` method.
- `packages/db/src/index.ts` — regenerated Prisma client with `McpToolCall`.

### Issues encountered
- Initial typecheck failures due to `darkMode: ['class']` array syntax in Tailwind config and missing React type declarations — both fixed.
- `useAuth` hook threw during static export build because `AuthContext` was undefined on server — fixed by returning default state instead of throwing when no context.

### Next steps / blockers
- Deploy `apps/dashboard/` to Vercel and configure `DASHBOARD_URL` and `CORS_ORIGIN` env vars on the API server.
- Consider extracting shared auth/API client code from `desktop-ui` and `dashboard` into `packages/openlinear` to prevent drift.

---

## [2026-05-23] — Add GitHub auth success feedback

**Status:** Done
**Agent:** Codex

### What was done
- Added a visible authenticated status on the login page after a pasted desktop callback token is accepted.
- Delayed the manual callback redirect briefly so the success state is visible before entering the app.
- Added a success toast for automatic Tauri deep-link callback completion.
- Updated the browser callback bridge copy to say the user is authenticated after GitHub succeeds.

### Files changed
- `apps/desktop-ui/app/login/page.tsx` — shows "Authenticated. Opening OpenLinear..." after callback-token verification and prevents duplicate submits during handoff.
- `apps/desktop-ui/hooks/use-auth.tsx` — shows a success toast when automatic desktop callback authentication completes.
- `apps/api/src/routes/auth.ts` — updates the Chrome callback bridge success copy.
- `ISSUES.md` — recorded this session.

### Issues encountered
- The codebase search MCP returned 429, so investigation used direct repository search.
- Existing unrelated dirty files remain in the worktree and were left untouched.

### Next steps / blockers
- Manually run the desktop GitHub OAuth flow and confirm the Chrome bridge plus OpenLinear login screen show the success feedback.

## [2026-05-24] — Fix GitHub OAuth 404 and get local dev stack running

**Status:** Done
**Agent:** Claude Opus (OpenCode / Sisyphus)

### What was done
- Pulled latest from `origin/dev` (fast-forward, 179 new files including Electron desktop shell, chat tests, .omo plans/evidence)
- Stashed local changes (`pnpm-lock.yaml`, `scripts/dev-live.sh`), pulled, popped stash — no conflicts
- Verified `.env` already matches `.env.dev` (correct dev Neon DB, GitHub OAuth app `Ov23liy8A1JNx3VSY0la`, localhost callbacks)
- Generated Prisma client successfully (`pnpm --filter @openlinear/db db:generate`)
- Started sidecar on :3001 (healthy, DB connected) and Next.js on :3000 in tmux session `ol-dev`
- Confirmed `/api/auth/github` returns 302 → `github.com/login/oauth/authorize` with correct `client_id` and `redirect_uri`

### Root cause of original OAuth 404
The sidecar was likely not running when login was attempted (single-tenant guard `OPENLINEAR_ALLOW_SHARED_OPENCODE` blocks startup without the env var). Using `dev-live.sh` or manually exporting the var fixes it.

### Files changed
- No file edits — only git pull + stash pop

### Issues encountered
- `.env` has unquoted `&` in DATABASE_URL which breaks `source .env` in bash; `dev-live.sh` handles this with line-by-line parsing

### Next steps / blockers
- Test full GitHub OAuth login flow in browser at http://localhost:3000
- Ensure GitHub OAuth App callback URL includes `http://localhost:3001/api/auth/github/callback`
