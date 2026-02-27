# Hybrid Cloud Data + Local Agents

## TL;DR

> **Quick Summary**: Migrate OpenLinear to a hybrid trust-boundary architecture: cloud keeps collaborative product data, desktop keeps secrets and executes agents locally, and only execution metadata syncs to cloud.
>
> **Deliverables**:
> - Privacy-safe execution metadata ingestion contract and APIs
> - Desktop local runner + secure secret storage
> - Removal of server-side secret persistence and container execution paths
> - Phased rollout with feature flags, canary, and privacy regression tests
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 implementation waves + final review wave
> **Critical Path**: 2 -> 7 -> 8 -> 12 -> 17 -> F1/F3

---

## Context

### Original Request
- Keep OpenLinear desktop-first.
- Keep centralized cloud data for projects/teams/issues.
- Never store user AI keys on OpenLinear servers.
- Users run agents locally with their own keys and local codebases.
- Sync execution metadata only.

### Interview Summary
**Key Discussions**:
- Local-only full DB approach was rejected because centralized collaborative data is required.
- Hybrid split was confirmed: cloud data + local secrets/execution.
- Execution sync policy was chosen: metadata-only.

**Research Findings**:
- Current schema includes secret persistence risk: `packages/db/prisma/schema.prisma` (`User.accessToken`).
- Current backend execution model is server/container-centric: `apps/api/src/services/container-manager.ts`, `apps/api/src/routes/opencode.ts`, `apps/api/src/services/opencode.ts`.
- Task execution currently allows optional auth path that must be tightened: `apps/api/src/routes/tasks.ts`.
- Desktop sidecar primitives already exist and can host local runner control: `apps/desktop/src-tauri/src/sidecar.rs`, `apps/desktop/src-tauri/src/opencode.rs`.

### Metis + Oracle Hardening
**Identified Gaps (addressed in this plan)**:
- Missing explicit secret taxonomy and trust boundary.
- Missing ingestion auth/provenance controls (device + user binding).
- Missing contract tests for forbidden-field rejection.
- Missing phased migration/cutover strategy and rollback controls.

---

## Work Objectives

### Core Objective
Deliver a privacy-preserving hybrid architecture where cloud handles collaboration state and desktop handles all secrets plus execution, without breaking existing team/project/task workflows.

### Concrete Deliverables
- Metadata-only ingestion endpoint family under API with strict allowlist validation.
- Desktop local runner orchestration with secure local secret storage.
- Server-side secret write path removed/deprecated (`User.accessToken`, raw execution logs).
- Feature-flagged migration from container/server execution to local execution.
- End-to-end automated verification for privacy, sync reliability, and regression safety.

### Definition of Done
- [ ] API rejects forbidden sync fields (`prompt`, `toolLogs`, `rawOutput`, absolute local paths) with 4xx.
- [ ] No production path writes secrets to cloud DB.
- [ ] Desktop can run tasks locally, then sync metadata-only events.
- [ ] Offline metadata queue syncs on reconnect without duplicate records.
- [ ] Team/project/task APIs remain behavior-compatible with current tests.

### Must Have
- Central PostgreSQL remains source of truth for collaborative entities.
- AI/provider keys remain local only in desktop secure storage.
- Metadata sync includes only: runId/taskId/state/timestamps/duration/branch/commit/pr refs/outcome/errorCategory.

### Must NOT Have (Guardrails)
- No raw prompt, tool trace, terminal output, or secret values sent to cloud.
- No server-side container fallback left enabled after final cutover.
- No acceptance criteria requiring manual end-user verification.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — verification is tool/agent executed only.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after)
- **Framework**: Existing API test suite (`apps/api/src/__tests__/*.test.ts`)

### QA Policy
- Every task includes at least one happy-path and one negative-path scenario.
- Evidence captured under `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

| Deliverable Type | Verification Tool | Method |
|------------------|-------------------|--------|
| Desktop runner + local storage | interactive_bash (tmux) | Start app-side processes, inspect command output, assert exit/health |
| API contract + validation | Bash (curl) | Send allowed/forbidden payloads, assert response codes and body |
| Schema/DB behavior | Bash (test command) | Run migrations/tests, assert writes/reads and constraints |
| UI integration | Playwright | Trigger local run, assert status transitions rendered |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately)
├── Task 1: Secret taxonomy + trust boundary spec [writing]
├── Task 2: Metadata ingestion schema/allowlist contract [deep]
├── Task 3: Feature flags for execution-mode migration [quick]
├── Task 4: Desktop secure storage abstraction [unspecified-high]
└── Task 5: DB migration prep (deprecate server secret writes) [unspecified-high]

Wave 2 (Core implementation — max parallel)
├── Task 6: API metadata ingestion endpoints [deep]
├── Task 7: Ingestion auth (user auth + device signing + idempotency) [ultrabrain]
├── Task 8: Desktop local runner orchestration [unspecified-high]
├── Task 9: Offline metadata queue + retry sync [deep]
├── Task 10: Route hardening for execution auth boundaries [quick]
└── Task 11: Forbidden-field rejection + privacy contract tests [deep]

Wave 3 (Migration + product integration)
├── Task 12: Replace server/container execution in lifecycle via flags [unspecified-high]
├── Task 13: Desktop UI integration for local run + cloud metadata status [visual-engineering]
├── Task 14: Batch local execution metadata model alignment [deep]
├── Task 15: Backfill/cleanup for legacy secret fields/logs [unspecified-high]
└── Task 16: CI gates for privacy regression + compatibility tests [quick]

Wave 4 (Final integration)
├── Task 17: Canary rollout + kill-switch playbook [writing]
├── Task 18: End-to-end offline/reconnect reliability tests [deep]
└── Task 19: Remove deprecated server execution paths post-canary [unspecified-high]

Wave FINAL (Independent review, parallel)
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real QA execution of all scenarios (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: 2 -> 7 -> 8 -> 12 -> 17 -> F1/F3
Parallel Speedup: ~60% vs sequential
Max Concurrent: 6
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|------------|--------|------|
| 1 | — | 6,11,17 | 1 |
| 2 | — | 6,7,11 | 1 |
| 3 | — | 12,19 | 1 |
| 4 | — | 8,9,13 | 1 |
| 5 | — | 15,19 | 1 |
| 6 | 1,2 | 12,14 | 2 |
| 7 | 2 | 9,12 | 2 |
| 8 | 4,7 | 13,18 | 2 |
| 9 | 4,7 | 18 | 2 |
| 10 | 2 | 12 | 2 |
| 11 | 1,2 | 16,18 | 2 |
| 12 | 3,6,7,10 | 19 | 3 |
| 13 | 8,9 | 18 | 3 |
| 14 | 6,7 | 18 | 3 |
| 15 | 5,6 | 19 | 3 |
| 16 | 11 | 17 | 3 |
| 17 | 1,16 | 19,F1-F4 | 4 |
| 18 | 8,9,11,13,14 | F3 | 4 |
| 19 | 12,15,17 | F1,F4 | 4 |

### Agent Dispatch Summary

| Wave | # Parallel | Tasks -> Agent Category |
|------|------------|-------------------------|
| 1 | 5 | T1 `writing`, T2 `deep`, T3 `quick`, T4 `unspecified-high`, T5 `unspecified-high` |
| 2 | 6 | T6 `deep`, T7 `ultrabrain`, T8 `unspecified-high`, T9 `deep`, T10 `quick`, T11 `deep` |
| 3 | 5 | T12 `unspecified-high`, T13 `visual-engineering`, T14 `deep`, T15 `unspecified-high`, T16 `quick` |
| 4 | 3 | T17 `writing`, T18 `deep`, T19 `unspecified-high` |
| FINAL | 4 | F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep` |

---

## TODOs

- [ ] 1. Define secret taxonomy and trust-boundary policy
  - **What to do**: create explicit cloud-allowed vs local-only field catalog; map existing payloads/DB fields.
  - **Must NOT do**: do not leave any unclassified field; default unclassified -> local-only.
  - **Recommended Agent Profile**: `writing`, skills `security-modeling`, `api-contracts`.
  - **Parallelization**: Can run in parallel YES; Group Wave 1; Blocks 6/11/17; Blocked by none.
  - **References**: `packages/db/prisma/schema.prisma` (identify sensitive fields), `apps/api/src/routes/tasks.ts` (execution payload patterns), `apps/api/src/routes/opencode.ts` (runtime data flow).
  - **Acceptance Criteria**: policy doc exists and lists every execution/auth field with classification.
  - **QA Scenarios**:
    - Happy: Validate policy coverage script returns 100% classified fields; evidence `.sisyphus/evidence/task-1-policy-coverage.txt`.
    - Negative: Add synthetic unclassified field in check fixture -> script fails; evidence `.sisyphus/evidence/task-1-policy-fail.txt`.

- [ ] 2. Implement metadata ingestion contract (allowlist DTO/schema)
  - **What to do**: define versioned ingestion DTO with strict allowlist and shared validators.
  - **Must NOT do**: no permissive passthrough/unknown field acceptance.
  - **Recommended Agent Profile**: `deep`, skills `schema-validation`, `typescript`.
  - **Parallelization**: YES; Wave 1; Blocks 6/7/11; Blocked by none.
  - **References**: `apps/api/src/routes/tasks.ts` (current execution state), `apps/desktop-ui/lib/api/types.ts` (client types), `apps/api/src/__tests__/tasks.test.ts` (API test style).
  - **Acceptance Criteria**: shared validator module rejects unknown keys and invalid enums.
  - **QA Scenarios**:
    - Happy: POST valid metadata payload -> 2xx; evidence `.sisyphus/evidence/task-2-valid-payload.json`.
    - Negative: POST payload containing `prompt` or `toolLogs` -> 4xx + explicit code; evidence `.sisyphus/evidence/task-2-forbidden-field.json`.

- [ ] 3. Add feature flags for migration phases
  - **What to do**: add flags for `local_execution_enabled`, `server_execution_enabled`, canary cohort behavior.
  - **Must NOT do**: no hard cutover without rollback path.
  - **Recommended Agent Profile**: `quick`, skills `config`, `feature-flags`.
  - **Parallelization**: YES; Wave 1; Blocks 12/19; Blocked by none.
  - **References**: `apps/api/src/services/opencode.ts`, `apps/api/src/services/container-manager.ts`, `apps/api/src/routes/tasks.ts`.
  - **Acceptance Criteria**: toggling flags switches code path deterministically in tests.
  - **QA Scenarios**:
    - Happy: flag matrix test verifies expected execution branch; evidence `.sisyphus/evidence/task-3-flag-matrix.txt`.
    - Negative: conflicting flag config triggers startup validation error; evidence `.sisyphus/evidence/task-3-invalid-flags.txt`.

- [ ] 4. Build desktop secure storage abstraction for secrets
  - **What to do**: implement OS-keychain-backed secret interface for AI keys/GitHub token.
  - **Must NOT do**: no plaintext secret persistence in SQLite/logs.
  - **Recommended Agent Profile**: `unspecified-high`, skills `tauri`, `security`.
  - **Parallelization**: YES; Wave 1; Blocks 8/9/13; Blocked by none.
  - **References**: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/opencode.rs`, `apps/desktop/src-tauri/src/sidecar.rs`.
  - **Acceptance Criteria**: secrets retrievable via secure storage API, absent from local app logs.
  - **QA Scenarios**:
    - Happy: set/get/delete secret command succeeds; evidence `.sisyphus/evidence/task-4-secret-roundtrip.txt`.
    - Negative: tampered storage key lookup returns controlled error; evidence `.sisyphus/evidence/task-4-secret-error.txt`.

- [ ] 5. Prepare DB migration away from server secret writes
  - **What to do**: deprecate `User.accessToken` write path; define migration/backfill policy for legacy rows.
  - **Must NOT do**: do not break collaborative entities (teams/projects/tasks).
  - **Recommended Agent Profile**: `unspecified-high`, skills `prisma`, `migrations`.
  - **Parallelization**: YES; Wave 1; Blocks 15/19; Blocked by none.
  - **References**: `packages/db/prisma/schema.prisma`, `apps/api/src/services/github.ts`, `apps/api/src/routes/auth.ts`.
  - **Acceptance Criteria**: automated tests prove no new `accessToken` persistence occurs.
  - **QA Scenarios**:
    - Happy: auth flow succeeds while DB token field remains null/unchanged; evidence `.sisyphus/evidence/task-5-auth-no-secret.txt`.
    - Negative: forced legacy write attempt is blocked and logged as policy violation; evidence `.sisyphus/evidence/task-5-write-block.txt`.

- [ ] 6. Implement metadata ingestion endpoints
  - **What to do**: add start/progress/finish ingestion routes with strict schema and task/run linkage.
  - **Must NOT do**: do not accept arbitrary text blobs.
  - **Recommended Agent Profile**: `deep`, skills `express`, `api-design`.
  - **Parallelization**: YES; Wave 2; Blocks 12/14; Blocked by 1/2.
  - **References**: `apps/api/src/routes/tasks.ts`, `apps/api/src/routes/settings.ts`, `apps/api/src/__tests__/tasks.test.ts`.
  - **Acceptance Criteria**: route tests cover valid state transitions and invalid transitions.
  - **QA Scenarios**:
    - Happy: start->progress->finish accepted with correct ordering; evidence `.sisyphus/evidence/task-6-state-flow.json`.
    - Negative: finish before start rejected with 409/422; evidence `.sisyphus/evidence/task-6-invalid-order.json`.

- [ ] 7. Add authenticated provenance for metadata uploads
  - **What to do**: require user auth + device-bound signature + nonce/sequence/idempotency.
  - **Must NOT do**: no bearer-only unsigned ingestion in final mode.
  - **Recommended Agent Profile**: `ultrabrain`, skills `crypto`, `auth`.
  - **Parallelization**: YES; Wave 2; Blocks 9/12; Blocked by 2.
  - **References**: `apps/api/src/routes/auth.ts`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/main.rs`.
  - **Acceptance Criteria**: replayed signed batch is rejected; idempotent retry returns stable result.
  - **QA Scenarios**:
    - Happy: valid signed envelope ingests once and returns run checkpoint; evidence `.sisyphus/evidence/task-7-signed-ok.json`.
    - Negative: replay same nonce/sequence rejected; evidence `.sisyphus/evidence/task-7-replay-reject.json`.

- [ ] 8. Implement local runner orchestration on desktop
  - **What to do**: orchestrate local OpenCode execution lifecycle and emit metadata events.
  - **Must NOT do**: do not stream raw logs/prompts to cloud.
  - **Recommended Agent Profile**: `unspecified-high`, skills `tauri`, `process-management`.
  - **Parallelization**: YES; Wave 2; Blocks 13/18; Blocked by 4/7.
  - **References**: `apps/desktop/src-tauri/src/opencode.rs`, `apps/desktop/src-tauri/src/sidecar.rs`, `apps/api/src/services/opencode.ts`.
  - **Acceptance Criteria**: local run transitions through expected lifecycle and emits metadata buffer.
  - **QA Scenarios**:
    - Happy: execute task locally and observe emitted metadata events; evidence `.sisyphus/evidence/task-8-local-run.txt`.
    - Negative: missing local key causes local failure category `AUTH` without cloud secret leak; evidence `.sisyphus/evidence/task-8-missing-key.txt`.

- [ ] 9. Add offline metadata queue with retry + dedupe
  - **What to do**: persist outgoing metadata locally, retry with backoff, enforce idempotency keys.
  - **Must NOT do**: no duplicate final state updates in cloud.
  - **Recommended Agent Profile**: `deep`, skills `resilience`, `queueing`.
  - **Parallelization**: YES; Wave 2; Blocks 18; Blocked by 4/7.
  - **References**: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop-ui/lib/api/client.ts`.
  - **Acceptance Criteria**: network-off run queues events; reconnect flushes exactly once.
  - **QA Scenarios**:
    - Happy: disconnect network, run task, reconnect, flush succeeds; evidence `.sisyphus/evidence/task-9-offline-flush.txt`.
    - Negative: duplicate flush attempts do not duplicate DB records; evidence `.sisyphus/evidence/task-9-dedupe.txt`.

- [ ] 10. Harden execution route auth boundaries
  - **What to do**: remove optional-auth execution entrypoints and enforce authenticated identity mapping.
  - **Must NOT do**: no anonymous execution endpoints.
  - **Recommended Agent Profile**: `quick`, skills `express`, `authz`.
  - **Parallelization**: YES; Wave 2; Blocks 12; Blocked by 2.
  - **References**: `apps/api/src/routes/tasks.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/batches.ts`.
  - **Acceptance Criteria**: unauthorized execution requests consistently return 401/403.
  - **QA Scenarios**:
    - Happy: authenticated execution metadata endpoint works; evidence `.sisyphus/evidence/task-10-auth-ok.json`.
    - Negative: missing/invalid token fails with no side effects; evidence `.sisyphus/evidence/task-10-auth-fail.json`.

- [ ] 11. Add privacy contract tests (forbidden-field rejection)
  - **What to do**: add negative contract tests for prohibited payload fields and path leakage.
  - **Must NOT do**: no permissive test fixtures that normalize forbidden fields.
  - **Recommended Agent Profile**: `deep`, skills `testing`, `security`.
  - **Parallelization**: YES; Wave 2; Blocks 16/18; Blocked by 1/2.
  - **References**: `apps/api/src/__tests__/tasks.test.ts`, `apps/api/src/__tests__/auth.test.ts`, `apps/api/src/__tests__/health.test.ts`.
  - **Acceptance Criteria**: CI fails if forbidden fields are accepted.
  - **QA Scenarios**:
    - Happy: allowed metadata passes all contract tests; evidence `.sisyphus/evidence/task-11-contract-pass.txt`.
    - Negative: payload with local path or raw logs rejected; evidence `.sisyphus/evidence/task-11-contract-reject.txt`.

- [ ] 12. Replace server/container execution in lifecycle via flags
  - **What to do**: route execution lifecycle to local metadata mode; gate legacy container path.
  - **Must NOT do**: no unguarded direct use of `container-manager` in active path.
  - **Recommended Agent Profile**: `unspecified-high`, skills `refactoring`, `feature-flags`.
  - **Parallelization**: YES; Wave 3; Blocks 19; Blocked by 3/6/7/10.
  - **References**: `apps/api/src/services/execution/lifecycle.ts`, `apps/api/src/services/container-manager.ts`, `apps/api/src/routes/opencode.ts`.
  - **Acceptance Criteria**: local mode enabled -> no container provisioning call occurs.
  - **QA Scenarios**:
    - Happy: execution in local mode updates task states via ingestion only; evidence `.sisyphus/evidence/task-12-local-mode.txt`.
    - Negative: forced server execution request when disabled returns controlled error; evidence `.sisyphus/evidence/task-12-server-disabled.txt`.

- [ ] 13. Integrate desktop UI with local execution + cloud metadata state
  - **What to do**: wire UI status components to local-run and synced metadata states.
  - **Must NOT do**: no UI rendering of sensitive local logs by default cloud data source.
  - **Recommended Agent Profile**: `visual-engineering`, skills `react`, `state-management`.
  - **Parallelization**: YES; Wave 3; Blocks 18; Blocked by 8/9.
  - **References**: `apps/desktop-ui/lib/api/tasks.ts`, `apps/desktop-ui/lib/api/client.ts`, `apps/desktop-ui/app/page.tsx`.
  - **Acceptance Criteria**: UI shows pending/running/synced/failed transitions from metadata states.
  - **QA Scenarios**:
    - Happy: run task locally and verify UI progression + final summary; evidence `.sisyphus/evidence/task-13-ui-happy.png`.
    - Negative: sync failure state renders retry hint without exposing raw logs; evidence `.sisyphus/evidence/task-13-ui-failure.png`.

- [ ] 14. Align batch execution with local-run metadata model
  - **What to do**: adapt batch state machine to local-run events and metadata-only sync.
  - **Must NOT do**: no server-side batch code execution fallback in final mode.
  - **Recommended Agent Profile**: `deep`, skills `state-machines`, `backend`.
  - **Parallelization**: YES; Wave 3; Blocks 18; Blocked by 6/7.
  - **References**: `apps/api/src/routes/batches.ts`, `apps/api/src/services/batch.ts`, `apps/api/src/routes/tasks.ts`.
  - **Acceptance Criteria**: batch progress and completion remain accurate from metadata events.
  - **QA Scenarios**:
    - Happy: 3-task batch reports ordered metadata progress and completion; evidence `.sisyphus/evidence/task-14-batch-happy.json`.
    - Negative: one task error yields proper batch failure semantics per settings; evidence `.sisyphus/evidence/task-14-batch-failure.json`.

- [ ] 15. Cleanup/backfill legacy secret fields and execution logs
  - **What to do**: stop writing legacy fields; migration cleanup of existing secret/log columns per policy.
  - **Must NOT do**: do not delete collaborative history needed for product UX.
  - **Recommended Agent Profile**: `unspecified-high`, skills `data-migration`, `prisma`.
  - **Parallelization**: YES; Wave 3; Blocks 19; Blocked by 5/6.
  - **References**: `packages/db/prisma/schema.prisma`, `apps/api/src/services/github.ts`, `apps/api/src/routes/auth.ts`.
  - **Acceptance Criteria**: post-migration audit returns zero new secret field writes.
  - **QA Scenarios**:
    - Happy: migration runs and integrity checks pass; evidence `.sisyphus/evidence/task-15-migration-pass.txt`.
    - Negative: attempted legacy write path triggers test failure; evidence `.sisyphus/evidence/task-15-legacy-write-fail.txt`.

- [ ] 16. Add CI privacy and compatibility gates
  - **What to do**: CI jobs enforce privacy contract tests and existing collaboration regression suites.
  - **Must NOT do**: do not loosen failing privacy tests to pass pipeline.
  - **Recommended Agent Profile**: `quick`, skills `ci`, `testing`.
  - **Parallelization**: YES; Wave 3; Blocks 17; Blocked by 11.
  - **References**: `.github/workflows/deploy.yml`, `apps/api/src/__tests__/projects.test.ts`, `apps/api/src/__tests__/teams.test.ts`.
  - **Acceptance Criteria**: CI fails on forbidden-field acceptance; passes collaboration regressions.
  - **QA Scenarios**:
    - Happy: pipeline run passes with new gates enabled; evidence `.sisyphus/evidence/task-16-ci-pass.txt`.
    - Negative: seeded forbidden-field test causes expected CI failure; evidence `.sisyphus/evidence/task-16-ci-fail.txt`.

- [ ] 17. Create canary rollout + kill-switch playbook
  - **What to do**: rollout steps, cohorting, rollback triggers, incident response runbook.
  - **Must NOT do**: no irreversible cutover without documented rollback.
  - **Recommended Agent Profile**: `writing`, skills `ops`, `incident-response`.
  - **Parallelization**: YES; Wave 4; Blocks 19/F1-F4; Blocked by 1/16.
  - **References**: `.github/workflows/deploy.yml`, `apps/api/src/routes/settings.ts`, `README.md`.
  - **Acceptance Criteria**: runbook includes precise trigger thresholds and rollback commands.
  - **QA Scenarios**:
    - Happy: tabletop dry-run script follows playbook steps successfully; evidence `.sisyphus/evidence/task-17-tabletop.txt`.
    - Negative: simulated canary error threshold breach triggers rollback path; evidence `.sisyphus/evidence/task-17-rollback.txt`.

- [ ] 18. Validate end-to-end offline/reconnect reliability
  - **What to do**: automated E2E covering local execution during offline window and eventual metadata sync.
  - **Must NOT do**: no manual-only validation.
  - **Recommended Agent Profile**: `deep`, skills `e2e`, `resilience`.
  - **Parallelization**: YES; Wave 4; Blocks F3; Blocked by 8/9/11/13/14.
  - **References**: `apps/desktop-ui/lib/api/client.ts`, `apps/api/src/__tests__/health.test.ts`, `apps/desktop/src-tauri/src/main.rs`.
  - **Acceptance Criteria**: zero lost metadata events in offline/reconnect test matrix.
  - **QA Scenarios**:
    - Happy: 10-run offline/reconnect soak with no missing final events; evidence `.sisyphus/evidence/task-18-soak.txt`.
    - Negative: intentional API outage causes queued retries and eventual success without duplicates; evidence `.sisyphus/evidence/task-18-outage-recovery.txt`.

- [ ] 19. Remove deprecated server execution paths after canary success
  - **What to do**: delete/retire container execution codepaths and dead flags after canary gate.
  - **Must NOT do**: do not remove rollback path before canary sign-off.
  - **Recommended Agent Profile**: `unspecified-high`, skills `cleanup`, `safe-removal`.
  - **Parallelization**: YES; Wave 4; Blocks F1/F4; Blocked by 12/15/17.
  - **References**: `apps/api/src/services/container-manager.ts`, `apps/api/src/routes/opencode.ts`, `apps/api/src/services/opencode.ts`.
  - **Acceptance Criteria**: no active runtime references to removed server execution modules.
  - **QA Scenarios**:
    - Happy: grep/static analysis finds zero active imports from removed modules in active path; evidence `.sisyphus/evidence/task-19-no-imports.txt`.
    - Negative: attempt to enable removed mode fails fast with clear unsupported message; evidence `.sisyphus/evidence/task-19-mode-reject.txt`.

---

## Final Verification Wave (MANDATORY)

- [ ] F1. **Plan Compliance Audit** (`oracle`)
  - Verify all Must Have/Must NOT Have conditions with command evidence.
  - Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT`.

- [ ] F2. **Code Quality Review** (`unspecified-high`)
  - Run type/lint/test checks; scan for banned shortcuts (`as any`, raw secret logs).
  - Output: `Build/Lint/Test matrix + VERDICT`.

- [ ] F3. **Real QA Scenario Execution** (`unspecified-high` + Playwright where needed)
  - Execute all task QA scenarios and validate evidence files exist.
  - Output: `Scenarios [N/N] | Integration [PASS/FAIL] | VERDICT`.

- [ ] F4. **Scope Fidelity Check** (`deep`)
  - Compare actual changes vs this plan; flag scope creep and omissions.
  - Output: `Compliant [N/N] | Unaccounted changes [N] | VERDICT`.

---

## Commit Strategy

| After Task(s) | Message | Verification |
|---------------|---------|--------------|
| 1-5 | `refactor(privacy): establish trust boundary and secret policy` | privacy contract checks |
| 6-11 | `feat(execution): add signed metadata ingestion and local runner plumbing` | API tests + contract rejects |
| 12-16 | `refactor(runtime): switch to local execution metadata model` | integration + regression tests |
| 17-19 | `chore(migration): canary rollout and server execution retirement` | e2e reliability + rollout checks |

---

## Success Criteria

### Verification Commands
```bash
pnpm --filter @openlinear/api test
pnpm --filter @openlinear/api typecheck
pnpm --filter @openlinear/api build
```

### Final Checklist
- [ ] Cloud stores collaborative data only.
- [ ] Secrets/log traces remain local only.
- [ ] Metadata-only sync contract enforced by tests.
- [ ] Local execution is default and reliable under offline/reconnect.
- [ ] Legacy server/container execution path removed after canary sign-off.
