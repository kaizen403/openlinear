# W16a — environment setup recipes: setup before the agent starts

Date: 2026-10-27. Status: **implemented and locally validated; not committed,
not deployed.** No real agent run or paid inference; the run engine is
exercised with the in-memory control plane and fake runtime, the setup port
with a recording executor and with real steps under the enforced macOS
Seatbelt sandbox in a real `git worktree`.

## 1. Problem

A run starts in a fresh worktree with no dependencies, and inside its sandbox
the agent has no network, so it cannot `pnpm install`. Verification already
installs in its pristine checkout; the agent's worktree had nothing.

## 2. What was built

### 2.1 Settings (execution-core `setup.ts`, `verification.ts`; API `execution-verification.ts`)

- `setup`: an ordered list of ≤ 10 steps in **the check format, parsed by the
  check parser** (`run` or `command`, `cwd` inside the worktree, timeout
  1 s–1 h, default 10 min, network `none` unless the step declares
  `"registries"` or `{ allow, registries }`, `required` by default). Errors use
  `setup[i]…` paths; `at most 10 setup steps are allowed`.
- Stored **inside** the verification settings:
  `executionSettings.verification.setup`. `GET/PUT
  /api/projects/:id/verification-settings` carry it (same owner/admin rule,
  same 400 `VALIDATION_ERROR` with `details.errors`, audited with
  `setupSteps`/`setupHash`). The view adds `setupHash`. A PUT body without a
  `setup` key keeps the stored steps (older editors); `setup: []` clears.
- Setup is independent of the verification policy (runs with `off` too).

### 2.2 Sealing

`verificationSnapshotFor` already seals the parsed verification settings into
`attempt.snapshot.verification`; with `setup` in that object the steps are
sealed with no change to the snapshot builder, api-client or
`snapshotFromTask` (the sidecar journals `snapshot.verificationSettings` at
acceptance). `resolveSetupPlan(raw)` re-validates **only** the `setup` key: a
problem elsewhere is verification's concern; an unreadable `setup` fails the
run (never "no setup").

### 2.3 Execution (sidecar `run/service.ts` `runSetup`, `run/setup/index.ts`)

In `prepare`, after the workspace is acquired and verification sealed,
**before the runtime is started, the attempt claimed or any prompt**:

1. `execute` is answered (`state: preparing`) instead of holding the request
   through a long install.
2. Each step runs in order through `createLocalSetup` → the W11a
   `createSandboxedCheckExecutor`: the worktree (realpath) is the only
   writable project dir, its `.git` metadata unreadable/protected, a private
   HOME/TMP root `<sandbox>/setup/<runId>` shared by the run's steps and
   removed afterwards, the repos root denied, egress only via the per-step
   proxy allowlist, ≤ 1 MiB log artifact at
   `<app data>/artifacts/setup/<runId>/NN-<id>.log`, redacted 4 KiB tail.
3. Journal: a relayed `progress` event per phase with `payload.setupRecord`
   (`start`: step spec; `end`: a `VerificationCheckResult` — exit code,
   duration, log sha/bytes/tail — plus sandbox info), validated by
   `setupStepRecordSchema`. Only the scalar fields (`setupPhase`,
   `setupStep`, `setupStatus`, `exitCode`, `durationMs`, `logSha256`, …) leave
   the device; logs carry `Setup step "install" passed (exit 0 · 41.2 s)` and
   the tail on failure.
4. A required step that fails/times out/cannot run: `failed`, reason `setup
   failed`, outcome `Setup failed: install exited 1. Worktree kept on <branch>
   at <path>`. Never claimed, so the attempt is released and the task row is
   untouched (like other preparation failures), but the worktree is **kept**
   (unlike them). An optional failure is logged and the run continues.
5. Cancel/fence during a step aborts it (executor signal) and the run ends
   `cancelled`/`abandoned` as before.

**Crash / "don't re-run finished steps".** Recovery policy is unchanged: a run
that crashed in `preparing` is failed (`the sidecar restarted before the agent
started`) and nothing is re-run. Steps are idempotent per worktree: a step
whose `end` record passed — identified by command + cwd + network
(`setupStepHash`), not name/timeout — in this run or any run in its follow-up
chain in the same worktree is skipped (`reusedFrom` recorded). So a follow-up
on a run that crashed mid-setup runs only the remaining steps, and a normal
follow-up does not reinstall (a changed command runs). A `start` without an
`end` (died mid-step) is re-run.

### 2.4 Desktop

Project settings → Verification: a "Setup before the agent starts" block
reusing the check rows (`Setup step N name/command`, timeout, required, needs
package registries), counter `n/10`, local checks, server `setup[i]` errors in
the existing alert. `SETUP_FAILED` added to `lib/api/errors.ts`.

## 3. Tests

- execution-core `setup.test.ts` (7): parsing, round-trip, errors/limit,
  sealed plan, step identity, outcome text.
- API `execution-setup.test.ts` (4, real Postgres): defaults, store/audit,
  validation shape + 403s, keep/clear, sealing across later edits.
- sidecar `setup.service.test.ts` (10): order before runtime/claim/prompt,
  journal + relay, required failure/timeout (no session, worktree kept),
  optional failure continues, none configured, unreadable steps → 422,
  cancel mid-step, crash → recovery re-runs nothing → follow-up resumes,
  crash mid-step re-runs it, follow-up skips done / runs changed.
- sidecar `setup/setup.test.ts` (3): port wiring, missing worktree, real
  Seatbelt run (writes in worktree; beside it, `.git` and network refused).
- desktop `verification-settings-setup.test.mjs` (6).

## 4. Limitations / follow-ups

- Setup steps cannot read git metadata (the executor only trusts the
  worktree); `git`-based steps fail.
- `describe()` has no structured setup view yet (logs/progress only).
- The executor's env/log text still says `OPENLINEAR_VERIFY=1` /
  "verification cancelled" for setup steps.
- `schema.prisma`'s `executionSettings` comment does not mention `setup`.
- `run/index.ts` does not pass `setup:`; the service defaults to the local
  sandboxed port.

## 5. Security review fixes (2026-10-27)

- **IP addresses in a step's network allow list.** These are refused, and the egress proxy refuses loopback, link-local and metadata targets. Details: trust.md, "Security review fixes".
- **Setup output published as the agent's work.** The run now fingerprints the worktree's committable changes (git status plus a content hash per path) before the first step that runs and after the last one. If setup changed, added or deleted a non-ignored file, the run fails before the agent starts. It lists the files and suggests `.gitignore` or a frozen install. A follow-up's earlier agent work is part of the baseline, and fully reused setups skip the check.
- **Sandbox errors when steps exist.** Before accepting the run, the port checks that a step could run (a verified sandbox, or a grant covering the worktree). Without one, execute answers 503 `SANDBOX_UNAVAILABLE`, with the desktop's sandbox and trust-grant guidance, instead of a generic failure.
- **Not changed (low):**
  - Installs under the private setup HOME (Go/Cargo caches, `pip --user`, Poetry/Pipenv virtualenvs outside the project) don't reach the agent; use in-project locations (`POETRY_VIRTUALENVS_IN_PROJECT=1`, `PIPENV_VENV_IN_PROJECT=1`, `.venv`).
  - A setup step's process group is not journaled, so a sidecar crash mid-step can leave it running until it exits on its own.
- **Tests:**
  - `setup.service.test.ts` +2: changes left behind; 503 without a sandbox.
  - `setup/setup.test.ts` +1: fingerprint on a real repository, with ignored files excluded and a second change to a dirty file noticed.
