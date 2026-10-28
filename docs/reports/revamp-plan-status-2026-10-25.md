# Desktop revamp plan — status audit and required plan updates

Date: 2026-10-25. Baseline: working tree at `922dbd7` (= `origin/dev` = `origin/main`) plus the uncommitted W02a / W04a / CI changes recorded in `ISSUES.md` (2026-10-25). Plan audited: `~/Desktop/Open Linear Revamp Plan/` (written 2026-09-04, handoff notes 2026-09-10; `ISSUES.md:224` still cites the old `~/Downloads/…` path).

Method: three read-only audits (Phases 0/1/6, Phases 2/3, Phases 4/5/7) classified every row of the eight phase documents against the code with `file:line` evidence. The coordinator re-verified every finding that changes the headline (marked **verified** below). Nothing was run except read-only `curl`/`dig` against the public hosts and `gh run list`.

## 1. Every plan that exists

| Plan | Where | Date | Status today |
|---|---|---|---|
| **Desktop revamp plan** (A-to-Z review: 5 research reports, 7 code reviews, 8 phases, 5 architecture docs, ~32k lines) | `~/Desktop/Open Linear Revamp Plan/` (off-repo) | 2026-09-04 | Audited here. No phase meets its exit criteria. |
| **Backend master plan** W00–W21 (replaces the backend parts of Phases 1–4/7) | `tasks/prd-backend-agent-platform.md` | 2026-10-15, updated 2026-10-25 | W00 done; W01, W02a, W04a slices verified locally. W03a next. |
| Backend product contracts | `docs/plans/backend-product-contracts.md` | 2026-10-15 | Reference for W02–W21 |
| Backend review reports + ledgers | `docs/reports/backend-review-2026-10-15/` | 2026-10-15/25 | engine, api-data, ai-product, sandbox, benchmark, openai, validation, w01/w02a/w04a |
| Frontend backlog FE-01…FE-16 (replaces Phase 5 scope) | `~/Downloads/frontend work pending.md` (off-repo) | 2026-10-15 | Not started; nobody owns it |
| Cloud services decision record (defers Phase 6) | `~/Downloads/OpenLinear cloud services pending.md` (off-repo) | 2026-10-15 | No provider selected, by design |
| P95 performance plan (Phases 0–6) | `docs/PERFORMANCE_IMPROVEMENT_PLAN.md` + `docs/reports/performance-codebase-review-2026-06-04.md` | 2026-06-04 | Not started |
| PRD: user strengthening (RBAC, SSO/2FA, invitations, assignees, notifications, audit; 108 boxes) | `tasks/prd-user-strengthening.md` | 2026-05-25 | Boxes never ticked; much of it exists in code via Phase 0/1 (SSO, TOTP, Session, Invitation, TaskAssignee, NotificationPreference, AuditLog). No `Role`/`Watcher` models. |
| Architecture refactor (Workspace → Project → Team → Issue) | `architecture-refactor.md` | 2026-05-20 | Largely implemented (Workspace, ProjectAccess, Project.key). No `IssueLink`. |
| Sisyphus plans: openlinear-80-percent (57/102 boxes, active "boulder"), god-mode-web-search-voice (8/75, archived), brainstorm-feature (18/18), dual-auth-project-repo (55/55), landing-pages-redesign (0/23) | `.sisyphus/plans/` | Feb–May 2026 | Checkboxes stale per the 2026-10-15 audit; treat as history |
| `.omo` plans: deferred email invites; MCP Phase 4 bulk plan tool (tool shipped as `openlinear_bulk_create_plan`) | `.omo/plans/` | 2026-05-24 | History |
| Known limitations (OpenCode single-tenant) | `docs/limitations.md` | 2026-05-01 | Still true |
| Work log with scattered "next steps" | `ISSUES.md` | ongoing | Authoritative session record |

## 2. Is the product running anywhere right now? (all **verified**)

- **Hosted API is down.** `api.openlinear.tech` CNAMEs to `openlinear-api.whitesmoke-ccbab1c5.centralindia.azurecontainerapps.io`, which does not resolve. Last successful "Deploy API to Azure" run: 2026-05-24 (`e03fe27`). Both deploys since (2026-09-14, 2026-10-22) failed. **None of the Phase 0 security fixes (2026-09-09) has ever reached production.**
- **Even with the drift-check fix, the deploy cannot succeed:** `apps/api/Dockerfile:23,36` copies `packages/types` (deleted 2026-05-25) and omits `packages/execution-core` (a dependency of `apps/api`). `deploy-azure.yml` has no production `migrate deploy` step (only the CI test DB, line 59).
- **No background worker ships:** `apps/api/esbuild.config.js` bundles only `src/index.ts`; the image runs `node dist/index.js`. `worker.ts` is never built.
- **Last desktop release is v0.1.61 (2026-05-13)** — pre-Phase-0 code pointing at the dead API. Nothing has been released since.
- **The current tree cannot be packaged as a working desktop app:**
  - `scripts/build-sidecar.sh:20,50-57` targets Node 18 (esbuild + pkg), but `apps/sidecar/src/journal/sqlite.ts:4` imports `node:sqlite` (Node ≥ 22.5) and `index.ts:12,146` loads it at boot.
  - `apps/desktop/src-tauri/src/sidecar.rs` always injects `DATABASE_URL` and sets `NODE_ENV=production` without `--with-cloud-api`; `apps/sidecar/src/persistence/boot.ts:20-26` throws on exactly that combination.
  - `apps/desktop-ui/lib/api/client.ts:178-182`: in the Tauri runtime `getApiUrl()` returns the **sidecar** URL for every request, including login (`lib/api/auth.ts:127`), token refresh (`fetch.ts:72`), projects and chat. Since `a4a314c` (2026-09-12) the sidecar mounts only `/api/tasks`, `/api/opencode`, `/api/batches`, `/api/transcribe`, `/api/events` (`apps/sidecar/src/app.ts:135-139`).
  - `scripts/download-opencode.sh:22,28` pins `opencode-ai/opencode v0.0.55` (the archived Go CLI) while the sidecar drives `opencode serve` via `@opencode-ai/sdk 1.18.30`. `services/opencode.ts:127` names plugin `opencode-openlinear`, which exists nowhere.
- **CI has no `pull_request` trigger** in any workflow; checks run only on push to `dev`/`main`/tags. The migration-safety step never inspects a diff (default branch is `dev` → empty diff on dev pushes; shallow checkout + `|| true` on main).
- Up: `openlinear.tech` (landing, Vercel behind Cloudflare), `mcp.openlinear.tech` (worker), `docs.openlinear.tech`.

## 3. Phase-by-phase status

Percentages are the auditors' estimates of plan rows with code; "wired" means on the enabled production path.

| Phase | Code exists | Wired / exit criteria | Headline |
|---|---|---|---|
| 0 Stop the bleeding | ~75 % | **Exit criteria not met** | Prod rotation blocked; `.env.dev/.env.prod` + the full PAT still in history (`f37414b`, `9e1aef8`, `c6bb0d5`, `d7aece7`); no gitleaks; hot-path indexes never reconciled; `unsafe-eval` still in Tauri CSP; deep link prints a URL that now carries a 30-day refresh token; 12 of 25 UI primitives lack focus-visible |
| 1 Platform foundations | ~40 % | Infra/observability ~5 % | Tenancy, registry (136 routes), SSO/2FA/refresh tokens, pg-boss jobs exist. Outbox is **not** written inside transactions (`events/outbox.ts:86-89`; ~75 fire-and-forget `persistAndDeliver` sites); relay `SKIP LOCKED` outside a transaction; modules are 3-line re-exports; `api-client` hand-written; OTLP branch empty; biome covers 30/141 API files and nothing else; worker not deployable |
| 2 Execution engine v2 | ~65–70 % | **~25–30 % wired; v2 core 0 %** | RunJournal, SessionManager, RunCoordinator, AgentRunner, recovery and CodexRunner exist but are reachable only from tests and `latency-bench.ts`. Normal execute/batch routes use the legacy `lifecycle.ts`/`events.ts`/`batch/orchestrator.ts` path (call chain in §5). Choosing Codex → 400 `RUNNER_NOT_SUPPORTED`. 12 sidecar files still import `@openlinear/db`. None of the 8 exit criteria met |
| 3 Sandboxing and trust | ~5 % (Phase 0 prerequisites only) | **0 % of the phase** | No `SandboxProvider`, no `@anthropic-ai/sandbox-runtime`, no credential broker, no GitHub App, every permission request auto-rejected (`event-stream-processor.ts:215`), redaction on 1 of 5 sinks, Codex adapter inherits the full environment |
| 4 AI platform | ~5 % | — | No `packages/ai-core`, no Vercel AI SDK, no caching/compaction/evals/memory/pgvector; 1 of 5 model-call sites metered; tools have a `mutating` boolean, not `effect`; `bulk_update_issues` with no ids rewrites a whole project by design; chat provider defaults to Fireworks `kimi-k2p6` |
| 5 Frontend revamp | ~10 % (Phase 0 §0.5) | — | No TanStack Query, Tailwind 3.4 (not 4), HSL tokens with accent `#10b981`, no Storybook/Playwright/ESLint, agent-execution kit ≈ 2 of 10 components, board unvirtualized with per-task bulk requests, no updater |
| 6 Cloud execution and scale | ~5 % | — | No cloud runner/queue; MCP still on `@modelcontextprotocol/* 2.0.0-alpha.2`, PAT-only; release.yml unsigned (`signingIdentity "-"`), sidecar/OpenCode binaries never built in the job; CLI installer downloads from the wrong org without checksum |
| 7 Product AI | ~2 % | — | Flat plan import only; no PR review agent, digests, embeddings, scheduler, skills or transcript viewer |

### 3.1 Phase 0 rows still open (for the next tranche)
#1–4 (prod rotation, history purge, gitleaks, TOTP rotation), #6 (handshake/keychain; launcher injects `DATABASE_URL`), #15 (handshake token), #18 (`x-openlinear-client` still trusted, `projects.ts:44-47`), #22 (git/Codex env spread: `execution/git.ts:124`, `worktree.ts:249`, `batch/completion.ts:76`, `runners/codex/index.ts:272,290`), #27 (API logger redacts only auth header/cookies), #31 (chat never sets `stream_options.include_usage`), #33 (wrong OpenCode artifact), #37 (Dockerfile broken; no PR checks), #39 (`/readyz` without migration check), #40 (indexes), #41 (PAT `lastUsedAt` written every request), #42, #45, #46 (web refresh token in localStorage), #49 (`unsafe-eval`, deep-link print).

### 3.2 Phase 1 code that exists but is not what the plan describes
Outbox not transactional; relay in both API and worker; Redis single channel `ol:domain-events`; `hasRequiredScopes([])` still `true` (scopes enforced by per-method defaults instead); `Project.workspaceId`/`Task.projectId`/`Task.workspaceId` still nullable; backup codes scrypt not argon2id; no `keyVersion`; 10 explicit `requireAuth([...])` vs 122 bare; legacy `*` PATs still grant everything; account-wide PAT creation unaudited (`logAudit` requires workspaceId); W04a idempotency only on task create — the non-transactional `lib/http.ts` cache still serves projects/teams/workspaces.

## 4. Pinned versions vs plan assumptions (**verified**)

| Library | Plan assumed | Actual |
|---|---|---|
| `@opencode-ai/sdk` | upgrade to 1.18 then `/v2` | 1.18.30 installed; production uses the v1 client |
| `@openai/codex-sdk` | adopt | 0.147.0 present, adapter not routed |
| `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sandbox-runtime`, `better-sqlite3`, `ai`/`@ai-sdk/*`, `@tanstack/react-query`, `@playwright/test`, storybook, `@tauri-apps/plugin-updater`, `@opentelemetry/*` | adopt | **absent** |
| `@anthropic-ai/sdk`, `openai` | 0.123.x / 7.x | 0.74 / 6.22 declared in sidecar, **never imported** (remove) |
| zod | 3 → 4 everywhere | 3.25 in api/sidecar/desktop-ui/landing; 4.1 only in `apps/mcp` |
| `@modelcontextprotocol/*` | stable SDK | `2.0.0-alpha.2` (split `/server` + `/node` packages) |
| Tailwind | v4 + OKLCH | 3.4.17–3.4.19 |
| React | — | 19.2 everywhere except `apps/intro-video` (18) |
| Prisma | pin 7.x | 7.4.0 pinned (done) |

## 5. Today's actual execution call path (static trace)

Single task: `POST /api/tasks/:id/execute` (`apps/sidecar/src/routes/execution.ts:39`) → `requireAuth` + `assertTaskOwned` (Prisma) → `executeTask` (`services/execution/lifecycle.ts:371`) → `gatherExecutionInputs` → `requireLegacyRunner` (rejects non-OpenCode) → `setupRepository` (local project = user's own checkout; remote = `cloneRepository` → `acquireLocalWorktree`) → shared OpenCode server, v1 client, `session.create` → `createAgentRun` (Prisma) → 30-min hard timer → `subscribeToSessionEvents` (`events.ts:746`) → `promptAsync` → legacy `processEvent` → on idle `handleSessionComplete` → `commitAndPush` → `publishGithubPullRequest` → `finalizeAgentRun`.
Batch: `routes/batches.ts:31` → `createBatch` (`batch/orchestrator.ts:83`) → `startBatch` → `startTask` (legacy `createWorktree`, own event decoder) → `handleTaskComplete` → `finalizeBatch` → merge/push/`publishBatchPullRequest`. No AgentRun or usage recorded for batches.
RunJournal, RunCoordinator, engine SessionManager, AgentRunner, `processAgentEvent`, `cancelRun`, `checkWatchdogs`: not on either path.

## 6. Plan statements that are now wrong or superseded

- Executive summary "PAT scopes enforced on 2 of 117 routes": 136 routes, all PAT-reachable routes check a scope (registry + inventory test).
- Phase 0 #9 "disable SSO until rebuilt": SSO was rebuilt in Phase 1.4 and is live. #21: the batch event-handler file no longer exists. #24 cites SDK 1.2.5; code comments in `opencode.ts`/`lifecycle.ts` still say 1.2.5. #5/#46 file:line references have moved.
- Phase 1.2 "api-client generated from the registry": hand-written. 1.3 "Redis PUBLISH ws:<workspaceId>": single channel. 1.4 "argon2id": scrypt. 1.5 Azure Blob / 6.1 ACA Jobs-or-E2B / A5 infra table: superseded by `OpenLinear cloud services pending.md` ("no provider selected prematurely").
- Phase 2 "better-sqlite3": `node:sqlite`. "single reducer": three consumers. "contract moves into the system definition": still in the user prompt. "today 50–105 s to first token": stale; nothing measures end-to-end (the W00/W01 benches are component-only, no CI gate). "100 % coverage thresholds the config asserts": not enforced in CI.
- Phase 3: corrections already recorded in `docs/reports/backend-review-2026-10-15/sandbox.md` — HostProvider is scaffolding not a default; `wrapWithSandbox` (not `wrapWithSandboxArgv`) must be verified against a pinned release; never substitute sentinels into arbitrary bodies; Seatbelt/bwrap cannot enforce CPU/memory/pid limits (report `unsupportedLimits`); protect gitdir/commondir/alternates/filters/object store, not just hooks/config; learn mode only on synthetic fixtures or under a grant; Windows "T2 or refuse" is insufficient; sequence Phase 3 behind W03–W08.
- Phase 4 "openai 7.x / @anthropic-ai/sdk 0.123": unused packages; "voice hardened in Phase 0": lives in the sidecar on Cartesia; "UI CostMeter reads real values": no CostMeter exists. Phase 7.1 tool is `openlinear_bulk_create_plan`; 7.3 "summaries already generated": no summarizer exists.
- Phase 5 "7 test files": 23 files / 242 tests, running in CI. "ticket never in URL": ticket is in `?ticket=` (JWT removed). "290 rounded-sm": 303. "Linux deb/AppImage restored": built in release.yml (but `tauri.linux.conf.json` builds only deb while release.yml expects an AppImage). "~1,300 LOC dead UI": the named pieces are ~180 LOC; new unused files appeared (`brainstorm-panel.tsx` 447, `voice-capture.tsx` 84, `api-loading-screen.tsx` 175). Phase 5 "runs in parallel with 2–4": superseded by the FE-01…FE-16 backlog, which is gated on backend contracts.
- Phase 6.3 "second MCP implementation": gone. "docs say 8": public docs say 12; only `docs/CODEBASE_INDEX.md:32` is stale.
- Runbooks: `rotate-leaked-secrets.md:49-51` cites a `DIRECT_DATABASE_URL` that does not exist; `apply-hot-path-indexes.md:54-55` claims the drift check fails until indexes are reconciled — false, the drift check never sees them.
- `ISSUES.md` 2026-09-10/11/12 "Done"/"code complete" labels for Phases 1–2 are overstated (facade modules, no-op migration gate, un-deployable worker, unwired v2 engine).

## 7. Risks not covered by any plan (new in this audit)

1. **Agent → sidecar code execution via git config** (likely; untested): sidecar git calls spread `process.env` (incl. `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`) and reset only `core.hooksPath`, `core.fsmonitor`, `protocol.*` (`services/git-credentials.ts`). The repo `.git/config` is agent-writable (no sandbox); `credential.helper = !…` or `filter.*` would execute during the sidecar's own `git add`/`git push`. W10 targets this; nothing is implemented.
2. **SSO state exposes the PKCE verifier**: `services/sso.ts:146-148` serialises `{codeVerifier, nonce, …}` as base64url + HMAC into `state`, readable by anyone who sees the redirect; not bound to the browser. One TXT record verifies every `allowedDomains` entry; `OPENLINEAR_SSO_SKIP_DNS` bypasses verification.
3. **Desktop deep link logs a refresh token**: `routes/auth.ts:159-163` puts `refreshToken` in the callback URL; `deeplink.rs:55` prints it.
4. **Chat data processor**: workspace chat history, tool results, attachments (base64) go to Fireworks/Kimi by default (`lib/chat-llm.ts:130-132`). No plan names this processor.
5. **Broad model-driven writes**: `bulk_update_issues` without `issueIds` updates every non-archived issue in a project (`chat-tools/domain.ts:306-317`); no confirmation step.
6. **PAT edge cases**: `PersonalAccessToken.workspaceId` is `onDelete: SetNull` — any workspace deletion outside the route makes bound PATs account-wide; legacy `*` PATs are non-expiring full access; account-wide PAT creation is unaudited.
7. **Possible tool-result replay**: the chat journal keys cached results by the provider's tool-call id (`chat.ts:209`); if a provider repeats ids across turns an old result replays. Unverified against real Fireworks output.
8. **Crash leaves tasks stuck**: after a sidecar crash tasks stay `in_progress`, new executes return 409 (`lifecycle.ts:85`, `batch/admission.ts:83-84`), detached OpenCode keeps running.
9. **Supply chain**: unused `@anthropic-ai/sdk`/`openai` shipped and marked external in `apps/sidecar/esbuild.config.js:20`; OpenCode pinned to the wrong upstream.
10. **Frontend contract drift has no owner**: none of `INVALID_RUNNER`, `RUNNER_NOT_SUPPORTED`, `PAT_WORKSPACE_RESTRICTED`, `IDEMPOTENCY_*`, batch `publication` appears in `apps/desktop-ui`.

## 8. Required updates to the plan before work starts

1. **Replace the staffing/timeline model.** The plan assumes 6–7 engineers over 24 weeks with Phases 2–5 in parallel. Reality is one owner plus parallel coding agents. Sequence by gates, not weeks; one slice per agent; independent verification per slice (the W-package pattern already in use).
2. **Formalise the supersession.** Backend parts of Phases 1–4 and 7 → `tasks/prd-backend-agent-platform.md` (W00–W21). Phase 5 → `frontend work pending.md` FE-01…FE-16, gated on backend contracts; adopt Phase 5's design decisions (tokens, Tailwind 4, agent kit) only after FE-01–FE-08 contracts exist. Phase 6 → `cloud services pending.md` (decision record, not a phase). Keep the revamp folder as research; move the three off-repo handoff files into `docs/plans/` so agents can find them.
3. **Insert a "make it runnable" tranche before anything else** (none of these is in any plan): fix `apps/api/Dockerfile`; build and run `worker.ts` (or run jobs in-process deliberately); add a production `migrate deploy` step; restore or re-create the Azure Container App / DNS; add `pull_request` triggers and fix the migration-safety diff base; retarget the sidecar bundle to Node 22 (or drop `node:sqlite`); fix the OpenCode download to the real upstream and version the SDK talks to, remove the phantom plugin; decide the desktop API routing (cloud API for auth/projects/chat, sidecar for execution) and make the Tauri launcher consistent with the sidecar's persistence mode (this is W03 — pull its client-side half forward); stop printing the deep-link URL and move the refresh token out of it. Without this tranche nothing can be manually tested in packaged form.
4. **Close the Phase 0 leftovers as a tracked list** (§3.1), with the owner-only items (prod rotation, history purge decision) explicitly assigned to the owner.
5. **Adopt the Phase 3 corrections** from `sandbox.md` verbatim into the plan (§6), and gate sandbox work behind W03–W08 as the PRD does.
6. **Refresh every version and count** (§4, §6) and the file:line references, or mark the phase documents "historical, see PRD" so agents stop implementing from stale rows.
7. **Record the unratified decisions** from the executive summary §6 with a date and owner: sidecar/API split (now W03), GitHub App credential (W10), `sandbox-runtime` as T1 (W09), Vercel AI SDK vs native drivers for chat, cloud runner provider, Tailwind 4 + OKLCH + accent change, remove-or-fund Brainstorm/God Mode (both now just open Home Chat while landing docs still advertise them), rotation/purge.
8. **Add the competitive framing the owner now wants** (Devin, Conductor, Capy) to the evaluation protocol in PRD §10 (Terminal-Bench 4.0 via Harbor, SWE-bench Pro V2, private holdout) and the differentiator list in §11; the current plan benchmarks against Claude Code/Codex/OpenCode only. Research on those three products is a prerequisite for the forward plan.
9. **Add the data-safety items in §7** to W02b/W04b/W10/W18 as named acceptance tests (git config injection, SSO state, deep-link token, default processor, `bulk_update_issues` approval, PAT `SetNull`, tool-id replay, crash recovery).
10. **Fix the record**: correct `ISSUES.md:224` path, the runbook claims (`DIRECT_DATABASE_URL`, drift-check), `docs/CODEBASE_INDEX.md:32`, the Phase 1–2 "Done" labels, and the SDK 1.2.5 comments.
