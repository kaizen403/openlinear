# W07 preparation — conformant native runners (Claude Code, Codex, OpenCode)

Date: 2026-10-26. Engineer: `runners` (round 2). Base tree: `round2d-base.patch` on `922dbd7` (`fa4934e5…`).
Status: **Done for adapters + conformance.** Routing ordinary execution through these adapters is W05/W07 integration (not done here; the legacy execute route still refuses non-OpenCode runners).
No paid inference was run. Real binaries were run only with `--version`, `claude auth status --json` and `codex login status`.

## 1. Outcome

- **Claude Code runner** (`apps/sidecar/src/runners/claude-code/`): spawns the user's own unmodified `claude` binary in headless stream-json mode, under the W09a SandboxProvider. It never reads, copies or relays Claude credentials.
- **Codex runner**: `@openai/codex-sdk` upgraded from `^0.147.0` to exact `0.164.0`. Every mapped event type was re-verified against the new typings. The CLI now runs under the SandboxProvider.
- **One shared launcher** (`runners/shared/sandboxed-process.ts`) puts every runner CLI under the verified provider, the same way W09a runs OpenCode servers. Without a provider it fails closed with `SANDBOX_UNAVAILABLE` and spawns nothing.
- **Conformance suite** (`runners/conformance.test.ts`): one contract, three adapters, 57 tests. It found and fixed real defects in all three adapters (§8).
- **Capability discovery**: `RunnerFeatures` + `RunnerHealth` (additive in `execution-core`), plus a read-only `getRunnerCatalogueSnapshot()`. No route was added.
- **`pickRunner('claude-code')`** now returns the adapter instead of throwing "Phase 4". `requireLegacyRunner` (`RUNNER_NOT_SUPPORTED`) is unchanged.

## 2. Choices

### Claude Code: drive the official CLI directly (not the Agent SDK package)

- **Compliance.** The research notes cite Anthropic's legal page: third parties may not route requests through Free/Pro/Max credentials, but an end user may sign in to the *unmodified Claude Code binary*. `@anthropic-ai/claude-agent-sdk` bundles its own CLI copy and is the "Agent SDK" whose docs restrict claude.ai login in third-party products. So the adapter spawns the binary the user installed (`OPENLINEAR_CLAUDE_PATH`, PATH, or the known install locations). It is never resolved from the worktree; the launcher refuses a binary inside it.
- **Contract sources, nothing guessed.**
  - `claude --help` (2.1.310).
  - Headless docs: `code.claude.com/docs/en/headless`, fetched 2026-10-25. They give the stream-json flags, the SIGTERM vs SIGINT semantics, `system/init.capabilities`, `api_retry` and `permission_denied`.
  - Authentication docs: credential storage. `CLAUDE_CONFIG_DIR` re-keys the Keychain entry, and the file login is `<config>/.credentials.json`.
  - Env-vars docs: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
  - The Agent SDK's published typings (`@anthropic-ai/claude-agent-sdk@0.3.310`, `sdk.d.ts`), downloaded to /tmp and read, not installed. They define the message union, `SDKResultMessage`, `TerminalReason`, the control protocol (`control_request` / `control_response` / `control_cancel_request`, `SDKControlInterruptRequest`, `can_use_tool` and `PermissionResult`), and the argv the official SDK uses.
- **Exact invocation:**
  ```
  claude -p --output-format stream-json --verbose --include-partial-messages
         --input-format stream-json --setting-sources user --strict-mcp-config
         --append-system-prompt <contract> (--session-id <uuid> | --resume <id>)
         [--model <id>] [--max-turns N] [--max-budget-usd X] <permission flags>
  ```
- **Prompt and stdin.** The prompt is one stream-json `user` message on stdin. Stdin stays open for control requests and closes after the `result`.
- **Permission flags:**
  - `allow` → `--permission-mode acceptEdits --allowedTools Bash,Edit,Write,NotebookEdit --permission-prompts none`
  - `deny` → `--permission-mode dontAsk --permission-prompts none`
  - `ask` → `--permission-prompt-tool stdio` (interactive approvals over the control protocol)
- **Minimum version 2.1.259**, the release that added `--permission-prompts`. It is checked by `claude --version`, and older binaries get `RUNNER_UNAVAILABLE`. Verified against 2.1.310.
- **No `--bare`.** Bare mode never reads the subscription login. `--setting-sources user` plus `--strict-mcp-config` keep repository hooks, env, `apiKeyHelper` and `.mcp.json` out, like `OPENCODE_DISABLE_PROJECT_CONFIG`. CLAUDE.md is still read, like AGENTS.md for OpenCode.
- **Env:**
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so one prompt gives one result and no background turn starts after it.
  - `DISABLE_AUTOUPDATER=1`.
  - In enforce mode, also `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (the proxy would refuse that traffic anyway).

### Codex: SDK pinned 0.164.0; spawning moved under the provider

- **Version.** `npm view @openai/codex-sdk version` returns 0.164.0 (latest; 0.165 is alpha), pinned exact. Its dependency `@openai/codex` is 0.164.0. The lockfile diff touches only the codex entries.
- **Changelog check.** I diffed the published 0.147.0 and 0.164.0 `dist/index.d.ts` and `dist/index.js`.
  - `ThreadEvent`, `ThreadItem` and `Usage` are **unchanged**.
  - The additions are all optional: `TurnOptions.cyberAccessProgram`, `CodexOptions.configOverrides`, `ThreadOptions.threadSource`, and wider `ModelReasoningEffort`. The adapter does not use them.
- **Why our own driver.** The SDK spawns the CLI itself with no spawn hook. A `codexPathOverride` wrapper cannot carry the Linux provider's extra fds (the seccomp program). So `runners/codex/exec.ts` mirrors the SDK's `CodexExec` argv (`exec --experimental-json`, the flags, then `resume <id>`) and the SDK's vendored-binary resolution. The adapter keeps the SDK for its event types and its version-matched binary.
- **Sandbox mode.** Under enforce mode Codex runs with `--sandbox danger-full-access`: our OS sandbox is the boundary, and Codex's own Seatbelt/Landlock cannot nest inside it. Under a trusted-host grant it keeps `--sandbox workspace-write`, as before.
- **Kept W00 corrections:** per-item text deltas, command/MCP/patch outcomes, all five usage categories with no subset addition, real thread id, model forwarding, EOF failure, single consumption, and a resume continuation that does not replay the task.
- **"Positive abort receipts"** now means a confirmed process exit (§6). It is no longer an SDK AbortSignal.

## 3. Event mapping

### Claude Code (stream-json → AgentEvent)

| Claude Code message | AgentEvent |
|---|---|
| `system/init` | `session.started{externalId: session_id, model: {anthropic, model}}` + `turn.started{1}`; `capabilities` recorded |
| `stream_event` `content_block_delta` `text_delta` / `thinking_delta` | `message.delta` / `reasoning.delta` (main thread; message id marked streamed) |
| `assistant` `tool_use` / `server_tool_use` / `mcp_tool_use` | `tool.started{callId, name, input}` (once per id, subagents included) |
| `assistant` text/thinking blocks not seen as partials | `message.delta` / `reasoning.delta` once per (message id, block); subagent text is not surfaced |
| `assistant.message.usage` | kept per message id (dedupe for split per-block messages) for the usage lower bound |
| `assistant.error` | remembered for result classification |
| `user` `tool_result` | `tool.finished{ok: !is_error, summary ≤ 8 KB, secret-scrubbed}`; synthetic `tool.started` if unseen |
| successful `Write` / `Edit` / `MultiEdit` / `NotebookEdit` | `file.changed{path relative to worktree, kind create (Write + tool_use_result.type=create) / edit}` |
| `*_tool_result` blocks in assistant content | `tool.finished` (ok unless the content type ends in `error`) |
| `system/status: compacting` / `system/compact_boundary` | `compaction{start}` / `compaction{end, before: pre_tokens}` |
| `system/api_retry` | `diagnostic{api_retry}` (non-terminal) |
| `system/permission_denied`, `rate_limit_event` rejected, `auth_status.error` | `diagnostic` |
| `tool_progress`, `keep_alive` | `heartbeat` (at most one per 5 s) |
| `control_request can_use_tool` (ask policy) | `permission.requested{id: request_id}`; `replyPermission` answers with `control_response` (`PermissionResult` allow+updatedInput[+session rule] / deny) |
| other `control_request` | answered `control_response{subtype: error}` + `diagnostic` (never left hanging) |
| `control_response` | resolves our pending interrupt request |
| `result success` (not is_error) | `usage` + `turn.finished{idle}` |
| `result error_max_turns` / `terminal_reason max_turns` | `usage` + `diagnostic{max_turns}` + `turn.finished{max_turns}` |
| `result` after our interrupt (`aborted_*`, `error_during_execution`) | `usage` + `cancel.receipt{runner-ack}` + `turn.finished{interrupted}` |
| other `result` errors | `usage` + `error{code, retryable}` + `turn.finished{error}`: 429→`rate_limit`✓, 529→`overloaded`✓, 5xx→`server_error`✓, 401/403/auth→`auth`, billing, `prompt_too_long`→`context_overflow`, budget→`budget_exhausted`, `model_not_found`, else `claude_code` |
| stdout EOF / exit without `result` | `diagnostic{process_exit, stderr tail scrubbed}` + `error{eof}` + `turn.finished{error}` |
| unknown type / unknown system subtype / malformed line | `diagnostic{unknown_event / malformed_line / invalid_event}` (bounded, never terminal) |

### Codex (`ThreadEvent` 0.164.0 → AgentEvent)

Unchanged from W00 except where noted.

| Codex event | AgentEvent |
|---|---|
| `thread.started` | `session.started` (real thread id) |
| `turn.started` | `turn.started{n}` |
| `agent_message` / `reasoning` | `message.delta` / `reasoning.delta` (per item id) |
| `command_execution` | `tool.started{bash}`, `tool.output` deltas, `tool.finished{ok: completed && exit 0}` |
| `mcp_tool_call` | `tool.started{server.tool}` / `tool.finished` |
| `file_change` completed | **W07: `tool.started{apply_patch}`** + `tool.finished` + `file.changed` per successful change |
| `error` item | **W07: `tool.started{codex}`** + `tool.finished{ok:false}` |
| `turn.completed` | `usage` (5 categories, `cache_write_input_tokens` backfilled to 0 like the SDK) + `turn.finished{idle}` |
| `turn.failed` / `error` | `error{codex}` + `turn.finished{error}` |
| EOF without terminal | `diagnostic{process_exit}` + `error{codex, "Codex stream closed before the turn ended"}` + `turn.finished{error}` |
| unknown type / malformed / undecodable | `diagnostic` |

### OpenCode (adapter changes only)

- `session.error` is now followed by `turn.finished{error}`. Before, the stream ended on `error` with no terminal, so the session manager never called `onComplete`.
- A stream that ends without idle/error → `error{eof}` + `turn.finished{error}`.
- Cancellation:
  - The session owns its cancellation, and the iterator unblocks immediately; before, it only noticed on the next bus event.
  - The receipt is the server's abort reply: `cancel.receipt{server-ack}`. If the request is cancelled before the prompt was sent, the receipt is `not-started`.
  - A failed abort gives `error{cancel_unconfirmed}`.
- Malformed events → `diagnostic{malformed_line}` with **no content** (it may belong to another session). Own events of an unknown type → one `diagnostic{unknown_event}` per type.
- Resume sends the continuation prompt instead of an empty one.
- Health no longer claims a hard-coded `version: '1.18'`.

## 4. Capability matrix (`capabilities` + additive `features`)

| | OpenCode | Codex | Claude Code |
|---|---|---|---|
| resume | native session | native thread (`resume <id>`) | native session (`--resume`) |
| interrupt | server abort | process abort (no in-band interrupt in `codex exec`) | **graceful ack** (control `interrupt`, then the aborted result) |
| approvals | interactive | policy only | **interactive** (ask policy, stdio control) |
| models | live (`provider.list`) | passthrough, no discovery | aliases `fable`/`opus`/`sonnet` + passthrough, no discovery |
| max context | unknown (null) | unknown (null) | unknown (null; per-model `contextWindow` arrives in `result.modelUsage`) |
| usage semantics | snapshot per message | delta per turn | delta per run (one `usage` at the result) |
| cost | reported | none (tokens only) | reported (`total_cost_usd`, client-side estimate) |
| isolation | sandbox provider, per-attempt server | sandbox provider, per-attempt process | sandbox provider, per-attempt process |
| min version | — | binary version matched with SDK 0.164.0 | 2.1.259 |
| healthCheck (non-inference) | management server running | `codex --version` + `codex login status` (method only; the masked key it prints is dropped) | `claude --version` + `claude auth status --json` (email/org dropped) + reachability in the current sandbox mode |

`getRunnerCatalogueSnapshot()` returns `{ sandbox: {mode, verified, provider, blockers}, runners: [{id, capabilities, features, health, available, legacyExecuteSupported}] }`. Health checks are bounded at 20 s and cached for 60 s per runner.

## 5. Sandbox allowances and credentials

**Launcher.** It applies the W09a policy unchanged:
- live-verified provider;
- one egress proxy per attempt;
- worktree writable; Git metadata read-only;
- private HOME/TMP/XDG under `<sandbox>/runners/<runner>/<key>/`;
- exact env via `buildSandboxAgentEnv`, nothing inherited.

**Private runtime dir.** `CLAUDE_CONFIG_DIR` / `CODEX_HOME` point at `<attempt>/runtime`. Sessions persist there for resume, kept while the worktree exists. The agent cannot read the user's other transcripts or write persistent settings or hooks.

**Login-file allowance** (the only policy addition). The user's own login file is linked into the private dir and made readable as **one file, read-only, as the last rule**, after the mandatory credential denies.
- Files: `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`; `<CODEX_HOME or ~/.codex>/auth.json`.
- The sidecar only checks the file exists; it never opens, copies or forwards it.
- The allowance is used only when no per-run key is passed.
- Measured on real Seatbelt (runners corpus test):
  - The login file reads.
  - Denied: `~/.claude/projects/*`, `~/.claude/settings.json`, `~/.ssh`, writes to the login file, writes to `settings.json`.
  - The private config dir is writable.
  - HOME is private; planted sidecar secrets are absent.

**macOS Keychain logins.** This is the default for Claude Code on macOS. The base Seatbelt profile deliberately denies `securityd` and the Keychain. Opening them would expose every item trusted by `/usr/bin/security` (gh tokens etc.) to agent code.
- Start therefore fails closed **before spawning** with `RUNNER_AUTH_UNAVAILABLE` (412).
- Remedies: pass an Anthropic API key for the run, or use an explicit trusted-host grant.
- Health reports `unreachable-in-sandbox`.
- Verified here: the real `claude` 2.1.310 under real Seatbelt runs `--version` (exit 0), and `auth status` reports `loggedIn:false`.

**Per-run credentials.** Only `StartInput.env` / `ResumeInput.env` are used: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (https only), `OPENAI_API_KEY`/`CODEX_API_KEY` → `CODEX_API_KEY`. The sidecar's own `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` never reach a runtime.

**Egress:**
- Claude: `api.anthropic.com`, `console.anthropic.com`; `platform.claude.com` only with a login file; plus the base-URL host.
- Codex: `api.openai.com`, `auth.openai.com`, `chatgpt.com`.
- Plus registries unless `OPENLINEAR_SANDBOX_REGISTRIES=0`, plus `OPENLINEAR_SANDBOX_ALLOW_HOSTS`.

**Trusted-host grant.** The unmodified CLI runs with the user's own HOME, Keychain and config. The env comes from `buildRunnerProcessEnv` (allowlist). Use is logged at warn level.

**Known limit (documented, not fixed).** With a file login, a token refresh inside the sandbox cannot be written back. If the provider rotates refresh tokens, the user may have to log in again. A credential broker (W10) removes this.

## 6. Cancellation and receipts

- **Exactly one terminal per stream.** A cancellation ends with `cancel.receipt{via, confirmedBy}` followed by `turn.finished{interrupted}`, and only once the stop is confirmed:
  - Claude: `runner-ack` (control response, then the aborted result).
  - Codex/Claude fallback: `process-exit` (observed exit code or signal).
  - OpenCode: `server-ack`.
  - Any runner: `not-started`.
- **Escalation.**
  - The graceful interrupt is Claude only, after `init`.
  - It falls back to SIGTERM on the process group (detached), then a 5 s grace, then SIGKILL on the group.
  - If SIGKILL cannot be confirmed, the stream ends with `error{cancel_unconfirmed}` instead of a receipt.
  - The group is reaped after every terminal event; `whenClosed()` resolves after the reap.
- **External signal and repeated calls.** An aborted signal is treated as a graceful interrupt. Calls are single-flight, so the engine's `cancelRun` order (signal → `interrupt()` → `abort()`) sends one in-band interrupt, and `abort()` can always escalate.
- **Early close.** A consumer that closes the iterator early stops the runtime.

## 7. Usage accounting

`reduceUsage(events)` is in `execution-core`:
- A `usage` event with a `messageId` is a snapshot and replaces earlier ones with that id (OpenCode).
- A `usage` event without one is a delta (Codex per turn, Claude per run).

Categories stay provider-raw:
- **OpenAI:** `cacheRead` ⊂ `input`, `reasoning` ⊂ `output`.
- **Anthropic:** `input`, `cacheRead` and `cacheWrite` are disjoint; `reasoning` (thinkingTokens) ⊂ `output`.

**Claude Code values:**
- **Fresh session:** `result.modelUsage`, summed across models (subagents and internal calls included).
- **Resumed session:** Claude reports conversation-cumulative totals, so the baseline recorded host-side at the end of the previous run is subtracted (`<sandbox>/runners/records/sessions`, not agent-readable).
- **Floor:** the per-message usage seen in the run (split per-block messages deduplicated by id) is the floor in both cases.
- **Cost:** `cost.basis` names the source.

The conformance test asserts that `reduceUsage` over each recorded stream equals the recorded totals. A double-counted split message would fail it.

## 8. Conformance results

`runners/conformance.test.ts` runs 19 checks per adapter (57 tests):
- start → events → idle;
- tool lifecycle + changed file;
- usage exact once;
- EOF = failure;
- malformed/unknown lines tolerated and reported;
- resume by id with a continuation (no task replay);
- sandbox unavailable → no spawn or prompt;
- already-aborted signal → not started;
- cancel × {startup, streaming, tool} × {interrupt, abort, signal} with confirmed receipts, process gone;
- cancel after terminal = no-op;
- no secret-named sidecar variable reaches the runtime.

Defects found and fixed by the suite:
- **Codex:** `file_change` / `error` items emitted `tool.finished` without `tool.started`.
- **OpenCode:** no terminal after `error`; EOF treated as end; cancellation not observed while the stream was blocked; empty resume prompt; malformed events silently dropped.
- **Claude:** new adapter, written to the contract.

Other new tests:

| File | Tests |
|---|---|
| `claude-code/index.test.ts` | 26 |
| `codex/index.test.ts` | 30 (was 20) |
| `shared/shared.test.ts` | 16 |
| `runners.corpus.test.ts` | 2 real-Seatbelt + 2 opt-in real-binary (`OPENLINEAR_RUNNERS_REAL_BINARIES=1`, run locally: pass) |

**Intermittent flake.** Early runs showed random 4–104 s stalls in single tests, and Vitest's own timer fired late, which means the event loop was blocked.
- Every fake CLI was a newly written executable. On this Mac a first exec of a new file costs about 300 ms (vs 30 ms re-exec), consistent with an OS first-exec assessment, and the multi-second stalls coincided with the network/TLS outage window.
- After the outage: 6 runs instrumented with a worker-side and an external lag monitor showed no lag over 1 s, and the stall itself could not be reproduced.
- **Fix:** one static fake script per runtime. Each scenario is a symlink plus a `.scenario.json` file, and the fake reads `argv[1]`, so no test executes a new file.
- Result: suite time went from about 11.5 s to about 2 s, and 10 consecutive stress runs over all runner tests passed (141 passed + 2 skipped each, with the 141-test suite before the cancel-order test was added).
- **Production is unaffected:** the real CLIs are long-lived installed binaries.

## 9. Validation

| Check | Result |
|---|---|
| Root `pnpm typecheck` | 11/11 |
| `pnpm lint` (root list + `apps/sidecar/src/runners`) | passed, 150 files |
| `pnpm --filter @openlinear/sidecar test` | **830 passed, 3 skipped**, 45 files. Baseline was 719 + 1 skipped; the +2 skips are the opt-in real-binary checks |
| `pnpm --filter @openlinear/execution-core test` | 28/28 |
| Real Seatbelt runners corpus | 2/2; opt-in real binaries 2/2 (claude 2.1.310 `--version` + `auth status` → `loggedIn:false`; codex 0.164.0 `--version`) |

Existing tests that changed. All were stale assertions of superseded behaviour; none was a regression:
- **`runners/opencode/index.test.ts` (3):**
  - An `error` is now followed by `turn.finished{error}` (2 tests).
  - Malformed events are now reported as content-free diagnostics; that test now also asserts the 4 diagnostics and that no content leaks.
- **`runners/codex/index.test.ts`:**
  - The patch decoder test now expects `tool.started` before `tool.finished`.
  - The 9 SDK-constructor-injection session tests were replaced by fake-binary tests asserting the same behaviours: model/key forwarding, prompt contract, real id, resume, pre-cancel, three cancel paths, early close, EOF, start failure, capabilities. Additions: SIGKILL escalation, stderr scrubbing, the login link, trusted-host, health. Pre-cancel now also expects the `not-started` receipt.

## 10. Behaviour changes (verify manually)

1. **Codex auth.**
   - Codex no longer falls back to the sidecar's `process.env.OPENAI_API_KEY`. The key must come from the run's env, or from Codex's own login (`~/.codex/auth.json`, read-only).
   - A login kept in a keyring is unreachable in enforce mode.
2. **Codex launch.**
   - Codex starts at `start()`, not on the first iteration, so a sandbox refusal surfaces from `start()`.
   - Under enforce mode Codex runs with `--sandbox danger-full-access`.
3. **Claude on macOS** fails closed with `RUNNER_AUTH_UNAVAILABLE` unless an API key is passed or a trusted-host grant applies.
4. **OpenCode:**
   - Runs now complete on `session.error` (terminal event).
   - Cancel waits for the server's abort reply.
   - Health drops the fabricated version.
5. **`pickRunner`** returns the Claude Code adapter. The legacy execute route is unchanged (`RUNNER_NOT_SUPPORTED`).

## 11. Left for W05 / W07 routing

- Route runs through the run service with `pickRunner`, pass a per-run key in `StartInput.env` (from stored provider settings), and journal `cancel.receipt` / `diagnostic` (`processAgentEvent` ignores both today).
- **Engine (not mine):**
  - `processAgentEvent` treats `turn.finished{max_turns}` as success.
  - `cancelRun` aborts the signal before `interrupt()` (P1 in engine.md). The adapters treat the signal as a graceful interrupt, which mitigates it.
  - Persist `RunnerSandboxMetadata` (`session.sandbox`) on `AgentRun`.
  - Expose the catalogue on a route (W03a).
- **Credential broker (W10):** refresh-token write-back and Keychain logins without a trusted-host grant.
- Wall-clock budgets stay with the engine watchdogs; adapters pass `maxTurns` and `maxUsd` only (Claude).
- **Optional extras:**
  - Claude `--thinking-display summarized`, for non-empty reasoning deltas on current models. It is undocumented in `--help`, so not used.
  - Claude model discovery via the `supportedModels` control request.
  - A Codex PATH binary fallback.
  - The app-server adapter for an in-band Codex interrupt.
- Run the Linux bwrap path of the runners corpus in `sandbox.yml` (the login-file bind is unit-reasoned, not run on Linux here).
- **Owner/legal:** confirm that a user's own subscription login, driving their own unmodified `claude` binary from OpenLinear, is within Anthropic's terms. This is the design the research notes recommend; the API-key path is unambiguous.

## 12. Merge hazards

- **`packages/execution-core/src/agent.ts`** (additive):
  - New `AgentEvent` variants `diagnostic` and `cancel.receipt`. Exhaustive switches elsewhere would need cases; `processAgentEvent` has a default branch.
  - Optional fields on `ResumeInput` (`prompt`, `model`, `env`, `permissions`).
  - `healthCheck(): Promise<RunnerHealth>`.
  - Optional `AgentRunner.features`.
  - `reduceUsage`.
- **`apps/sidecar/package.json` + `pnpm-lock.yaml`:** `@openai/codex-sdk` `0.164.0` exact; lock entries `@openai/codex*@0.164.0`.
- **Root `package.json`:** `apps/sidecar/src/runners` appended to the lint list after `apps/sidecar/src/sandbox`.
- **`runners/opencode/index.ts`:** the session class was rewritten (cancellation, EOF, diagnostics, resume prompt, health). `decodeOpenCodeEvent` is unchanged except a lint fix (the `??=` expression was split).
- **`runners/index.ts`:**
  - Registry now has three entries.
  - New `getRunnerCatalogueSnapshot`.
  - `catalogue/models-dev.ts` `listRunnerCatalogue` now also visits Claude Code (its `listModels()` returns `[]`, so the output is unchanged).
- **Sandbox modules:** read-only imports of `sandbox/*` (`buildEgressAllowlist`, `EgressProxy`, `buildSandboxAgentEnv`, `resolveSandboxMode`, `darwinDeveloperBin`, `sandboxStateRoot`, `buildAttemptPolicy`, `validatePolicy`, `getVerifiedProvider`). No sandbox file was edited.
- **New state dir:** `<sandbox>/runners/{claude-code,codex}/<key>`, with host-only records under `<sandbox>/runners/records`.
- **Untouched:** `routes/`, `persistence/`, `services/execution`, `services/batch`, `app.ts`, `index.ts` (W03a).
