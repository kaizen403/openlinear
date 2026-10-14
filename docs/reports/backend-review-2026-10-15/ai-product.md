# OpenLinear AI product backend audit and work packages

> Source evidence includes the pre-fix audit. Read [consolidated validation](validation.md) for final repairs, tests and remaining scope. Audit line references may precede the local edits.
Date: 2026-10-15. Checkout: `157de4e8e16580309dde04bca033647ab98b1c6a`, with audit-time worktree changes coordinated by the root agent.

## Scope and evidence

Reviewed `AGENTS.md`, the relevant work-log entries in `ISSUES.md`, local `.sisyphus` brainstorm/God Mode plans, Desktop revamp Phase 4, Phase 7, and A3, and the actual chat/tool/planning/MCP/model/usage/runner paths. This report is a static call-path audit plus a focused archive-selector fix requested during the audit. The root agent owns the combined session log. The local report is not a deployment plan. No cloud execution, infrastructure deployment, frontend implementation, publishing, commits, or external messages are included.

Do not interpret past work-log test counts or model-provider response-time estimates as current evidence. The original Phase 4/A3 SDK versions, model defaults, pricing and savings assumptions require revalidation when implemented; this audit does not recommend adopting those dated values. No measured latency or quality benchmark was run for this report. The focused archive fix passes API typecheck. The new archive-selector suite (15 tests) and existing chat-tool suite (9 tests) passed together against dedicated loopback database `openlinear_ai_audit_test` on port 55439: 24/24 passed, two files. Root owns broader integration validation.

## What is actually present

- Home Chat has persistent sessions/messages/tool calls, owned-session checks, workspace/project access checks, SSE text/tool events, boundary repair for leading orphan tool results, in-flight/replay result truncation, unique synthesized call IDs per request, attachment text envelopes and five withheld permission tools. These are useful Phase 0 foundations (`services/chat.ts:154`, `:174`, `:196`, `:323`; `services/chat-tools/index.ts:28`).
- The core runner interface has five usage fields and typed events; OpenCode and Codex adapters, a coordinator, local journal and watchdog helpers exist. Their existence does not establish the normal route uses them (`packages/execution-core/src/agent.ts:3`, `:21`, `:65`; `apps/sidecar/src/engine/run-coordinator.ts:17`).
- Project setup supports preview, label matching, a target date and up to 100 flat tasks. MCP supports creating a new project, labels and phase-grouped tasks. These are record creation operations, rather than validated executable plans (`apps/api/src/services/project-plan.ts:9`, `:71`; `apps/mcp/src/mcp/tools/plan.ts:35`).
- Usage aggregates AgentRun fields. Maintenance scheduling exists, but user-owned AI schedules and durable local orchestration schedules do not (`apps/api/src/routes/usage.ts:52`; `apps/api/src/jobs/index.ts:72`).
- `packages/ai-core` is absent. There are no durable plan graph, acceptance evidence, chat-turn, memory/provenance, embedding, product AI schedule or review models in the Prisma schema. The Task hierarchy is a single parent/subtasks relationship (`schema.prisma:128`, `:167`, `:495`, `:589`).

## Findings requiring work before expanded autonomy

### 1. Destructive archive targeting can broaden to the whole project — P0, focused fix implemented

At the audited checkout, `archive_issues` tests only array length (`apps/api/src/services/chat-tools/domain.ts:330–337`). `issueIds: [' ']` or `issueIdentifiers: [' ']` passes. `bulkArchiveTasks` trims and drops blank values, then conditionally omits the selector predicate when no values remain (`apps/api/src/services/tasks.ts:520–539`). The query becomes every active task in the project. Mixed arrays are also silently filtered by `stringArrayArg` (`chat-tools/types.ts:115`), masking malformed input.

The focused fix validates the raw selector arrays through the existing request schema at both tool and service boundaries, rejects blank members and an empty effective target set, and always applies the selector predicate. It preserves valid identifier trimming/case matching, duplicate valid selections, project access checks and cross-project exclusions. It leaves broad status updates and other independent broad operations untouched. Regression coverage is `apps/api/src/__tests__/tasks.archive-selectors.test.ts`; the root report should incorporate its actual test result.

### 2. Other destructive/bulk operations still rely on model intent — P0/P1

`ChatTool` exposes only a `mutating` boolean, which the dispatch policy does not use (`chat-tools/types.ts:76`; `chat-tools/index.ts:129`). `bulk_update_issues` intentionally permits omission of IDs; an empty or filtered-invalid ID list produces every active project task (`domain.ts:305–315`; `services/tasks.ts:366–371`). Archive only guards exact selection; it has no approval channel. The env flag can re-enable the five permission-changing tools without an implemented approval protocol (`chat-tools/index.ts:36`). Tool results containing workspace text remain raw JSON; only attachment text gets the envelope helper (`chat.ts:120`, `:379`, `:384`, `:494`).

Work: add effects and explicit selectors, dry-run previews, resource version hashes, exact-target approvals, principal revalidation and per-operation idempotency. A destructive approval must bind canonical arguments, target-set hash, workspace/project, resource revision, expiry and policy version; a model-written statement of consent must not count as approval. Distinguish ordinary caller-authorized writes from permission/external publish effects. Keep permission tools withheld until their policy contract works through every entry point.

### 3. A timed-out or cancelled tool can still mutate data — P0/P1

`withTimeout` only rejects its wrapper promise; it does not stop the underlying handler (`chat-tools/index.ts:92–114`). `tool.handler(ctx,args)` is evaluated before `withTimeout` checks an already-aborted signal (`:171`). Most domain handlers do not propagate an abort signal into their database work. The journal can report `failed`/`cancelled` while the write commits later (`:185–195`). A retry with a new call ID can duplicate the write. The tool journal and domain transaction are independent, leaving a crash window between mutation and journal result (`:149`, `:171`, `:172`).

Work: do not start an already-aborted handler; require cancellation-aware read tools; for writes, define atomic commitment and an `outcome_unknown` reconciliation state rather than reporting a reversible failure after crossing the commit boundary. Use a durable operation key/hash shared by the domain transaction and tool journal. Retry only known replay-safe operations; reconcile ambiguous success before repeating a write.

### 4. Chat streaming loses usage and terminal semantics — P1

The provider request omits streamed usage options (`lib/chat-llm.ts:193–201`). The parser skips usage-only frames when `choices` is empty (`:237–238`) and emits usage only when a choice has `finish_reason` (`:257`). `runChatTurn` consumes text and tool deltas, never `done` usage or finish reason (`services/chat.ts:406–423`). A truncated `length` response, early EOF, or incomplete tool arguments can be treated as a completed answer or empty args. Stream/nonstream temperature differs (`chat-llm.ts:155`, `:198`). Nonstream title calls return text only, dropping their usage (`:171–176`).

Work: parse model terminal state independently of usage, handle fragmented/CRLF/final-buffer frames, finish cancellation and stream-reader cleanup, carry five-field usage with provider-specific semantics, and reject incomplete tool args without degrading to `{}` (`chat.ts:41`). Treat early EOF and maximum-output termination distinctly. Meter title, retry and error calls as well as successful turns. Keep adapter migration behind the existing `ChatLLMClient` seam and an integration fixture suite.

### 5. Chat turns have no durable lock or restart/resume contract — P1

Each POST starts a fresh random turn ID, inserts a user message and executes immediately (`chat.ts:331–338`; `routes/chat.ts:174–207`). There is no durable `ChatTurn` row or active-turn lock (`schema.prisma:495–586`). Tool rows dedupe only `(sessionId,toolCallId)`, so replaying the HTTP user request is not deduped. Crashes after persisting assistant tool calls but before all results can leave replay history structurally invalid. Boundary repair only removes leading tool messages, rather than guaranteeing complete assistant/result groups (`chat.ts:174–193`). Ordering the prompt query only by `createdAt` adds ambiguity when timestamps match (`:186`). The POST SSE has no event IDs, heartbeat or replay cursor (`routes/chat.ts:166–168`); it appends `done` after any yielded error (`:213–216`).

Work: durable turn ID, client request key, lease/single active turn, append-only turn/round events and a deterministic transcript projection. Return 409 or an explicit queued response for a second turn. Persist partial text periodically; reconcile pending writes before resume. Emit one typed terminal result (`succeeded`, `cancelled`, `failed`, `outcome_unknown`), resumable event sequence and checkpoint. Session archive/scope changes need explicit behavior while a turn is active.

### 6. Context is a row cap, not a budget or memory strategy — P1

The window is always 32 rows and the round loop is 16 model calls (`chat.ts:38–39`). Tool results are bounded at 8,000 characters by slicing serialized JSON, without a stable artifact/read-more reference (`:120–135`). Large string-bearing results can still be resent every round, and slicing can break JSON. Images are read/base64 encoded per turn; up to ten attachments can contribute independent text limits, without a total context budget (`:360–392`; `schemas/chat.ts:25–27`). Only attachments supplied to the new request are rehydrated; historical message reconstruction does not include attachment references (`chat.ts:138–151`, `:184–193`). There is no compactor, structured summary, context usage report or caching policy.

Work: measure token headroom, prioritize stable contract/scope/pending ask/identifiers, pin tool-result groups, store bulky output as artifacts, and rehydrate attachments by checksum/reference. Use prune → structured summary → audit → continue with a persisted anti-thrash state and append-only lineage. Audit summaries mechanically for exact IDs, pending asks, limits and source references. Separate stable system rules, selected workspace/project and untrusted facts; do not lose authority or elevate a summary into an instruction.

### 7. Usage is incomplete and authorization differs — P1

`/api/usage` sees AgentRun only (`usage.ts:52–62`); chat, title, transcription, planning, review and compaction calls are invisible. Missing cost becomes zero (`:27–32`), hiding unknown billing coverage. `costBasis` exists in AgentRun but is not reported here (`schema.prisma:602`). The scope is run owner OR task team member, without the canonical project-deny predicate (`usage.ts:19–24`); `/by-task` then returns titles for those task IDs (`:154–170`). The daily list materializes each run and total group count materializes every task group (`:58`, `:148`). Runner usage capture on the old OpenCode path has per-message high-water logic, but can continue without an AgentRun record on persistence error (`sidecar/services/execution/agent-run.ts:43–48`).

Work: one append-only invocation/usage ledger, upsert by provider request + message ID, explicit delta-vs-cumulative semantics and provider/model/pricing-version/cost-source metadata. Unknown cost must remain unknown. Expose coverage and reconciliation status, known totals and conservative estimated bounds. Carry request→turn→plan→run→child→tool lineage. Apply canonical scoped task/project filters before all aggregates and labels; replace unbounded row materialization with bounded rollups after correctness.

### 8. Model/runner capability claims are not enforced — P1

API `/models` returns an unvalidated models.dev payload and fixed subset of capability claims; external fetch has no timeout, request coalescing or stale fallback (`routes/models.ts:10–26`). Sidecar runner listings use a different adapter path (`sidecar/catalogue/models-dev.ts:41`). Codex lists two hardcoded model strings and ignores `StartInput.model`, budgets, permissions and sandbox handle, choosing `workspace-write`/`never` (`runners/codex/index.ts:178–198`). It advertises reasoning deltas while decoding no reasoning-item event, and completed command events become `ok:true` without inspecting exit status (`:13–22`, `:82–84`). Interrupt/abort methods are no-ops (`:150–156`). OpenCode advertises fork/revert without corresponding public AgentSession methods; `compact` can silently do nothing if the optional SDK method is absent (`runners/opencode/index.ts:15–23`, `:215–217`; `execution-core/agent.ts:81–103`). The new coordinator defaults unknown runner IDs to OpenCode and hardcodes permission allow and a six-hour wall-clock budget (`run-coordinator.ts:32–35`, `:71–85`).

Work: separate static adapter capability, detected installed version, authenticated usable models and policy-allowed effective capability. Validate configuration at admission, fail closed on unsupported actions and unknown IDs, and record requested vs resolved model/runner. Provide stable list provenance, stale/error state and configuration revision. Verify adapters with captured SDK event fixtures and a controlled sample task before enabling their claims.

### 9. Execution prompt authority and normal call paths remain incomplete — P1 dependency

The current normal execution path still builds task title/description/labels directly into a user prompt and calls OpenCode (`services/execution/lifecycle.ts:218–260`). Batch prompts splice task descriptions directly too (`packages/execution-core/src/batch/prompts.ts:37`, `:58–77`). Even the new OpenCode runner puts its claimed system contract in a text part (`runners/opencode/index.ts:152–159`), so the contract is not in a privileged system channel and may be lost during backend compaction. The coordinator and runner selection must be integrated before PM dispatch can rely on them. Global OpenCode subscribe forwards nonterminal traffic even when a different direct session ID is identified (`:181–187`); nested part session IDs are not inspected (`:45–49`).

Work: unify actual execution through a tested runner coordinator, durable local journal, verified event demux, sandbox and policy adapter. Protect the contract in the supported runner system mechanism; carry task/issue/repo text as source-tagged data. Treat repository instructions as lower-priority guidance bounded by permissions. The parent audit covers the fuller execution lifecycle; this is a prerequisite to product agents, not a separate second execution engine.

### 10. Planning and MCP create partial records with inconsistent semantics — P1/P2

`SetupProjectPlanInput` has title/description/priority/status/labels/date/parentId only (`services/project-plan.ts:15–31`). Duplicate detection is title matching against existing active rows, not a versioned operation key (`:100–121`), and duplicates within one input or concurrent calls are not solved by that check. Labels, project date and bulk task creation happen in separate writes (`:158–207`); an error can leave a partial plan. MCP independently creates a project, resolves or creates a team, then per-phase labels and task batches (`mcp/tools/plan.ts:37–93`). Its per-phase catches return a normal result with errors (`:102–120`), so callers can get a success-shaped partial project and repeat to create another. It lacks preview/idempotency/acceptance/dependencies/estimates and plan revision.

Work: a single versioned plan domain operation used by chat, REST and MCP. Validate the complete graph before writes; apply transactionally where feasible, or expose a durable progress operation with explicit resumable partial status. A plan client key plus canonical spec hash must return the prior result; same key/different spec must return 409. Phase labels stay a compatible board projection, while dependency and acceptance semantics get their own records.

### 11. MCP parity and metrics are missing — P1/P2

MCP registers independently maintained workspace/project/team/label/phase/issue/plan tools (`mcp/server.ts:55–61`) rather than the chat catalogue. It has no execution start/status/cancel/evidence/review/approval operations. Its logging proxy measures client method names, not the outer MCP invocation; one bulk plan records many API calls, and awaits a logging HTTP request after each call (`:25–34`). Log failures are swallowed and read-only PATs may not authorize the mutating log endpoint. The shared client has no signal/timeout/request key contract (`packages/api-client/src/index.ts:44–58`). Chat requests ask for `chat:write` even though the PAT enum has no such creatable scope (`routes/chat.ts:176`; `packages/api-core/src/scopes.ts:2–12`); generic write/admin currently permit it. Do not claim a current limited `chat:write` scope exploit without evidence of legacy tokens.

Work: one schema/effect/authorization/idempotency/result catalogue exported to all transports, transport-specific adapters and an effective-capabilities endpoint. Do not blindly export every chat permission tool. MCP writes should return operation/approval IDs when needed and offer status/read/resolve tools; token scopes and owning principal remain enforced at the backend. Separate user invocation telemetry from internal HTTP spans; batch logging off the response path. A user-run external MCP client owns its own model billing: OpenLinear should meter internal calls and API tools, not invent the external model's cost.

### 12. Intelligence, scheduling and evals are not implemented — P2/P3

Search is case-insensitive substring matching, and the task branch omits selected workspaceId while project/team branches include it (`services/search.ts:21–49`). It returns authorized tasks from other selected-user workspaces, a scope drift rather than demonstrated outsider data access. It reconstructs JWT context rather than using the caller's bound principal (`:15–19`). Brainstorm/God Mode backend is not mounted in API or sidecar; voice exists as a separately configured Cartesia endpoint with bytes/time limits, no usage/quota/provider abstraction (`sidecar/app.ts:135–139`; `routes/transcribe.ts:8–10`, `:61–132`). Jobs are maintenance tasks, with no owner/time-zone/misfire/lease/budget contract for product AI work (`jobs/index.ts:4–12`, `:107–137`). Chat tests cover one happy-path tool loop and basic safety/permissions, not an injection corpus, compaction, stream fixtures or cost/quality eval gate (`__tests__/chat.orchestrator.test.ts:64`; `chat.tools.test.ts:52–218`). Telemetry records unbounded in-memory series and means; OTLP setup is a stub (`packages/telemetry/src/index.ts:23–26`, `:37–49`).

Work: fix current scoped search, then add local repo-aware evidence retrieval; durable schedule runs and local report artifacts; deterministic tests before model judges. Define capabilities accurately from backend availability. Integrate brainstorming into plan drafts after the provider/context/policy layer, rather than adding another independent model client.

## Backend delivery sequence

These are dependency-ordered slices, not fixed calendar estimates. Each closes a real user path and has observable exit evidence.

### B0 — Make existing operations truthful and safe

Dependencies: none beyond a dedicated disposable local test database. Ship the focused archive fix; strict raw tool args; abort-before-start checks; ambiguous-write reconciliation; canonical usage/search scoping; distinct chat terminal/EOF outcomes; runner model/capability contract checks. Do not rewrite the whole stack to fix these defects.

Exit evidence: malformed selector corpus causes no task mutation; repeated and simultaneous write requests reconcile to one domain effect; denied project data never appears in usage/search; truncated stream does not appear as complete; fake/recorded runner fixtures prove selected models and terminal states. API typecheck and relevant API tests pass against a loopback `*_test` database.

### B1 — Durable, measured chat and execution seams

Dependencies: B0 plus parent execution audit's coordinator/journal integration. Introduce `ai-core` incrementally at the provider seam with no Express/Prisma dependency, five-field usage ledger, local trace IDs, classified retries, bounded idle/absolute deadlines, turn lease, exact operation keys and event replay. Add bounded read-tool concurrency; sequential writes preserve order. Record first byte, first model token, first useful user-facing answer, each tool latency, queue delay and end-to-end completion separately. Report provider wait apart from local overhead.

Exit evidence: reconnect/restart/abort fixtures preserve partial output and never replay committed writes; 200-message/60-tool local conversation preserves valid groups; every internal invocation has a usage record or explicit `unknown` outcome; negative/missing/cumulative usage cases reconcile correctly; one active session turn enforced. Establish repeated local cold/warm distributions and sample counts before changing prompts or asserting savings. Baselines must disclose provider, model, context sizes, network conditions and hardware. Do not treat stub latency scripts as measurements.

### B2 — Context, artifacts, policy and approvals

Dependencies: B1. Add `ContextReport`, stable prompt blocks/hash, model headroom, result artifacts/read-more, attachment extraction cache, line/source citations, provenance tags and a structured compaction checkpoint. Add `ToolSpec` schema, effect, required scopes, target resolution, replay safety, policy version and transport exposure. Persist approval as its own operation; authorization only resumes a matching live request after fresh tenancy/resource validation. No approved shell command is substituted by the model after approval.

Exit evidence: large attachment and tool-output fixtures cannot overflow declared context budgets; summaries retain exact IDs, pending asks and explicit limits; repeated compaction avoids thrash; injection corpus cannot grant permissions or broaden target sets; approvals expire/reject/revoke/revalidate deterministically; unavailable capabilities fail explicitly.

### B3 — Plan v2: a validated, executable DAG with evidence

Dependencies: B1/B2 and a usable read-only local repo scan. Add an immutable `PlanVersion` with input goal/constraints, repository base commit and scan artifact, task node client keys, phase projection, expected outputs, scope/files/packages, acceptance criteria, validation command profiles, estimates as ranges/confidence, dependencies and review/risk notes. `TaskDependency` distinguishes `blocks` from advisory relation; do not reinterpret `parentId` as a dependency. Validate unique keys, all references, acyclicity, allowed cross-project edges and maximum graph size before applying.

Plan APIs: `POST /api/plans` creates a draft/spec revision; `POST /api/plans/:id/validations` produces graph/authorization/feasibility diagnostics; `POST /api/plans/:id/applications` materializes issues with an idempotent operation; `GET /api/plans/:id` exposes revision, graph and citations. Make MCP `bulk_create_plan` a compatible facade over this domain operation. Plan review/approval binds revision and target set; modifying the plan invalidates prior approval.

Each acceptance criterion has a stable ID, expected observable result, verifier kind (`command`, `artifact`, `human`, `review`) and whether it blocks completion. `AcceptanceEvidence` records criterion ID, attempt/base/head hashes, toolchain, command profile + arguments, cwd, timestamps, exit code, bounded stdout/stderr artifact hashes, result and runner. Record which checks were run versus omitted; never infer pass from a prose claim. Proposed checks from untrusted repository scripts run only inside the configured sandbox and policy.

Exit evidence: cyclic/unresolved/unauthorized DAG rejected; a retry materializes one plan; stale approvals fail; independent nodes can run while blocked ones cannot; failed/missing evidence cannot mark a task accepted. A small fixture repo proves plan→task→run→validation→evidence end to end before automatic scheduling. Human-readable citations and scope hashes make planning reviewable without frontend redesign.

### B4 — Planner, executor, verifier and reviewer with bounded feedback

Dependencies: B3 plus the actual local sandbox, coordinator and artifact/event journal. Use roles with distinct capabilities rather than one unrestricted PM agent. Planner has read-only repo/data access and produces a plan. Executor can edit only its admitted worktree. Deterministic verifier runs configured checks on the exact output commit. Reviewer sees read-only base/head diff and acceptance evidence; it emits structured findings with file/line, severity, supporting snippet/check and acceptance impact. A reviewer does not approve its own modified patch.

`PlanRun` references the approved plan revision. `RunAttempt` records a node/role/runner/model/config and links retry/fork parent. Durable scheduler dispatches ready DAG nodes using a dependency snapshot, max concurrency/worktree/disk/memory limits and file/branch conflict hints. Use one writer per shared repository state; dependency results propagate through verified artifacts/commits. Rebase/merge changes invalidate checks and review as needed. Keep combined execution as an explicit mode whose evidence still maps back to every selected criterion.

Initial loop: one planning pass, one execution attempt, deterministic checks, one review, one bounded repair attempt. Configurable quotas reserve budget before starting; child work inherits from the same plan allocation. Cap model calls/turns/elapsed time/tokens/estimated USD/tool retries/artifact bytes/parallelism and record why work stopped. No recursive reviewer chains. A different model/runner retry must be a recorded bounded decision; it cannot hide costs or reset quota. Unknown pricing requires token/time/concurrency hard limits and explicit cost coverage, rather than a promise of strict dollar enforcement.

Exit evidence: restart resumes ready nodes only; cancellation targets one attempt and its descendants; dependency failure blocks dependents; verifier failure leads to bounded repair then a clear outcome; reviewer precision is evaluated on planted defects; stale base/head invalidates evidence. Task execution success, review readiness and accepted completion are distinct statuses. Human policy decides whether a validated local change is published; no auto-merge is needed to deliver value.

### B5 — Memory and regression learning with provenance

Dependencies: B2/B4. Store explicit user preferences and accepted conventions as trusted memory with principal, source turn/statement, repo/workspace scope, version, confidence, expiry and tombstone. Session summaries, workspace digests and retrieved repo snippets are separate derived artifacts with lineage; they must not become instructions merely because summarized. Snapshot memory at run start so a mid-run write cannot silently change the execution contract.

On verified failure/repair, propose a `RegressionCase`: minimized input/fixture, exact failing check, observed bad behavior, approved remediation/evidence and producing base/head hashes. Deduplicate by error/criterion signature. Only promote confirmed cases into an eval/test corpus after review; retain applicability (repo/version/toolchain) and allow removal. A failed run or external comment cannot autonomously write policy or alter a skill. Suggestions to add tests, amend repo conventions or load a workspace skill remain provenance-backed proposals; accepted skill versions and content hashes are attached to runs.

Start with keyword/path/symbol retrieval plus indexed artifacts and ACL checks. Add hybrid semantic search/dedupe after ingestion quality, deletion propagation, source ownership and freshness work. Similarity yields a suggestion, never an automatic issue merge. Evaluate recall and tenant/scope isolation using known fixtures before embedding production content.

Exit evidence: tool-output injection cannot write trusted memory; deletion/tombstones remove future retrieval; revoking project access removes that source; two repos' conventions cannot cross; regression promotion is traceable and demonstrably catches a known failure without memorizing a judge answer.

### B6 — Useful local product intelligence and schedules

Dependencies: B4/B5. Add event-derived task outcomes and workspace digest drafts, local on-demand diff review, triage/duplicate candidates, budget forecasts, stale-task/blocked-dependency explanations and plan refinement suggestions. Generate summaries from recorded evidence off the task's completion path. Voice/brainstorming share provider accounting, content quotas, structured outputs and plan-draft admission.

Persist `Schedule` and `ScheduleRun` locally with owner, workspace/repo, timezone, rule, capability revision, budget, allowed effects, pause/cancel state, misfire policy, next occurrence, dedupe key and lease. A local machine being asleep/offline is an explicit `missed/deferred` result; define catch-up behavior and expose local availability. Defaults draft/read-only; writes, publication and permissions require the same approval contract. Start with schedules such as weekly backlog-plan draft, read-only open-change review and nightly local regression check. A schedule owner losing access cancels future admission and removes inaccessible context.

Exit evidence: DST/misfire/restart fixtures run one occurrence; overlapping runs do not stack unbounded work; paused/revoked schedules do not dispatch; reserved quotas bound catch-up; outputs are local artifacts linked to evidence. No email/Slack/Teams sending or cloud execution is required by this local scope.

### B7 — MCP parity and transparency

Dependencies: B2–B6 as capabilities become real, rather than one late wholesale replacement. Export effective tool schemas from the shared catalogue; offer plan draft/validate/apply, execute operation, status/events, cancellation, evidence/report, review, schedule and memory read/delete APIs with appropriately narrow scopes. Expose tools only when backend capability is usable and allowed. Apply the identical principal/effect/approval/argument-hash contract in chat, MCP and direct API routes.

Create a per-run report from the journal: what source files/artifacts it read (to the extent the adapter observed them), exact base/head and diff, checks/results, policy/approvals, model/usage/cost coverage and unresolved findings. Do not claim exhaustive read tracking if the runner cannot observe all reads. Local transcript export uses explicit allowlists/redaction and artifact retention; internal/public sharing is a separate later publishing action, not a prerequisite for local orchestration.

Exit evidence: contract snapshots detect schema drift; equivalent authorized requests produce equivalent domain results on all transports; denied scopes do not leak through another transport; progress is resumable and tool telemetry counts the outer invocation once. Exports omit secrets/untrusted instruction escalation and disclose unknown billing/observability coverage.

## Deterministic verification and eval design

Use three layers. First, replayable deterministic checks for graph cycles, scoped queries, selector semantics, idempotency, policy/approval expiration, quota reservations, cancellation isolation, event ordering, truncated provider streams, summary identifier preservation and evidence state transitions. Second, captured provider/runner fixtures plus a small disposable local repository for actual plan/run/evidence/restart flows. Third, a small opt-in model eval set for tool choice, plan decomposition, review precision and summary recall, with pinned prompt/tool/model/config/input hashes and disclosed variability/cost. Keep provider network calls out of ordinary unit tests.

Measure tool choice and argument validity, source-grounded factuality, mutation count, fulfilled acceptance criteria, useful answer latency, review precision/recall and repair success within the allotted budget. A judge produces advisory scores; deterministic verifiers and authorized humans decide safety/completion. Keep golden development examples separate from held-out cases; seed failures that previously escaped and audit false positives. Expand datasets from reviewed regression cases. No proposed numeric quality or latency target is a current benchmark result.

## UI contract dependencies only

No frontend implementation is proposed here. Backend clients will eventually need: effective capability/config/error metadata; typed queued/running/verifying/reviewing/accepted/failed/cancelled/unknown statuses; exact approval request/expiry/diff data; resumable event cursor and partial text; plan revision/DAG diagnostics; acceptance criterion/evidence links; context section usage and compaction state; cost coverage/source/reservation; memory provenance/delete results; schedule next occurrence/missed state/local availability; and artifact/read-more/report references. Existing UI may consume incremental additive events while later presentation work is separately scoped.

## Priority recommendation

Finish the safety/terminal/authorization contracts and integrate the execution coordinator before adding a broad autonomous PM tool. Deliver measured durable chat, then executable plans and deterministic evidence, then bounded review/repair, then memory/schedules. This preserves the revamp plan's useful goals while replacing its unproven time/cost promises and platform assumptions with reviewable local behavior.
