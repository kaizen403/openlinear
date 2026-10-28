# Agent-execution UI kit v1 (engineer `execui`, round 2)

Status: done for this slice. Uncommitted; frontend only (`apps/desktop-ui`). Base tree `11cb047` (HEAD `922dbd7` plus `round2b-base.patch`). Nothing in `apps/sidecar`, `apps/api` or `packages/*` was changed. No deployments or remote calls.

Targets: FE-01 (phases incl. recovery-required), FE-05 (timeline, tool calls, bounded memory, reconnect without drops or duplicates), FE-06 (stop with its real outcome), FE-07 (file changes, partially), FE-08 (cost: unknown never renders as $0), plus the Phase 0 focus-ring leftover.

Screenshots (headless Chrome, fixture-driven, real components and Tailwind build):

- `execui-run-live.png`: the task detail Activity section mid-run. It shows the phase pill, runner/model, elapsed, "Cost unknown", counters, compact tool rows, agent text without a bubble, a reasoning line, a file edit, and a failed tool open by default with its red rail.
- `execui-run-drawer.png`: the 420 px drawer on a journal (W05-shape) run. It shows "Stop unconfirmed — Retry stop", provider-reported cost `$0.0874`, the expanded shell call with arguments and output, A/M/D file markers, and a running tool row.

## Outcome

- **`lib/run-model/`**: a pure adapter (no React, no I/O, injectable clock). It folds today's events (legacy `execution:progress` / `execution:log`, history from `GET /api/tasks/:id/logs`, the persisted task row, stream connectivity) and the W05 run journal into one `RunSnapshot`:
  - phase
  - timeline entries
  - counters
  - files
  - cost/tokens
  - outcome
- **`components/execution/`**:
  - `RunHeader`
  - `RunTimeline` (virtualized ARIA feed)
  - `FileChangesList`
  - `RunControls` / `StopButton` / `StopStatus` + `useStopControl`
  - empty, loading, error and recovery states
  - `RunView` (composition)
  - `useRunModel` (binds model ↔ store ↔ SSE ↔ task row)
  - `TaskRunSection` (isolates per-frame re-renders)
- **Task detail view**: the raw "Activity" log dump is replaced by the run view. The header Stop button uses the shared stop control. The sidebar Execution status uses the phase pill. Escape on an expanded timeline row collapses the row instead of closing the sheet.
- **Execution drawer** (still unused by any page): rebuilt on Radix `Sheet` (focus trap, focus restore, `aria-modal`) and the run view. It replaces the hand-rolled overlay and flat log list.
- **`components/ui/**`**: one shared focus token (`components/ui/focus-ring.ts`). It is applied to every focusable element of every primitive, and a test renders all 25 primitives to check it.

## Design decisions

1. **The adapter is the only place that knows wire shapes.** `decode.ts` maps SSE payloads to typed inputs; `legacy.ts` holds the sidecar's log-message vocabulary. W05 only has to emit journal events (see the contract below); components never change.
2. **Mutable model, immutable snapshot.**
   - `RunModel.apply()` is O(1) amortized.
   - `getSnapshot()` rebuilds at most once per change, and `useRunModel` batches snapshots to one per animation frame.
   - Entries are immutable objects replaced by identity, so memoized rows re-render only when their entry changed.
3. **Dedupe on three keys:**
   - SSE id (`id:<id>`);
   - journal `(runId, seq)`;
   - log content `timestamp|type|message|details`, the same key the execution store uses. This lets the HTTP history copy and the live copy of a line fold once.

   The dedupe memory is a bounded set (8,192).
4. **Ordering.**
   - Entries are kept sorted by journal seq within a run, else by timestamp, then by numeric outbox id or arrival.
   - Out-of-order arrivals are inserted in place by walking back from the tail (cheap: displacement is small).
   - Legacy outbox ids are monotonic, and outbox delivery is async (`persistAndDeliver`), so live events really can arrive out of order. A phase change backed by an older id than the current phase is ignored.
   - A late non-terminal beat after a terminal phase never reopens a run. OpenCode's `session.status busy` can still beat after a cancel.
   - Only a provably newer `cloning`/preparing beat opens a new attempt.
5. **Attempts.**
   - A fresh start after a finished run opens attempt N+1 behind a "Run N started" divider. Earlier evidence stays in the timeline (FE-06); counters are per attempt.
   - A start request is a reversible `queued` overlay, not an attempt. If the board's start is rejected, the last run's state comes back untouched.
6. **Unknown, not guessed.**
   - When the event stream drops mid-run, the phase becomes `unknown` ("Connection lost").
   - On reconnect the last phase is restored, and the cursor replay corrects it.
   - A task row whose outcome starts `sidecar_recovery_` (the sidecar restarted mid-run) shows `unknown` ("Recovery required").
   - Cost is `unknown` unless a provider reported one. A provider-reported `0` renders as `$0.00`; unknown never does.
7. **Outcome reuses the board's logic.** `describeTaskExecution` / `classifyPublicationUrl` from `components/board/execution-outcome.ts` are used unchanged:
   - Only a `/pull/<n>` URL counts as a PR.
   - Compare links are branch evidence.
   - Retained branch/path are parsed from the outcome.

   When the live terminal beat lands before the task row catches up, the live phase wins.
8. **Legacy tool pairing is heuristic, and documented as such.** The legacy wire has no call ids:
   - `Running: X` lines for the same call merge.
   - A bare tool name upgraded by its title merges.
   - A completion arriving before its start gets the start attached.
   - Rows left open by a terminal phase become `unfinished` ("no result"). A late completion can still close them.

   The journal path uses real `callId`s.
9. **Bounded memory.**
   - At most 1,500 entries; the oldest are dropped in 5 % chunks and counted ("N earlier entries are not shown — totals still include them").
   - Per-entry text, args and output budget: 4,000 chars. Tool output keeps the tail; agent text keeps the head.
   - Output older than the newest 300 entries is collapsed to a 240-char preview.
   - At most 500 listed files; the rest are counted.
10. **Rendering isolation.** `TaskRunSection` owns the model and reports only a coarse summary to the detail page: phase, recovery, attempt and the last agent message. The page re-renders when that summary changes, not on every streamed frame. Before, the whole detail view (markdown, comments) re-rendered on each log append.
11. **Stop is a request, not a fact.** `useStopControl` reports:
    - `requested` ("Stop requested — waiting for the agent to confirm.");
    - `stopped` (the sidecar answers 200 only after the provider confirmed the abort);
    - `unconfirmed` ("Stop unconfirmed — … Retry stop"), with mapped copy from `lib/api/errors.ts`;
    - `not_running`.

    The board's `handleCancel` contract is `Promise<boolean>` with its own toast. `false` is therefore mapped by run state: if the run had already finished it is `not_running`, else `unconfirmed`. A rejected promise with an `ApiError` gives precise copy. An unconfirmed stop keeps "Retry stop" in the header even after the task row moved to `cancelled`; the sidecar persists `cancelled` before the abort, and the agent may still be running.

## Run model contract (what W05 must emit)

Today's sidecar already lights these phases through legacy `execution:progress.status`:

| Phase | Legacy source today |
|---|---|
| `queued` | the board's start request (overlay until the first report) |
| `preparing` | `cloning`; log lines "Using local repository", "Repository cloned successfully", "Branch created", "OpenCode agent started" |
| `running` | `executing`; "Task prompt sent to agent", agent text, tool lines |
| `committing` | `committing`; "Agent finished, committing changes..." |
| `publishing` | `creating_pr`; "Creating pull request..." |
| `succeeded` | `done`; "Pull request created" (details = PR URL); task row `done` |
| `failed` | `error`; task row `cancelled` with a failure outcome, or `todo` with a failed batch outcome |
| `cancelled` | `cancelled`; "Execution cancelled by user"; task row `cancelled` |
| `unknown` | client-side: stream lost; task row outcome `sidecar_recovery_*` while `in_progress` |
| `awaiting_approval`, `verifying` | **not emitted today** |

The W05 journal path is `execution:progress { runId, taskId?, seq, type, payload, at? }`, with SSE id `run:<runId>:<seq>`, live or replayed, on either stream. `type` is `payload.t`.

| Journal `type` (payload) | Effect |
|---|---|
| `run.phase` `{ phase, message? }` | **Authoritative phase** for every value of `RunPhase`, including `awaiting_approval` and `verifying`. Ordered by seq; an older seq never overrides. `phase: "unknown"` means recovery required. |
| `run.started` / `session.started` `{ runner?, model: { id } }` | Runner/model; phase `running` if nothing live yet |
| `run.outcome` `{ status: succeeded\|failed\|cancelled, prUrl?, branchUrl?, reason?, retained?: { branch, path } }` | Terminal phase plus the outcome panel (PR vs compare vs retained work) |
| `tool.started` `{ callId, name, input }` / `tool.output` `{ callId, chunk, cumulative? }` / `tool.finished` `{ callId, name, ok, summary? }` | Tool rows: name, args summary, args, output (tail), duration |
| `message.delta` / `reasoning.delta` `{ text }` | Agent text / reasoning blocks (merged until another entry intervenes) |
| `file.changed` `{ path, kind: create\|edit\|delete }` | File rows and A/M/D markers |
| `permission.requested` `{ id, tool, detail }` | Warning row plus `awaiting_approval` |
| `usage` `{ usage, cost?: { usd, basis }, messageId? }` | Tokens; cost becomes known only when `cost` is present (latest per message id, summed) |
| `compaction`, `turn.finished` (error/interrupted/max_turns), `error` | System, warning and error rows |

Requirements for W05:

- `seq` must be monotonic per run.
- A new `runId` is a new attempt; late events from an earlier run are ignored.
- Journal events without `taskId` (sidecar-local delivery) are routed once a run is known for the task.
- Recommended: always include `taskId`, emit `run.phase` on every state-machine transition, and emit `run.outcome` once.

## Components and accessibility

**Timeline**

- An ARIA `feed` of `article`s with `aria-posinset` and `aria-setsize`.
- Roving focus with one tab stop. The focused row is always rendered, even when virtualized away (custom `rangeExtractor`).
- Keys:
  - `j` / `k` / `↓` / `↑` move between rows;
  - `Home` / `End` jump to the ends;
  - `Enter` (or Space) expands;
  - `Escape` collapses. If the row isn't expanded, Escape reaches the sheet. Radix listens for Escape in the capture phase, so sheets call `timelineConsumesEscape` from `onEscapeKeyDown`.
- Each row's accessible name includes its state ("…, completed, 5.1s, collapsed").
- New notable rows (tool results, errors, file edits) are announced through a polite live region, throttled to once per 2 s, never per event.
- The view follows the live edge only while it is at the bottom. Scrolling up shows a sticky "Jump to live · N new" button; nothing fights the reader.

**Row styles**

- Tool rows are 24 px: status icon, title, `·` subtitle (only the subtitle ellipsizes), duration, chevron.
- Expansion is disabled while a tool is running. Failed tools open by default with a 2 px red rail.
- Shell rows render `$ command` in mono.
- Agent text has no bubble; long text clamps to 6 lines and expands.
- Reasoning is muted behind a rail.

**Header and status**

- The phase pill is the only live region in the header (`role=status`, polite); the ticking clock is not announced.
- Pills use icon plus label, never colour alone. File markers are letter, colour and screen-reader label.

**Contrast**

- Every kit text colour is ≥ 4.5:1 on all five dark surfaces and on its own tinted pill. `run-kit.test` asserts this from the hex values.
- The kit never uses `text-linear-text-tertiary` (#6a6a6a, 3.5:1) for text; `muted` #8f8f8f (5.8:1) replaces it.

**Reduced motion**

- Spinners and skeletons use `motion-safe:`; chevron transitions use `motion-reduce:transition-none`.
- Scrolling is never smooth.
- The global reduced-motion CSS still applies.

**Focus ring (Phase 0 leftover)**

- `focusRing` (2 px `--ring`, 2 px offset) for controls, and `focusRingInset` for items inside menus, lists, popovers and scrollers. `--ring` is #e6e6e6, about 15:1.
- The 13 primitives that had hand-written rings now use the tokens.
- Added where focusable elements had no ring:
  - assignee-picker trigger;
  - command input;
  - popover content (it takes focus when it holds nothing focusable);
  - scroll-area viewport (keyboard-scrollable);
  - badge (defensive);
  - `TabsContent`. Radix makes the panel `tabindex=0`; the test caught this beyond the original 12.
- Alert-dialog actions already inherited the ring through `buttonVariants`.
- Avatar, card, form, label, skeleton and tooltip render nothing focusable; the test asserts that.

## Benchmark

Command (opt-in, skipped by default):

```sh
EXECUI_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/execution/run-timeline.bench.test.mjs
# EXECUI_BENCH_EVENTS=10000 EXECUI_BENCH_PER_FRAME=8 EXECUI_BENCH_BEFORE=<abs path to a base-tree execution-drawer.tsx inside the package>
```

Setup: 10,000 recorded-shape legacy log events (tool starts and completions with 600-char outputs, agent text, reasoning, file edits, retries, errors) streamed through `RunModel` into the real `RunTimeline` (480 px viewport). Environment: jsdom with a React dev build on a shared machine, so compare runs relative to each other only.

| | 8 events / frame | 1 event / frame | 8 events / frame (repeat) |
|---|---|---|---|
| Fold per event p50 / p95 / p99 / max | 0.005 / 0.012 / 0.019 / 1.0 ms | 0.013 / 0.024 / 0.035 / 1.87 ms | 0.006 / 0.015 / 0.024 / 1.32 ms |
| React commit per frame p50 / p95 / max | 1.27 / 3.85 / 13.6 ms | 1.34 / 3.50 / 11.2 ms | 1.40 / 4.82 / 14.8 ms |
| Frame wall (fold + render) p50 / p95 / max | 1.86 / 4.99 / 18.1 ms | 1.89 / 4.17 / 14.6 ms | 2.07 / 5.95 / 19.4 ms |
| Max rendered rows / DOM nodes | 28 / 338 | 28 / 341 | 28 / 338 |
| Entries kept / dropped | 1,496 / 6,004 (totals: 2,500 tool calls, 50 files) | same | same |

**Before** (base-tree `ExecutionDrawer`, which rendered every stored line; the store caps at 2,000): 2,000 lines → **20,166 DOM nodes**, 255 ms mount. After: ≤ 341 nodes at any point during 10,000 events.

The bench asserts the following; all pass with large margins:

- entries ≤ 1,500;
- rows ≤ 60;
- DOM ≤ 1,500 nodes;
- fold p95 < 0.25 ms and p99 < 1 ms.

Always-on guards in the normal suite:

- 3,000 events render ≤ 40 rows and < 800 nodes.
- Folding 20,000 events: the late-window per-event cost stays within 5× the early window (no O(n) growth).
- 10,000 events with `maxEntries` 600: entries capped, totals exact, old outputs ≤ 80 chars.

## Tests

90 new tests in 8 files, plus 1 opt-in bench file. All are `.mjs`, following the package's style.

| File | Tests | Covers |
|---|---|---|
| `lib/run-model/model.test.mjs` | 20 | Recorded successful run (phases, tool rows, durations, counters, files, PR outcome, unknown cost); elapsed; **reconnect replay plus HTTP history dedupe**; history-then-live; **out-of-order** (completion before start, `done` before `creating_pr`); stale and post-cancel beats; new attempt keeps evidence; **stream lost → unknown → restored**; task-row phases (done/failed/never/compare); service restarted → recovery required; a re-sent stale row doesn't end a newer attempt; queued overlay and abandoned start; journal fold (args/output/duration, A/M/D, deltas, tokens); journal seq order, replay, cost; `run.phase` / `run.outcome` (verifying, awaiting_approval); new runId; bounded memory at 10k; flat per-event cost |
| `lib/run-model/decode.test.mjs` | 7 | Legacy/journal decoding, runId/seq from SSE id, malformed payloads → null, routing by run; tool summaries; MCP names; log vocabulary |
| `components/execution/run-timeline.test.mjs` | 6 | Compact rows / no bubble / error open by default; bounded DOM; j/k/↑/Enter/Escape (and Escape left for the sheet when collapsed); jump to live with "N new"; polite live region and dropped marker; empty state |
| `components/execution/run-kit.test.mjs` | 13 | Header (phase status region, cost unknown, never $0, counters); cost formatting incl. real $0; lost stream / unconfirmed badge; stop requested → stopped, double click; unconfirmed via mapped `CANCEL_INCOMPLETE`; board `false` → unconfirmed vs not running; Stop → Stopping… → Retry stop → Stopped; no Stop for finished/queued; files A/M/D not colour-only; collapse/overflow; states; **contrast of every kit text token** |
| `components/execution/use-run-model.test.mjs` | 7 | Seeds from the store before first paint (no request); live events plus the store copy plus replay fold once; journal without taskId routed by run; stream down → unknown → recovered; history fetch (skipped for never-run tasks, mapped `NetworkError`, retry); queued start dropped on rejection; task-row phases; ignores a journal payload mis-cast into the progress store |
| `components/task-detail-view.test.mjs` | 6 | Run view replaces the raw dump; Stop unconfirmed → Retry stop → Stopped; Retry stop survives the row moving to `cancelled`; Escape collapses the row, not the sheet; completion box keeps the conclusion and PR; empty state for never-run tasks |
| `components/execution-drawer.test.mjs` | 4 | Labelled modal sheet with timeline and PR outcome; compare link is branch evidence; stop outcome and Escape closes; closed renders nothing |
| `components/ui/focus-ring.test.mjs` | 27 | Every file in `components/ui` is audited; no hand-written ring classes remain; each of the 25 primitives (opened where it has an overlay) puts the ring on every focusable element. Verified to fail when the ring is removed from the assignee-picker trigger. |
| `components/execution/run-timeline.bench.test.mjs` | opt-in | Benchmark above |

**Existing tests:** none changed, none failed. No existing test encoded the old raw rendering: `TaskDetailView` is mocked in the board render/bench tests, and `ExecutionDrawer` had no tests.

## Validation

| Check | Result |
|---|---|
| `pnpm --filter @openlinear/desktop-ui test` | Vitest **47 files passed, 2 skipped; 719 tests passed, 2 skipped**. Baseline on this base: 39 files + 1 skipped, 629 + 1 skipped. The skips are the board and execui opt-in benches. Fonts: "ok desktop font fallback config". Scroll gate: 3/3 passes, p95 16.7 ms, max 16.8 ms, 0 long tasks. |
| Root `pnpm typecheck` | **11/11** tasks; `desktop-ui:typecheck` was a cache miss and executed. The fresh worktree first failed `@openlinear/api#build` (a typecheck dependency) because the Prisma client wasn't generated (`--ignore-scripts`). I ran `pnpm --filter @openlinear/db db:generate` (gitignored output); this is an environment issue, not a regression. |
| Root `pnpm lint` | Passed. The biome scope is unchanged (API files only). |
| Biome on the new desktop-ui files (informational) | `lib/run-model`, `components/execution`, `focus-ring.*`, `execution-drawer.*`, new tests: **0 diagnostics**. Two intentional `useExhaustiveDependencies` ignores carry their reasons. |
| `pnpm --filter @openlinear/desktop-ui build` | Passed, 20/20 static pages. `next-env.d.ts` was rewritten by the build and restored by hand. |
| Strict TS | No `any`, `@ts-ignore` or `@ts-expect-error` added. |

## User-visible changes

- **Task detail "Activity"** is now an agent-run view:
  - phase pill, runner/model, live elapsed time, "Cost unknown" (or the provider's cost), counters (tool calls, files, errors, tokens, branch);
  - a chronological timeline: oldest at top, following the live edge. It was newest-first before;
  - compact expandable tool rows, agent text, reasoning, file edits and system lines;
  - "Files changed" with A/M/D markers;
  - loading, empty, error-with-retry and connection-lost / recovery-required states.
- **Stop** shows what happened: "Stop requested…", "Stopped — the agent confirmed it stopped.", or "Stop unconfirmed — … Retry stop". After an unconfirmed stop, Execute stays hidden and "Retry stop" stays available.
- **Escape** on an expanded row collapses the row; the next Escape closes the sheet as before.
- **History** is no longer fetched for tasks that never ran.
- **Keyboard focus**:
  - a visible, consistent focus ring on all ui primitives;
  - new rings on the assignee picker, command input, popover content, scroll areas and tab panels.
- **Execution drawer** (unused today): now a proper modal sheet with the run view.

## Leftovers

1. **W05 wiring.** Today nothing emits `run.phase`, `run.outcome` or provider cost on the journal, so `awaiting_approval`, `verifying` and known cost only light up once W05 emits them. The sidecar's legacy path still carries no call ids or file kinds: every legacy file change is "M", and tool pairing is heuristic.
2. **The board's stop contract** (`handleCancel` → `Promise<boolean>`, with its own toast) hides the error, so the detail view infers `not_running` vs `unconfirmed` from run state. If the board rejected with the `ApiError` (or returned it), the copy would be exact.
3. **DiffView, ApprovalPrompt and PlanTimeline** (R5 §5.12) are not built. File rows show paths only, with no diff (FE-07 needs a diff artifact from the backend).
4. **Markdown in agent text.** It renders as plain pre-wrapped text, which is safe. A streaming markdown renderer (`streamdown`) is a later step.
5. **Production numbers.** The benchmark is jsdom + React dev; no Chromium/production benchmark of the timeline yet. The screenshots are static, not a perf run.
6. **Other surfaces.** The board's `BatchProgress` per-member logs and the chat tool-call card still use their own renderers (not in this ownership).
7. **Title/description editors.** The detail view's inline title/description editors stop Escape with `stopPropagation`, which can't stop Radix's capture-phase handler. That's outside the execution sections and was not changed; the timeline uses `onEscapeKeyDown` correctly.

## Merge hazards

- **`hooks/use-task-sse.ts`** (desktop engineer): its `execution:progress` case casts **any** payload with a `taskId` to legacy `ExecutionProgress`. Journal events from the API (`{runId, taskId, seq, type, payload}`) therefore land in the progress store with `status: undefined`. The run model ignores them (tested), but other store consumers (task cards, `isTaskActivelyExecuting`) don't. Suggested fix: skip payloads that carry `runId`/`seq`.
- **`providers/sse-provider.tsx`**: not changed. `execution:progress` / `execution:log` were already subscribed.
- **`components/ui/*.tsx`** (18 files): focus-style-only edits. Literal ring classes became `focusRing` / `focusRingInset` imports and `cn(...)` arguments; `button`/`badge` cva bases became arrays. Anyone restyling primitives will conflict on those lines. `focus-ring.test.mjs` fails on any new primitive file without a case, and on any hand-written `focus-visible:ring`.
- **`components/task-detail-view.tsx`**:
  - imports;
  - the header Stop/Execute block;
  - the Activity section (now `<TaskRunSection key={task.id} …>`);
  - the sidebar Execution status (phase pill; heading colour secondary);
  - `onEscapeKeyDown` on `SheetContent`.

  `useExecutionLogsWithHistory` and the local virtualizer are gone from this file. Props are unchanged.
- **`components/execution-drawer.tsx`**:
  - rewritten;
  - props are additive (`onCancel`, `onCheckPullRequest`; `logs` now optional; `task` accepts a partial `Task`);
  - `ExecutionLogEntry` / `ExecutionProgress` are re-exported from `types/task`;
  - it now needs `SSEProvider` (`useSSESubscription`), like the detail view.
- **Cross-ownership imports** (read-only):
  - `components/board/execution-outcome{,-panel}`;
  - `components/board/keyboard-guards` (`isEditableTarget`);
  - `lib/execution-state-store`;
  - `lib/api/{errors,fetch,tasks}`.

  Renames there break the kit.
- **Sidecar rewrite (attempt identity).** If journal event names or legacy log strings change, update only `lib/run-model/model.ts#applyJournal` or `lib/run-model/legacy.ts`. Fixtures in `lib/run-model/fixtures.mjs` document the recorded shapes.
