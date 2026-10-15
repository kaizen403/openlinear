# Backend review and first-tranche validation — 2026-10-15

Historical W00 baseline. The later [W01 implementation ledger](w01-implementation.md) supersedes current implementation status and records 928 passing tests, source commits pushed to `dev` and the remaining gates. The baseline measurements below retain their original scope and results.

Status: planning and bounded first implementation tranche complete locally. The full backend programme remains pending. See [master plan](../../../tasks/prd-backend-agent-platform.md) for W00–W21 and gate definitions.

## Scope and environment

Reviewed the Desktop revamp plan, repository history/current wiring, and six backend workstreams: execution, API/data, AI/product, sandboxing, OpenAI integration and benchmarking. Source audits distinguish live routes from prototypes; they do not certify every line or production configuration.

Baseline checkout: dev at 157de4e. Dependencies installed with frozen lockfile and lifecycle scripts disabled. Prisma client generated. Tests used a new loopback-only PostgreSQL 16 container and three disposable databases ending in _test; no live database, cloud account or paid inference was used. The test container is removed after verification.

No frontend implementation, deployment, commit or push was performed. Desktop UI typecheck was a compatibility check required by repository guidance; no UI source changed.

Runtime: Node 22.16.0, pnpm 9.0.0, Git 2.49.0, SQLite 3.49.1. Codex SDK and no-inference CLI version check both resolve to 0.147.0. OpenCode SDK lockfile resolves to 1.18.30.

## Implemented changes

| Area | Concrete repair | Evidence |
|---|---|---|
| Remote task setup | Return and use actual acquired workspace path/branch; full UUID per attempt; acquire client after directory resolution; release owned failed setup and finalize owned partial state | Real-Git lifecycle composition and mocked upstream-session boundary |
| Workspace provider | Explicit fresh branch/tag namespaces; no bare-origin HEAD dependency; missing branch cannot fall back to tag; full commit resolution; credential-scoped partial-clone materialization | Origin advancement, deleted/updated tags, same-name branch/tag, filtered file transport tests |
| Workspace safety | Validate path segments and symlinks; preserve valid .github/_repo names; refuse existing attempts without deleting edits; validate release ownership; surface removal errors; bounded mutex entry cleanup | Concurrent real acquisitions, collision preservation, traversal/symlink/forged-handle, release and failed-fetch recovery tests |
| API replay and progress | Authorize current task/project before opening run replay; require full permission for progress writes | Ten new access regressions including cross-tenant, denied project, view-only write and positive replay |
| Archive targeting | Validate raw selectors and effective nonblank selection at shared service boundary; malformed input cannot become project-wide archive | Fifteen new selector regressions plus existing chat-tool cases |
| Codex prototype adapter | Official pinned event types; command/patch/MCP outcomes; per-item text; usage categories; configured model; live ID; AbortSignal cancellation; unexpected EOF and error handling | Twenty offline SDK-typed tests; actual binary version check |
| OpenCode prototype adapter | Scope raw events before decoding/state mutation; nested IDs and v2 deltas; reject foreign/missing/conflicting ownership | Ten new interleaved-session and native-event fixtures |
| Benchmark | Real seeded Git + worktree + SQLite + prototype coordinator/FakeRunner; raw samples, hardware/source hashes, failures, optional threshold, cleanup | 30 small and 4 large measured trials, failure/interrupt/determinism exercises |
| Existing test defects | Correct GitService mocks to the hardened Git wrapper; make stale-session fixture actually remove state before its delayed event | Original assertions retain intended behavior; full sidecar suite passes |

These changes do not wire the prototype adapters/coordinator into production routes, implement an OS sandbox, or repair every existing execution flaw. The normal route's runner-selection gap, API-only bootstrap, batch completion/concurrency, durable event integration, active-worktree GC and real recovery remain explicit next work.

## Integrated verification

| Check | Result |
|---|---|
| API full suite | 26 files; 213 passed, 2 preexisting skipped |
| Sidecar full suite | 29 files; 412 passed; no unhandled rejections |
| execution-core full suite | 2 files; 28 passed |
| API typecheck | Passed |
| Sidecar typecheck | Passed |
| execution-core typecheck | Passed |
| MCP typecheck | Passed |
| Desktop UI compatibility typecheck | Passed |
| Benchmark helper strict typecheck with existing SQLite shim | Passed |
| git diff --check | Passed |

Total: **653 passing tests**, plus two existing skips. The skips are obsolete many-team project-association cases in API projects.test.ts, already marked skipped in the baseline. Test counts are not a proxy for missing end-to-end coverage.

Commands run from the repository, using the dedicated TEST_DATABASE_URL for API tests:

~~~sh
pnpm --filter @openlinear/api test
pnpm --filter @openlinear/sidecar test
pnpm --filter @openlinear/execution-core test
pnpm --filter @openlinear/api typecheck
pnpm --filter @openlinear/sidecar typecheck
pnpm --filter @openlinear/execution-core typecheck
pnpm --filter @openlinear/mcp typecheck
pnpm --filter @openlinear/desktop-ui typecheck
git diff --check
~~~

Do not run the API suite against an existing development/production database: its fixtures truncate tables. The repository guard requires a loopback URL and a database named with _test.

## Measured component baseline

Hardware: Apple M5 Pro, arm64, 15 logical CPUs, 24 GiB RAM. The controlled file:// origin advertises partial-clone filtering. Fixture content/commit are deterministic. Cold means an empty application mirror; OS page caches were not flushed. One warmup is excluded from measured counts.

| Fixture | Measured trials | Cold first journaled fake delta | Warm first journaled fake delta |
|---|---|---|---|
| 2,000,000 bytes / 8 files | 5 cold + 25 warm; 30/30 successful | p50 204.47 ms; p95 231.97 ms | p50 65.31 ms; p95 73.97 ms; p99 74.67 ms |
| 300 MiB / 1,200 files | 1 cold + 3 warm; 4/4 successful | 6,004.69 ms, one sample | p50 305.12 ms; p95 389.72 ms, three samples |

Large-fixture tail percentiles are descriptive, not robust tail estimates. Full samples and source hashes: [small fixture JSON](artifacts/latency-small-30.json), [300 MiB JSON](artifacts/latency-300mb.json). Both report temporaryFixtureCleaned=true.

The measured interval includes journal open, workspace acquisition, checkout byte-count verification, and the first fake message persisted to SQLite through RunCoordinator/SessionManager. It excludes API admission, real provider/network TTFT, OS sandboxing, actual code changes/tests, and PR publication. The coordinator is a prototype exercised directly, not the normal HTTP execution route. These results establish a reproducible component baseline and **do not establish improved end-to-end latency or superiority over another agent**.

Reproduction (requires local dependencies, Node with node:sqlite, Git and disk space):

~~~sh
node apps/sidecar/scripts/latency-bench.mjs --cold-iterations 5 --warm-iterations 25 --output /tmp/openlinear-latency-small-30.json
node apps/sidecar/scripts/latency-300mb.mjs --cold-iterations 1 --warm-iterations 3 --output /tmp/openlinear-latency-300mb.json
~~~

Use --max-warm-p95-ms only after calibrating a comparable machine/workload; the script exits nonzero on failure. Threshold failure, invalid arguments, missing-Git setup failure, interrupt cleanup, deterministic fixture hash/commit and temporary directory cleanup were exercised. The wrapper supplies a minimal environment and restricts local-file Git permission to its child.

## Review findings incorporated

An independent execution review caught stale-tag/branch ambiguity, valid repository-name rejection and private partial-clone materialization needing credentials; these were corrected before the final suite/benchmark run. Private HTTPS authentication itself was not exercised against a real service.

Master-plan review tightened durable journal/coordinator acceptance, test/trust gating before sandbox completion, candidate-commit verification, honest in-flight cancellation semantics, the durable-chat/plan dependency order, and non-command evidence schemas.

The current provider still needs remote/trust-aware mirror keys, cross-process locking, coalesced refresh, full active-lease/maxBytes GC and normal-completion cleanup. Acquisition path checks are not an OS sandbox or protection against arbitrary concurrent same-user filesystem mutation.

## Next authorized engineering sequence

W01 fixes truthful runner selection, batch validation and publication outcomes. W02/W04 close remaining scope/idempotency/outbox gaps. W03 removes cloud database/signing-key dependence from local execution. W05/W06 then prove one durable FakeRunner execution path before native runner/workspace/sandbox integration. See the master plan for dependencies, exact gates and later product work.

No paid coding-task benchmark, sandbox enforcement corpus, six-hour soak, process-kill recovery proof, production traffic test or live migration was performed. Those remain planned gates, not implicit completed work.
