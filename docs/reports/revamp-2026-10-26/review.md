# The review loop: see the diff, comment inline, send it back, gate publishing (engineer `review`, round 5)

Status: done for this slice. Uncommitted. Base: `922dbd7` + `round5-base.patch` (tree `be37042d…`). Local work only: no deployment, no paid inference, no network from tests (real-git fixtures, loopback servers, headless Chrome on `file://`).

Target: the Conductor bar from the competitive analysis (inline diff comments sent back to the agent, checks gating merge) and FE-07 (diff + verification before publishing; evidence bound to the displayed commit). FE-06 partially (a follow-up is a new attempt; prior evidence stays in the run view).

Screenshots (fixture-driven, real components, the app's Tailwind build, headless Chrome 1180×760):

- `review-unified.png`: unified diff with a draft thread under a line, the comment editor open on another line (opened by pressing `c`), the composer with two drafts and a message, and the checks gate **blocked** (verification not reported, unsent drafts) with the override offered.
- `review-split.png`: split view; the run reported passing verification for the displayed commit, so the gate is **open** and "Merge on GitHub" is enabled; the file tree with status letters and counts.
- `review-states.png`: override active for this revision ("Create PR on GitHub anyway"), uncommitted-workspace warning, comments written against an older diff, and the follow-up failing against an older sidecar: "Update OpenLinear to use this … Your drafts are kept."

Regenerate: `node apps/desktop-ui/components/review/dev/screenshots.mjs [outDir]` (`CHROMIUM_BIN`, `REVIEW_SHOTS_SCENARIOS=unified,split,states` optional). Sizes: 145 / 166 / 174 KB.

## 1. Outcome

| Part | Status |
|---|---|
| Sidecar `GET /api/tasks/:id/diff` (route + diff engine + workspace resolver), hardened git only | **Done** — `apps/sidecar/src/routes/task-diff.ts`, `services/review/{git-diff,diff-parser,workspace-resolver,types}.ts`, one mount line in `app.ts` |
| Real-git tests incl. renames, binary, huge-file truncation, planted drivers (must not execute) | **Done** — 22 real-git + 22 parser + 17 resolver + 12 route tests |
| Follow-up contract consumed (UI; another engineer builds the sidecar side) | **Done** — `sendTaskFollowUp`, every error code mapped, 404-without-code = "update the app" |
| Desktop UI `components/review/**` (tree, virtualized unified/split diff, syntax-light, inline drafts, composer, checks + gate) | **Done** |
| Task-detail integration (Details / Review changes tabs) | **Done**, minimal |
| Route table + `routes.test.mjs` rows, `lib/api/review.ts`, query keys | **Done** |
| Tests (parser, viewer interactions, follow-up errors, gating, bounded-DOM bench) | **Done** |
| Screenshots | **Done** (3 PNGs) |

## 2. Endpoint contract — `GET /api/tasks/:id/diff?base=<optional>`

Sidecar route (auth on the route itself — `router.get('/:id/diff', requireSidecarAuth, …)` — so mounting it ahead of the execution router never authenticates other `/api/tasks` paths).

```ts
200 {
  base: { ref: string; sha: string }          // 'origin/<b>' | '<b>' | 'origin/HEAD' | 'fork-point' | 'HEAD' | 'empty' | the ?base value
  head: { ref: string | null; sha: string | null; dirty: boolean }   // dirty = uncommitted/untracked changes are included
  revision: string                            // sha256 content fingerprint; unchanged when nothing changed (touching a file doesn't change it)
  source: 'legacy-live' | 'v2' | 'legacy-disk'
  files: Array<{ path; oldPath?; status: 'added'|'modified'|'deleted'|'renamed'|'binary'; additions; deletions;
                 hunks: Array<{ header; oldStart; oldLines; newStart; newLines;
                                lines: Array<{ kind: 'context'|'add'|'del'; oldNo?; newNo?; text; truncated?: true; noEol?: true }> }>;
                 truncated?: true; similarity?: number; untracked?: true }>
  truncated: boolean                          // any bound hit anywhere
  stats: { files; additions; deletions; shownFiles; binaryFiles; untrackedFiles }   // totals over ALL changed files (numstat)
  limits: { maxFiles: 300; maxLinesPerFile: 5000; maxTotalLines: 20000; maxLineChars: 1000; maxPatchBytes: 8 MiB; maxUntrackedFileBytes: 512 KiB }
}
```

What it diffs: the base commit against the **working tree** of the task's attempt worktree — committed + staged + unstaged changes — plus untracked files (read by the sidecar itself). `.sisyphus/` runtime artifacts are excluded (publication never commits them). `Cache-Control: no-store`.

Base selection: `?base` (safe ref name or 40/64-hex sha) → merge-base with HEAD; else the run's default branch (`refs/remotes/origin/<b>`, then `refs/heads/<b>`) → merge-base; else `origin/HEAD`; else the fork point from remote-tracking refs (task branches pushed back under `*/openlinear/*` excluded); else `HEAD` (only uncommitted changes); no commits → the empty tree.

| Error | When |
|---|---|
| 400 `INVALID_TASK_ID` / `INVALID_BASE_REF` | bad id; `?base` not a safe ref or sha (`--output=x` etc.) |
| 401 / 503 `CLOUD_API_UNREACHABLE` | from `requireSidecarAuth` (unchanged) |
| 403 `RUN_PRINCIPAL_MISMATCH` | the run's owner is known and is not the caller |
| 403/404/503 from the control plane | owner unknown → `authorizeTaskAccess(credential, taskId, 'full')` decides |
| 404 `BASE_REF_NOT_FOUND` | `?base` does not resolve to a commit |
| 404 `DIFF_WORKSPACE_NOT_FOUND` | no attempt worktree for the task on this device (never ran here, or gc'd after 24 h) |
| 409 `GIT_CONFIG_UNSAFE` | the worktree's repository config holds non-allowlisted keys; `details.keys` = key **names** only |
| 500 `DIFF_FAILED` | any other git failure; no stderr, paths or config values in the body (logged server-side) |

Concurrent requests for the same (task, base, worktree) share one computation (the UI polls every 4 s while a run is live).

### Workspace resolution and authorization

1. **legacy live** — the in-memory legacy execution (`getExecutionStatus`): worktree, branch, owner, default branch.
2. **v2** — the newest valid `run_attempts` row of the durable journal through a **read-only** `node:sqlite` connection (constructing `DurableRunJournal` would write), JSON columns validated with the run schemas; used only while the worktree exists. Owner = `user_id`.
3. **legacy disk** — finished legacy runs: today's legacy clones sit on `openlinear/<random uuid>`, named only by the run's own log. The route reads the task's persisted log **under the caller's credential** (`store.readPersistedLogs`, control-plane authorized), takes the newest sidecar-written `info` line `Branch created: openlinear/<segment>` (agent output is type `agent` and never matches), and scans `<repos>/worktrees/*` (≤ 500 entries) reading `.git`/`HEAD` files directly — no git, no symlinks followed, `gitdir:` must resolve inside the repos root. Older checkouts on `openlinear/<taskId[0..8]>` are matched too. Owner unknown → control-plane `full` access required.

Only the run's principal may read a diff whose owner is known (403 otherwise) — the diff is local, possibly uncommitted work on this device. Owner shortcut needs no control-plane round trip, so review works offline for your own runs.

## 3. Security of diff generation (the worktree is agent-controlled)

- **Only the hardened helpers.** Every git call goes through `execGit` (W09a `-c` overrides, env allowlist with global/system config off and a private HOME, repository-config scan). Every argv starts with `-C <worktree>` so the scan always runs (`gitWorkingDirectory` only scans then).
- **No programs from the repo.** `--no-ext-diff --no-textconv` on every diff; `diff.external=` (hardening); planted `diff.<x>.textconv/command`, `filter.<x>.clean/process` in the repo config → the scan refuses → **409 `GIT_CONFIG_UNSAFE`, nothing runs**. In-tree or `.git/info/attributes` drivers without config do nothing; drivers configured in a planted global config / `HOME/.gitconfig` / `GIT_CONFIG_GLOBAL` are ignored (env allowlist + `GIT_CONFIG_GLOBAL=/dev/null`). `--ignore-submodules=all` (no git runs inside nested repos with their own, unscanned config).
- **No network.** After the hardening prefix (which allows https for fetch/push) every transport is re-disabled (`protocol.{allow,file,git,http,https,ssh,ext}.allow=never`): a blobless mirror can never lazy-fetch from a diff. Proven with a real blobless mirror: `transport 'file' not allowed`, nothing fetched, 500.
- **No writes to the agent's repo.** `--no-optional-locks` + `diff.autoRefreshIndex=false` (measured: `--no-optional-locks` alone still rewrote `.git/index` and took `index.lock` on stat-dirty files — that would collide with the agent's or publication's `git add`). Stat-only entries are dropped from the listing.
- **Deterministic headers, no path parsing.** File list + exact counts from `--raw --numstat -z`; patch sections matched by order and checked against the exact header git prints (`core.quotePath=true`, fixed `a/` `b/` prefixes); paths never parsed out of patch text.
- **Untracked files read safely.** Path inside the worktree, no `..`, parent directory must be its own realpath (no symlinked parent, re-checked after reading), final component `O_NOFOLLOW`, `fstat` dev/ino must match the `lstat`, FIFOs/sockets/devices skipped (`O_NONBLOCK`), ≤ 512 KiB per file, ≤ 16 MiB total per response; a symlink shows its **target string** (as git records it) — a planted `link → ~/.ssh/id_rsa` never reveals the file.
- **Bounded.** maxBuffer/timeouts on every call; patch cut at 8 MiB is parsed partially and flagged; per-line, per-file and total line budgets.
- **Rendered as text.** The UI decodes defensively (`normalizeTaskDiff`) and renders lines as React text nodes only — no `dangerouslySetInnerHTML` anywhere in the kit; a test renders `<img onerror>`/`<script>` lines and asserts no element is created.

## 4. Follow-up contract (consumed; sidecar side by another engineer)

`POST /api/tasks/:id/follow-up` `{ message, comments?: [{ path, line?, side?: 'old'|'new', body }] }` → `202 { runId, attemptId, state }`.

- The composer sends **all** drafts (sorted by file, line) plus the message; with comments only, the message defaults to "Please address the review comments below."
- Accepted → the sent drafts are removed from storage (also when the panel unmounted meanwhile: `forgetSentDrafts`), a toast confirms, and the task detail switches back to **Details** with the run shown as *Queued* until the new attempt reports in (`startRequested` overlay on `TaskRunSection`).
- Never retried automatically. Drafts are kept on every failure:

| Response | Copy (components/review/review-errors.ts, layered over lib/api/errors.ts) |
|---|---|
| 404 **without a code** (Express "route not found") | "Update OpenLinear to use this — this version of the local execution service can't send review follow-ups…" |
| 409 `RUN_ACTIVE` | "The agent is still working on this task — wait for the run to finish (or stop it)…" (Send is also disabled while the run is live) |
| 409 `FOLLOW_UP_UNSUPPORTED` | "This run can't take a follow-up" + the server's reason |
| 404 `TASK_NOT_FOUND` | "This task no longer exists, or you lost access to it" |
| 400 validation | first field error from the shared map |
| 503 `SANDBOX_UNAVAILABLE` | shared copy (blocked instead of running unprotected) |
| 503 `CLOUD_API_UNREACHABLE` / network | "Can't reach OpenLinear to verify your session" / "The local execution service isn't reachable" (retryable) |

## 5. UI design (`apps/desktop-ui/components/review/**`)

Layout: header (base ← head, `+ uncommitted`, file/line totals, Unified|Split, refresh) · left sidebar (Checks + gate + publish actions, then the Files tree) · virtualized diff · composer docked at the bottom. Opened from a **Details | Review changes** tab pair in the task-detail header; the review panel is mounted on first open and kept, the Details panel stays mounted (hidden) so the run model keeps streaming.

| Piece | Notes |
|---|---|
| `model/rows.ts` | Pure O(lines) flattening: file / hunk / line (unified) or pair (split) / notice / thread rows; split pairs removal runs with the following additions; context lines anchor to the new side in both views; orphaned comments collected at the end of their file. 20,000 lines build in ≈1 ms (jsdom). |
| `model/syntax.ts` | Syntax-light, no dependency: per-line scanner for comments, strings, numbers, keywords by extension (JS/TS, C-family, Go, Rust, Python, Ruby, shell, CSS, SQL, JSON/YAML/TOML, markup). Lines > 2,000 chars stay plain. |
| `diff-viewer.tsx` | `@tanstack/react-virtual`, measured rows, overscan 12, sticky current-file label, `scrollPaddingStart`. Roving focus with one tab stop; the focused row is always rendered (the range extractor changes identity per tab stop, so a focus move renders its row even without a scroll). |
| `file-tree.tsx` | ARIA `tree`: compressed single-child directories, status letter + label (A/M/D/R/B), `+N −M`, draft count, `aria-current` for the file at the top of the diff. |
| `comment-thread.tsx` | Drafts with edit/delete, "Outdated" when written against another revision and the line text changed, editor (⌘/Ctrl+Enter save, Esc cancel). |
| `review-composer.tsx` | Draft list (jump/remove), message, Send, live status region. Warns when localStorage refuses writes. |
| `checks-panel.tsx` | Gate summary (`role=status`), required checks then "Info" checks, verification sub-checks, publish actions, explicit override. |
| `model/drafts.ts` | Per-task localStorage `openlinear:review-drafts:v1:<taskId>`; corrupt/foreign values read as empty; ≤ 100 comments, ≤ 8,000 chars each, message ≤ 16,000; cross-window `storage` sync. |
| `use-review-data.ts` | TanStack Query hooks (diff, run state, follow-up mutation) and the drafts hook. |

**Keyboard** (documented in the header and via `aria-keyshortcuts`): `j`/`k` next/previous file, `n`/`p` next/previous hunk (from anywhere in the panel except text fields), `↑`/`↓` rows, `Home`/`End`, `c` (or Enter on a line) comment on the focused line, Enter on a file header collapses it, Esc cancels an editor — and **only** the editor: `reviewConsumesEscape` is wired into the sheet's `onEscapeKeyDown` like the timeline's. Tree: arrows / Home / End / Enter. Tabs: ←/→.

**Screen readers**: file headers are level-3 headings named "File <path>, modified, 6 added, 3 removed, 1 draft comment, expanded"; hunk headers "Change 2 of 5 in <path>, old lines 40–43, new lines 41–45"; every line row "added line 12 of <path>: <text>"; split rows name both halves. Status never by colour alone (letters, icons, words, ± signs). Comment buttons are mouse affordances (`tabIndex=-1`, labelled); the keyboard path is `c`.

**Focus**: shared `focusRing` / `focusRingInset` everywhere (no hand-written rings). **Reduced motion**: spinners/skeletons `motion-safe:` only; no smooth scrolling.

**Colours** (per the coordinator's design-token note): every colour lives in `components/review/diff-colors.ts` as **semantic classes + opacity** (`text-foreground/70`, `bg-primary/[0.12]`, `bg-destructive/[0.12]`, `text-destructive`, …) — no hex/arbitrary and no raw palette classes anywhere in the kit (a test scans the directory). Roles: TEXT (primary/secondary/muted), TONE (success/danger/warning/info), DIFF_LINE_BG/GUTTER, SYNTAX_TEXT, FILE_STATUS_MARK, CHECK_TONE, BUTTON. Contrast is asserted against the base theme values: code, syntax, gutter and hunk text ≥ 4.5:1 on context/added/removed/gutter surfaces; text roles ≥ 4.5:1 on panel surfaces. **Exception**: the base `--destructive` red is ~3.5:1 (≈3.0:1 on a selected row); danger text is only a `−N` count, the "D" mark or a word next to an icon — map `TONE.danger` to the verified danger token at merge. The base theme has no warning token: warning = neutral highlight + warning icon (map `TONE.warning`).

### Data layer

- Keys (`lib/query/keys.ts`): `queryKeys.tasks.diff(taskId, base)` = `['ol','tasks','detail',taskId,'diff',{base}]` (prefix `diffs(taskId)`), `runState(taskId)` = `['ol','tasks','detail',taskId,'run']`. Under the task's detail key, so `task:deleted` cleanup and reconnect resyncs include them.
- **Head sha / revision**: a refetch that returns the same `revision` + `head.sha` + `base.sha` keeps the cached object (custom `structuralSharing`), so polling re-renders nothing when nothing changed; drafts and the publish override are bound to the revision. (Decision: the head sha is not *in* the key because it is only known from the response; the revision identity gives the same per-head caching.)
- Freshness: live run → `staleTime 0`, poll every 4 s; otherwise 15 s. Invalidated (no cancel of in-flight) on `execution:progress` for the task with a run boundary status (`cloning`, `committing`, `creating_pr`, `done`, `error`, `cancelled`) or any `runState`, and on `task:updated` to done/cancelled; also after a follow-up is accepted. Retries follow the shared policy, never for a missing route.
- Run state (`GET /api/tasks/:id/run`, now in `SIDECAR_ROUTES` — it was missing): 404 (`RUN_NOT_FOUND` or older sidecar) = "no v2 run" (`null`), polled every 5 s while live.

## 6. Gating rules (`components/review/model/checks.ts`)

Required checks — all must pass for **Create PR on GitHub** / **Merge on GitHub**:

| Check | Passes when | Otherwise |
|---|---|---|
| Agent run | live phase → running; else the v2 terminal state, else the run phase, is `succeeded` | failed (cancelled, failed, `recovery_required`, `abandoned`), pending (never ran), warning (unknown) |
| Verification | the run reports `verification.status = passed` **for the displayed commit** and the workspace isn't dirty | `missing` ("didn't report verification checks") — today's default, W11 not built; `stale` (checks ran on another commit, or uncommitted changes since); failed / running / pending from the report |
| Review comments | no unsent draft comments | warning ("2 draft comments haven't been sent to the agent") — Conductor's "blocks merging while todos remain" |

Informational: Branch & pull request (from run effects / outcome), Uncommitted changes, Diff size (truncated).

- Gate: **open** (all required pass) · **pending** (only running/pending) · **blocked**. Summary names the blocking checks.
- **Override**: an explicit checkbox ("I reviewed this diff and want to publish without passing checks. Applies to this revision only."), bound to the diff `revision`: a changed diff clears it (tested). Never available while the agent is working. The enabled action is relabelled "… anyway" and styled distinctly.
- Actions: a confirmed PR → "Merge on GitHub" opens the PR; a pushed branch (compare link) → "Create PR on GitHub" opens the compare page; nothing pushed → disabled with the reason. (No in-app create/merge API exists; both open GitHub.)
- Forward-compatible verification shape decoded from the run state: `run.verification = { status: 'passed'|'failed'|'running'|'pending'|'skipped'|'error', commit?: sha, checks: [{ name, status, summary?, url? (https only) }] }` — a proposal for W11.

## 7. Tests

| File | Tests | Covers |
|---|---|---|
| sidecar `services/review/diff-parser.test.ts` | 22 | hunk numbering, add/del/no-newline, CRLF, line/file/total budgets, listing parse (raw+numstat, renames, binary), section alignment, `buildDiffArgs` flags (`--no-ext-diff`, `--no-textconv`, `--ignore-submodules=all`, network off, `-C` first) |
| sidecar `services/review/git-diff.realgit.test.ts` | 22 | committed+staged+unstaged+untracked vs merge-base after origin advances; clean HEAD; rename with edits; binary (added/modified/untracked); 30k-line file capped with exact totals; maxFiles; maxPatchBytes partial parse; untracked symlink to an outside secret shows only the target; FIFO; explicit base (sha / unsafe / unknown); `.sisyphus` excluded; revision stable and index never rewritten; empty repo; no remotes; origin/HEAD and fork point; blobless mirror never lazy-fetches; **planted payloads (a) repo-config drivers/filters → 409, nothing runs; (b) global/HOME/env drivers, filters and `diff.external` → ignored, real content shown, nothing runs; (c) `.git/info/attributes` → nothing runs** — each with a plain-git live trigger proving the payload is real |
| sidecar `services/review/workspace-resolver.test.ts` | 17 | live wins; v2 journal (owner, baseRef fallback), gone worktree falls through, corrupt rows skipped, a real `DurableRunJournal` read while its writer is open; legacy scan (`.git` file/dir, relative gitdir, CRLF), no match for v2 branches / detached / symlinked `.git` / gitdir outside root; **branch from the persisted log** (agent lines ignored, unsafe names refused, unreadable log still scans) |
| sidecar `routes/task-diff.test.ts` | 12 | 200 shape; owner served without control plane; mismatch 403; unknown owner → `full` authorization and its 403; 404; 409 keys only; 400s; 500 without stderr; single-flight; unrelated `/api/tasks` paths untouched |
| `components/review/model/model.test.mjs` | 19 | normalizer (hostile text stays text, malformed entries dropped, envelope errors, run state + https-only links); rows (unified, split pairing, threads/editor/orphans, collapse, j/k/n/p targets, 20k-line build budget, excerpts); syntax; drafts (round trip, corrupt/throwing storage, limits, reducer); follow-up plan; file tree |
| `components/review/model/checks.test.mjs` | 9 | gate blocked/open/pending, stale verification, drafts block, agent busy (no override), terminal-state precedence, override bound to revision, no pushed branch, effects |
| `components/review/review-panel.test.mjs` | 27 | header/tree/diff; **j/k/n/p/↑/↓ roving focus**; tree Enter + j/k; collapse; hostile text; split + preference; **`c` → editor → Ctrl+Enter draft persisted per task, focus returns, survives remount**; Esc cancels; **send all drafts + message → contract body, drafts cleared, run handed over**; **follow-up failures (404-no-code, RUN_ACTIVE, FOLLOW_UP_UNSUPPORTED, SANDBOX_UNAVAILABLE, CLOUD_API_UNREACHABLE, validation) keep drafts**; Send disabled while live; **gate: override required, applies to one revision; open with passing verification; drafts block; Merge never while the agent works**; diff unavailable states (workspace missing, never ran, old sidecar, unsafe config keys, other principal); empty live diff |
| `components/review/task-detail-review.test.mjs` | 3 | tabs mount the panel on demand and keep Details mounted; ←/→ between tabs; Esc in an editor doesn't close the sheet; a sent follow-up switches to Details and shows *Queued* |
| `components/review/review-kit.test.mjs` | 6 | no hex/raw-palette classes in the kit; contrast of every role on the diff and panel surfaces; error copy; Escape ownership |
| `components/review/diff-viewer.bench.test.mjs` | 1 + opt-in | **always on: 5,000 changed lines → ≤ 80 rendered rows, < 2,500 DOM nodes while scrolling to 25/50/75/100 % and after 30 `n` presses** |
| `lib/api/routes.test.mjs` | +12 cases | the four review request functions in both runtimes land on the sidecar; route-table rows for diff / follow-up / run; look-alike paths stay cloud |

### Benchmark (opt-in)

```sh
REVIEW_BENCH=1 pnpm --filter @openlinear/desktop-ui exec vitest run components/review/diff-viewer.bench.test.mjs
# REVIEW_BENCH_LINES=20000 to scale
```

jsdom + React dev build, 5,000 changed lines (10 files × 500, hunks of 50), 720 px viewport: normalize p50 0.2 ms; build rows p50 0.6 ms; mount until the tree renders 26 ms; scroll frame p50 13 ms / p95 28 ms; keyboard nav p50 0.9 ms / p95 1.8 ms; split toggle 49 ms; **max DOM nodes 1,039**. Relative numbers only (shared machine, dev build).

## 8. Validation (this worktree, final tree)

| Check | Result |
|---|---|
| Root `pnpm typecheck` | **10/10** tasks successful |
| Root `pnpm lint` (biome, curated list + the 3 new sidecar paths) | **234 files, clean** |
| `pnpm --filter @openlinear/sidecar test` | 61 files, **1017 passed + 3 skipped** (baseline 944 + 3; +73 new). One earlier full run had a single timing failure in `runners/claude-code/index.test.ts` (untouched code; passed alone and on every rerun) |
| `pnpm --filter @openlinear/desktop-ui test` | Vitest 60 files + 2 skipped, **908 passed + 3 skipped** (baseline 828 + 2; +80 new, +1 skip = the opt-in review bench). Fonts: `ok desktop font fallback config`. Scroll gate: 3/3 passes, p95 16.8 ms, max 16.8 ms, 0 long tasks |
| `pnpm --filter @openlinear/desktop-ui build` | success, 20/20 static pages; `next-env.d.ts` rewritten by the build and restored |
| Strict TS | no `any`, `as any`, `@ts-ignore`/`@ts-expect-error`; no `dangerouslySetInnerHTML` in the kit |
| Colour rule (coordinator) | no hex/arbitrary or raw palette colour classes under `components/review/**` (asserted by `review-kit.test.mjs`); the task-detail tab lines added use semantic classes only |

## 9. Decisions

- **Diff = base vs working tree**, not vs the branch tip: during a run the agent's changes are uncommitted; after publication they're committed; both show. `head.dirty` says which.
- **Refuse rather than sanitize unsafe config**: hashing worktree files can run clean filters, so `GIT_CONFIG_UNSAFE` (409) is the only safe answer; the UI explains it and names the keys.
- **Only the run's principal** reads a diff with a known owner (stricter than logs' owner-or-full-access) — local uncommitted work; owner-unknown legacy checkouts fall back to control-plane `full` access.
- **Finished legacy runs via the persisted log** (the only durable task→branch link the legacy flow writes), read under the caller's credential.
- **Unsent drafts block publishing**, like Conductor's todos; override still possible.
- **Verification "not reported" blocks** until an explicit override — honest about W11 not existing yet, never "green by default".
- **Create/Merge open GitHub** (no in-app PR/merge API exists).
- **Errors mapped in the kit** (`review-errors.ts`) instead of adding codes to `lib/api/errors.ts` (board's file) — falls through to the shared map for everything else.
- **No Idempotency-Key on follow-up**: not in the contract; never retried automatically; a duplicate while the first runs gets `409 RUN_ACTIVE`.

## 10. Leftovers

1. **Follow-up sidecar route** is another engineer's; the UI is ready and degrades to "update the app" until it lands.
2. **W11 verification**: the gate consumes `run.verification` (shape above) but nothing emits it; until then verification is "not reported" and publishing needs the override.
3. **CI / GitHub checks** (Conductor's Checks tab: Actions, deployments, PR comments) need an API proxy for check runs — not available.
4. **Legacy local-path projects** (the user's own checkout) are found only while the run is live (no durable task→path record); v2 local paths work through the journal.
5. **Worktree lifetime**: `gcLocalWorktrees` deletes worktrees after 24 h, after which the panel says the workspace is gone (and the PR is the record).
6. **Draft anchors** follow line numbers; a comment whose line moved shows "Outdated" (excerpt mismatch) or under "lines no longer in this diff". No content-based re-anchoring.
7. **AI review** (Conductor's Review action) and agent-side `DiffComment` tools are not built.
8. **Line wrapping** is on (pre-wrap) instead of horizontal scrolling; very long lines are cut server-side at 1,000 chars and flagged.
9. Base theme `--destructive` is below 4.5:1 for text (see colours); fixed by the token merge mapping `TONE.danger`.
10. Screenshot harness lives in `components/review/dev/` (`.jsx`/`.mjs`, outside tsc and vitest); it borrows esbuild from the sidecar's toolchain.

## 11. Merge hazards

| File | Hazard |
|---|---|
| `apps/sidecar/src/app.ts` | one import + `app.use('/api/tasks', taskDiffRouter)` **before** the execution router (the diff router authenticates only its own route) |
| root `package.json` | three paths appended to the biome `lint` list (`apps/sidecar/src/services/review`, `routes/task-diff.ts`, `routes/task-diff.test.ts`) |
| `apps/desktop-ui/lib/api/routes.ts` + `routes.test.mjs` | 3 `SIDECAR_ROUTES` rows (`GET …/diff`, `POST …/follow-up`, `GET …/run`), the "documents every sidecar route" list, route-table cases, `review` module + CASES rows. The follow-up engineer may add the same follow-up row — keep one |
| `apps/desktop-ui/lib/query/keys.ts` | `tasks.diffs`, `tasks.diff`, `tasks.runState` added |
| `apps/desktop-ui/components/task-detail-view.tsx` | imports (`focusRing`, `isLivePhase`, review kit), Details/Review tablist in the header, review tabpanel + details tabpanel wrapper (`hidden`), `activityRef`, `startRequested={… || followUpPending}`, `reviewConsumesEscape` in `onEscapeKeyDown`, task-change reset. Tab classes are semantic (`border-border`, `bg-foreground/10`, `text-foreground/70`) |
| `components/review/diff-colors.ts` | the single place to remap review colours to the design-token system (success/danger/warning) |
| Cross-ownership imports (read-only) | `components/board/{execution-outcome,keyboard-guards}`, `components/execution/{task-run-section}` (via task-detail), `lib/run-model` (`isLivePhase`, `RunPhase`), `lib/api/{fetch,errors}`, `lib/query/{client,keys,use-app-query-client}`, `providers/sse-provider`, `sandbox/git-hardening`, `services/git-credentials`, `run/types`, `journal/durable`, `persistence/store` |
| `run/**` journal schema | the resolver reads `run_attempts.{task_id,user_id,workspace_json,snapshot_json,created_at}` read-only; a column rename there needs a one-line change here |
