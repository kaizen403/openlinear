# OpenLinear OpenAI/Codex execution research

> Source evidence includes the pre-fix audit. Read [consolidated validation](validation.md) for final repairs, tests and remaining scope. Audit line references may precede the local edits.
Fetched and inspected on **2026-10-15**. Scope: backend execution and orchestration; no paid model calls, deployments, frontend changes, or claims of benchmark parity. Local inspection preceded browsing, as required by the active tool instructions. Sources below were actually opened through the web tool; failed Markdown fetches and a timed-out raw GitHub request were not used as evidence. OpenAI Docs skill applied. The requested official `openai/codex` repository is used for exact pinned-release contracts.

## Recommendation and decisions

**First make OpenLinear's orchestration and persistence trustworthy, and retain the Codex SDK as the first local coding adapter.** It already runs the Codex execution harness, so replacing it with a home-built Responses loop before obtaining a baseline adds uncertainty. Keep the orchestration engine provider-independent and put each upstream runtime behind its own capability-tested adapter. Introduce app-server only if interactive approvals, explicit compaction, steering, fork/history operations, or a persistent connection justify the extra protocol lifecycle. Assess the new managed Agents API as a separate optional adapter, after account access, SDK support, data residency, runtime isolation, and total cost are established. This is an engineering recommendation, not a documented performance guarantee.

SDK choice alone cannot establish terminal benchmark parity. The model, harness release, tools, prompts, permissions, repository state, resource budget, and grading must be held constant before comparisons are meaningful. OpenLinear should own task acceptance, change/test validation, cancellation, durable run journals, recovery, repository worktrees, credential mediation, merge/publish decisions, and budget enforcement regardless of the selected runtime.

## Local baseline and immediate integration corrections

Inspected `apps/sidecar/src/runners/codex/index.ts`, its tests, sidecar manifest/lockfile, `packages/execution-core/src/agent.ts`, reducer, and SessionManager. Sidecar declares `@openai/codex-sdk: ^0.147.0` and `openai: ^6.22.0`; the lockfile resolves **0.147.0** and **6.22.0**. This is the checkout's dependency baseline, not a claim that either is today's latest version. Dependencies were initially absent. No appropriate execution-engine plan exists in `.sisyphus/plans/`; the parent is separately reviewing the Desktop plan. Latest work-log static audit says normal execution bypasses the runner coordinator and journal.

The adapter **at the initial audit** used a handwritten permissive event shape that hid upstream contract mismatches. Against the pinned sources below:

- Fatal stream error is `type: 'error'` with top-level `message`; the adapter expects `thread.error` and nested `error.message`.
- File patches are `file_change.changes[]` with each change's `path` and `kind`, plus patch status. The adapter expects `item.path`, so it loses file changes and cannot distinguish failed patches.
- Command items have `command`, `aggregated_output`, `exit_code`, and `status`; the adapter emits completion with `ok: true` regardless of failure and drops start/output information.
- Agent message text and reasoning summary text belong to **item IDs**. A global text watermark merges different messages and can repeat content. Maintain independent per-item snapshots; do not treat command `aggregated_output` as agent-message text.
- Cache-write and reasoning usage are in the pinned Usage type. Cache writes currently become zero. Preserve raw provider usage and normalize documented categories without counting included cached/reasoning subsets twice.
- SDK thread ID is set when `thread.started` is consumed. `thread.id ?? input.runId` captured before streaming is a local placeholder, not a resumable Codex ID. Persist the real ID from the session-start event.
- `input.model` is ignored. Forward the model ID using the pinned ThreadOptions. Do not make a catalogue containing `codex` and one stale model name appear to be live model availability.
- `interrupt()` and `abort()` are no-ops. Link external cancellation to a session-owned AbortController and pass that signal to `runStreamed`. Catch cancellation distinctly from provider failure. The SDK supports aborting the CLI child, not app-server's graceful `turn/interrupt` protocol.
- Fatal/error turns and an unexpectedly closed stream must produce a terminal failure rather than allow an orchestration layer to infer success from EOF.
- `ResumeInput` currently only contains worktree path and signal. It cannot carry caller-selected model, credentials, or new prompt without changing the shared interface. Preserve saved thread model and use an explicit continuation input; do not replay the original task automatically.

These are integration findings from local code compared with the exact pinned upstream types. App-server event names are different and must never be mixed into this decoder.

## Runtime options and roles

| Runtime | Upstream responsibility | OpenLinear responsibility | Fit and constraints |
|---|---|---|---|
| Local TypeScript Codex SDK | Wrap local CLI `exec` JSONL, coding tool loop, persisted local threads | Spawn/runtime isolation, configuration, credentials, task lifecycle, event adaptation, recovery, budgets and acceptance | Lowest-change route for unattended coding tasks. Thin execution interface; interactive approval replies, explicit compaction, fork/revert and live steering are absent from its pinned exported interface. |
| Codex app-server | Local Codex harness exposed through bidirectional JSON-RPC | Connection handshake, request IDs, server requests, approvals, process lifecycle, event routing, compatible schema pinning and durable product state | Rich embedded Codex lifecycle. Supports dedicated interrupt, history/thread operations, model listing and detailed deltas. Experimental fields require explicit capability opt-in. |
| Responses plus Agents SDK | Responses model/tool interface; SDK agent loop, tools, handoffs, sessions, approval state and tracing | Own coding harness/tool execution or sandbox integration, persistent storage, approval enforcement and workflow graph | Best when custom orchestration is the differentiator. Does not automatically recreate all Codex harness behavior. SDK tools still need real executors; SDK sessions are not Codex threads. |
| Managed Agents API | OpenAI-hosted Codex harness, saved sessions, compaction, orchestration and recovery | Application tools, task acceptance and environment lifecycle when self-hosted | Distinct current option documented under `beta.agents`, requiring `OpenAI-Beta: agents=v1`. Existing `openai` 6.22.0 support is unverified; do not implement from current docs without checking types and access. Managed session state is not a local SDK thread. |

This comparison is a synthesis of the source summaries below, not a promise of equivalent features, model availability, or performance.

## Evidence register: fetched 2026-10-15

Each entry states the supported upstream claim, practical implication, and uncertainty. Exact URLs are preserved for the plan. Current docs can change after this date; pinned GitHub sources identify the release actually used by this checkout.

### S1 — Local SDK surface

[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (the `developers.openai.com/codex/sdk` URL redirects here): the TypeScript SDK starts, continues, and resumes local threads and requires server-side Node 18+. Official guidance points unattended coding/CI automation to the SDK and richer authentication/history/approval/event clients to app-server. The obsolete `codex mcp-server` approach has been removed from current documentation. Implication: use local SDK for first baseline; do not confuse it with an OpenAI-managed cloud session. Uncertainty: current docs describe newer additions than the pinned release; source types govern the implementation.

### S2 — Pinned SDK persistence and environment

[TypeScript SDK README at rust-v0.147.0](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/README.md): streamed structured events, per-turn structured output, local thread storage under `~/.codex/sessions`, Git-directory checking, explicit CLI environment overrides, and config overrides are documented. Implication: isolate and retain the Codex state directory alongside each run's resumable workspace; a database thread ID alone is insufficient for cross-host recovery. Define an environment allowlist instead of inheriting application secrets. Do not infer exactly-once execution from thread resumption. Uncertainty: packaging/runtime executable identity must be checked after installation.

### S3 — Pinned events and token categories

[events.ts at rust-v0.147.0](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/events.ts): ThreadEvent includes `thread.started`, `turn.started`, `item.started/updated/completed`, `turn.completed`, `turn.failed`, and top-level `error` with `message`. Usage includes input, cached input, cache-write input, output and reasoning output fields. Implication: import the official discriminated union; fixtures should compile against it. Keep failure and terminal handling explicit and preserve all usage categories. Uncertainty: additive-vs-subset semantics require a separate cost mapping and real raw-response verification; don't invent a USD amount from tokens alone.

### S4 — Pinned item payloads

[items.ts at rust-v0.147.0](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/items.ts): commands carry command/output/status/exit code; file changes carry changes[] and patch status; messages and reasoning summaries carry ID/text; MCP calls include server/tool/arguments/result/error/status. Implication: decode each variant deliberately, deduplicate by item identity, and preserve failed commands so the agent can recover. Emit file changes only for successful patches. Reasoning text is a summary, not access to hidden reasoning. Uncertainty: JSONL item updates may be less granular than app-server token deltas.

### S5 — Pinned thread and process implementation

[thread.ts](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/thread.ts): the object receives its real thread ID from `thread.started`; turn signal flows into execution and missing cache-write counts receive a compatibility default.

[exec.ts](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/exec.ts): execution spawns the local CLI with AbortSignal, sends input on stdin, reads JSONL stdout, throws on unsuccessful child exit, and kills the child in cleanup. An explicit environment replaces inherited process environment; API key injection still occurs. Implication: cancellation needs stream cleanup and terminal state normalization; SDK import success is not proof that the runtime binary can execute. Uncertainty: whole-process-tree termination and graceful cancellation cannot be assumed from the SDK wrapper; verify inside the intended isolation boundary.

### S6 — Pinned configuration surface

[threadOptions.ts](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/threadOptions.ts): supports model ID, reasoning effort, sandbox, working directory, approval policy, network/web-search controls and extra directories. [codexOptions.ts](https://github.com/openai/codex/blob/rust-v0.147.0/sdk/typescript/src/codexOptions.ts): supports runtime path override, API URL/key, structured config and explicit environment. Implication: wire only available options; preserve version-specific approval spellings rather than copying a current docs example into an older release. Pin the runtime executable and record its actual version/checksum in benchmark artifacts. Uncertainty: raw config can enable more CLI behavior, but unsupported wrapper APIs must not be advertised as implemented capabilities.

### S7 — App-server lifecycle

[Codex app-server](https://learn.chatgpt.com/docs/app-server): bidirectional JSON-RPC supports initialization, thread start/resume/fork, turn start/steer/interrupt, item deltas, token-usage updates and approval request/reply flows. `turn/completed` carries final status, including interrupted turns. Types/JSON schemas can be generated with the exact installed CLI using `codex app-server generate-ts` or `generate-json-schema`. Current persistent history supports pagination. Dynamic tools and some permission/profile/history options are experimental. Implication: generate and pin a protocol contract from the shipped binary; handle server requests as well as notifications. Use the actual terminal status and item identity. Uncertainty: current docs and 0.147.0 may diverge; an app-server adapter needs its own release-specific spike and fixtures rather than reuse of SDK JSONL types.

### S8 — Approval and sandbox distinction

[Sandbox](https://learn.chatgpt.com/docs/sandboxing): sandbox boundaries apply to spawned commands; native enforcement differs by OS. Workspace-write bounds writes, while `never` prevents approval prompts. Full access combines danger-full-access and never. Current docs retire the untrusted policy although the old SDK type still lists it. Implication: approvals never does not mean unrestricted access; a worktree is not a tenant isolation boundary. OpenLinear must validate OS enforcement, filesystem/egress limits and credential exposure independently. Uncertainty: local OS sandbox behavior is not a guarantee of safe shared-host multi-tenancy; no sandbox smoke run was performed.

### S9 — Managed API architecture and access

[Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) and [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture): OpenAI hosts the Codex harness while applications submit work and supply tools/environments. The environment can be hosted or self-hosted, separate from the harness. Model usage and hosted tools/containers are charged at the relevant API rates. [Quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart) documents the beta header and API scopes. Implication: evaluate this as a distinct integration with runtime/access/cost checks; preserve provider-neutral journals even with saved managed sessions. Uncertainty: documentation establishes the surface, not this user's entitlement, region availability, or support in the checkout's SDK.

### S10 — Managed events, disconnects and cancellation

[Run and continue sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions): streams do not replay missed events; saved session/items recover work; cancel uses `agent.session.input.cancel` and retains the session. [Events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events): root turn completed/failed/cancelled is distinct from idle and from subagent completion. Reconnection opens/buffers a stream, retrieves saved paginated items, reconciles by item ID, then applies buffered updates; final text can replace a temporary buffer. Implication: track root and child scope and implement reconciliation; do not mark a root task done when a subagent or stream ends. Uncertainty: every lost intermediate delta is not recoverable.

### S11 — Managed environment key boundary

[Self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted): a dedicated environment key is passed as CODEX_API_KEY to `codex exec-server`; the application API key stays outside the sandbox. The environment key can be read by generated code but is limited to connecting environments. Implication: if choosing managed harness + self-hosted compute, use separate credentials and keep the product API key out of the executor environment. Uncertainty: provisioning provider choice, cleanup durability and runtime version need explicit verification.

### S12 — Agents SDK loop and persistence

[Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) and [Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents): SDK runs in application code, loops through tools and handoffs, and supports local history, SDK sessions, Conversations IDs, or previous response IDs. Mixing full local replay with server-managed state can duplicate context. [Results and state](https://developers.openai.com/api/docs/guides/agents/results): approval interruptions return resumable state and may have no final output. Implication: choose one canonical context strategy; persist pending approval state and workflow identity separately from a task transcript. Uncertainty: current guide examples require installed SDK contract checks; this checkout has no @openai/agents dependency.

### S13 — Custom coding tools remain application-owned

[Shell](https://developers.openai.com/api/docs/guides/tools-shell): Responses supports hosted shell or an application-owned local executor, paired shell_call/output items, exit/timeout outcomes, and SDK shell helper integration. [Apply Patch](https://developers.openai.com/api/docs/guides/tools-apply-patch): models propose file operations; integrations apply them and report status. Agents SDK can help parse diffs but still needs a real execution harness. Implication: a Responses route must implement bounded commands, output truncation/artifacts, timeout/cancellation and path-safe atomic patches. Preserve error outcomes for agent repair. Uncertainty: model/tool availability differs by model and current SDK version; old cookbook examples are explicitly archived and unsuitable as a current default specification.

### S14 — Compaction and caching

[Compaction](https://developers.openai.com/api/docs/guides/compaction): current Responses supports configured server-side compaction or explicit `/responses/compact`. Opaque compaction state carries prior reasoning; explicit compacted output is the canonical next window and should be passed as returned rather than pruned. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): reuse depends on matching rendered prefixes, including tools/instructions/history/settings. Sessions do not guarantee cache hits; current cache-write pricing is an alternative input rate, not an additive fee. Implication: keep stable instruction/tool order, put changing task context later, and measure cache splits; never synthesize plain summaries as a substitute for provider state. Uncertainty: SDK exposes no explicit compact method, although the underlying harness may compact automatically.

### S15 — Cancellation is resource-specific

[Background mode](https://developers.openai.com/api/docs/guides/background): background Responses can be cancelled through the response cancel endpoint; cancellation is idempotent. Streaming supports sequence-number cursors for reconnecting. Implication: cancelling an HTTP reader or model response does not itself terminate an application-owned shell/job. Maintain a cancellation chain across the model request, tool process group and run state. SDK abort, app-server interrupt, managed session cancel and Responses cancel are distinct provider mechanisms.

### S16 — Tracing, approval enforcement and delegation

[Integrations and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability): Agents SDK offers MCP connections and tracing of models, tools, handoffs, guardrails and custom spans. [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals): approval runs can pause and resume saved state; tool guardrails belong at side effects. Responses/SDK applications do not automatically inherit Codex auto-review. [Orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration): handoffs transfer ownership; agents-as-tools preserve manager ownership; add agents only when contracts differ. Implication: use traces to inspect work, but keep an independent durable journal. Start with one coding agent and isolated review/verifier roles only where measured benefit warrants them. Uncertainty: tracing defaults can transmit tool content; configure redaction and export policy deliberately.

### S17 — Usage and cost semantics

[Agents API observability and usage](https://developers.openai.com/api/docs/guides/agents-api/observability): cached tokens are included in total input tokens; reasoning tokens are included in total output tokens. Implication: persist source usage and category semantics; do not add cached input to input totals or reasoning again to output. Use a versioned price table with model/provider/service tier/currency/effective time; mark unknown cost unknown, not zero. Account for tools, containers and nested runs without double counting parent aggregate usage. Uncertainty: no numeric prices or latest model IDs were selected or verified for this account.

### S18 — Evaluation and deprecation

[Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): evaluate continuously with task-specific datasets, logs, automated scores and human calibration. [Deprecations](https://developers.openai.com/api/docs/deprecations): Evals become read-only **2026-10-31**, and Evals dashboard/API, reusable prompt objects and Agent Builder are scheduled to shut down **2026-11-30**. Implication: own portable benchmark manifests, graders, prompt text and trace artifacts; avoid depending on those retiring surfaces. Current docs point to Promptfoo migration. Uncertainty: test-run model calls require credentials/cost authorization and were not run.

## Concrete acceptance and benchmarking design (engineering proposal)

1. Establish deterministic adapter tests from release-typed fixtures: command success/nonzero failure, failed/successful patches, text/reasoning item updates, usage splits, fatal failures, EOF, external cancellation, session interruption and saved-thread continuation. No paid calls required.
2. Persist a run manifest: task/attempt/tenant/repo/commit/worktree, adapter/SDK/CLI version, binary hash, effective model/reasoning/config, prompt/instruction hashes, enabled tools, sandbox image/policy/network, deadlines/budgets, start/end, raw usage, provider thread/turn IDs and replay references. Never put secrets in it.
3. Treat success as provider terminal success **plus** task-specific independent verification. Snapshot the diff, prohibit publication until repository/task contract permits it, execute required tests, and record exit/log artifacts. A final assistant answer alone is not a passing grade.
4. Run a held-out representative coding suite with fixed environments and graders, separate from prompt-development tasks. Compare terminal Codex and OpenLinear using matching model/harness/config and identical runtime/permission/budget constraints. Repeat nondeterministic tasks; publish pass-rate distributions, latency, token/cache usage, cost, invalid-change rate, recovery rate and cancellations. Identify task dataset/version/licenses; avoid a naked universal terminal benchmark percentage.
5. Gate default/runtime changes on passing deterministic tests and a measured quality/cost/latency result. Preserve the old adapter path for rollback. An SDK upgrade is a schema migration: regenerate contract fixtures and record the exact shipped executable version.

Outstanding investigation: app-server version-specific schema, managed API account access and SDK compatibility, environment credential/storage boundaries, measured runtime cancellation/process-tree cleanup and actual terminal benchmark runs. No parity or production readiness claim is made.

## Focused implementation follow-up

At the parent's explicit request, corrected only `apps/sidecar/src/runners/codex/index.ts` and `index.test.ts`. Installed SDK `package.json` confirms **0.147.0** and its exported declaration file confirms the exact contracts used. The SDK depends on `@openai/codex` **0.147.0** in both installed metadata and the lockfile; no upgrades were performed. Running its dependency CLI with `--version` (no inference) returned **codex-cli 0.147.0** on Node 22.16.0.

The adapter now imports upstream event/options types, reports command/MCP/patch outcomes, emits per-item message/reasoning deltas, preserves all five token fields, forwards the start model, exposes the SDK's live thread ID, and normalizes fatal/provider failures and unexpected EOF. External cancellation and session interrupt/abort reach a linked AbortSignal. Iterators are single-consumer; early close aborts the SDK. Resume sends a continuation instruction and preserves the stored model. Unsupported approval replies throw, discovery returns an empty list instead of fabricated live models, and health constructs the SDK to verify binary discovery while labeling execution/authentication as unchecked.

Validation: `pnpm --filter @openlinear/sidecar typecheck` passed; focused Vitest suite **20/20 passed**. Fixtures cover cumulative text and independent IDs, command success/nonzero/status failures, patch success/failure/deduplication, MCP failure, usage categories, fatal/turn errors, start model/key, real thread ID, saved-thread resume, pre-cancel, blocked-stream interrupt/abort/external cancel, early consumer close, unexpected EOF and SDK exceptions. No paid calls or live model runs.

Limitations unchanged by this narrow patch: production runner/journal wiring, durable adoption of the real session ID, tenant isolation and sanitized runtime environments, resume credentials/prompt/model interface, independent task acceptance, real process-tree cancellation and benchmark performance. Thread-default model cannot be observed in SDK JSONL and is reported unknown if no model was configured. `interrupt: true` describes abort-backed stop, not app-server's graceful interrupt RPC.
