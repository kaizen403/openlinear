# Home Chat / PM agent — metering, caching, resilience and tool safety (W15 + W18a slice)

Date: 2026-10-26 (work done 2026-10-25). Engineer id: `ai`. Base: `922dbd7` + round-1 base patch (CI fixes, W02a, W04a). Status: **implemented and locally validated; not committed, not deployed, no real provider calls.**

All model traffic in tests goes to fake clients or a loopback stub provider (`apps/api/src/__tests__/fake-llm-provider.ts`, ephemeral port on 127.0.0.1). No paid inference was run, so nothing here claims real-provider behaviour beyond what the fixtures prove (see "Verification still owed").

## 1. What changed and why

### 1.1 Tool safety (priority 1)

| Finding | Change | Evidence |
|---|---|---|
| `bulk_update_issues` with no `issueIds` rewrote every active issue in the project; `issueIds: []` or a list of non-strings did the same (filtered to empty, then the service's "no ids = whole project" branch). | The tool is now `destructive` and has no direct execution path. It resolves the exact selection read-only (explicit `issueIds`, validated 1–100 UUIDs, or — only when `issueIds` is absent — every active issue in the project, bounded at 100 → `SELECTION_TOO_LARGE`). A malformed/empty list is a `VALIDATION_ERROR`, never "all". Execution always passes the exact, non-empty id list to `bulkUpdateTaskStatus`. | `chat.regressions.test.ts` (2 cases fail on the old code), `chat.tool-safety.test.ts` |
| Destructive actions ran on model-chosen arguments with no consent. | Two-step preview → confirm (`services/chat-tools/confirmations.ts`). The first call returns `CONFIRMATION_REQUIRED` with the exact preview and a server-issued code `CONFIRM-XXXXXXXX` (40 bits, Crockford base32, stored as SHA-256 only). The code is single-use (conditional `updateMany` claim), expires in 10 minutes (DB CHECK caps at 1 h), and is bound to session + user + tool + a hash of the change and every target's revision (`status@updatedAt`). It is redeemable **only if the authenticated user's own message for the current turn contains it** (typed text, or the new optional `confirmationTokens` body field for a future button). Model narration, tool output and workspace text can never confirm. A code cannot be used in the turn that issued it. Any concurrent edit, different arguments or different selection → `CONFIRMATION_STALE`. | `chat.tool-safety.test.ts`: end-to-end over two turns, bare "yes" refused (`CONFIRMATION_NOT_FROM_USER`), same-turn, changed status, concurrent edit, expiry, cross-session, 3-way concurrent redemption (exactly one executes), structured `confirmationTokens` over the HTTP route |
| `mutating` boolean, read nowhere. | Replaced by `effect: 'read' \| 'write' \| 'destructive' \| 'external'` on all 34 tools (types are a discriminated union: `read`/`write` have `handler`, `destructive`/`external` have `prepare` and cannot be executed without the gate). PAT scope check now keys on effect (`read` → `read`, anything else → `write`). `assertNoToolShapeDrift` also checks effect validity and duplicate names. | classification test: 14 read, 13 write, 7 destructive, 0 external |
| Archive had explicit-ids protection but no consent. | `archive_issues` is `destructive`: preview of exact tasks → confirm; executes `bulkArchiveTasks` with exact `taskIds` (identifiers resolved at preview). | updated `chat.tools.test.ts`, route test |
| Five permission tools could be re-enabled by env with no approval. | Still withheld by default; if `OPENLINEAR_ENABLE_CHAT_PRIVILEGE_TOOLS=1`, they are `destructive` and go through a generic confirmation bound to their exact arguments. | `chat.tool-safety.test.ts` |
| Journal keyed by the provider's tool-call id: a provider that reuses ids across turns (Kimi-style `functions.name:0`) got an old cached result. | Dispatch dedupes by a server key `<turnId>:<round>:<index>` (`ChatToolCall.toolCallId`), the provider id is kept in new `providerToolCallId`. Transcript ids keep the provider's id unless missing or repeated within the turn. | regression test fails on old code (second issue never created) |
| `tool.handler()` started before the abort check; a timed-out write was journaled as failed even if it later committed. | An already-aborted call is journaled `cancelled` and its handler never starts. A non-read tool interrupted after starting returns `TOOL_OUTCOME_UNKNOWN` ("re-read before retrying") and its real outcome is written to the journal when it settles (`details.reconciledAfter`). | deterministic test holds the team row lock so `create_issue` blocks, aborts, then releases and observes reconciliation |
| Malformed tool JSON degraded to `{}` and executed. | Refused with `INVALID_TOOL_ARGUMENTS`, journaled, nothing dispatched. `finish_reason: length` with pending tool calls → `LLM_OUTPUT_TRUNCATED`, nothing executed. | `chat.tool-safety.test.ts` |

### 1.2 Usage metering (priority 2)

New append-only ledger `model_usage` (one row per model **attempt**), service `services/model-usage.ts`, normalisation in `lib/llm-usage.ts`:

- Fields: invocation id (unique; replays are no-ops), surface, provider, model, user/workspace/session/turn/round/attempt, status (`succeeded`/`failed`/`aborted`), finish reason, error code, input/output/cache-read/cache-write/reasoning tokens (NULL = not reported), latency, first-token latency, cost, cost basis, pricing revision, prompt-prefix hash, tool-catalogue hash, provider request id, bounded raw usage receipt (≤2 KiB).
- Normalised token semantics (documented in `llm-usage.ts`): input includes cache reads/writes, output includes reasoning; Anthropic-style `input_tokens` (which excludes cache) is converted. Shapes handled: OpenAI/Fireworks/OpenRouter (`prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`), DeepSeek (`prompt_cache_hit_tokens`), Moonshot (`cached_tokens`), Anthropic (`cache_read_input_tokens`, `cache_creation_input_tokens`).
- Cost basis: `provider_reported` (OpenRouter `usage.cost` only), `estimated` (operator price snapshot `MODEL_PRICING_JSON`, revision recorded; unknown if cached tokens exist but no cache price), else `unknown` with `costUsd = NULL`. DB CHECKs enforce `(costBasis = 'unknown') = (costUsd IS NULL)`, non-negative tokens and costs, and the status set. No prices are hard-coded.
- Chat streams now send `stream_options: { include_usage: true }` (opt-out `CHAT_LLM_STREAM_USAGE=0`); the parser takes usage from the trailing usage-only chunk (the old parser dropped it).
- `done` SSE chunk gains `usage` (calls, coverage, tokens, cache reads, cost or null, basis) — matching the shape the desktop UI already types as optional on `done`.
- Reporting: `GET /api/usage/models?days=&workspaceId=&surface=` aggregates in SQL (two queries, ≤100 groups): totals and per surface/provider/model, `callsWithoutUsage`, `cacheHitRate` (over calls that reported cache tokens), `cost.knownUsd` (null when nothing is known), `cost.coverage` (`complete`/`partial`/`none`), counts by basis. Scope: the caller's own rows; `workspaceId` filter goes through `assertWorkspaceRole`; a workspace-bound PAT is confined to its workspace (403 elsewhere). Declared in `registry.ts`; route-inventory probes pass.
- Existing `/api/usage/summary` and `/by-task` keep every field and type; they gain `costCoverage { runsWithKnownCost, unknownCostRuns, coverage }`, `daily[].unknownCostRuns` and `items[].unknownCostRuns`, so a `0` total can be told apart from "no cost recorded".

#### Metering coverage (every model-call site found)

| Site | File | Metered now? | Where | Cost basis |
|---|---|---|---|---|
| Home Chat turn rounds (stream) | `apps/api/src/services/chat.ts` → `lib/chat-llm.ts` | **Yes** — every round, every retried attempt, final failures, aborts | `model_usage` `chat.turn` | reported (OpenRouter) / estimated (price snapshot) / unknown (default Fireworks, no snapshot) |
| Context-overflow retry round | same | **Yes** (failed row `LLM_CONTEXT_OVERFLOW` + the retried round) | `chat.turn` | as above |
| Session title generation | `services/chat.ts` `maybeAutoTitle` | **Yes** — each attempt; optional `CHAT_LLM_TITLE_MODEL` | `chat.title` | as above |
| Voice transcription (Cartesia `ink-whisper`) | `apps/sidecar/src/routes/transcribe.ts` | **Partly** — receipt (`audioBytes`, provider `duration` → `audioSeconds`, latency, status) returned in the response `usage` field and logged as `[usage] transcription` on success and failure. Not persisted: the sidecar has no usage persistence path (persistence is being rewritten by another engineer). | response + log | unknown (`costUsd: null`; Cartesia bills audio time; no price configured) |
| Single-task coding agent (OpenCode) | `apps/sidecar/src/services/execution/events.ts` → `agent-run.ts` | Yes (pre-existing, unchanged) | `AgentRun` columns | runner-reported (`opencode.message.updated`) |
| Batch coding agent (OpenCode) | `apps/sidecar/src/services/batch/orchestrator.ts` | **No** (pre-existing gap; outside my ownership — sidecar execution) | — | — |
| Codex runner / v2 OpenCode adapter | `apps/sidecar/src/runners/*` | Emit `usage` events but are not routed in production | — | — |
| Project plan (`setup_project_plan`) | `apps/api/src/services/project-plan.ts` | N/A — no model call (record creation only) | — | — |
| Brainstorm / God Mode | — | N/A — no backend mounted in API or sidecar | — | — |
| `/api/models` | `apps/api/src/routes/models.ts` | N/A — models.dev catalogue fetch, not inference | — | — |
| MCP worker, desktop UI | `apps/mcp`, `apps/desktop-ui` | N/A — no direct model calls (UI calls the API) | — | — |

### 1.3 Prompt caching (priority 3)

- **Layout** (`lib/chat-prompts.ts`, `services/chat-context.ts`): tools → system message (static core rules, then the per-session scope block: user id, workspace id, project id, UTC date) → history window → current user message → this turn's tool rounds. The core is a constant with no ids/dates (tested); the scope is date-only so it is stable all day. One system message is sent (core + blank line + scope) for compatibility; with cache hints on, it is sent as two parts with a breakpoint on the core.
- **Frozen catalogue** (`chat-tools/index.ts`): tool specs are built once per process configuration and reused by reference; their SHA-256 (`toolsHash`) and the core+catalogue hash (`promptHash`) are stored on every usage row, so a catalogue change (a cache invalidation) is visible in the ledger.
- **Stepped history window**: the old "newest 32 rows" window changed its first message on every turn once a session exceeded 32 rows, destroying the cached history prefix. The window now starts at a multiple of 16 (holds 32–47 messages) and stays fixed for up to 16 messages.
- **Byte-identical replay**: tool results are compacted identically in-flight and on replay, rows within a turn get strictly increasing timestamps (ms-precision ties could reorder an assistant message and its results), and `repairToolGroups` keeps only valid assistant/tool groups (orphans, unanswered calls, duplicates dropped).
- **Hints**: Anthropic-style `cache_control` breakpoints (static core + newest user/tool message; 2 of 4 allowed) when `CHAT_LLM_CACHE_HINTS=anthropic`, or `auto` with OpenRouter in front of an `anthropic/*` model. OpenAI gets a per-session `prompt_cache_key`. Fireworks (default), DeepSeek, Moonshot rely on automatic prefix caching; no hints are sent.
- **Measured on the fake-provider fixture** (`chat.caching.test.ts`; the stub reports cached tokens = longest common prefix with any earlier request, at ~4 chars/token):
  - static prefix: tool catalogue 17,416 chars + core 3,841 chars ≈ **5.3k tokens**, byte-identical in every request;
  - 3 requests (turn 1: tool round + answer; turn 2: answer): prompt 5,398 / 5,478 / 5,502 tokens, cache reads 0 / 5,396 / 5,477 → rounds 2–3 read **≈99%** from cache; ledger hit rate over the 3 calls **66%** (first call cold);
  - long session (59 prior messages, consecutive turns): share of the history prefix reused between turns **96%** with the stepped window vs **2.7%** with the old sliding window.
  - Honest caveat: for automatic-prefix providers the old single-string layout already kept the static part first (the UUIDs were at the end), so the cross-session gain there comes mainly from the frozen catalogue and the stepped window; real savings depend on the provider actually caching and must be measured from `model_usage` once real traffic runs. No cost-reduction figure is claimed.

### 1.4 Resilience (priority 4)

- `lib/llm-retry.ts` classifies failures: 429 → `LLM_RATE_LIMITED` (retry) unless quota/billing text → `LLM_QUOTA_EXCEEDED` (no retry); 5xx/425/529 → `LLM_PROVIDER_UNAVAILABLE` (retry); 408/idle timeout → `LLM_TIMEOUT` (retry); network → `LLM_NETWORK_ERROR` (retry); 401/403 → `LLM_AUTH_FAILED`; 404 → `LLM_MODEL_NOT_FOUND`; 400/422 → `LLM_BAD_REQUEST`; 413 or overflow text → `LLM_CONTEXT_OVERFLOW`; mid-stream provider errors, malformed frames and truncated streams have their own codes.
- Bounded retries: default 3 attempts, equal-jitter exponential backoff (500 ms → 8 s), `Retry-After` honoured as a lower bound, give up if it exceeds the max delay; abortable sleep. Retries happen only before any output reached the caller.
- Context overflow: the turn trims deterministically (system + newest 8 history messages in valid groups + the whole current turn, tighter tool-result caps, older images replaced by a note) and retries **once**; a second overflow is reported.
- `CHAT_LLM_TIMEOUT_MS` is now an idle timeout (headers, then between chunks) instead of a whole-stream cap; the whole turn (all rounds and tools) is bounded by `CHAT_TURN_TIMEOUT_MS` (default 300 s) → `TURN_TIMEOUT`.
- A stream that ends without a finish reason is `LLM_STREAM_TRUNCATED`, not a complete answer. SSE parsing handles CRLF/CR, fragmented frames, keep-alive comments and an unterminated final frame. Provider error text is sanitised (Bearer/keys) and moved to `details.providerMessage`.

### 1.5 Data processor transparency (priority 5)

`lib/chat-llm-config.ts` validates all chat model settings with Zod (`CHAT_LLM_BASE_URL` https-only except loopback or `CHAT_LLM_ALLOW_INSECURE_HTTP=1`, no embedded credentials; provider enum or inferred from host; model ids; integer bounds; cache-hint mode; pricing JSON). Invalid configuration fails closed with `LLM_MISCONFIGURED` instead of silently falling back. The module header documents the default processor and exactly what is sent. A one-time info log names the processor (provider, host, model, title model) in non-test processes.

**Default unchanged:** Fireworks AI, `https://api.fireworks.ai/inference/v1`, `accounts/fireworks/models/kimi-k2p6`. Data sent per chat request: static rules and tool schemas; user/workspace/project ids and date; the session history window (user text, assistant text, tool calls with arguments, tool results — issue titles/descriptions/statuses/comments/labels, project/team names, member usernames, **email addresses** and avatar URLs); attachments of the current message (images as base64, PDF/text extracts). Title calls send the first user message and answer (≤2,000 chars each).

## 2. Client-visible behaviour changes (verify manually)

1. **Bulk status changes and archiving now take two turns.** The model shows a preview and a `CONFIRM-XXXXXXXX` code; the user must reply with the code (case-insensitive) or the client must send it in the new optional `confirmationTokens` body field. A bare "yes" does not confirm. Codes expire after 10 minutes and are single-use. For one or a few issues the model is told to use `update_issue` (unchanged, no confirmation).
2. New SSE event `confirmation_required` (`code`, `expiresAt`, `summary`, `toolCallId`). The current UI ignores unknown events (verified in `hooks/use-chat-stream.tsx`), so the code is only visible through the model's reply and the tool-result card until the UI renders it.
3. `done` may carry `usage`; `assistant_final` may carry `finishReason` (e.g. `length`). Error chunks may carry `details` (`httpStatus`, `attempts`, `retryAfterSeconds`, `providerMessage`).
4. Error codes are more specific (see 1.4) and the error `message` is now a fixed sentence instead of the raw provider body.
5. Truncated provider streams now end in an error instead of a partial "final" answer; turns are capped at 5 minutes by default; a long but still-streaming answer is no longer cut at 60 s.
6. System prompt gained the confirmation rules and a UTC date line; history window is 32–47 messages instead of exactly 32. `tool_choice` is no longer sent without tools (title calls).
7. Configuration: `http://` to a non-loopback host and malformed numeric values are now rejected (chat returns `LLM_MISCONFIGURED`) — previously accepted or silently defaulted.
8. New `GET /api/usage/models`; additive fields on `/api/usage/summary` and `/by-task`; transcription response gains `usage`.
9. `chat_tool_calls.toolCallId` now stores the server key for chat turns (internal table; no route exposes it; the provider id is in `providerToolCallId`).

## 3. Tests and validation (exact counts)

New suites: `chat.regressions.test.ts` (6; all 6 fail on the pre-change code: replay, no-ids bulk, empty/malformed ids, include_usage + trailing usage, 429 retry, overflow trim), `chat.tool-safety.test.ts` (15), `chat.llm-provider.test.ts` (22), `chat.metering.test.ts` (14), `chat.caching.test.ts` (6). Sidecar: 1 new transcription test.

Stale tests updated (behaviour intentionally changed, not regressions):
- `chat.tools.test.ts` "bulk-updates project issues…" — expected the whole-project update on the first call; now asserts preview first, then confirmed update.
- `chat.tools.test.ts` "refuses to archive a whole project…" — expected the scoped archive on the first call; now preview → confirm.
- `chat.streaming.test.ts` — looked up the journal row by the provider id; now by `providerToolCallId`, and asserts the server key and `effect`.
- `transcribe.test.mjs` — exact-equality response check extended with the additive `usage` object.

| Gate | Result |
|---|---|
| `pnpm typecheck` (root) | 11/11 tasks successful |
| `pnpm lint` (root biome list, 12 new files added) | 53 files checked, no findings |
| `pnpm --filter @openlinear/api test` (private DB `openlinear_ai_test`) | **36 files, 349 passed, 2 skipped** (baseline before this work: 31 files, 286 passed, 2 skipped); rerun on a freshly recreated DB: same |
| `pnpm --filter @openlinear/sidecar test` | **38 files, 662 passed** (baseline 661) |
| Timing-sensitive suites rerun alone (tool-safety, metering, provider) ×2 | 51/51 both times |
| Migrations | `prisma migrate deploy` from an empty `openlinear_ai_test` applies all 20 migrations; `prisma migrate diff --from-config-datasource --to-schema schema.prisma --exit-code` → "No difference detected" (exit 0). The CI `--from-migrations` variant needs a shadow DB; I did not touch the shared `openlinear_shadow` (other engineers reset it), and the from-scratch replay + diff proves the same thing. Migration carries the `migration-safety: allow` note (indexes on new tables only, no destructive DDL). |

## 4. Owner decisions needed

1. **Default processor.** Keep Fireworks/Kimi K2 (confirm DPA, retention and training terms, zero-data-retention option), or switch (e.g. Anthropic via OpenRouter/native adapter, OpenAI). Not changed here. Member emails and attachments are sent to it today.
2. **Price snapshot.** Without `MODEL_PRICING_JSON` every chat/title cost is `unknown` (by design). Decide who maintains prices and how they are reviewed.
3. **Confirmation UX.** Typed code works today; a confirm button needs FE work (render `confirmation_required`, send `confirmationTokens`). Confirm the 10-minute TTL, and whether `bulk_update_issues` with a short explicit id list should also need confirmation (current: yes, every destructive call).
4. **Usage visibility.** `/api/usage/models` shows only the caller's own calls. Decide whether workspace owners/admins should see workspace totals.
5. **Retention.** `model_usage` and `chat_tool_confirmations` have no pruning job yet (confirmations cascade with their session). Set retention for billing/audit data.
6. **Privilege tools.** Re-enabling them is now gated by confirmation, but they remain withheld; keep withheld until a policy/approval contract exists across all transports.

## 5. Leftovers (not done in this slice)

- Batch execution usage (sidecar) is still unmetered; transcription usage is not persisted (needs the W03 sidecar → API path or an ingest route).
- W15 budgets/quotas/reservations and trace ids/OTel spans on usage rows.
- W18a/B1 durable `ChatTurn` with a lease (one active turn per session), resumable event ids, partial-text checkpoints; concurrent turns in one session can still interleave.
- Structured summarisation compaction (only deterministic trim-on-overflow exists); attachments are not rehydrated into history (an attachment turn breaks the cached prefix for later turns).
- Untrusted-content envelopes for workspace text in tool results (only attachments are wrapped).
- A per-turn write budget (many single `update_issue` calls are still possible in one turn).
- REST `PATCH /api/tasks/bulk-status` still treats omitted **or empty** `taskIds` as "whole project" (`schemas/tasks.ts` allows `[]`); owned by the tasks/route owner — recommend `.min(1)` when present.
- Desktop UI: render `confirmation_required`, a cost meter from `done.usage`, and unknown-cost coverage on the usage page.

### Verification still owed (needs a funded, approved staging run)

Real-provider confirmation that Fireworks accepts `stream_options.include_usage` and reports `prompt_tokens_details.cached_tokens` for Kimi; that OpenRouter forwards the `cache_control` parts; real cache hit rates and TTFT from `model_usage`. If a provider rejects `stream_options`, set `CHAT_LLM_STREAM_USAGE=0`.

## 6. Merge hazards

- `packages/db/prisma/schema.prisma`: two new models inserted immediately before `model AgentRun`; three columns on `ChatToolCall`; one relation field on `ChatSession`. Migration `20261026060000_chat_usage_ledger_and_tool_confirmations`. Conflicts are textual only; regenerate the client after merging.
- Root `package.json` `lint` line (one long line every engineer edits): 12 files appended.
- `apps/api/src/registry.ts`: one row after `/api/usage/by-task`.
- `apps/api/src/routes/usage.ts` (W02a also edited it): additive only; `buildScopeWhere` untouched.
- `services/tasks.ts` is **not** edited, but chat tools call `bulkUpdateTaskStatus`, `bulkArchiveTasks` and `createTask`. If the outbox engineer changes their signatures or return shapes, adapt `chat-tools/domain.ts` (`prepareBulkStatusUpdate`, `prepareArchive`). The interrupted-write test assumes `createTask` increments `team.nextIssueNumber` inside its transaction.
- `apps/sidecar/src/routes/transcribe.ts` (+ test): metering-only edits; the sidecar engineer may also touch this file.
- `apps/api/src/__tests__/chat.tool-safety.test.ts` builds a `TenancyContext` literal for `runWithPrincipal`; a change to that type's fields needs a one-line test update.
- `apps/api/src/schemas/chat.ts` (`confirmationTokens`) and `apps/api/README.md` (Home Chat section).
