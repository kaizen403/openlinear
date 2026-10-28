# OpenLinear evaluation harness (W21)

`packages/evals` (`@openlinear/evals`) implements the evaluation protocol in
[PRD §10](../../tasks/prd-backend-agent-platform.md). It runs completely
offline today, with fake runners that replay recorded trajectories. Funded runs
use the same pipeline later.

> **Nothing in this directory is a benchmark result.** The smoke suite uses
> synthetic tasks and replayed trajectories. It shows the harness works, not that
> any agent is good. No paid inference has been run.

## 1. Quick start (offline, no credentials, about 10 s)

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm eval:smoke                 # 5 tasks × 4 configurations × 5 repeats + reruns → report
pnpm eval:smoke --out ./tmp/smoke --repeats 5 --seed 20261026 --concurrency 4
pnpm eval:test                  # unit + integration tests (real git, fake runners)
pnpm eval:dry-run:tb4           # what a Terminal-Bench 4.0 run would execute (nothing runs)
pnpm eval:dry-run:swe-pro       # same for SWE-bench Pro V2 (HARD-51 by default)
pnpm eval:budget --tasks 66 --repeats 5 --config a=1.72:30 --config b=1.72:30 --contingency 0.25 --cap 10
pnpm eval:cli help              # every command
```

The smoke writes the following to `$TMPDIR/openlinear-eval/smoke-<time>/` (or `--out`):

- `report.md` and `report.json`;
- `manifest.json`, the frozen manifest plus drift notices;
- `trials.jsonl`, one record per trial;
- `trials/<trial>/{trajectory.json, trajectory.atif.json, patch.diff, logs.txt, grade.json, record.json}`;
- `holdout/`, the five generated tasks.

The run checks itself before it exits. If any check fails, it exits non-zero. The checks are:

- all task gates pass;
- every behaviour produced the outcome class it should;
- every outcome class occurred at least once;
- the infra-rerun rule was exercised;
- unknown cost is never 0;
- sealed trials never allow memory promotion.

CI runs the same steps in `.github/workflows/eval-smoke.yml`.

## 2. Concepts

| Term | Meaning |
|---|---|
| Manifest | The frozen experiment (`manifest/schema.ts`). It holds the task ids and checksums, the repository and dataset SHAs, image digests, hardware and concurrency, the toolchain, runner/SDK/binary versions and checksums, the model snapshot, provider, endpoint, effort and sampling, hashes of the prompt/tool/skill/MCP assets, the sandbox and network policy, timeout, cap and retry rules, prices, the verifier revision, contamination controls and the preregistered analysis. Aliases are resolved explicitly (`resolveManifest`), and drift notices are kept (`detectDrift`). The digest excludes drift notices. |
| Configuration | `harness` × `transport` × runner × model. **openlinear/adapter** drives an execution-core `AgentRunner`, the same contract the sidecar run engine uses. **openlinear/api** goes through the real API + sidecar headless path. **native/cli** runs the vendor CLI directly. |
| Trial | One fresh, independent first attempt: a new full clone of the base commit, a private HOME and scratch directory, and its own process group. Trials are scheduled randomized and interleaved, from a seed. |
| Outcome | The class of a trial: `pass`, `fail`, `timeout` (wall clock or any cap), `infra`, `refusal` or `safety`. Only `pass` counts as success. Every scheduled first attempt stays in the denominator. |
| Views | **Intent-to-run** (the primary view) counts the first attempt of every slot. **Adjudicated** counts the last attempt after the predeclared infra-rerun rule. Originals are never deleted. |
| Cost basis | `provider-reported`, `runner-reported` (for example Claude Code `total_cost_usd` or OpenCode step cost, which are client-side list-price estimates), `estimated` (tokens × the manifest price), `invoiced`, or `unknown`. Unknown cost is `null`, never 0, so totals become lower bounds. |

## 3. Private holdout format (PRD §10 layer 3)

```
<holdout>/holdout.json                id, frozenAt, [{id, checksum}]   (checksums enforced when frozen)
<holdout>/tasks/<id>/task.json        openlinear.eval.task/v1: split (development|validation|sealed), category,
                                      cluster (e.g. repository), repo (inline dir | git url + base SHA),
                                      verifier {argv, timeoutMs, graderDir, copyInto, failToPass, passToPass},
                                      protectedPaths, referencePatch
<holdout>/tasks/<id>/instruction.md   the only agent-facing text
<holdout>/tasks/<id>/repo/            inline seed repository (becomes one deterministic commit)
<holdout>/tasks/<id>/grader/          hidden tests + a grader canary — never copied into the agent worktree
<holdout>/tasks/<id>/reference.patch  reference solution
```

Authoring rules:

- **Gates.** A task is used only if its reference patch passes and the empty patch fails. Tasks that fail either gate are excluded before any system runs, and the report lists them.
- **History.** Git-sourced repositories are sanitized before use: one ref, no remotes, unreachable objects pruned. The harness also audits that no ref points past the base commit (`auditRepoHistory`).
- **Grader canary.** The grader holds a canary string, and the manifest lists it in `contamination.canaries`. If the canary shows up in a patch or a trajectory, the trial is a `safety` outcome.
- **Splits.** Split tasks by repository and time.
  - Tune only on `development`.
  - `sealed` tasks may run only in `release` manifests, never while tuning. The manifest schema enforces this.
  - Sealed trials carry `memoryPromotionAllowed: false`, and `assertPromotionAllowed()` throws for them. Validation and public-benchmark trials never feed memory either.
- **Samples.** The five sample tasks (`tasks/samples.ts`) are tiny Node libraries with a visible failing `node:test` test. The grader adds hidden cases. Each task also ships a plausible wrong fix that passes the visible test and fails the grader.

## 4. Grading contract

`grading/verifier.ts` grades every trial the same way:

1. The agent's process tree is stopped. A stop that cannot be confirmed makes the trial `infra`, because its artifacts cannot be trusted.
2. The patch is captured with `git add -A && git diff --cached --binary <base>` and the same code for every configuration.
3. A **pristine** clone of the base commit is made outside every agent worktree.
4. The patch is applied there. A patch that does not apply is a `fail`.
5. The grader assets from the task directory are copied over the checkout. This overwrites any test the agent edited.
6. The verifier argv runs with a minimal environment and a timeout. A verifier timeout or crash is `infra`, not `fail`.

The agent's own claims and test runs never count as success. Safety checks look for protected paths and canaries in the patch and the trajectory.

## 5. Statistics

`stats/` covers the following:

- **Primary metric.** Single-attempt success is the mean of per-task success rates, so each task weighs the same.
- **95% intervals.** They come from a task-cluster bootstrap, seeded and with 2 000 resamples by default, in two stages:
  1. draw clusters with replacement (a cluster is a task, or `clusterBy: cluster`, e.g. a repository);
  2. redraw each task's repeats with replacement.

  Repeats are never treated as new tasks.
- **Paired differences.** Treatment − baseline is computed over shared tasks. Both arms use the same resampled clusters, each with its own repeat draws. The report gives the counts where the treatment was better, the baseline was better, or they tied.
- **Verdict.**
  - `improvement` only if the interval excludes 0 and the preregistered practical threshold is met.
  - `regression` if the interval is entirely below 0.
  - `non-inferior` if the lower bound is above −margin.
  - Otherwise `inconclusive`.
- **Cost and latency.**
  - Cost per resolved task is total known spend ÷ successes. It is shown as `≥` (a lower bound) if any cost is unknown.
  - The report also shows all-task spend and mean cost per trial.
  - p50/p95 latency is reported for task→artifact, agent time and first action. Timeout and infra trials are included at their stop time and counted as censored.
- **Breakdowns.** Outcome rates per class, results per category, and the per-task outcome matrix.

## 6. Runners

| Runner | Status | Notes |
|---|---|---|
| `OpenLinearAdapterRunner` + `ReplayAgentRunner` | Offline, tested | Replays AgentEvent streams and applies recorded edits; interrupt, abort and signal give a confirmed `cancel.receipt`. |
| `OpenLinearAdapterRunner` + real adapter | Wired, not run (paid) | `loadRunnerAdapter('apps/sidecar/src/runners/index.ts', id)` loads it at run time with no compile-time dependency on the sidecar. Needs the sidecar's verified sandbox or an audited trusted-host grant (see `docs/reports/revamp-2026-10-26/sandbox.md`), plus per-run credentials through `--credentials-env`. |
| `OpenLinearApiRunner` | Client tested against a loopback stand-in | Covers task creation, `execute`, polling `running`, cancel on timeout, logs, task status, then harvesting the published branch from a local bare origin. It needs the e2e-style setup from `apps/api/src/__tests__/sidecar-api-only.e2e.test.ts`: an eval user + PAT, a project whose repository `cloneUrl` is a file origin (`OPENLINEAR_ALLOW_FILE_GIT=1`), and a loopback GitHub stub. Usage is reported as `unknown` until the API exposes AgentRun usage. |
| `NativeCliRunner` (FAKE) | Offline, tested | Spawns `replay-cli.mjs`, which prints the CLI's real headless protocol and applies the edits. The real argv is recorded. |
| `NativeCliRunner` (real) | Wired, refuses by default | Real CLIs must run inside an external sandbox (container or Harbor), so it needs `allowRealExecution`. The invocations used are listed below. |

Native invocations (from `--help` of the installed CLIs, read 2026-10-26):

- `claude -p --output-format stream-json --verbose --model M --permission-mode bypassPermissions --no-session-persistence --strict-mcp-config --setting-sources user [--disallowedTools WebFetch,WebSearch] [--max-turns N] [--max-budget-usd X]`, with the prompt on stdin.
- `codex exec --json --model M --sandbox workspace-write --skip-git-repo-check --ephemeral --ignore-user-config -C <worktree> [-c model_reasoning_effort="E"] -`
- `opencode run --format json --pure --auto --model P/M --dir <worktree> [--variant E] "<prompt>"`

Parsers turn each stream into execution-core `AgentEvent`s, a termination class and usage with its basis.

**Replay a finished run.** `pnpm eval:cli replay --manifest RUN/manifest.json --holdout HOLDOUT --recordings RUN` re-runs every trial from its recorded trajectory, at zero cost. It must reproduce every outcome class; the test suite and the ledger confirm 102/102 for the smoke. Use it after a funded run as a harness/grader regression check.

## 7. Public suites (PRD §10 layer 2)

Both suites run under Harbor. The adapters cover parsing, pinning, command construction, dry runs and result ingestion. They do not pull images or run inference.

### Terminal-Bench 4.0 (`suites/terminal-bench.ts`)

- **Pins.**
  - Dataset `terminal-bench/terminal-bench@4.0.0` at commit `452bf305c6daa62fc59061d22133a7cbc7c1572e` (release v4.0.0, published 2026-08-26), with 66 tasks.
  - Release asset `prebuilt-images.json`: sha256 `35930574…`, 157 images. That is an environment and a separate verifier image per task, plus 25 compose-sidecar images across 11 multi-container tasks.
  - Agent timeout: a flat 8 h.
  - Harbor 0.25.0 (`fdba28fc…`).
- **Dry run.** `pnpm eval:dry-run:tb4 --images <downloaded prebuilt-images.json> [--checkout <clone of the pinned commit>] --official` prints:
  - the oracle and nop gates;
  - paired harness-parity configurations (native vs OpenLinear for Codex and OpenCode);
  - image counts;
  - the budget.

  `--checkout` replaces the provisional image-entry checksums with task-directory hashes. Without `--images`, the 3-task excerpt fixture is used.
- **Ingest.** `pnpm eval:cli ingest-harbor --job jobs/<job> --manifest M --config ID --suite terminal-bench-4.0.0` maps each trial's `result.json` to a trial record. Harbor's `error_policy` causes map to our outcome classes, and `agent_result` maps to usage with its basis.

### SWE-bench Pro V2 (`suites/swe-bench-pro.ts`)

- **Pins.**
  - Repository tag v2.0.0 (`66f92766…`); V2 was introduced in `31a20c75…` on 2026-09-22.
  - 642 tasks; HARD-51 list sha256 `6e35e847…`; `v2/SHA256SUMS` sha256 `9d84f850…`.
  - Images `ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>` (linux/amd64, pinned by tag, so record digests at pull time).
- **Protocol.**
  - 50-minute agent phase.
  - Agent network is `no-network`, except the model host (`--allow-agent-host`).
  - `--ak disallowed_tools=WebFetch,WebSearch`.
  - Sanitized history.
  - The verifier never runs in the agent sandbox.
  - `patch_replay:PatchReplayAgent` re-grading is authoritative. Publish both numbers.
- **Dry run.** `pnpm eval:dry-run:swe-pro [--subset hard51|full] [--checkout <clone> --verify]` prints:
  - the oracle and nop gates;
  - the locked agents (`locked_claude_code`, `locked_codex`), each followed by a patch-replay re-grade;
  - an OpenLinear self-run, labelled "self-run, unofficial".

  `--verify` checks every task file against SHA256SUMS and the locked protocol: agent network, timeout, image and verifier config.

### Sources (all read 2026-10-26)

- https://www.tbench.ai/news/terminal-bench-4-0
- GitHub release `harbor-framework/terminal-bench` v4.0.0 (API metadata, `prebuilt-images.json`, `tasks/interleaved-vigenere/task.toml` at the pinned commit)
- https://docs.harborframework.com/tasks/configuration.md, `tasks/verifier.md`, `tasks/network-policies.md`, `tasks/resources.md`, `jobs/run-a-job.md`, `jobs/configs.md`, `agents/custom-agents.md`, `agents/pre-integrated-agents.md`, `agents/atif.md`
- `harbor-framework/harbor` sources on main: `src/harbor/models/trial/{paths,result,error_policy}.py`, `models/agent/context.py`, `models/verifier/result.py`, `rfcs/0001-trajectory-format.md` (ATIF)
- https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/v2/README.md, plus `v2/SHA256SUMS`, `v2/hard51_ids.txt`, one task's `task.toml`, `tests/test.sh` and `tests/config.json`, and the tag/commit metadata

## 8. Running a funded pilot later

This is not spending authorization. The owner approves the budget first.

1. **Deterministic gates.** These must be green: `pnpm eval:test` and `pnpm eval:smoke`, plus the backend suites for whatever is under test.
2. **Author tasks.**
   - Write 30–60 private tasks in the holdout format, split by repository and time.
   - Freeze `holdout.json` (`frozenAt` plus checksums).
   - Keep the sealed split away from anyone tuning prompts.
3. **Write the manifest.** Start from [`pilot-manifest.example.json`](pilot-manifest.example.json). Then:
   - resolve aliases with `resolveManifest` (provider model list, `--version` probes, `git ls-remote`);
   - fill in the price table with dates;
   - set `budgets` (the PRD pilot cap: 50 min, USD 10, 1M tokens per task, stop at the first cap, 10 % headroom);
   - preregister `practicalThresholdPts` and `nonInferiorityMarginPts`.

   `pnpm eval:cli validate-manifest M` must report no floating references.
4. **Estimate the budget.**
   - Formula: `total = tasks × repeats × configurations × measured mean cost per trial × (1 + contingency)`.
   - Approve against the worst case: `trials × per-task cap × (1 + headroom)`.
   - Commands: `pnpm eval:budget …`. `pnpm eval:cli run …` prints both before it refuses without `--confirm-spend`.
5. **Run the private holdout.**

   ```bash
   pnpm eval:cli run --manifest M --holdout H --out RUN --confirm-spend \
     --adapter-module apps/sidecar/src/runners/index.ts --allow-real --credentials-env OPENAI_API_KEY
   ```

6. **Run the public suites.** Run the Harbor commands from the dry runs, starting with the oracle and nop gates. Then ingest each job.
7. **Replay.** Run `pnpm eval:cli replay …` on the run directory. Every outcome must reproduce. Archive the run directory: the manifest, `trials.jsonl`, trajectories (native and ATIF), patches, logs and grades.

## 8a. Ablations (repository context, project knowledge, reviewer)

Three paired ablations (baseline vs one feature) are ready to run offline
(`pnpm eval:cli ablation smoke all`) and, once a budget is approved, funded
(`ablation plan …` → pin the manifest → `run … --confirm-spend`). Manifests,
commands, worst-case costs and the sealed-task guard:
`docs/reports/revamp-2026-10-26/evals.md` §12.

## 9. Fairness rules

- Every configuration gets the same:
  - task text;
  - fresh checkout;
  - wall-clock budget and caps;
  - network policy;
  - patch capture and grader;
  - infra-rerun rule.
- **Native CLIs.** User and project config and MCP servers are not loaded where the CLI allows it. Web tools are off unless the track's network is `public`. Permissions are auto-approved inside an external sandbox, and nothing interactive is allowed.
- **OpenLinear runs.** Permission requests outside the start policy are denied, the same way for every run.
- **Order.** Randomized and interleaved from a recorded seed. Five fresh trials per task and configuration for release evidence. Never best-of-N reported as pass@1.
- **Official-fidelity runs.** Use each suite's published resources, time and network rules. `officialFidelityProblems` flags overrides and subsets. A shortened run is a product-budget experiment and is not called an official score.
- **Evidence.** Keep every original. Infra reruns are predeclared and identical across configurations. Failed reasoning is never rerun.

## 10. What cannot be compared, and why

- **Different models.** Comparing different models measures the model, not the harness. The harness-parity track pins the same model, effort, resources, network policy and Harbor/suite SHAs on both sides.
- **Closed or cloud products** (Devin Cloud, Capy, Codex cloud, Claude Code web, Cursor Cloud Agents, Copilot cloud agent, Jules, Linear coding sessions). Their agents run on the vendor's VMs, so container, resource and network policy cannot be applied. They can only be compared observationally on the private holdout, by patch replay, with hardware, time and network marked uncontrolled. Devin **CLI** is not Devin Cloud.
- **Missing cost receipts.** A stack without token or cost receipts (closed services; OpenCode's JSON stream has no model id) cannot support matched-token or matched-dollar claims. Unknown is reported as unknown.
- **Token totals across families.** These are not comparable. OpenAI-family `cache-read ⊂ input` versus disjoint Anthropic/OpenCode categories are kept raw per configuration. ATIF export converts them to ATIF semantics, with cache writes kept in `extra`.
- **Suite versions.** TB 2.x/3.0 numbers versus TB 4.0, and SWE-bench Pro V1 versus V2 (or Full versus HARD-51), are different instruments. Never put them in one trendline.
- **Tiny differences.** A small mean difference whose paired interval includes 0 is `inconclusive`. Resource allocation alone moved TB 2.0 by about 6 points, and gaps under about 3 points deserve skepticism.

## 11. File map

- `src/manifest/`: schema, alias resolution, freeze checks, drift.
- `src/tasks/`: holdout format, loader, sanitized base repos, the five samples.
- `src/runners/`:
  - `openlinear-adapter.ts`, `replay-agent-runner.ts`, `openlinear-api.ts`, `adapter-loader.ts`;
  - `native/` (argv, stream parsers, CLI runner, `replay-cli.mjs`);
  - `classify.ts`, `workspace.ts`.
- `src/grading/`: pristine-checkout verifier and gates, outcome classification, safety scan.
- `src/usage/cost.ts`, `src/stats/`, `src/report/`.
- `src/trajectory/`: trajectory format, ATIF v1.7 export.
- `src/harness.ts` (the loop), `src/smoke.ts`, `src/replay.ts`, `src/funded.ts`, `src/cli.ts`.
- `src/suites/`: Harbor task/job formats, Terminal-Bench 4.0, SWE-bench Pro V2, budget.
- `fixtures/`: small public excerpts (TB4 `task.toml` and 3-entry image manifest; a SWE-bench Pro task's `task.toml`, `config.json`, SHA256SUMS lines and the HARD-51 list), each verified against its published checksum.
