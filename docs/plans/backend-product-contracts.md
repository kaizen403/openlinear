# Backend product contracts

**Status:** Proposed requirements, 2026-10-15; implementation proceeds by work package.
**Scope:** Local agent orchestration, chat, planning, verification and product intelligence.
This document specifies intended behavior. It does not claim these capabilities exist today.
Existing task, project, chat and AgentRun routes remain compatible while new contracts are added.
The current archive selector correction is a safety fix; broad status operations keep their separate semantics.
Implementation evidence and current defects belong in the master backend plan and `ISSUES.md`.
Master requirements: [backend agent platform PRD](../../tasks/prd-backend-agent-platform.md).
The master's W00–W21 packages reference these B0–B7 contracts; identifiers here do not imply independent delivery.

## Delivery order and dependencies

| Package | Deliverable | Admission dependency |
| --- | --- | --- |
| B0 | Truthful existing operations, strict destructive selectors, canonical authorization | Disposable local test database |
| B1 | Durable ChatTurn, invocation ledger, replay, measured provider seam | B0; integrated execution coordinator/journal |
| B2 | Effect-aware tools, exact approvals, context/artifact budgets | B1; supported local sandbox/policy adapter |
| B3 | TaskSpec, immutable PlanRevision DAG and acceptance manifest | B1–B2; read-only repository scan |
| B4 | Bounded planner/executor/verifier/reviewer and repair | B3; usable runner contract and isolated worktrees |
| B5 | Provenance memory, reviewed regression reuse and retrieval | B2–B4 |
| B6 | Local schedules, digest/triage/review/plan drafts | B4–B5; durable occurrence journal |
| B7 | API/CLI/MCP parity, reports, retention and export/delete | Incremental after each underlying capability |

Each package must close a working user path with evidence before advertising its capability.
Model/provider versions and prices are configuration snapshots validated at implementation time.
No fixed cost reduction, quality score or latency improvement is assumed from the historical revamp plan.

## Shared admission, authorization and operation contract

```ts
type Principal = {
  userId: string; authSource: 'session' | 'pat' | 'local_pairing';
  credentialId: string; workspaceId: string; scopes: string[];
  deviceId?: string; authRevision: string;
};
type Operation = {
  id: string; kind: string; principalId: string; workspaceId: string;
  requestKey: string; argsHash: string; contractVersion: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'succeeded'
    | 'failed' | 'cancel_requested' | 'cancelled' | 'outcome_unknown';
  resultRef?: string; error?: { code: string; message: string; details?: object };
  lastSeq: number; createdAt: string; endedAt?: string;
};
```

The server derives the principal from verified credentials; model arguments cannot set it.
Every domain command checks scopes **and** current workspace/project/task access, including explicit deny.
Background work retains initiating identity but revalidates access before admission, writes and result delivery.
Local pairing establishes transport identity; it does not replace authorization of project data or actions.
New scopes are closed, documented and transport-independent; generic legacy scopes retain defined compatibility.
Request IDs, task IDs and external runner session IDs are distinct and never interchangeable.

Mutating new APIs accept `Idempotency-Key`, scoped to principal, workspace and operation kind.
Equal key plus equal canonical arguments returns the same operation; different arguments return `409 IDEMPOTENCY_CONFLICT`.
Database effect, operation receipt and domain event commit atomically where they share a database.
External effects use persisted intent and reconciliation; an interrupted response is not proof the effect failed.
Retry an external effect only when its provider key or reconciled state proves replay is safe.
Validation errors use the existing `{ error, code, details? }` envelope; never return raw provider stacks.
`202` means admitted/queued, `201` means resource created, and a terminal result has an explicit status.
`GET /api/operations/:id` exposes scoped status; `GET .../:id/events?afterSeq=N` replays durable events.
`POST .../:id/cancellations` idempotently requests cancellation and returns the operation state.
Cancellation removes queued work, stops new tool starts and propagates to descendants/provider/processes.
Fences prevent new effects; already-dispatched external requests may still commit and require reconciliation.
Cancellation does not guarantee rollback; expose retained effects, unresolved requests and cleanup outcomes.
Do not report `cancelled` as proof no external effect occurred; retain `outcome_unknown` when reconciliation cannot establish it.
An already-aborted call cannot start its handler. A commit racing cancellation is reconciled as a known effect.

## B0 — Existing actions must not broaden or invent success

Archive requires an explicit, nonempty validated selector set after normalization; malformed members reject the whole request.
Blank, mixed invalid, null and empty selectors must never become an unfiltered query.
Deduplication of valid IDs and trimmed case-insensitive identifiers remain supported within the selected project.
Bulk status operations that intentionally support all tasks remain explicit documented operations; do not infer that mode from invalid input.
Future broad mutations resolve a bounded preview with exact target IDs and revisions before policy approval.
Timeout/abort after a write begins yields reconciliation or `outcome_unknown`, not an unconditional retry hint.
Provider EOF, output truncation, invalid tool JSON and failed commands cannot produce completed-success claims.
Runner admission records requested/resolved runner and model and rejects unsupported capabilities or unknown runner IDs.
Existing usage/search scopes must use the same project-deny rules as their source records.

## B1 — Durable chat, context and usage

```ts
type ChatTurn = {
  id: string; sessionId: string; requestKey: string; principalId: string;
  scopeSnapshot: { workspaceId: string; projectId?: string; revision: string };
  status: Operation['status']; parentTurnId?: string; kind: 'message' | 'summary';
  promptHash: string; toolsHash: string; configHash: string; memorySnapshotId?: string;
  lease: { holder: string; generation: number; expiresAt: string };
  nextRound: number; lastSeq: number; partialTextRef?: string;
  checkpointRef?: string; budgetReservationId: string; operationId: string;
};
type TurnEvent = {
  turnId: string; seq: number; at: string; version: 1;
  type: 'text.delta' | 'tool.started' | 'tool.finished' | 'approval.requested'
    | 'context.report' | 'compaction' | 'usage' | 'terminal'; payload: unknown;
};
```

One active turn per session is enforced by a durable lease; a second request queues explicitly or receives `409 TURN_ACTIVE`.
Lease generation fences stale workers. Persist checkpoints/partial text before replayable event delivery.
Stable tool IDs derive from turn/round/index; client retries reuse the turn instead of allocating another user message.
Crash recovery reconstructs complete assistant/tool-result groups and reconciles pending write receipts.
SSE event IDs encode stream identity and sequence; reconnect replays after the last received event.
Legacy chat SSE event names remain available through an adapter; `done` remains an end-of-stream marker, not proof of success.
There is exactly one authoritative terminal outcome; clients can retrieve it after losing the HTTP connection.
Scope changes during a turn require a new snapshot or rejection; never quietly mix two projects' authority.

`ContextReport` records tokens/bytes per contract, scope, memory, history, tool output and attachment section.
The usable budget subtracts reserved output and a safety margin from the selected model's supported context.
Tool groups, current ask, constraints and exact entity IDs survive windowing; large output becomes a referenced artifact.
`read_more` applies source authorization and a bounded byte/token range rather than reinserting the whole result.
Attachments are checksum-addressed, extraction-cached and rehydrated by reference across turns.
Compaction appends a structured summary/checkpoint with goals, decisions, pending asks, IDs and source references.
Mechanical audit rejects lost identifiers/constraints; cooldown and ineffective-compaction state prevent repeated thrashing.
Summaries remain derived data and cannot elevate tool/file instructions into trusted policy.

```ts
type UsageEntry = {
  id: string; invocationId: string; providerRequestId?: string; messageId?: string;
  principalId: string; workspaceId: string; turnId?: string; planRunId?: string; attemptId?: string;
  role: string; provider: string; model: string; pricingRevision?: string; traceId: string;
  tokens: { input: number | null; output: number | null; cacheRead: number | null;
    cacheWrite: number | null; reasoning: number | null };
  accounting: 'delta' | 'message_total' | 'request_total'; rawUsageRef?: string;
  cost: { usd: string | null; basis: 'reported' | 'list_estimate' | 'managed' | 'unknown';
    coverage: 'complete' | 'partial' | 'unknown' };
  status: 'pending' | 'observed' | 'reconciled' | 'unknown'; at: string;
};
```

Meter chat, titles, plans, compaction, retries, reviews, transcription and coding children, including failed calls when usage is available.
Retain provider token semantics; normalize cache/reasoning overlaps without double counting or summing incompatible snapshots.
Upsert cumulative observations by provider/message identity; replay cannot increase totals twice.
Unknown usage/cost stays null; reports separate known totals, estimates and uncovered invocations.
Reserve budget before a call and reconcile afterward; children share the parent allocation and cannot reset it through retries.
Enforce per-request output, call/turn, time, concurrency and byte caps only where the adapter/supervisor can prove enforcement.
Aggregate token/USD budgets use conservative reservations and declared stop/overshoot semantics; usage may arrive after consumption.
Keep missing provider usage unknown and admit or reject by conservative policy; unknown totals never silently become zero.
Strict aggregate token/USD ceilings require a proven upper bound, rather than a polled watchdog guarantee.
MCP tool telemetry counts tool invocations; external MCP clients' own model billing is outside OpenLinear's ledger.
Local metrics distinguish queue wait, context assembly, provider first token, useful answer, tool time and completion.
Record distributions, sample counts, cold/warm state, fixture size, hardware and provider context before setting performance gates.

## B2 — Effect-aware tool registry and approval

```ts
type ToolSpec = {
  name: string; version: string; inputSchema: object; outputSchema: object;
  effect: 'read' | 'write' | 'destructive' | 'permission' | 'publish';
  requiredScopes: string[]; transports: Array<'chat' | 'api' | 'cli' | 'mcp'>;
  replaySafety: 'idempotent' | 'receipt_required' | 'never'; timeoutMs: number;
  capabilityRequirements: string[]; resolveTargets: string; handlerId: string;
};
type Approval = {
  id: string; operationId: string; principalId: string; workspaceId: string;
  toolVersion: string; policyVersion: string; argsHash: string; targetSetHash: string;
  resourceRevision: string; decision: 'pending' | 'allow' | 'deny' | 'expired'; expiresAt: string;
};
```

One registry owns runtime validation, effect, scope, result format and transport exposure; adapters do not duplicate business rules.
Policy produces `allow`, `require_approval` or `deny` from principal, effect, provenance and exact targets.
Permission/publish tools remain unavailable until their approval and credential boundaries are implemented.
Approval is an authenticated human decision binding canonical arguments, revisions and expiry; model narration is not consent.
Fresh access/policy/target checks run when resuming; changing args or plan revision invalidates prior approval.
Repository/tool/web text uses source-tagged untrusted envelopes; tags and summaries are escaped consistently.
Bounded reads may run concurrently; writes are ordered, journaled and committed under the operation receipt contract.
Tool results carry truncation/artifact references, error class and replay-safety status; raw malformed args never degrade to `{}`.
Effective capabilities combine adapter support, installed version, credential readiness and policy; unsupported actions fail explicitly.

## B3 — TaskSpec, immutable plan DAG and acceptance manifest

```ts
type AcceptanceCriterion = {
  id: string; statement: string; blocking: boolean;
  verifier: { kind: 'command_profile' | 'artifact' | 'human' | 'review'; profileId?: string };
  expected: { result: string; artifactKind?: string }; sourceRefs: string[];
};
type TaskSpec = {
  key: string; taskId?: string; title: string; goal: string; constraints: string[];
  scope: { repoId: string; paths: string[]; packages: string[]; forbiddenEffects: string[] };
  acceptance: AcceptanceCriterion[]; outputs: Array<{ kind: string; description: string }>;
  estimate: { range: [number, number]; unit: 'minutes'; confidence: 'low' | 'medium' | 'high' };
  sourceRefs: string[]; preferredRunner?: string; modelRole?: string;
};
type PlanRevision = {
  id: string; planId: string; revision: number; parentRevisionId?: string; specHash: string;
  workspaceId: string; projectId: string; createdBy: string; goal: string; constraints: string[];
  repoSnapshot: { repoId: string; baseCommit: string; scanArtifactId: string };
  nodes: TaskSpec[]; edges: Array<{ from: string; to: string; kind: 'blocks' | 'advisory' }>;
  acceptanceManifestHash: string; sourceRefs: string[];
};
```

A revision's content is immutable; changing nodes, edges or criteria creates a new revision and invalidates stale approval.
Validate unique node/criterion keys, referenced nodes, acyclicity of blocking edges, size bounds and authorized repository/project scope.
`parentId` remains task hierarchy; dependency edges are separate and must not be inferred from issue order or phase labels.
Phase labels remain a compatible board projection; PlanRevision stores executable dependency/acceptance meaning.
Draft planning uses a read-only scan pinned to a repository commit; uncertain claims carry confidence and file/line sources.
Applying a revision validates the whole input, assigns stable node→Task IDs and records an idempotent application receipt.
Prefer a transaction for project/labels/tasks/edges; larger or external operations expose explicit resumable partial state.
Title matching alone is not plan idempotency. A repeated application returns the original mapping, not another project.
Legacy `openlinear_bulk_create_plan` preserves its result shape through a facade and exposes additional revision/operation metadata additively.

## B4 — Evidence, bounded roles and review/repair

```ts
type RunAttempt = {
  id: string; planRunId: string; nodeKey: string; role: 'planner' | 'executor' | 'verifier' | 'reviewer';
  parentAttemptId?: string; runner: string; model: string; configHash: string;
  baseCommit: string; headCommit?: string; worktreeId: string; budgetReservationId: string;
  state: 'queued' | 'running' | 'verifying' | 'reviewing' | 'ready' | 'failed' | 'cancelled';
};
type EvidenceBinding = {
  id: string; criterionId: string; attemptId: string; manifestHash: string;
  baseCommit: string; headCommit: string; issuedBy: string; issuedAt: string;
  outcome: 'pass' | 'fail' | 'not_run' | 'inconclusive'; sourceRefs: string[];
};
type AcceptanceEvidence = EvidenceBinding & (
  | { kind: 'command_profile'; profileId: string; argv: string[]; cwd: string;
      environmentHash: string; toolchainHash: string; startedAt: string; endedAt: string;
      exitCode: number | null; stdoutArtifactId?: string; stderrArtifactId?: string }
  | { kind: 'artifact'; artifactIds: string[]; outputHashes: string[];
      validatorId: string; validatorRevision: string; validationReportId: string }
  | { kind: 'human'; principalId: string; attestationId: string; statement: string }
  | { kind: 'review'; reviewId: string; reviewerAttemptId: string;
      findingIds: string[]; disposition: 'open' | 'accepted' | 'dismissed' }
);
type ReviewFinding = {
  id: string; attemptId: string; headCommit: string; path: string; line: number;
  severity: 'critical' | 'high' | 'medium' | 'low'; explanation: string;
  evidenceRefs: string[]; criterionIds: string[]; disposition: 'open' | 'accepted' | 'dismissed';
};
```

Planner reads/produces drafts; executor writes its admitted worktree; verifier runs configured checks; reviewer reads diff/evidence.
Checks proposed by repo/model text run only inside the admitted sandbox with approved command profiles and bounded output/time.
Model claims never substitute for exit codes, generated artifacts, human acceptance or recorded skipped checks.
Evidence is tied to exact head and manifest; command evidence also binds environment. Editing/rebasing invalidates affected checks and review.
Each evidence kind must match its criterion; verified issuer identity and exact snapshot binding apply to all kinds.
Human attestations and review dispositions require scoped authorized decisions, not invented command receipts or model self-approval.
Task execution success, ready-for-review and accepted completion are separate facts; legacy status fields use an explicit projection.
Initially admit one planning pass, one execution, deterministic verification, one review and at most one repair attempt.
Configure maximum attempts/children/concurrency/turns/tokens/time/USD/bytes; nested agents cannot acquire unrestricted budgets.
Only DAG-ready nodes dispatch; dependency failure blocks dependents and records the cause. Advisory edges do not block.
Use unique worktrees, repository locks and conflict hints; never permit concurrent writers to the same working tree.
Resume/cancel tracks attempt ancestry; cancelling one node does not abort unrelated runs.
Review findings create proposed follow-up TaskSpecs linked to criteria/evidence; applying them is an authorized domain operation.
Do not automatically merge/publish a patch because a reviewer approves it; external effects use B2 policy.

## B5 — Memory and regression reuse

`MemoryRecord` stores scope/repo/user, category, content hash, source principal/turn/statement, version, expiry and tombstone.
Trusted preferences/conventions originate in explicit user statements or user-accepted proposals; tool output cannot write trusted memory.
Digests, session summaries and extracted repo facts are derived artifacts with source lineage, not policy-bearing memory.
Runs freeze a memory snapshot; concurrent changes take effect only in a new admitted snapshot.
Read/delete/export operations recheck source ACLs; revoked project content cannot remain retrievable through summaries/embeddings.
`RegressionCase` links minimized fixture, failing criterion/check, failure signature, producing commits and verified repair evidence.
Promotion into reusable tests/evals requires review; record applicability by repo/toolchain/version, false positives and removal reason.
Failed runs or external comments may propose cases/skills, but cannot silently rewrite policy, tests or trusted conventions.
Versioned workspace skills carry content hashes and provenance, explicit allowed capabilities and the same effect policy.
Begin retrieval with scoped keyword/path/symbol/artifact indexes; embeddings and duplicate suggestions follow ingestion/deletion correctness.
Similarity is advisory; issue merging is a separate exact-target operation with an auditable decision.

## B6 — Local schedules and product intelligence

`Schedule` stores owner, workspace/repo, timezone, rule, task template/plan revision, allowed effects, budget and pause state.
`ScheduleRun` stores unique occurrence key, scheduled/actual times, lease generation, operation and terminal/missed outcome.
Define daylight-saving behavior and `skip`, `run_once` or bounded catch-up misfire policy; sleeping/offline devices are visible states.
Occurrence uniqueness prevents duplicate dispatch after restart; overlap limits prevent unbounded backlog accumulation.
Revalidate owner's credentials/access/capabilities before each occurrence; pause/revocation stops admission.
Draft/read-only defaults apply to weekly plan drafts, local diff review, evidence-derived digests and regression checks.
Scheduled writes/publication need the same target approval; a schedule is not permanent unlimited consent.
Brainstorming yields structured plan drafts; triage/dedupe yields proposals; voice uses shared usage/time/size quotas.
Digest/outcome generation happens off completion's critical path and cites changes, checks, blockers and cost coverage.

## B7 — API/CLI/MCP parity, retention and lifecycle

| New API outline | Shared CLI/MCP command semantics |
| --- | --- |
| `POST /api/plans`; `POST /api/plans/:id/revisions` | Create draft / append immutable revision |
| `GET /api/plans/:id?revision=N` | Read scoped immutable revision, sources and graph |
| `POST /api/plans/:id/validations`; `.../applications` | Validate graph / idempotently apply exact revision |
| `POST /api/plan-runs`; `GET /api/plan-runs/:id` | Admit approved plan / inspect DAG attempts |
| `POST /api/chat/sessions/:id/turns`; `GET .../turns/:turnId` | Durable chat admission / inspect turn |
| `POST /api/approvals/:id/decisions` | Resolve authenticated matching live approval |
| `GET /api/attempts/:id/evidence`; `.../reviews`; `.../report` | Read verified artifacts and unresolved findings |
| `POST /api/schedules`; `PATCH /api/schedules/:id` | Create scoped schedule / pause or update new revision |
| `GET /api/memories`; `DELETE /api/memories/:id` | Inspect provenance / tombstone trusted memory |
| `POST /api/exports`; `POST /api/deletion-requests` | Produce redacted scoped archive / tracked deletion |

All transports call identical domain commands with strict schemas, principal checks, receipt keys and error codes.
CLI JSON and MCP structured results expose operation IDs and terminal status; asynchronous writes are never reported as completed.
MCP exposes only usable, scoped capabilities; approval-required commands return an approval ID and status/read follow-up.
Existing routes/CLI commands/tool names retain shapes and meaning; new metadata is additive or opt-in by contract version.
Snapshot tests compare transport schemas/results; old clients must still create/list/update issues after rollout.
Public sharing and external notifications are separate publish capabilities, disabled in this local delivery scope.

Retention policy covers transcripts, tool args/results, attachments, run artifacts, evidence, usage and regression fixtures by category.
Persist per-artifact owner/scope/checksum/size/expiry and source links; redact secrets before log/export content capture.
Export is a scoped operation with redaction manifest and explicit coverage; unavailable read tracking is disclosed, not invented.
Deletion immediately tombstones retrieval, cancels relevant queued work and invalidates memory/embedding/artifact projections.
Purge local blobs/indexes and derived artifacts, record completion/failures, and disclose minimal retained receipt/audit fields and expiry.
Deletion must not leave copied prompt text retrievable in compaction summaries or regression fixtures; provenance drives propagation.
Referenced evidence may become unavailable after retention; report that state instead of preserving hidden copies indefinitely.

## Acceptance evidence required at each gate

| Gate | Observable check |
| --- | --- |
| B0 | Blank/mixed malformed selectors mutate zero tasks; denied projects appear in zero scoped results |
| B1 | Simultaneous/retried requests create one turn/effect; crash/reconnect replays stable sequence and terminal outcome |
| B1 usage | Duplicate cumulative usage does not double count; every invocation has observed or explicit unknown coverage |
| B2 | Injection cannot widen targets/grant permissions; expired/stale/altered approvals never dispatch writes |
| B2 context | 200 messages/60 tool calls keep valid groups; compaction retains pending ask, constraints and exact IDs |
| B3 | Cycle/unresolved edge rejected; repeat application returns same mapping; stale revision approval rejected |
| B4 | Failed/not-run blocking checks cannot accept task; head change invalidates evidence; repair budget ends deterministically |
| B5 | Tool text cannot write trusted memory; revoke/delete removes derived retrieval; approved case catches known regression |
| B6 | Restart/DST/misfire produces one bounded occurrence; paused/revoked schedules dispatch zero new attempts |
| B7 | API/CLI/MCP equivalent requests share effects/errors; exports redact secrets; deletion covers all indexed derivatives |

Use deterministic fixtures and a disposable local repository first; model quality evals are opt-in, metered and versioned.
Separate development examples from held-out cases; judge scores are advisory and do not override policy/evidence.
Record measured latency/quality/cost with fixture/model/config hashes; proposed targets are not reported as achieved benchmarks.

## Boundaries and related documents

No frontend implementation, desktop styling, cloud execution, infrastructure deployment or production rollout is specified here.
Future clients need capability/status/approval/event/evidence/cost/context/memory/schedule contracts; presentation remains separately scoped.
Local runner isolation and recovery are prerequisites documented in the master execution plan, not replaced by product-agent prompts.
Related evidence: [work log](../../ISSUES.md), [codebase index](../CODEBASE_INDEX.md), [performance plan](../PERFORMANCE_IMPROVEMENT_PLAN.md).
Current audit: [AI product findings](../reports/backend-review-2026-10-15/ai-product.md), [codebase context](../reports/backend-codebase-context-2026-10-15.md).
Historical review: [performance audit](../reports/performance-codebase-review-2026-06-04.md); verify findings against current code before action.
Deferred user-owned scopes: [frontend work](</Users/sriharsha/Downloads/frontend work pending.md>) and [cloud services](</Users/sriharsha/Downloads/OpenLinear cloud services pending.md>).
