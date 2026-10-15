# W01 legacy execution implementation — 2026-10-15

Implementation commits: `ed4d843` implements the main slice; `7bb8330` preserves single-task work after an ambiguous prompt dispatch; `ca680b1` counts overlapping admission reservations once; `7d2d610` fences recovered publication and terminal/cancellation ownership. Earlier commits: `ad7d6e7` records the master plan/audit; `42a2a55` records the initial access, runner-adapter and workspace repairs. This source batch is pushed to `origin/dev`.

Status: this bounded legacy execution slice is implemented and locally verified. The full backend programme and its acceptance gates remain in progress. Root authored production changes; helper concurrency stayed at two, including high-reasoning GPT-6.1-sol reviewers for the follow-up races. No frontend source, deployment, live database or paid inference changes were made. User-authorized source pushes target `dev`, whose workflow runs checks/builds; deployment and release workflows require `main`, tags or manual dispatch.

## Enabled behavior

| Boundary | Result | Main source |
|---|---|---|
| Runner choice | The legacy path accepts OpenCode. Unknown/blank choices fail; known Codex/Claude choices fail explicitly instead of silently running OpenCode. Native adapters remain prototypes. | `engine/resolve-agent.ts`, `execution/lifecycle.ts`, `batch/admission.ts` |
| Single admission | Pending work reserves the task before awaits. Count each task once while its active state and setup reservation overlap. Archived, persisted-running and unlinked tasks fail; the global active-repository fallback is removed. Authorized task bindings must match the fetched snapshot. | `execution/lifecycle.ts`, `execution/state.ts` |
| Batch admission | Validate every member, duplicates/count, explicit remote repository/base, local-path exclusion and combined model consistency. Bind members atomically against their exact selected status and resource/configuration values. | `batch/admission.ts`, `batch/orchestrator.ts` |
| Launch and approvals | Initial launches and refill respect per-batch concurrency. Queue approval is conditional after validation. Queued members are revalidated before checkout and submission. | `batch/orchestrator.ts`, `batch/completion.ts`, execution-core batch helpers |
| SDK readiness | The installed OpenCode SDK creates a lazy stream. Readiness now requires a received frame; initial failure, EOF, cancellation and a 30-second readiness budget are explicit. Reconnect closes the previous consumer. | `services/session-manager.ts`, `execution/events.ts` |
| Prompt acceptance | Immediate rejection returns a failed start. Mark dispatch before the SDK call and retain single-task work after a lost acknowledgement, recording branch/path in the failure outcome. Cancellation during readiness prevents submission; acceptance after dispatched cancellation triggers another stop attempt. | `execution/{lifecycle,events,state}.ts`, `batch/orchestrator.ts` |
| Stop ownership | Positive SDK boolean acknowledgement is required before publishing recovered work. Missing/false/error responses remain reserved for retry. Single cancellations share one operation through persistence and cleanup; retries cannot overlap stream-failure finalization. Member cancellation owns its receipt/persistence interval; sibling publication waits for it. | `execution/events.ts`, `execution/lifecycle.ts`, `batch/{shared,orchestrator,completion}.ts` |
| Publication | Single and batch paths share strict GitHub publication. One POST; one filtered GET reconciliation for duplicate/ambiguous dispatch or lost response body. A compare link, foreign/invalid PR URL or HTTP failure cannot complete the task. | `services/github-publication.ts`, `execution/git.ts`, `batch/publication.ts` |
| Completion | Single done and cancelled writes require the captured session/status and resource binding. Stale completion catches cannot cancel a replacement session. Confirmed terminal markers prevent retries from rewriting the task. Logs and cleanup retain captured ownership, including after awaited stream closure. Batch done writes are one transaction bound to the batch/project. Done notifications follow persistence. Accepted remote results are retained during cancellation. | `execution/{events,state,lifecycle}.ts`, `batch/completion.ts` |
| Receipts | Atomic, fsynced, private JSON under `<repo>/.receipts`, outside worktrees. Store owner/repository/member/session/branch/path/PR/cancellation facts and redact held credentials from errors. Writers serialize before taking the snapshot. | `batch/publication.ts` |
| Git and cleanup | Full batch/attempt branch IDs, explicit fresh origin refs, credential-scoped materialization, absent-target push lease, detached merge workspace and conditional target-ref advancement. Git/list/remove failures preserve artifacts; only empty batch roots are removed. | `services/worktree.ts`, execution-core batch helpers |
| Staging | Parse literal NUL-delimited status records, including rename source/destination. Check working tree and actual staged index; protect workflows/hooks and nested script-bearing manifests, including deletion and symlinks. | `engine/staging-allowlist.ts`, `execution/git.ts` |

Failed, skipped, cancelled and uncertain workspaces remain inspectable. A fully published batch can clean only after its completed receipt is recorded; dirty/locked worktrees and unknown root files still prevent deletion.

Compatibility note: legacy batch-member `status: completed` means its local commit is ready while the batch is still running. Actual task rows remain `in_progress` at 95% until PR publication and terminal persistence. Consumers must inspect batch status/publication and the actual task result. Legacy single failures still use the existing `cancelled` task projection with a failed AgentRun/error outcome; W05 will separate run results from this projection.

## Verification

| Check | Result |
|---|---|
| Sidecar full unit/HTTP/real-Git/SDK fixture suite | 38 files, 661 passed |
| Sidecar PostgreSQL integration suite | 1 file, 26 passed |
| API full suite | 26 files, 213 passed; 2 preexisting skips |
| execution-core full suite | 2 files, 28 passed |
| API / sidecar / execution-core typechecks | Passed |
| MCP / desktop UI compatibility typechecks | Passed; no frontend source changes |
| Diff checks | Passed |
| GitHub Dev workflow on `7d2d610` | Passed: lint/typecheck, tests and builds ([run](https://github.com/kaizen403/openlinear/actions/runs/38669609917)) |
| Documentation push `457e3d2` CI | Build and lint/typecheck passed. Test job failed the unchanged frontend browser-scroll gate: 200 ms maximum frame on attempt one; Chromium DevTools startup timeout on attempt two. Sidecar 661 and execution-core 28 passed in both attempts ([run](https://github.com/kaizen403/openlinear/actions/runs/38669992496)). Deferred to the Downloads frontend backlog. |

Total: **928 passing tests**, excluding duplicate focused reruns. The full sidecar suite, PostgreSQL integration suite and sidecar typecheck were rerun after the final ownership fixes. The API and execution-core suites remain from the main slice; their exercised paths were unchanged by the follow-ups. The existing API skips concern the obsolete many-team project association model; no new skips were introduced. Test counts do not establish end-to-end model quality, isolation or recovery.

PostgreSQL regressions use actual transactions and row locks. They verify all-member admission rollback, no externally visible partial done while a terminal transaction waits on cancellation, denied stale batch callbacks/logs, and denied single done/cancelled/log writes after session or project/team/creator replacement. Positive captured logs work before and after a confirmed terminal write; cancellation retry leaves the row unchanged. Replacement execution survives stale callbacks and awaited cleanup. Fixtures delete only rows they create. The integration config requires an explicit disposable loopback `TEST_DATABASE_URL` ending in `_test`; it does not accept ambient production credentials.

Real Git regressions cover fresh/deleted origin refs, bad origin HEAD, concurrent checkouts, attempt collisions, other remote writers, locked/dirty/unknown cleanup artifacts, retained merge directories, writes before a lost prompt acknowledgement, staged-versus-working-tree differences, protected renames, odd filenames and nested manifests. Admission interleaving verifies that a second task starts at limit two while the first awaits acknowledgement, a third is rejected, and the original reservation remains owned. Installed SDK fixtures use synthetic HTTP/SSE responses; GitHub requests are mocked.

Representative commands:

~~~sh
pnpm --filter @openlinear/sidecar test
TEST_DATABASE_URL=postgresql://openlinear:openlinear@127.0.0.1:55439/openlinear_w01_test pnpm --filter @openlinear/sidecar test:integration
TEST_DATABASE_URL=postgresql://openlinear:openlinear@127.0.0.1:55439/openlinear_w01_test pnpm --filter @openlinear/api test
pnpm --filter @openlinear/execution-core test
pnpm --filter @openlinear/sidecar typecheck
pnpm --filter @openlinear/api typecheck
pnpm --filter @openlinear/execution-core typecheck
pnpm --filter @openlinear/mcp typecheck
pnpm --filter @openlinear/desktop-ui typecheck
git diff --check
~~~

The PostgreSQL 16 container was disposable, had no persistent volume and exposed only `127.0.0.1:55439`. Its schema was migrated locally and the container was removed after verification. API fixtures truncate tables, so they must never use an existing development/live database.

## Latency evidence

The concrete legacy-path change removes each member's redundant explicit base-ref fetch: batch admission refreshes the mirror once and members check out that known namespace. Partial-clone blob materialization can still make network requests. Parallel setup remains bounded, and readiness waits for an actual connection rather than reporting a premature start. Full HTTP/model/task-to-PR instrumentation remains W15/W21 work.

The existing offline component harness was rerun without the test suite running alongside it:

| Fixture | Trials | Cold first journaled fake delta p95 | Warm first journaled fake delta p95 |
|---|---|---|---|
| Small deterministic Git repository | 5 cold + 25 warm; 30/30 passed | 488.26 ms | 92.21 ms |

One warmup is excluded; all temporary fixtures were removed. Percentiles use nearest rank. The nine benchmarked source hashes match the earlier component baseline. The changed legacy lifecycle/publication code is outside this harness, so these timings cannot be attributed to W01 or used as a claim of latency improvement. The earlier warm p95 was 73.97 ms; repeated host timings vary.

The first rerun overlapped test load and measured warm p95 184.14 ms. It is retained separately as a diagnostic, not a release baseline.

- [Isolated raw report](artifacts/w01-latency-isolated-30.json)
- [Concurrent-test-load diagnostic](artifacts/w01-latency-with-test-load-30.json)
- [Earlier baseline and full audit validation](validation.md)

Both runs exclude real inference, native agent quality, HTTP admission, sandbox startup, GitHub publication and cloud transport. No Codex/Claude/Devin superiority claim is made.

## Remaining gates and next work

W02–W04 establish central principal/resource policy, scoped API-only bootstrap, immutable events/outbox and idempotency. W05/W06 then prove one durable run service and journal/effect reconciliation together before native route integration.

The latest authorization review confirms the first W02 targets: current task permission for comment mutations, scoped historical usage, project revocation on chat reads, workspace task-search filtering, live/domain replay policy and workspace-bound PAT principals. Reuse the existing scoped predicates and access assertions. Those findings remain pending; this slice does not claim that all API surfaces share one authorization policy.

Current reservations, concurrency, cancellation quarantine and cleanup coordination are process-local. Batch receipts provide manual inspection evidence; they do not perform restart recovery, attach to surviving provider sessions or reconcile every effect automatically. SDK abort acknowledgement does not prove OS process-tree termination. Pending single setup cancellation, every-await fault coverage, cross-process admission/leases and global scheduling limits require the durable engine.

Production still uses the legacy OpenCode path and direct Prisma access. Native Codex/Claude routing, isolated local-project checkouts, cache leases/GC, OS filesystem/process/network isolation, credential brokerage, immutable candidate verification and crash-safe publication remain pending. Staging rules govern what can be published; they do not prevent repository code from executing before the gate.

The public coding benchmark, sealed holdout, six-hour soak and complete task-to-PR latency/usage gates remain unrun. Frontend contract migrations and optional cloud dependencies are recorded in the Downloads files; no frontend or cloud provisioning is part of this implementation slice.
