# W11a — "done means verified": sealed checks, pristine sandboxed verification, evidence bound to the commit

Date: 2026-10-26. Engineer id: `verify` (sidecar half by a worktree agent;
retention, API, UI, wiring and every test finished in the coordinator
workspace). Status: **implemented and locally validated; not committed, not
deployed.** No real agent run or paid inference was used; the run engine is
exercised with the in-memory control plane and fake runtime, the checks with
real git and real processes.

## 1. Problem

Before W11a a run went `running → finishing` and published whatever the agent
committed. "Done" meant "a PR exists", not "the work passes the project's
checks". The review panel's Verification check was always "not reported", so
every publish needed a manual override. Separately, the boot-time worktree GC
deleted every worktree older than 24 h without looking at the journal, so a
next-day follow-up failed with `FOLLOW_UP_UNSUPPORTED`.

## 2. Design

### 2.1 Sealed manifest (execution-core `verification.ts`, sidecar `run/verification/manifest.ts`)

Resolved **before the prompt** and journaled with the run
(`run_attempts.verification_json`). Precedence (first source with checks
wins):

1. project settings (`linear_projects.executionSettings.verification`),
   sealed into the attempt snapshot at start;
2. `.openlinear/checks.json` read from the run's **base commit** object
   (`git ls-tree` / `cat-file`), never the working tree;
3. opt-in auto-detection from the base commit's `package.json` (`typecheck`,
   `test`; an install step with registry egress and `--ignore-scripts`).

The **policy comes only from the project** (`require-pass` | `warn` default |
`off`); a `policy` key in the repository file is ignored with a warning. An
invalid repository file makes verification unevaluable (`error`), never
"no checks". Check bounds: ≤ 20 checks, argv ≤ 64, timeout 1 s–1 h (default
10 min), cwd inside the checkout, network `none` unless a check declares an
egress allowlist or `registries`.

`.openlinear/checks.json`:

```json
{
  "checks": [
    { "name": "Typecheck", "run": "pnpm typecheck" },
    { "id": "unit", "name": "Unit tests", "command": ["pnpm", "test"], "timeoutSeconds": 900 },
    { "name": "Lint", "run": "pnpm lint", "required": false },
    { "name": "Install", "command": ["pnpm", "install", "--frozen-lockfile"], "network": "registries" }
  ]
}
```

### 2.2 `verifying` state (sidecar `run/service.ts`, execution-core `run-contract.ts`)

`running → verifying → finishing` when the manifest asks for it (checks, a
problem, or `require-pass`); otherwise unchanged. In `verifying`:

1. the candidate commit is made (or reconciled from its trailer);
2. effect `verify.run` (keyed by the commit) runs the sealed checks against
   that exact commit in a **pristine clone** (`git clone --shared
   --no-checkout` + detached checkout; no untracked files, index, hooks or
   agent config; the source repository is not mutated);
3. each check runs in the **verified sandbox** (W09a provider, checkout the
   only writable project dir with `.git` read-only, private HOME/TMP, sidecar
   state and credential stores denied, exact env, network none or the
   per-check egress proxy). A trusted-host grant must cover the checkout and
   is recorded in the evidence. No sandbox and no grant → the check is not
   run (`error`). Wall-clock timeout kills the process group; ≤ 1 MiB log
   artifact (hashed) locally, a redacted ≤ 4 KiB tail in the evidence;
4. evidence is journaled (`verify.run` receipt), then projected to the
   control plane (`verification.record`, first in the control-effect order,
   re-driven with the terminal projection if the API was unreachable);
5. publication policy: `require-pass` publishes only on `passed`
   (otherwise the run fails, work retained, nothing pushed); `warn`
   publishes and says how verification went in the outcome.

Recovery: `verifying` resumes like `finishing`. A confirmed `verify.run` is
reused; a pending one (sidecar died mid-checks) re-runs from scratch in a
fresh checkout. Cancel aborts the checks, keeps the partial evidence
(`error`, remaining checks `skipped`) and publishes nothing.

Journal schema 2: `verifying`, the two effect kinds, `verification_json`,
retention tables. A version-1 file is upgraded in place on open (stale
tables rebuilt in one transaction, rows copied, indexes/trigger recreated).

### 2.3 Control plane (API)

| Piece | Behaviour |
|---|---|
| `GET/PUT /api/projects/:id/verification-settings` | View: project view access. Edit: full access **and** workspace owner/admin (the checks are commands every member's sidecar runs). Strict validation via the shared execution-core parser; audited (`project.verification_settings_updated`). |
| Attempt snapshot `verification` | The settings at start. Later edits never change a running attempt. |
| `POST /api/executions/attempts/:id/verification` | Capability scope `execution:verification`; attempt running/finishing. Idempotent per (attempt, commit, checks hash) by body hash; a different body → 409 `VERIFICATION_CONFLICT`. Refuses evidence whose policy differs from the sealed one (409 `VERIFICATION_POLICY_MISMATCH`), evidence for other checks when the project defines them (409 `VERIFICATION_CHECKS_MISMATCH`), and a `publication` that is not what the policy decides for the status (400; also a DB CHECK). No local paths accepted. |
| `done` gate | Under a sealed `require-pass` policy, `POST …/terminal {status: done}` needs a `passed`/`allowed` record for the attempt: 422 `VERIFICATION_REQUIRED`. An old or misbehaving sidecar cannot mark the task done unverified. |
| `GET /api/executions/tasks/:taskId/verifications` | Durable evidence, newest first (task view access). |
| Migration `20261026160000_w11a_verification_evidence` | Nullable `executionSettings` column (catalog-only) + `execution_verifications` with format/enum/publication-policy CHECKs. |

### 2.4 Worktree retention (sidecar `workspace/retention.ts`)

Replaces the 24 h boot GC when the v2 engine is active. Runs after recovery
and every 6 h. Groups runs by worktree (follow-ups share one). Never touches
in-flight runs or the user's own repository. Removes for `task_closed`
(control plane reported archived/deleted), `superseded` (a newer run of the
task has its own surviving worktree), `retention_expired` (default 7 days,
`OPENLINEAR_WORKTREE_RETENTION_DAYS` 1–13, below the journal's 14-day record
retention) and `disk_budget` (20 GiB, least recently used first). Unjournaled
directories keep the 24 h rule (`legacy_age`); leftover verification
checkouts are removed (`orphan_checkout`). A receipt is journaled before
deletion and settled after; failures are retried next sweep. A follow-up on a
removed workspace answers 409 `FOLLOW_UP_UNSUPPORTED` with
`reason: workspace_expired`; the run view carries `workspaceExpired`.

### 2.5 Desktop UI

The review checks panel already consumed `runState.verification`; it now
reads the full view: the commit the checks ran on, informational checks
shown as warnings (not blockers), the sidecar's reason for `error`/`skipped`,
and integrity notes (checks ran without OS isolation under a trusted-host
grant, publication blocked by `require-pass`, the agent edited the check
file). The gate opens on a pass for the commit on screen; otherwise the
explicit per-revision override still applies.

## 3. Evidence

| Gate | Result |
|---|---|
| execution-core `verification.test.ts` | 16 (part of 68) — parsing, precedence, auto-detect, summary, publication decision |
| sidecar `run/verification.service.test.ts` (new) | 9/9 — sealed before prompt; `verify.run` + `verification.record` before `git.push`; require-pass failure blocks push/PR and records `blocked`; warn publishes with the failure in the outcome; no checks → no `verifying`, view `skipped`; require-pass with no checks blocks; crash before the result journaled re-runs checks (2 runs, 1 commit, 1 record); crash after reuses (1 run); cancel while verifying keeps `error` evidence, nothing pushed; follow-up on an expired workspace → `workspace_expired` |
| sidecar `run/verification/verification.realgit.test.ts` (new) | 7/7 — base-commit check file graded although the agent rewrote it (warning); untracked file absent from the pristine clone; source repo untouched; artifacts kept, checkout removed; invalid file → `error`; project > repository; auto-detect only when enabled; exit codes, 1 s timeout kills `sleep 20`, 2 MB output truncated with a ≤ 4 KiB tail, token redacted; informational failure doesn't fail; fail-closed for no sandbox / uncovering grant / invalid mode / missing cwd; cancel → passed/error/skipped |
| sidecar `workspace/retention.test.ts` (new) | 8/8 |
| sidecar `journal/durable.upgrade.test.ts` (new) | 2/2 — v1 file upgraded in place, rows/events/effects preserved, trigger recreated, no leftovers; current file untouched |
| API `execution-verification.test.ts` (new) | 6/6 — settings authz (member/read-PAT 403, stranger denied), strict errors, sealing vs later edits, idempotency/conflict, policy/checks/publication contradictions, no local paths, require-pass gate (blocked record not enough), warn needs nothing |
| desktop-ui review model | 4 new cases (69 in components/review) |
| Full suites | API 70 files, 767 + 3 skipped · sidecar 1083 + 3 skipped · sidecar integration 26 · execution-core 68 · desktop-ui 1022 + 9 skipped · mcp 102 · evals 83 |
| Typecheck 11/11, `pnpm lint` 330 files, fresh-DB migrate + drift `No difference detected`, migration-safety (allow, reasoned) | clean |

## 4. Not done / owed

- ~~Settings UI~~ — done (follow-up the same day): Project settings →
  Verification edits policy, checks (command line, timeout, required,
  registries), the repository-file and auto-detect switches, shows server
  validation errors, turns read-only for non-admins, and shows the GitHub
  App install state with an Install/Manage link
  (`components/projects/verification-settings-*`, 6 tests).
- **The enforced sandbox path for checks is exercised only through its
  failure modes here**; a real Seatbelt/bwrap run of a check (e.g. `pnpm
  test` with registry egress) should be done by hand on macOS and Linux.
- Checks are assumed effect-free (network off by default); a check that
  declares egress and has external side effects can repeat after a crash.
- Evidence shows the log tail only; the full log artifact stays on the
  device (`<app data>/artifacts/verification/<run>/<sha>/`), not uploaded.
- The run drawer could show live per-check progress (the progress events
  carry it; the drawer shows them as log lines today).
- W19 (independent reviewer, provenance) builds on this evidence.

## Addendum (2026-10-27): enforced-sandbox check run, automated

The manual check above is now a test,
`apps/sidecar/src/run/verification/verification.realsandbox.test.ts`: real
verification checks run in **enforce** mode under the live-verified provider
against a pristine clone. A check reads the checkout and writes inside it;
a write beside the checkout is refused (the file never appears); `curl` to
the internet fails with network `none`; only optional checks fail, so
verification passes; the evidence says `sandboxMode: enforce`, names the
provider and lists the sealed policy hashes; the candidate source is
untouched. **Run on this Mac under Seatbelt: passes (twice).** Skipped where
no provider is usable; required on Linux CI — added to
`.github/workflows/sandbox.yml` (bubblewrap, `OPENLINEAR_SANDBOX_CORPUS_REQUIRED=1`).
Declared egress is covered too (opt-in, it reaches the public registry:
`OPENLINEAR_SANDBOX_NETWORK_TESTS=1`): a check with `network: "registries"`
reaches `registry.npmjs.org` through the per-check egress proxy while
another host is refused, in enforce mode. **Run on this Mac: passes.**

