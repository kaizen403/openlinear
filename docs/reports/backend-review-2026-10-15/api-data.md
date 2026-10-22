# OpenLinear API/data audit — 2026-10-15

> Source evidence includes the pre-fix audit. Read [consolidated validation](validation.md) for final repairs, tests and remaining scope. Audit line references may precede the local edits.
Scope: backend API/data code and local verification only. No frontend, deployment/cloud implementation, live database access, or credentials. Evidence below is static source inspection; no measured p95 claim is made. Root agent owns ISSUES.md. Read AGENTS.md, relevant ISSUES.md entries (September foundations/execution and October implementation audit), local Prisma/performance skills, Phase 1 platform foundations, and docs/PERFORMANCE_IMPROVEMENT_PLAN.md. No applicable revamp plan exists under .sisyphus/plans; the supplied external Phase 1 plan is the relevant source.

## Module inventory

| Area | Source and current state |
| --- | --- |
| HTTP composition | apps/api/src/app.ts; ~30 route files, pino-http, JSON 256 KB cap, local express-rate-limit, health/error mapping |
| Identity/security | middleware/auth.ts; lib/auth-tokens.ts; services/{sessions,pats,totp,sso}.ts; auth/users/totp/sessions/pats/sso routes |
| Tenancy | tenancy/{context,policy,scopes,types}.ts; ownership.ts and workspaces.ts remain parallel public authorization surfaces |
| Task aggregate | routes/tasks.ts, schemas/tasks.ts, services/tasks.ts; route/chat creation now shared, update paths still duplicated |
| Hierarchy/members | projects/teams/workspaces/members/labels/invitations routes and services; aggregate module files are re-export facades |
| Reads/reporting | search/inbox/activity/dashboard/usage/agent-runs/mcp-usage; several scopes and aggregations remain divergent |
| Realtime | events/{outbox,relay,bus,hub,types}.ts, routes/events.ts, sse.ts; domain outbox + separate agent journal and incompatible SSE cursor forms |
| Jobs | worker.ts, jobs/index.ts; interval maintenance and optional pg-boss both started; many promised job types absent |
| Data | packages/db/prisma/schema.prisma + migrations + manual indexes; Prisma adapter-pg lazy singleton in packages/db/src/client.ts |
| Contracts | packages/api-core, api-client; route registry manually maintained, not generating route wiring/client schemas |
| Observability | logger.ts + pino-http; packages/telemetry stores unbounded arrays, no exporter or route metric calls |
| Other backend | chat/attachments/uploads/repositories/models/settings/notifications; inspected relevant routing dependencies, not an exhaustive security audit of these modules |

## Highest-priority correctness findings

### A01 — Run journal replay bypasses authorization (critical; focused fix selected)

apps/api/src/routes/events.ts:137–152 accepts a caller-chosen run:{runId}:{seq} Last-Event-ID and reads agentRunEvent by runId with no assertion on its task/project. Any authenticated user who knows a run UUID can retrieve its persisted payloads, including a user explicitly denied its project. Ownership is enforced in regular run reads (routes/agent-runs.ts:99–101) but not this stream path.

Fix: resolve run.taskId and assertTaskAccess(taskId, userId, 'view') before opening headers/registering stream or reading events. Missing run should fail without payload; unauthorized caller receives the normal ownership envelope. Tests: unrelated authenticated user, same-workspace denied project, authorized owner/read-only viewer, nonexistent run, and verify no stream registration/payload on rejection. This does not solve live hub audience leaks below.

### A02 — Run progress accepts read-only resource permission (high; focused fix selected)

routes/agent-runs.ts:189 requires PAT tasks:write but :203 asserts resource access 'view'. A JWT with only view project access can submit arbitrary run journal records, and upsert :220–223 rewrites an existing sequence payload/type. Require 'full' resource access. Later harden writer identity/run ownership, immutable sequence records, ordered/batched ingest, nonnegative usage, terminal-state transitions and replay-safe duplicates. Gate: view-only and denied/unrelated users cannot ingest, owner can; denied writes leave journal/outbox unchanged.

### A03 — Live/replayed domain events bypass project deny (critical; remaining)

events/hub.ts:81–85 uses union of user/team/workspace audiences. sse.ts:58–74 broadcasts project events to every workspace member plus every project team, with no subtraction of explicit deny. sse.ts:83–85 broadcasts task payloads by team only. replaySince in events/outbox.ts:132–149 applies the same broad array membership union. These routes can disclose task/project data while HTTP scopedProjectWhere rejects it. broadcastToChatSession at sse.ts:123–130 also sends owner-session events to the entire workspace; evaluate against chat's owner/private visibility.

Add explicit resource metadata (projectId/taskId/privacy) to events, scope live/replay through one policy, and fail closed for legacy events that cannot be authorized. Audience is a routing hint, not an authorization decision. Membership refresh at hub.ts:99–105 is async after delivery and carries no project grants; it cannot repair this. Gate: no event to an explicitly denied user across live, reconnect, grant change, member removal, run progress, and private chat.

### A04 — PAT workspace restriction is stored but not enforced (high)

schema.prisma:312–313 stores PAT.workspaceId. services/pats.ts:42–48 does not select it, PatClaims :9–13 has no workspace constraint, middleware/auth.ts:121–125 passes only user/scopes and tenancy/context.ts:52–65 loads all user memberships. A scoped token therefore authorizes all the user's workspaces according to its action scopes. When a workspace is deleted, onDelete:SetNull would also convert a constrained token into an unconstrained one if null means account-wide. Carry workspace binding throughout auth and every resource/list scope, and revoke constrained PATs on workspace deletion. Gate: same user owns workspace A/B but A-token cannot read/write B, including aggregate/read/reporting and sidecar routes.

### A05 — Remaining HTTP tenancy drift (high)

usage.ts:19–24 scopes runs by user or team, not project access; by-task :154–159 then returns task title/identifier from those runs. teams.ts service :55–61 and routes/teams.ts:75–82 use team membership without project deny. workspaces.ts:244–259 includes every project in details with no project-grant filter; :323–348 structure includes all project/team/member trees. ownership.ts:211–219 allows a comment author or any team member without checking project permission. Its DELETE consumer at routes/comments.ts:253–264 then checks only author or team owner/admin: a denied project team admin can delete others' comments. PATCH comments.ts:206 checks only author, allowing the author to mutate after losing project access. These are counterexamples to Phase 1's claimed sole scoped authorization surface.

Gate: generated resource/role/scope matrix must include nested payloads, counts, historical runs, deny overriding ownership, and post-removal access. Use correlated scoped predicates before selects/counts/aggregates; avoid filtering already loaded data.

### A06 — Outbox is not transactional by construction (high)

Search for emitOutbox calls finds only definition and persistAndDeliver calling with global Prisma, not a domain mutation's tx. tasks.ts:175–200 commits task before broadcast :203; :310 update and :312 broadcast likewise. sse.ts:30 fire-and-forgets outbox persistence. outbox.ts:107–111 falls back to local event when persistence fails. Process death after mutation or failed outbox write yields a committed mutation with no durable replay. Event failure can be hidden while HTTP returns success.

Move mutation + journal/outbox + required audit records into one transaction. Relay after commit; external notifications/jobs should be transactional queue commands or durable event consumers. Gate: transaction rollback has zero events; crash at each commit/publish boundary preserves eventual replay and domain state.

### A07 — Relay has duplicate claims, local fallback marks distributed delivery complete (high)

outbox.ts:154–173 uses FOR UPDATE SKIP LOCKED on global $queryRaw; relay.ts:12–15 publishes after the query completes with no retained transaction/lease. Independent relays can claim the same rows. publishOutboxEvent :72–77 falls back locally if Redis publish fails then marks published, permanently preventing later cross-process delivery retries. Redis bus receives no consumer acknowledgement; an at-least-once contract and dedupe are needed. API index.ts:22 plus worker.ts:15 both start relays.

Use bounded leased claims with atomic compare-and-set / retained transaction as appropriate, attempts/lease/error fields and retry backoff. A local-only mode must not claim distributed delivery succeeded. Gate: concurrent relays, Redis unavailable/recovered, duplicate publish, crashed claimer, and nondecreasing client cursor.

### A08 — Reconnect and backpressure semantics can silently lose records (high)

events.ts registers a live client :124 before replay :137–169, so live and replay can interleave, duplicate or advance cursor past late rows. replaySince limit is 200 (outbox.ts:130), run replay 500 (events.ts:144), no continuation/gap signal; missed history past page one is never drained. Domain bigint IDs and run IDs share one EventSource last-event-id; progress first emits run ID locally (agent-runs.ts:233–243), then a numeric outbox ID for only the final batch event :247–255. Remote replicas see only the last progress item, and reconnect may select the wrong replay branch. hub.ts:37 ignores res.write false; each event scans every client :93. Heartbeat/live connection has no session recheck after connection.

Adopt one durable cursor contract or separate streams with independent cursors. Snapshot high-water mark; replay authorized rows in bounded pages; queue live records newer than high-water until replay completes; signal pruned/gap history. Bound per-client buffer, evict slow clients and require reconnect. Gate: >500 missed records, concurrent write during replay, mixed domain/run traffic, revocation during open stream, and slow-reader memory bound.

### A09 — Idempotency cache is not safe idempotency (high)

lib/http.ts:64–75 reads an existing key; routes/projects.ts:98–107 checks then performs mutation then stores. lib/http.ts:87–101 upserts afterward, so concurrent same-key requests execute twice and a crash before storage makes a retry duplicate. There is no request digest/conflict detection or in-progress state. Changed body under same key replays unrelated response. Task/agent-run writes have no key support. api-client request :44–52 cannot supply idempotency header.

Add requestHash/state/lease/completed response, atomically claim unique key and perform mutation/record response in same database transaction. Restrict bounded key format/body retention; authorize before replay. Gate: 20 concurrent identical requests = one mutation/number allocation/event; mismatched request = 409; crash/retry preserves result; expiry deterministic. Add idempotency headers in client options and only retry safe/idempotent methods.

### A10 — Bulk contracts and semantics drift (high)

api-client/index.ts:166 sends {ids,status}, while schemas/tasks.ts:67–70 requires {projectId,status,taskIds}; central client cannot call its bulk endpoint successfully. Bulk route delegates to partial validation: tasks.ts:639–653 filters invalid inputs and commits valid subset :675–711, despite AGENTS describing atomic bulk creation. assigneeIds are directly nested-created :703–705 without assertUsersInTeam used elsewhere; cross-team assignment can slip through. Duplicate label IDs can abort whole transaction. Optional/empty taskIds for status (schema :70, tasks service :371) and archive (schema :75–76, service :539) mean operate on ALL project tasks, bypassing a 100-ID expectation; at 50K tasks this becomes unbounded work/event/response.

Keep legacy partial behavior behind an explicit, documented compatibility mode if needed; add atomic v2/bulk contract with all validation first, deduped inputs and membership checks. Separate all-project async operation from bounded selected-ID operation; explicit empty list means zero work/error, never all. Generate client DTOs from canonical schemas. Gate: contract test actually invokes central client against app, mixed invalid batch rollback/partial declared behavior, number allocation, 100-task bound and denied assignment.

### A11 — Task relationships/denormalized workspace not maintained (high)

schema Task.projectId/workspaceId remain nullable (:152–155), Project.workspaceId nullable (:432), SetNull FKs can orphan rows. createTask :183–196 and bulk :688–706 never set Task.workspaceId; updateTaskRoute :992–1006 moves project/team but not workspace, allows team change leaving existing project unrelated, and does not revalidate old labels/assignees/parent relation on move. team+number uniqueness can also conflict on changing team without fresh issue number. updateTaskRoute updates main task :1044–1048 then assignee relation in separate tx :1063–1068. updateTask and updateTaskRoute remain parallel implementations (status reset differs: batchId reset only route :984; bulk :405–410 never resets it).

Implement a single command preserving task→project→team→workspace plus labels/assignees/parent invariants. Validate actor and destination in transaction; assignment sync and outbox same tx. Expand/backfill/validate/check constraints before tightening nullability; explicitly migrate legacy team-only/orphan tasks to personal/default projects rather than breaking existing writes immediately. Gate: moves between workspaces/project/team, concurrent moves, foreign labels/parents/assignees, archived parent, identifiers and uniqueness, existing orphan deletion lifecycle.

### A12 — Opaque token consumption and refresh rotation race (high)

events.ts:24–31 reads/updates ticket in two statements, concurrent consumes can both succeed. lib/auth-tokens.ts:78–88 does same for 2FA challenge; :97–107 refresh reads then unconditional revokes, concurrent refresh can both issue fresh sessions; :109 calls issueSession creating a new familyId (:50), so no family continuity or reuse revocation. Auth cache invalidation after refresh is absent; existing old access hash stays accepted within cache TTL (and normal expiry).

Atomic consume with conditional update count / transaction, consistent shared access-token verifier for SSE (events.ts:40–48 currently lacks issuer/audience checks in production), preserve refresh family and reject/revoke reuse. Challenge should only be consumed on valid second factor, with bounded attempts. Tickets need session binding/revocation rather than only userId. Gate: parallel consumes exactly one succeeds, refresh reuse kills family according to defined policy, invalid factor retry policy, expires/logouts cannot reconnect.

## Latency/scale findings (hypotheses until benchmarked)

1. Main task route is offset/count despite a cursor service existing: routes/tasks.ts:62–64 calls listTasksPaginated; services/tasks.ts:855–862 uses createdAt-only sort + deep skip + exact count. Same timestamp rows lack tie-breaker. Proposed updatedAt indexes do not match this active createdAt query. Introduce additive cursor mode with stable tuple and optional count; preserve legacy page shape.
2. Bulk create holds a team counter lock through up to 100 sequential nested creates (tasks.ts:677–708), each with includes; bulk status emits aggregate + every task (:424–433), then 100 activity writes (:436–443), each activity broadcast may persist further events. Bulk archive similarly 100 events + activities :574–591. Batch rows/joins and activities with createMany and one authorized aggregate; establish exact query/event budgets.
3. PAT authentication still hits lookup and lastUsedAt UPDATE every request (pats.ts:40–62); session throttles are implemented (sessions.ts:24–25,136–151). Tenancy cache is unbounded map (context.ts:8,93), 30s local invalidations only, and full membership queries are separate from per-resource ownership queries. Add bounded TTL/single-flight caches with revocation-aware design and batched resource queries; verify warm/cold budgets separately.
4. Project list route unbounded/full includes by default (routes/projects.ts:85–88); team list includes all members; workspace detail/structure unbounded nested members/projects/teams (workspaces.ts:323–348). Field selection is opt-in and workspaces picks after querying. Introduce thin default via explicit version/opt-in projection to preserve clients; bounded collections and page tokens. Retain counts only when requested/cheap.
5. Usage loads all last-30-day rows into memory to construct daily series (usage.ts:58–62,80–86) and loads every group to count groups :148–152. SQL scoped date aggregation / count(distinct task_id) and proper bigint/decimal transport; confirm timezone totals and last-day boundary consistency (current daily array excludes today while totals may include today).
6. Search still ORs ILIKE contains across description/title/identifier/name/key (search.ts:37–85), including columns not covered by proposed manual trigrams. Existing manual index source has a fatal relation name mismatch at manual/2026-09-09-phase0-hot-path-indexes.sql:56–57: ON projects, but schema maps Project to linear_projects (:461). Applied state is unknown and must be verified only on isolated DB; source cannot prove production indexes. Query shape/index candidates must be measured with realistic tenant distribution and short search terms; use trigram/FTS semantics behind versioned contract if behavior changes.
7. Slow-query logs absent: packages/db/src/client.ts:16–19 initializes adapter/client without query logging or timings; pino-http has response times but no stable route label, query count/pool wait/body bytes, trace. telemetry recordRoute has no calls; histograms retain every sample forever (telemetry/index.ts:24–26) and only means are snapshotted, not p95 (:45–50). No exporter implementation even when OTLP endpoint supplied (:39–41). A bounded instrumentation layer is prerequisite for credible optimization.
8. SSE fanout O(clients × audience) and per-event task/project DB lookup (sse.ts:58,103), no active routing cache, large progress/outbox volume. Index clients by audience, bounded resource routing cache with grant invalidation, coalesce bounded progress, payload caps. Prove work avoided under 1K client fixture.
9. Jobs: worker.ts:17 starts interval before :18 pg-boss, so fallback runs even when boss active. pg-boss setup schedules/workers session/invitation/outbox/audit/attachment only; usageRollup/githubRefresh constants unused; activity/notification/chat-title/text extraction absent. Idempotency pruning runs only fallback. Catch-all falls back silently on any pg-boss error (jobs:139–141). Explicit single owner/scheduler, complete job registry, retries/dead letters/leases; assert repeatability and durations without cloud implementation.
10. Rate limiting in app.ts:90–111 uses default local memory store; all /api/events paths skipped :98,:179–180, including ticket creation. api-core events policy is declared but unused. Register per-subject policy after auth and bounded ticket limits; multi-process correctness needs a shared adapter but cloud configuration remains excluded.

## Phase 1 and performance-plan reconciliation

| Promised work | Source status | Remaining code acceptance |
| --- | --- | --- |
| Sole tenancy surfaces + exhaustive matrix | Partial: ALS/scoped helpers exist; routes/services bypass them; registry only asserts its own array | Compare all mounted routes with metadata; generate role/resource/scope tests and include nested payload/count/event scopes |
| NOT NULL project/workspace and task workspace | Not done; nullable schema and writes omit workspace | Reversible expand/backfill/validate/contract migration on fixture |
| Feature modules/repository-only DB imports | Re-export facades; routes and services import db | Gradual aggregate extraction preserving public route/service exports, boundary lint |
| Typed generated client | Manual mostly unknown-input/unknown-output client; broken bulk DTO | Schema/client integration tests, generated canonical contracts, abort/timeouts/idempotency/trace options |
| Transactional outbox, Redis/replay/backpressure | Partial; post-commit global writes, unlocked relay, broad audiences, truncated replay | Fault/concurrency/deny/reconnect tests before scalability claim |
| pg-boss complete job set | Partial; duplicate fallback scheduler and limited maintenance | Explicit lifecycle; retry/idempotency coverage + complete event consumers |
| Auth rebuild | Claims, refresh, opaque ticket/challenge, identity table exist; binding/rotation races and PAT workspace gap | Concurrent consume/reuse and workspace constraint tests |
| Observability/RED/query metrics | Health split done; metric exporter/instrumentation no-ops | Local traces/metrics and route/pool/query instrumentation with bounded cardinality/memory |
| Bulk 1 event/createMany | Routes done; writes/events still amplified | 100-row server-only benchmark/query budget, no hidden all-project mutation |
| Composite/trigram index improvements | Manual SQL present, no source proof applied; wrong projects table | Correct local migration chain, query plans showing selected candidates help |
| Usage SQL aggregation, thin payloads, cursor list | Incomplete on active HTTP paths | Scope-preserving aggregates, additive projections/cursor contract |
| p95 targets/load regression gates | No executable API board/search/inbox/bulk benchmark found in reviewed API files | Fixture+runner producing measured artifacts; initial thresholds advisory until baseline |

## Proposed backend work packages and order

WP0 immediate regression fixes: A01/A02 and client contract; add bounded telemetry retention/instrumentation if root selects it. No schema change needed. Gate: API typecheck + focused tests + full isolated-db suite; negative tests assert both response and zero side effects.

WP1 security/tenancy closure: PAT workspace binding, all HTTP/reporting/nested includes, event resource policy, comment permission, exhaustive actual-route registry. Gate: actor (owner/admin/member/viewer/external), grant (full/view/deny), scope, tenant A/B, orphan/private combinations; cache invalidation and open-stream revocation under concurrent changes.

WP2 atomic write core: single task commands and DTOs; atomic idempotency; mutation/audit/event transactions; bulk bounded selected IDs vs explicit asynchronous all-project job. Gate: transaction fault injection, concurrent duplicate requests/issue numbering, relation invariant/move tests, old clients contract tests.

WP3 durable realtime/job lifecycle: leased outbox, no local mark-complete fallback, immutable/batched run event ingest, unified stream cursor or distinct streams, high-water replay+gap signals, slow-client buffer, single scheduler. Gate: local two-process relay/bus test, >500 missed events, restart/Redis-loss/slow-reader tests and deterministic job retries. Cloud soak/deploy excluded.

WP4 measurement and query/payload work: implement bounded route/DB/queue/stream tracing; fixture and benchmark first; keyset HTTP read mode, count gates, scoped SQL usage, thin projections, measured index migration and resource routing caches. Gate: same fixtures/workload before-after, no tenant leak, constant payload/memory growth, per-route query budgets and saved EXPLAIN evidence.

WP5 maintainability contracts: module extraction tasks→projects→members; repository imports only; central schema/registry generation/client; safe client timeouts+AbortSignal; boundary lint and architecture tests. Gate: existing API snapshots + scoped integration tests preserved, no route/client drift, no new cross-module route imports.

## Controlled bottleneck measurement plan

Use an explicitly isolated local database whose name ends *_test, checked by existing assert-test-database guard; do not fall back to environment DATABASE_URL. No production/cloud measurement here. Fixture at 1K/10K/50K tasks in one workspace, many small tenants, full/view/deny grants, archived/unread proportions, realistic description sizes/labels/assignees, 100K+ run history and active execution events. Seed deterministically and capture seed/version/environment.

Capture build SHA + Node/pnpm/Prisma/Postgres versions, hardware, local DB connection limits, warm-up vs cold cache, concurrency 1/10/50, duration and offered vs achieved rate. Measure p50/p95/p99/throughput/error+timeout percent, response bytes, auth time, tenancy/resource check time, connection acquisition wait, DB duration/query count, event loop delay, RSS/heap, outbox age/depth/attempts, job lag/depth, SSE clients/buffer/eviction/replay lag. Use stable route templates and bounded labels; no raw token/user/body/query content or unbounded IDs as metric labels. Disable LLM/network dependency or stub deterministically to isolate backend overhead.

Routes: board /api/tasks first+deep page/cursor (target <250ms p95), selected 100 status/archive/delete (<500ms), auth warm (<25ms), scoped search (<300ms), inbox count (<150ms), usage summary/by-task and activity, workspace structure/list bytes, journal ingest 1/50-event batches, chat first-byte excluding provider latency (<500ms). Open 1K local SSE clients, reconnect 250/1000-event gaps, drive slow readers and mixed event types.

EXPLAIN (ANALYZE, BUFFERS) only against fixture database after ANALYZE; capture SQL with parameter structure but scrub values; compare sorting, rows visited, index usage, buffers, estimates and wall time. Index usage alone is not a correctness/performance acceptance. Evaluate createdAt HTTP board vs updatedAt cursor, mixed statuses, archived/unread counts, project-grant EXISTS, short queries/description search, aggregate scopes, high-history group counts. Save machine-readable distributions and explain artifacts under docs/reports/ or benchmarks/results; tests should fail on query-count/payload/memory regression, numerical latency threshold initially advisory with documented variance.

## Additive compatibility/migration strategy

Preserve old route paths/error fields and page response while adding cursor/include/count gates; no frontend dependency required to expose backend mode. Canonical request schema package can re-export existing schema definitions first. Client methods must type request/response with integration fixture; include optional signal/timeout/header/trace/idempotency options without breaking existing constructor. New scopes require explicit back-compat mapping and revocation behavior, never broaden token rights.

Expand schema with nullable event resource/lease/requestHash/state/constraint metadata first. Update new writers and compatibility reads; deterministically backfill fixture data, log remaining orphan/inconsistent rows, validate FKs/CHECKs as separate steps, then tighten NOT NULL only after all writer paths comply. Task.workspaceId is derived from project and must be set on create/move, with a compound relational constraint or equivalent validated enforcement. Legacy team-only tasks need owned personal/default project migration; deleting parents must have defined archive/reject/cascade policy. Never drop history/legacy nullable columns as first step.

Indexes should reflect final measured active query shape and Prisma drift contract. Correct linear_projects relation name; separate transactional schema migration from concurrent index execution when required. Source/manual SQL existence is not proof applied. Keep old readers working while columns are added; rollback code must still understand newly written data. Idempotency and outbox response/journal claims should be atomic, uniqueness constraints enforce duplicate safety, and retry policy requires defined TTL/lease semantics.

Initial focused changes will close A01/A02 only; all other findings remain open until separately implemented and tested. No deployment, cloud provisioning, remote secret rotation, production migrations, or commits are part of this audit.

## Focused implementation addendum

Root authorized a small A01/A02 tranche after the initial read-only audit. Changed only routes/events.ts (resolve run and assert current task/project view permission before headers/client registration), routes/agent-runs.ts (progress requires full permission), and a new __tests__/events.access.test.ts. Ten integration cases cover two tenants, explicit deny, read-only write rejection without journal/outbox side effects, both cursor transports, missing run, owner/viewer authorized replay, and owner authorized ingest. API typecheck passed. Focused + adjacent API suites passed on root's isolated loopback openlinear_api_audit_test database: events.access.test.ts (10), agent-runs.test.ts (2), events.outbox.test.ts (4), 16/16 tests across 3 files. The full integrated suite remains root-owned. Remaining audit findings are pre-fix source observations; root may implement other separately owned changes during the same session.
