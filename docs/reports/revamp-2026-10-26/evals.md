# W21: evaluation harness, offline today and ready for funded runs (`evals` ledger)

- **Date:** 2026-10-26.
- **Engineer:** `evals` (round 4).
- **Base tree:** `round4b-base.patch` on `922dbd7` (`0c6daaf9…`).
- **Status:** done for the offline harness, the public-suite adapters (dry run and ingest) and the docs. No paid inference was run. Real CLIs were run only with `--version` and `--help`.
- **Owner constraints honoured:**
  - local work only;
  - no cloud services;
  - no multi-GB images. Only small public metadata files (≤ 151 KB) were fetched, and their checksums were verified.

## 1. Outcome

New package `packages/evals` (`@openlinear/evals`). Its only dependencies are `zod` and `@openlinear/execution-core`. It provides:

- **Manifest** (Zod): every field PRD §10 requires, explicit alias resolution, freeze checks and a drift report.
- **Runners** behind one interface (`HarnessRunner`):
  - **OpenLinear in the loop, adapter transport.** It drives any execution-core `AgentRunner`: a real sidecar adapter loaded at run time, or `ReplayAgentRunner`.
  - **OpenLinear in the loop, API transport.** It runs the real control-plane + sidecar headless path and harvests the published branch from a loopback origin.
  - **Native baselines.** Claude Code, Codex and OpenCode CLIs, invoked with documented headless flags.
  - **FAKE mode for every runner.** Recorded trajectories are replayed; native replays go through a real child process (`replay-cli.mjs`).
- **Grading.**
  - Pristine-checkout verifier with grader assets kept outside the agent worktree.
  - Reference and empty-patch gates.
  - Safety and contamination scan: protected paths, grader canaries.
  - Outcome classes `pass`/`fail`/`timeout`/`infra`/`refusal`/`safety`.
  - Usage with cost basis `provider-reported`/`runner-reported`/`estimated`/`invoiced`/`unknown`. Unknown is `null`, never 0.
  - Sealed-holdout flag that blocks memory promotion.
- **Statistics.**
  - Two-stage task-cluster bootstrap 95% CI.
  - Paired differences with a preregistered threshold and non-inferiority margin.
  - Cost per resolved task, shown as a lower bound when any cost is unknown.
  - p50/p95 latency for task→artifact, agent time and first action, with censored trials included.
  - Intent-to-run and adjudicated views.
  - Markdown + JSON report.
- **Private holdout format** plus 5 synthetic sample tasks, generated in temp dirs at run time.
- **`pnpm eval:smoke`:** 102 trials end to end in about 8 s, with built-in self-checks.
- **Replay.** Any finished run (smoke or funded) can be replayed offline from its recordings. It reproduced 102/102 outcomes.
- **ATIF v1.7 export** for every trial (`trajectory.atif.json`), validated structurally.
- **Public-suite adapters.**
  - Terminal-Bench 4.0 (Harbor) and SWE-bench Pro V2.
  - Pinned to full SHAs and checksums.
  - Task-manifest parsing, `harbor run` command construction, dry runs, and Harbor job-result ingestion into the common report.
- **Funded-run wiring.** `eval:cli run` refuses unless `--confirm-spend` is passed and the manifest is frozen.
- **Docs:** `docs/eval/README.md` and `docs/eval/pilot-manifest.example.json`.
- **CI:** `.github/workflows/eval-smoke.yml`.

## 2. Design

```
manifest (frozen, digest) ─┬─ tasks (holdout loader; checksums must match the manifest)
                           ├─ gates: reference passes / empty patch fails (per task, zero inference)
                           └─ schedule: repeats × tasks × configurations, seeded shuffle (randomized, interleaved)
trial: fresh full clone of the base commit → HarnessRunner.run → identical patch capture (git add -A; diff --cached --binary base)
       → safety scan (patch + trajectory) → pristine-checkout grading (grader assets copied in) → classification
       → usage finalised with basis + manifest price → artifacts (trajectory, ATIF, patch, logs, grade, record)
infra outcome → predeclared rerun (fresh env), original kept (supersededBy) → views: intent-to-run / adjudicated
→ drift (host, runner-reported model/version, task checksums, price age) → statistics → report.md / report.json
```

Choices:

- **No compile-time dependency on `apps/**`.**
  - Real sidecar adapters are loaded at run time with `loadRunnerAdapter(modulePath, runnerId)`. The module must export `pickRunner` (as `apps/sidecar/src/runners/index.ts` does) or `createEvalRunner`. The returned object is shape-checked against `AgentRunner`.
  - The API transport talks HTTP to the documented routes.
  - Reason: other engineers are changing the run engine and API now.
- **One task format for the harness, Harbor for public suites.**
  - Private tasks use the holdout format, graded by our pristine-checkout verifier.
  - TB 4.0 and SWE-bench Pro V2 are already Harbor tasks with separate verifiers, so they run under Harbor. Results are ingested from Harbor's `result.json` (its `TrialResult` model) into the same trial records and report.
  - This keeps official-protocol fidelity (Harbor's network/resource enforcement and patch replay) instead of re-implementing it.
- **Shared trajectory vocabulary.** Native stdout protocols are parsed into execution-core `AgentEvent`s. OpenLinear and native trajectories therefore share one format, and the raw native lines are kept as well.
- **Fresh clone, not `git worktree`, per trial.** It gives full independence (no shared object store or refs) and identical preparation for every configuration. OpenLinear's own lease and worktree mechanics are part of the API transport, not the adapter transport.
- **An unconfirmed stop is `infra`.** If the runtime cannot be confirmed stopped, it may still be editing the worktree, so its artifacts are untrustworthy. This follows the PRD's "first stop the entire process tree".
- **Package and directory named `evals`, not `eval`.** The agent tooling's worktree guard misreads `…/eval` in a command line as the shell builtin. The root scripts are still `eval:*`.

## 3. Manifest schema (`packages/evals/src/manifest/schema.ts`)

| Block | Fields (PRD §10 requirement) |
|---|---|
| top | `schemaVersion`, `id`, `title`, `createdAt`, `purpose` (smoke/development/validation/release), `track` (deterministic-smoke/harness-parity/named-stack/product-budget/official-fidelity/observational), `repeats` |
| `suites[]` | `kind`, `name`, `version`, `source {repository, revision (full SHA when frozen), datasetChecksum, config, split}`, `official`, `tasks[] {id, checksum, category, cluster, sealed, images[] {role environment/verifier/sidecar, service, ref, digest sha256:…, platform}}` |
| `hardware` | provider, os, arch, cpus, memoryMb, diskMb, `resourcePolicy` (guarantee/limit/request/auto/none), headroom |
| `concurrency` | maxConcurrentTrials, order (randomized-interleaved/sequential), seed |
| `toolchain` | node, git, packageManager, python, docker, `harbor {version, revision}`, extra |
| `configurations[]` | `harness` (openlinear/native) × `transport` (adapter/api/cli); `runner {id, binaryVersion, binarySha256, sdkVersion, mode real/fake}`; `model {requested, snapshot, provider, endpoint, region, effort, sampling {temperature, topP, seed}, maxOutputTokens, contextPolicy, routing fixed/adaptive-disclosed}`; `assets {systemContract, promptTemplate, tools, skills, mcpConfig}` sha256; `enhancements` flags |
| `sandbox` | provider, agentNetwork, allowedHosts, verifierNetwork, envPolicy, privateHome |
| `budgets` | agentTimeoutMs, verifierTimeoutMs, maxUsdPerTask, maxTokensPerTask, maxTurns, stopRule first-cap, headroomPct, gradeOnTimeout |
| `retries` | infraRetries (≤ 3), retryOutcomes [infra], keepOriginal true |
| `prices[]` | provider, model, USD per MTok (input, output, cacheRead, cacheWrite), `asOf`, `source` |
| `verifier` | revision, graderAssets sha256, method (pristine-checkout/harbor-separate-verifier/patch-replay) |
| `contamination` | sealedHoldoutPresent, crossTaskMemoryReset, solutionLookup, historySanitized, canaries |
| `analysis` | primaryMetric, bootstrapResamples, confidence, clusterBy, practicalThresholdPts, nonInferiorityMarginPts, comparisons[], categories[] |
| `aliases[]` / `drift[]` | resolution records `{field, requested, resolved, source, resolvedAt}`; retained notices `{field, expected, observed, severity, detectedAt, note}` (excluded from `manifestDigest`) |

Enforced rules:

- `release` needs at least 5 repeats.
- Fake runners are allowed only in `smoke` manifests.
- Sealed tasks may not run in `development` or `validation` manifests.
- `official-fidelity` requires `suite.official`.
- Configuration ids are unique, and comparisons must name existing, distinct configurations.
- A native harness must use the `cli` transport.

`findFloatingRefs` flags:

- non-SHA revisions;
- unresolved or alias models (`sonnet`, `*-latest`, empty);
- floating versions (`latest`, `^`, `~`, `x`);
- a missing artifact checksum for real release runners;
- non-SHA Harbor revisions.

`assertRunnable` refuses non-smoke runs with any of these.

`detectDrift` reports:

- **blocking:** task checksum, runner-reported model, runner version;
- **warning:** node/git/arch/cpus/memory;
- **info:** unverifiable model (runner reports none), prices older than 30 days.

## 4. How the fakes work

- **Adapter path (`ReplayAgentRunner`).**
  - Implements execution-core `AgentRunner`.
  - Replays `{atMs, event}` streams (time-scaled) and applies recorded file effects to the real worktree at the recorded event index.
  - interrupt, abort and signal yield `cancel.receipt{runner-ack}` followed by `turn.finished{interrupted}`.
  - Can simulate start errors (`SANDBOX_UNAVAILABLE`, …) and hangs.
- **Native path (`NativeCliRunner` FAKE + `replay-cli.mjs`).**
  - The harness builds the real argv (recorded in the trial), then spawns the static `replay-cli.mjs` in the worktree.
  - The script prints the CLI's real headless protocol: Claude stream-json, Codex `exec --json` JSONL, or OpenCode `run --format json` objects (confirmed against the bundled `run` command of the installed opencode 1.18.32).
  - It applies the recorded edits, can hang (to exercise the watchdog and group kill) and exits with the recorded code.
  - The same parsers as real mode turn the output into events, termination and usage.
- **Synthetic recordings (`fakes/recordings.ts`).**
  - Kinds: fix, wrong-fix, noop, timeout, refusal, infra (529/503), safety (writes a grader canary), agent-error. Each is generated per runner protocol, with plausible usage and cost receipts. Codex reports no cost, so its cost is `estimated` from the manifest price.
  - A trial's behaviour comes from a stable hash of (configuration, task, repeat, attempt) against a per-configuration propensity. Seven forced slots guarantee that every class and the infra rerun occur.
- **Recorded trajectories are replay-faithful.**
  - `trajectoryFromResult` keeps timeouts as a hang at the stop point.
  - It keeps start errors and native exit codes.
  - It places edits before the terminal event.
  - `pnpm eval:cli replay` re-runs any run directory offline. For the smoke, 102/102 outcomes match. For a funded run this becomes a free regression check of the harness and grader.

## 5. Statistics method (`packages/evals/src/stats/`)

- **Estimand.** Single-attempt success is the mean over tasks of the per-task success rate. With equal repeats this equals the trial mean. Every scheduled first attempt counts, and timeout/infra/refusal/safety are failures.
- **CI.** A two-stage task-cluster bootstrap, seeded with mulberry32, 2 000 resamples by default, percentile interval with type-7 quantiles:
  1. clusters (task, or a repository via `clusterBy: cluster`) drawn with replacement;
  2. each task's repeats redrawn with replacement.

  A test checks that 10 always/never-solved tasks × 5 repeats give an interval wider than 45 points, where a naive per-trial bootstrap gives about 28.
- **Paired.** Treatment − baseline per shared task. The same cluster draw is used for both arms; repeats are drawn per arm. The report also counts better, worse and tied tasks.
- **Verdicts.**
  - `improvement` needs the lower bound > 0 *and* the preregistered threshold.
  - `regression` needs the upper bound < 0.
  - `non-inferior` needs the lower bound > −margin.
  - Otherwise `inconclusive`.
- **Cost.**
  - Cost per resolved task is known spend ÷ successes, marked `≥` when any trial's cost is unknown.
  - All-task spend is reported, and mean cost per trial is reported only when complete.
  - Token totals stay provider-raw per configuration.
- **Latency.** p50/p95 task→artifact (trial start → patch captured), agent time and time to first action. Censored trials are included at their stop time and counted.

## 6. Smoke results (`pnpm eval:smoke`, this machine, 2026-10-26)

FAKE runners: this is a pipeline check, not a benchmark. Outcomes are deterministic for a seed; latencies vary.

| Configuration | Mode | Trials | Tasks | Success (95% CI, task-cluster bootstrap) | Fail | Timeout | Infra | Refusal | Safety | Cost / resolved | All-task spend | p50 / p95 task→artifact |
|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|
| ol-opencode | fake | 25 | 5 | 64.0% [44.0%, 84.0%] | 7 | 1 | 1 | 0 | 0 | ≥ $0.2047 | ≥ $3.27 (3 unknown) | 280 ms / 338 ms (2 censored) |
| native-opencode | fake | 25 | 5 | 48.0% [24.0%, 72.0%] | 12 | 1 | 0 | 0 | 0 | ≥ $0.2524 | ≥ $3.03 (4 unknown) | 180 ms / 254 ms (1 censored) |
| native-claude-code | fake | 25 | 5 | 64.0% [36.0%, 88.0%] | 7 | 0 | 0 | 1 | 1 | $0.1984 | $3.17 | 197 ms / 276 ms (0 censored) |
| native-codex | fake | 25 | 5 | 64.0% [40.0%, 88.0%] | 7 | 0 | 1 | 1 | 0 | ≥ $0.1503 | ≥ $2.40 (2 unknown) | 204 ms / 249 ms (1 censored) |

| Treatment | Baseline | Tasks | Δ success | 95% CI | T better / B better / tie | Verdict |
|---|---|---:|---:|---|---|---|
| ol-opencode | native-opencode | 5 | +16.0 | [-12.0, +44.0] | 3 / 0 / 2 | inconclusive (interval includes zero) |
| native-claude-code | native-codex | 5 | +0.0 | [-40.0, +36.0] | 2 / 1 / 2 | inconclusive (interval includes zero) |

- **Run:** 102 trials (100 first attempts + 2 infra reruns). Gates 5/5. Wall clock 8.1 s.
- **Self-checks:** OK.
- **Replay:** 102/102 outcomes match.
- **Drift notices:** 2 info notices (native OpenCode and Codex do not report the model id).

## 7. Validation

| Check | Result |
|---|---|
| `pnpm --filter @openlinear/evals test` | 10 files, **83 passed**. Stable over 3 repeated runs. The smoke + replay test takes about 18 s. |
| `pnpm eval:smoke` | OK, 102 trials, about 8 s (table above) |
| `pnpm eval:cli replay` (smoke run dir) | 102/102 outcomes reproduced |
| `pnpm typecheck --force` (root, turbo) | 11/11 successful, 0 cached (`@openlinear/evals` is the new 11th task) |
| `pnpm lint` (root biome list + `packages/evals/src`) | clean, 242 files |
| `pnpm eval:dry-run:tb4 --images <downloaded prebuilt-images.json> --official` | sha256 matches the v4.0.0 asset. 66 tasks, 157 images (11 multi-container tasks), 1 320 trials for 4 configurations, budget printed. |
| `pnpm eval:dry-run:swe-pro` | HARD-51: 51 `-i` filters, gates, locked agents + patch-replay re-grade, 765 trials, budget printed |
| `pnpm eval:cli validate-manifest docs/eval/pilot-manifest.example.json` | Exit 2 with 5 floating references listed (intended: the template must be resolved before a run) |

Test coverage:

| Area | What is tested |
|---|---|
| TOML reader | Real TB4 and SWE-Pro `task.toml` files |
| Manifest | Rules, digest, alias resolution, drift severities |
| Holdout | Deterministic base SHA; tamper detection; git-source sanitization (a future commit and tag are pruned) |
| Gates | All 5 tasks; wrong fixes fail via hidden tests; edited tests are overwritten; a patch that does not apply fails; verifier timeout is `infra` |
| Outcome table | 12 cases |
| Safety scan | Protected paths and canaries |
| Cost semantics | Unknown is never 0 |
| Bootstrap and paired statistics | Determinism, cluster resampling, censored trials kept |
| Native argv | Exact flags |
| Native parsers | All three protocols |
| Native FAKE end to end | All 3 CLIs; hang killed at the budget; real mode refuses |
| Adapter path | StartInput contents; start failure → infra; watchdog → `cancel.receipt`; permission deny; unconfirmed stop → infra |
| Adapter loader | Shape checks |
| API transport | Against a loopback HTTP stand-in plus a bare origin; execute refusal → infra |
| Harbor suites | Argv, official-fidelity checks, ingestion of synthetic `result.json` with error-policy mapping |
| SWE-Pro fixtures | Hashes equal the published SHA256SUMS lines |
| Budget | Formula |
| ATIF | Export and validation |
| Smoke | End to end + replay |
| Funded run | Plan and refusal |

## 8. Public-suite adapter status and citations

| Suite | Implemented | Not implemented (needs funding or other owners) |
|---|---|---|
| Terminal-Bench 4.0 (`suites/terminal-bench.ts`) | Pins: dataset, full commit `452bf305…`, `prebuilt-images.json` sha256, Harbor 0.25.0 `fdba28fc…`. Image-manifest parser (environment/verifier/sidecar digests, completeness and pin checks). Task-dir hashing from a checkout. `harbor run` argv. Official-fidelity checks. Dry run. Job ingestion (`result.json` → trial records, Harbor `error_policy` → outcome classes, `agent_result` → usage `runner-reported`). | Pulling images; running Harbor; the OpenLinear Harbor agent (`BaseInstalledAgent`, emitting ATIF); leaderboard submission (ATIF + agent-judge review, required trial count unconfirmed) |
| SWE-bench Pro V2 (`suites/swe-bench-pro.ts`) | Pins: tag v2.0.0 `66f92766…`, introducing commit `31a20c75…`, SHA256SUMS and HARD-51 sha256s. SHA256SUMS parser and verifier. `tests/config.json` test lists in JSON, JSON-string and Python-literal forms. Per-task locked-protocol check (no-network agent, 3 000 s, image name, verifier config). HARD-51/full dry run with oracle/nop gates, locked agents and `patch_replay` re-grade. Ingestion through the Harbor ingester. | Pulling 642 images (`linux/amd64`; emulated on Apple Silicon, so use amd64 hosts); Modal (cloud) per the README; the OpenLinear agent for a self-run, which must emit `model.patch` for patch replay |

Sources (all read 2026-10-26; in-code comments repeat them):

- [TB 4.0 announcement](https://www.tbench.ai/news/terminal-bench-4-0).
- GitHub API for `harbor-framework/terminal-bench` release v4.0.0: target commit, asset digests, task list in the release notes.
- `prebuilt-images.json` (downloaded, 151 KB, sha256 verified).
- `tasks/interleaved-vigenere/task.toml` @ `452bf305`.
- Harbor docs: [task configuration](https://docs.harborframework.com/tasks/configuration.md), [verifier](https://docs.harborframework.com/tasks/verifier.md), [network policies](https://docs.harborframework.com/tasks/network-policies.md), [resources](https://docs.harborframework.com/tasks/resources.md), [run a job](https://docs.harborframework.com/jobs/run-a-job.md), [job configs](https://docs.harborframework.com/jobs/configs.md), [custom agents](https://docs.harborframework.com/agents/custom-agents.md), [pre-integrated agents](https://docs.harborframework.com/agents/pre-integrated-agents.md), [ATIF](https://docs.harborframework.com/agents/atif.md).
- Harbor sources (main): `src/harbor/models/trial/paths.py`, `result.py`, `error_policy.py`; `models/agent/context.py`; `models/verifier/result.py`; `rfcs/0001-trajectory-format.md`. Harbor v0.25.0 = `fdba28fc…` (2026-10-25).
- [SWE-bench Pro V2 README](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/v2/README.md) and `v2/SHA256SUMS`, `v2/hard51_ids.txt`.
- One task's `task.toml`, `tests/test.sh` and `tests/config.json` (ansible-40ade1f8).
- Repository tags/commits (GitHub API).
- Local `--help` output: `claude` 2.1.310, `codex` 0.163.0, `opencode` 1.18.32. Also the opencode binary's bundled `run` command, for the `--format json` event shapes.
- Context: [PRD §10](../../../tasks/prd-backend-agent-platform.md), [benchmark research](../backend-review-2026-10-15/benchmark.md), and the competitive analysis §6 (outside the repo).

## 9. Funded-run checklist and cost formula

**Formula (PRD §10):**

```
total = tasks × repeats × Σ_configurations(measured mean cost per trial) × (1 + contingency)
approve against = trials × per-task USD cap × (1 + headroom)
```

The formula is implemented in `suites/budget.ts` and exposed as `pnpm eval:budget`.

Orientation only. These are not authorisations, and the costs are assumptions from public figures in competitive analysis §6.5, to be replaced by pilot means.

| Run | Configurations | Trials | Mean-cost assumption | Total with +25 % |
|---|---|---:|---|---:|
| TB 4.0 harness parity | native and OpenLinear, × Codex and OpenCode | 1 320 | $1.72 / $5.23 per trial | ≈ $5.7k |
| SWE-bench Pro V2 HARD-51 | 2 locked + 1 OpenLinear | 765 | $4 / $2 / $4 per trial | ≈ $3.2k |
| Private-holdout pilot | 2 configurations at the PRD cap, 40 tasks × 3 repeats | 240 | — | worst case 240 × $10 × 1.1 = $2.6k |

Checklist:

1. Deterministic gates are green (backend suites + `pnpm eval:test` + `pnpm eval:smoke`).
2. Credentials are authorised by the owner. Per-run keys only, through `--credentials-env`; they are never written anywhere.
3. A frozen holdout (`frozenAt` + checksums) exists, and the sealed split is held by someone who is not tuning.
4. The manifest is resolved (`resolveManifest`), `validate-manifest` reports no floating references, prices are dated, and the threshold and margin are preregistered.
5. Sandbox:
   - OpenLinear adapter runs: verified sidecar sandbox (Seatbelt/bwrap) or an audited trusted-host grant;
   - native CLIs: an external container;
   - public suites: Harbor (`-e docker` locally, or a cloud provider by separate decision).
6. Run the gates first: Harbor oracle/nop, and the holdout reference/empty gates (automatic).
7. Run with `eval:cli run … --confirm-spend` and the Harbor commands from the dry runs. Then ingest, replay to confirm outcomes, and archive the run directories.

## 10. Leftovers and follow-ups

- **F1: OpenLinear Harbor agent.** A Python `BaseInstalledAgent` that installs the sidecar runner inside the task container, drives the runner contract headless, writes ATIF (with `toAtif` as a reference) and captures `model.patch`. Without it, OpenLinear entries on TB4/SWE-Pro cannot be produced. *Owner:* runners/sidecar + evals.
- **F2: API usage receipts.** The API transport reports usage `unknown`, because AgentRun usage and cost receipts are not readable through `/api/executions` or `/api/tasks`. It needs a read route (W15). *Owner:* API.
- **F3: Artifact-only execution mode.** The full path ends in PR publication, which needs a GitHub stub. A sidecar `execute` option that commits to a local branch, or exposes a W11 artifact, would remove the stub. *Owner:* sidecar/W11.
- **F4: Eval principal seeding.** An operator script to create the eval user, PAT, workspace, project, team and file-origin repository against a local DB, reusing the e2e test setup. *Owner:* API (Prisma).
- **F5: Code-quality / mergeability rubric.** PRD §10 asks for a blinded, calibrated review. Not implemented: it needs human or LLM-judge time, and LLM judging is inference. The record has room for it (`grade` stays the executable gate).
- **F6: Harbor `--ae NAME=$NAME`.** Shell expansion puts the key in Harbor's argv. Prefer Harbor's environment-variable mechanism (`jobs/environment-variables.md`, not read) for funded runs.
- **F7: Binary replays.** Recorded edits are captured as UTF-8 file contents, so replays of binary-file edits are lossy. The patch itself (`patch.diff`, `--binary`) is exact.
- **F8: Model and version reporting.** OpenCode's JSON stream and Codex's `exec --json` stream do not report the model id. The model snapshot is unverifiable for those stacks, and the report says so (info drift). The adapter path reports the model through `session.started`.
- **F9: Grader isolation on bare hosts.** The harness enforces path separation, but on a bare host the agent process could read the grader dir. Real isolation comes from the sidecar sandbox's positive read allowlist, or the Harbor separate verifier.

## 11. Merge hazards

- **`package.json` (root).**
  - `packages/evals/src` is appended to the end of the biome `lint` list (after `apps/sidecar/src/runners`).
  - Six scripts are appended after `build:desktop`: `eval:smoke`, `eval:test`, `eval:cli`, `eval:dry-run:tb4`, `eval:dry-run:swe-pro`, `eval:budget`.
  - Both edits are append-only. Re-append them if someone else also extended the lint list.
- **`pnpm-lock.yaml`.**
  - One new importer block, `packages/evals` (execution-core link, zod 3.25.76, @types/node, tsx 4.21.0, typescript, vitest 4.0.18). No version changes elsewhere.
  - If it conflicts, run `pnpm install --ignore-scripts` after merging.
- **Root `pnpm test` / `pnpm typecheck` (turbo)** now also run `@openlinear/evals`. Tests take about 20 s: real git, child processes and the full smoke + replay.
- **New files only, otherwise:**
  - `packages/evals/**`;
  - `docs/eval/**`;
  - `.github/workflows/eval-smoke.yml`;
  - this ledger.
- **Not touched:** `apps/**`, `packages/execution-core` (consumed through its public exports: `AgentRunner`, `AgentEvent`, `StartInput`, `reduceUsage`, …), other workflows, ISSUES.md, the PRD.
- **Contract coupling.**
  - The harness and `AgentEventSchema` follow execution-core's `AgentEvent` union. `toAgentEvent` makes TypeScript fail if a new variant is added there without a schema case, so typecheck catches drift.
  - `OpenLinearApiRunner` assumes the current sidecar routes: `POST /api/tasks/:id/execute`, `GET …/running`, `GET …/logs`, `POST …/cancel`.
  - Changes to the runner adapters' `StartInput` or `healthCheck` semantics affect only funded runs. The fakes implement the same interface.

## 12. Ablations for W16b / W19a / W19b

- **Date:** 2026-10-27.
- **Status:** prepared, **not run**. Everything below runs offline with the fakes. The funded runs stay behind `--confirm-spend` and need the owner's budget. No paid inference was used and no real runner was started.
- **What the PRD asks:**
  - W16: "context benefit demonstrated with ablation";
  - W19: "ablations justify extra agents".

### 12.1 The three ablations (`packages/evals/src/suites/ablations/`)

Each ablation is a paired experiment. A `baseline` arm and one treatment arm run the same tasks with the same repeats, randomized and interleaved, and are compared with the existing paired task-cluster bootstrap. With track `ablation`, the schema requires the arms to be identical except for `features`: same harness, transport, runner, model and assets.

| Ablation | Ledger | Treatment arm | Treatment `features` | Agent sessions per trial |
|---|---|---|---|---|
| `repository-context` | context.md (W16b) | `repo-context` | `repositoryContext: { maxChars: 6000, maxFiles: 6 }` (the sidecar's defaults) | 1 |
| `project-knowledge` | knowledge.md (W19b) | `knowledge` | `knowledge: { fixture, checksum }` (sha256 of the fixture file) | 1 |
| `reviewer` | reviewer.md (W19a) | `reviewer` | `reviewer: { followUp: true, maxFindings: 10 }` | up to 3 (run, review, follow-up) |

Manifests are built by `buildAblationManifest`, in one of two modes:

- **`smoke`:** the five sample tasks (the sealed one included), the FAKE adapter runner, purpose `smoke`.
- **`funded`:** real runners with OpenLinear in the loop (adapter transport). The defaults are the pilot's stack: Codex, `gpt-6.1-sol`, medium effort. Other settings:
  - purpose `validation`;
  - the holdout's **non-sealed** tasks only, because an ablation drives a product decision;
  - the pilot's budgets: $10 per-task cap, 50 min wall clock, 10 % headroom.

The funded manifest deliberately carries the references the owner must pin: model snapshot, runner version, a dated price and the holdout revision.

### 12.2 Manifest fields (`configurations[].features`, `manifest/schema.ts`)

- **`repositoryContext`:** `maxChars` from 1 000 to 20 000 (the sidecar clamps `OPENLINEAR_REPO_CONTEXT_MAX_CHARS` to the same range), and `maxFiles` from 1 to 20 (default 6).
- **`knowledge`:** `fixture` is a file stem in the knowledge directory. `checksum` is the sha256 of the file bytes, so a frozen manifest pins the exact entries.
- **`reviewer`:** `followUp` is a boolean and `maxFindings` runs from 1 to 50.
- **Strict validation:** unknown keys and out-of-range values are refused.
- **Digest:** `features` is part of `manifestDigest`. The field is optional, so manifests without features keep the digest they had before.
- **New track `ablation`:** it needs at least one comparison. In each comparison, the arms must be identical apart from id, label, `features` and `enhancements`, and the treatment must enable something the baseline does not.

### 12.3 How the arms are applied (`features/pipeline.ts`, called by `runEvaluation` per trial)

**Sidecar code is reused, not copied.** `features/sidecar.ts` loads the following at run time, the same way `adapter-loader.ts` loads runners:

- `repositoryContextFor` and `ContextEngine`, from `apps/sidecar/src/context`;
- `projectKnowledgeSection`, from `apps/sidecar/src/run/service.ts`;
- `buildReviewPrompt`, `parseReviewOutput`, `anchorFindings`, `safeRepoPath`, `REVIEWER_SYSTEM_CONTRACT` and `MAX_REVIEW_DIFF_CHARS`, from `apps/sidecar/src/run/reviewer/contract.ts`.

Every export is shape-checked and every result is validated with zod, so a changed sidecar signature fails loudly. Two details of the loading:

- Loading the sidecar creates its repository storage root (`services/repo-storage.ts`, `REPOS_DIR`). When `REPOS_DIR` is unset, the loader points it at a private temp directory, so the user's app data is never touched.
- The context engine is memory-only (`cache: null`).

**Prompt sections** come first, in the order the run engine's `promptFor` uses: knowledge, then repository context.

- **Knowledge:**
  - Fixture entries are selected the way the control plane's `promptKnowledge` selects them: conventions, then procedures, then notes, up to 20 entries and 8 000 characters.
  - The sidecar renders them.
  - The receipt records the fixture, its sha256 and the titles given.
- **Repository context:**
  - The trial checkout is indexed at its base commit, under the key `eval:<task>`.
  - The section is given to the agent as untrusted data, exactly as the sidecar builds it.
  - The harness waits up to 120 s for the index, because a "still indexing" answer would silently run the baseline.
  - A missing section with any reason other than "nothing related" is `infra`. The trial is refused before any session starts, then rerun under the predeclared rule.

**Reviewer.** A review runs after a run whose termination is `completed`:

1. **Snapshot.** The agent's work is committed with a private index and `commit-tree`. The trial worktree's index, refs and files are untouched. The commit is then cloned (`--shared`, no remote) into a disposable checkout.
2. **Review session.** The reviewer runs in that checkout as a fresh session of the same runner, with:
   - the reviewer contract;
   - `permissions.default: 'deny'`;
   - the sidecar's review prompt, with the diff capped as the sidecar caps it.
3. **Findings.** The answer text (`message.delta`, as the sidecar's `consume` collects it) is parsed. The findings are then anchored against the reviewed commit.
4. **Follow-up.** Blocker and major findings, up to `maxFindings`, go into **one follow-up session** in the trial worktree. Its prompt is built with execution-core `buildFollowUpPrompt` in seeded mode. Each finding becomes a comment on its last line, with the same text as the desktop's `findingComment`.
5. **Grading.** The final worktree is graded, as for every trial.

Rules around the review:

- An `infra` review is a trial `infra` (rerun), never a baseline result.
- A failed or malformed review, or a run that changed nothing, is recorded, and the trial is graded as the run left it.
- The sessions share the per-task USD cap: each later session gets what is left. If a cost is unknown, the next session gets the full cap, and this is logged.
- The trial's usage is the sum of its sessions. Tokens and cost are summed only when every session reported them; otherwise they are unknown, never a partial sum.
- The trial's event stream merges the sessions, with exactly one terminal event, so `replay` reproduces it. The test replays the reviewer smoke: every outcome and every cost match.

**Runner paths:**

| Path | Prompt sections | Reviewer |
|---|---|---|
| openlinear/adapter | yes | yes |
| native/cli | yes (the CLI gets the composed prompt) | no |
| openlinear/api | no: the sidecar builds the prompt itself, from `OPENLINEAR_REPO_CONTEXT` and the project's knowledge | no |

Anything a path cannot apply is a plan-time problem: `feature unsupported: …` in `planFundedRun`, and `run` refuses it with exit 2. `runEvaluation` checks again before anything runs. It also refuses:

- a feature manifest with no feature environment ("it would run as the baseline");
- a runner instance without `featureSupport`;
- a knowledge fixture that was not loaded or no longer matches.

**Receipts.** Every treatment trial's `record.json` carries a `features` receipt:

- the section sizes and citations;
- the knowledge entries given;
- the review status, findings with their evidence, and whether the follow-up ran;
- per-session termination, time, cost and tokens.

The report gains an **Ablation** section:

- per arm: sections given, entries, reviews and findings, follow-ups, extra-session spend and its share of the arm's spend;
- per comparison: Δ success, mean cost per trial in each arm, Δ cost, extra resolved trials, and USD per extra resolved trial.

### 12.4 Sealed tasks and knowledge (`features/knowledge.ts`)

Each fixture entry records `provenance.derivedFrom`, the task ids it was learned from. The following are refused by `ablation plan`, by `prepareFeatureEnvironment` and again inside `runEvaluation`:

- entries derived from a **sealed** task;
- entries derived from a **validation** task (the same rule as `memoryPromotionAllowed`);
- entries that contain a grader canary;
- a file whose sha256 differs from the manifest's;
- a fixture written for another holdout.

An entry derived from a development task that the manifest also evaluates is flagged as **in-sample**: a note in the plan and a caveat in the report, because its result on that task is not evidence of benefit.

The sample fixture is `fixtures/knowledge/sample-holdout.json`. It has 6 entries: general conventions and procedures, plus two learned from the development tasks. Nothing comes from validation or sealed tasks.

### 12.5 Fakes (`fakes/ablation.ts`)

The fake agent reacts to what actually reached its prompt:

- its success probability rises when the "Repository context" section **cites the file the fix belongs in** (+0.30);
- it rises when the "Project knowledge" section **carries the task's rule** (+0.30);
- a failed run usually leaves a wrong fix, which acts as a planted bug.

The fake reviewer finds the planted bug in the diff the sidecar's prompt shows:

- recall is 0.8, and the reviewer quotes the exact line, so anchoring marks the finding `verified`;
- a correct fix gets a false-positive major finding with probability 0.2, and a nit with probability 0.5;
- the answer is malformed with probability 0.05.

The fake follow-up repairs the bug only if the finding is in its prompt (probability 0.85). Prompt length is charged as input tokens. Draws are common random numbers keyed by task, repeat and attempt, so both arms of a slot face the same draw.

**The report labels these results "prove the plumbing, not a benefit".** The lifts are programmed into the fake.

### 12.6 How to run when funded

Prerequisites (§9 checklist):

- the owner has approved the budget;
- a frozen private holdout exists;
- for the knowledge ablation, a fixture written or approved by a person for that holdout;
- the sidecar sandbox (or an audited trusted-host grant) for adapter runs.

```bash
pnpm eval:cli ablation list
pnpm eval:cli ablation plan <repository-context|project-knowledge|reviewer> --holdout HOLDOUT_DIR \
  [--knowledge NAME --knowledge-dir DIR] [--runner codex --model gpt-6.1-sol --provider openai] \
  [--repeats 5] [--holdout-revision SHA] --write ablation-<name>.json
# Freeze by editing the JSON (there is no CLI resolver; resolveManifest is a library call):
#   configurations[].model.snapshot, runner.binaryVersion (+ binarySha256), a dated prices[] entry,
#   suites[0].source.revision
pnpm eval:cli validate-manifest ablation-<name>.json          # exit 0 = frozen
pnpm eval:cli run --manifest ablation-<name>.json --holdout HOLDOUT_DIR --out runs/ablation-<name> \
  --adapter-module apps/sidecar/src/runners/index.ts --credentials-env OPENAI_API_KEY \
  [--knowledge-dir DIR] [--sidecar-src apps/sidecar/src] --confirm-spend
pnpm eval:cli replay --manifest runs/ablation-<name>/manifest.json --holdout HOLDOUT_DIR --recordings runs/ablation-<name>
```

**Environment:**

- the provider key is passed per run through `--credentials-env` and never written anywhere;
- `REPOS_DIR` is optional; when unset, a private temp directory is used.

**Gates.** `run` always prints the plan first. It then refuses:

- with **exit 3** when `--confirm-spend` is missing (checked: the reviewer manifest written by `ablation plan`);
- with **exit 2** on floating references, a smoke manifest or an unsupported feature.

`runEvaluation` refuses again if a feature cannot be applied.

### 12.7 Worst case per ablation (`ablation plan`)

The formula is trials × sessions × $10 per-task cap × 1.1 headroom. The reviewer arm counts 3 sessions at the cap: its sessions share the cap whenever their cost is known (a priced snapshot), but a runner that reports no cost cannot be held to a shared cap from outside.

| Ablation | Sample holdout (4 non-sealed tasks × 5 repeats, 40 trials), as printed | Per task (both arms, 5 repeats) | 40-task holdout × 5 repeats | 40 tasks × 3 repeats |
|---|---:|---:|---:|---:|
| repository-context | $440 | $110 | $4 400 | $2 640 |
| project-knowledge | $440 | $110 | $4 400 | $2 640 |
| reviewer | $880 (baseline $220 + reviewer $660) | $220 | $8 800 | $5 280 |
| all three | $1 760 | $440 | $17 600 | $10 560 |

The baselines of the three ablations are the same configuration. One manifest with one shared baseline and three treatment arms would cost (1 + 1 + 1 + 3) / 8 = 75 % of running them separately: $13 200 instead of $17 600 at 40 × 5. The schema already accepts that (track `ablation`, three comparisons). The builder makes pairs, so this would need a small builder option (§12.10).

For the sample holdout, `ablation plan` currently lists 7 blocking problems:

- 5 floating references: suite revision, model snapshot × 2, runner version × 2;
- 2 missing prices.

`project-knowledge` also notes the two in-sample entries.

### 12.8 Offline smoke (`pnpm eval:cli ablation smoke all`, FAKE runners, this machine)

Settings: 5 sample tasks × 2 arms × 4 repeats (40 trials) per ablation, about 4 s each. The outcomes are deterministic for the seed. Self-checks are OK for all three.

| Ablation | Baseline success | Treatment success | Δ (95% CI) | Verdict | Mean cost / trial T / B | What the treatment got |
|---|---|---|---|---|---|---|
| repository-context | 50.0% | 90.0% | +40.0 [+15.0, +65.0] | improvement | $0.1478 / $0.1444 | 20/20 sections, mean 1 498 characters, 2 files, always citing the file to fix |
| project-knowledge | 50.0% | 80.0% | +30.0 [+0.0, +60.0] | non-inferior | $0.1389 / $0.1444 | 20/20 sections, 6 entries, 1 224 characters |
| reviewer | 50.0% | 65.0% | +15.0 [−15.0, +50.0] | inconclusive | $0.2515 / $0.1444 | 45 sessions for 20 trials: 17 reviewed, 1 failed (malformed answer), 2 skipped (no change); 15 findings, all verified, of which 7 major; 7 follow-ups; the extra sessions cost $2.09, 41.6 % of the arm's spend |

What the smoke shows:

- the sidecar's own section builders, review contract and follow-up builder run inside the harness;
- the baseline's prompt is the task alone, and each trial gets one session;
- the reviewer runs under a deny policy in a disposable checkout;
- findings anchor to the reviewed commit;
- cost includes every session;
- the paired statistics, the report and the replay all work.

It shows **nothing about benefit**: the numbers come from `fakes/ablation.ts`.

### 12.9 Validation

| Check | Result |
|---|---|
| `pnpm --filter @openlinear/evals typecheck` | ✓ |
| `pnpm --filter @openlinear/evals test` | 12 files, **107 passed**. 24 are new: `features/features.test.ts` has 13 and `suites/ablations/ablations.test.ts` has 11. The suite takes about 24 s. |
| `pnpm --filter @openlinear/evals lint` (biome) | clean, 67 files |
| `pnpm typecheck` (root, turbo) | 11/11 |
| `pnpm eval:cli ablation smoke all --quiet` | OK, 3 × 40 trials |
| `pnpm eval:cli ablation plan …` (all three, `--write`) and `validate-manifest` | as in §12.7. `validate-manifest` exits 2 (floating references), as intended. |
| `pnpm eval:cli run --manifest <reviewer plan>` without `--confirm-spend` | plan printed, refused with exit 3 |

The new tests cover:

- **Schema:** strict feature blocks, digest sensitivity to every knob, unchanged digests without features, and the ablation-arm rules.
- **Support refusals:** the api transport and the native reviewer, with session-aware worst-case arithmetic.
- **Refusals before anything runs:** no feature environment, or a runner without support.
- **Knowledge:** selection order and limits; refusals for sealed or validation sources, canaries, a changed checksum or another holdout; the in-sample note.
- **Sidecar loader:** the real modules load and the user's app data is not touched.
- **Merging:** usage merge semantics, and a single terminal event.
- **Native path:** prompt sections reach a native CLI.
- **Missing index:** an index that cannot be built gives `infra` with no session started.
- **Each arm's prompt and flow,** asserted on what the fake runner received:
  - exact prompt prefixes and sections;
  - the review session's deny policy, contract and checkout;
  - follow-up comments.
- **Reviewer cost:** the trial's cost equals the sum of its sessions.
- **Replay:** outcomes and costs match.
- **Plans:** trials, worst case and problems.
- **Sealed guard:** checked in the plan, in preparation and inside the harness, plus a fixture edited after pinning.
- **Offline smoke:** all three ablations, with their paired reports.

### 12.10 Limits and follow-ups

- **Not run for real.** Real effects need the funded runs above.
- **Follow-up mode.** The eval's follow-up is the engine's *seeded* mode: a fresh session plus the previous diff. The sidecar resumes the session when the runner can, which uses somewhat fewer input tokens.
- **Reviewer coverage.** There is no reviewer on the native CLI path, and the api transport cannot take per-trial features (both are refused).
- **Repository-context timing.** Indexing time is counted in task→artifact time, not agent time. The eval index is memory-only, so production's disk-cache hits are not reproduced.
- **Shared baseline.** Shared-baseline (multi-treatment) ablation manifests are accepted by the schema but not built by `buildAblationManifest`.
- **Requests for files owned by others (optional, nothing is blocked):**
  - **Sidecar.** `services/repo-storage.ts` creates `REPOS_DIR` at import time. Making that lazy would let tools load sidecar modules without the `REPOS_DIR` workaround.
  - **Sidecar.** `run/reviewer/index.ts` collects the answer text inside a private `consume`. Exporting an `answerText(events)` helper would let the eval reuse it rather than mirror it.
  - **CI.** `.github/workflows/eval-smoke.yml` could add `pnpm eval:cli ablation smoke all --quiet`, which takes about 15 s.
  - **Docs.** `docs/eval/README.md` could link this section.

### 12.11 Files

- **New:**
  - `packages/evals/src/features/{types,support,sidecar,knowledge,reviewer,pipeline}.ts` and `features/features.test.ts`;
  - `packages/evals/src/fakes/ablation.ts`;
  - `packages/evals/src/report/ablation.ts`;
  - `packages/evals/src/suites/ablations/{definitions,manifest,index}.ts` and `ablations.test.ts`;
  - `packages/evals/fixtures/knowledge/sample-holdout.json`.
- **Edited** (all inside `packages/evals`):
  - `manifest/schema.ts`: `features` and the `ablation` track;
  - `runners/types.ts`: phase, `budgetUsd`, `featureSupport`, feature receipt;
  - `runners/openlinear-adapter.ts`: deny policy for review, remaining cap;
  - `runners/native/native-runner.ts`, `runners/openlinear-api.ts`: support flags;
  - `harness.ts`: guard, `runWithFeatures`, receipt, ATIF prompt;
  - `records.ts`: `features`;
  - `funded.ts`: sessions in the worst case, feature problems;
  - `replay.ts`: `features: 'recorded'`;
  - `report/report.ts`: ablation section, notes;
  - `usage/cost.ts`: `finalizeTrialUsage`, `mergeRawUsage`;
  - `util/git.ts`: `env` option;
  - `fakes/recordings.ts`: phase ids, extra input tokens;
  - `smoke.ts`: exported fake model ids;
  - `cli.ts`: `ablation list|plan|smoke`, `run --sidecar-src/--knowledge-dir`;
  - `index.ts`: exports;
  - `package.json`: an `ablation` script.
- **Not touched:** `apps/**`, `packages/execution-core`, `ISSUES.md`, `AGENTS.md`, root `package.json`, the lockfile. No new dependencies.
