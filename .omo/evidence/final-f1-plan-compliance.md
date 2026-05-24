# F1 — Plan Compliance Audit

```
Must Have [16/17] | Must NOT Have [13/16] | Tasks [48/48] | Evidence [62/48] | VERDICT: REJECT
```

**Date**: 2026-05-06
**Auditor**: F1 (oracle plan-compliance)
**Plan**: `.sisyphus/plans/openlinear-80-percent.md`

---

## Headline

Implementation is materially complete (all 48 tasks committed, all named deliverables on disk, API + sidecar typecheck clean, schema models migrated, security routes hardened, brand assets shipped, landing copy purged). However, **3 explicit "Must NOT Have" guardrails are violated** and **1 typecheck target fails**, which the plan's Must-Have list requires to pass implicitly via the build/run criterion. Verdict is **REJECT** pending small fixes — none touch architecture, all fixable in <30 min.

---

## 1. Must Have — Evidence

| # | Item | Evidence | Status |
|---|------|----------|--------|
| 1 | Auth + team-scope on POST/PATCH/DELETE `/api/tasks` | `apps/api/src/services/ownership.ts` exists; `apps/api/src/routes/tasks.ts` uses `requireAuth` + `assertTaskOwned`; commit `66ee3c6`; evidence `task-7-unauth-rejected.txt`, `task-7-cross-tenant-rejected.txt`, `task-7-archived-scoped.txt` | ✅ |
| 2 | Shell injection eliminated in git.ts/worktree.ts | `grep -rEn 'execAsync\(\`\|exec\(\`' apps/sidecar/src/services/execution/git.ts apps/sidecar/src/services/worktree.ts` → 0 matches; `apps/sidecar/src/services/execution/exec.ts` exports `execFileAsync`; commit `867c895`; evidence `task-6-injection-blocked.txt`, `task-6-no-token-leak.txt`, `task-6-happy-path.txt` | ✅ |
| 3 | Single `apiFetch()` wrapper used everywhere | `apps/desktop-ui/lib/api/fetch.ts` exists; commit `72c38b4`; evidence `task-3-no-module-capture.txt` | ⚠️ See REJECT-1 (2 stragglers) |
| 4 | 401 clears token + redirects to /login | `apiFetch` dispatches `auth:expired`; `hooks/use-auth.tsx` listens; evidence `task-3-qa-scenarios.txt` | ✅ |
| 5 | Comment + Notification + AgentRun + ActivityLog models | `grep -E "^model (Comment\|AgentRun\|Notification\|ActivityLog) " packages/db/prisma/schema.prisma` → 4 matches; commit `88dbd92`; evidence `task-1-migration-success.txt` | ✅ |
| 6 | `assigneeId` + `creatorId` on Task; my-issues filters | schema.prisma:114-119 + indexes 130-131; commit `6af55e0`; evidence `task-32-assignee.txt` | ✅ |
| 7 | Cmd+K command palette with global search | `apps/desktop-ui/components/command-palette.tsx`; commit `bd3b498`; evidence `task-25-palette.txt` | ✅ |
| 8 | Markdown rendering on tasks + comments | commit `ecd48dc`; evidence `task-26-markdown.txt` | ✅ |
| 9 | Theme switcher functional (dark/system) | commit `f8d412d` (theme batch); evidence `task-29-theme.txt` | ✅ |
| 10 | `prefers-reduced-motion` respected | commit `8dacbb6` + `22da6de`; evidence `task-21-css-diff.txt`, `task-24-animations.txt` | ✅ |
| 11 | `focus-visible` 2px accent ring | commit `22da6de`; evidence `task-21-css-diff.txt` | ✅ |
| 12 | SVG logomark + wordmark + favicon + Tauri icon set | `apps/desktop-ui/public/brand/{logomark,wordmark}.svg` exist; commits `f374471`, `117d517`; evidence `task-5-tauri-icons.txt`, `task-5-logomark-sizes.png`, `task-34-logo-svg.txt`, `task-35-tauri-icons.txt` | ✅ |
| 13 | Domain unified to `openlinear.tech` | `grep -rn 'openlinear\.dev' apps/landing/` → 0 matches; commit `2310987` | ✅ |
| 14 | `kaizen403` handle replaced everywhere user-visible | `grep -rin "kaizen403"` → only in `.sisyphus/plans/` and `.sisyphus/notepads/` (plan history, not user-visible); zero user-visible refs; commit `5b6f39b`; evidence `task-41-handle.txt` | ✅ |
| 15 | Landing copy: zero Zep/Mem0, zero fake stats, footer links resolve | grep for `zep\|mem0\|google drive\|onedrive` in `apps/landing/` → 0 matches; commits `810710a`, `2310987`; evidence `task-39-copy.txt`, `task-40-footer.txt` | ✅ |
| 16 | App Router error boundaries (loading.tsx/error.tsx/not-found.tsx) | All 3 files exist at `apps/desktop-ui/app/`; commit `4495952`; evidence `task-43-boundaries.txt` | ✅ |
| 17 | Final container builds/runs smoke test | API typecheck PASS; sidecar typecheck PASS; **desktop-ui typecheck FAIL** (see REJECT-3) | ❌ |

**Score: 16/17**

---

## 2. Must NOT Have — Violations

| # | Guardrail | Result | Status |
|---|-----------|--------|--------|
| 1 | No `as any` / `@ts-ignore` introduced | **1 violation** in `apps/sidecar/src/routes/opencode.ts:196` | ❌ REJECT-2 |
| 2 | No `console.log` in production code | **20+ violations** in sidecar (see REJECT-4) | ❌ |
| 3 | No `window.confirm` / `window.alert` / `window.prompt` | grep clean | ✅ |
| 4 | No raw `localStorage.getItem('token')` outside `apiFetch()` | **2 violations** (sidebar.tsx:198, inbox/page.tsx:141) | ❌ REJECT-1 |
| 5 | No new direct `fetch()` in pages — must go through `apiFetch()` | Spot-checked OK | ✅ |
| 6 | No new raw hex color literals | grep for `bg-\[#\|text-\[#\|border-\[#` in components/app → 0 matches | ✅ |
| 7 | No `exec()` with shell interpolation in git.ts/worktree.ts | grep clean | ✅ |
| 8 | No new endpoints without auth + ownership | Spot-checked tasks/comments/notifications/activity → all use `requireAuth` + ownership helpers | ✅ |
| 9 | No new module-level `getApiUrl()` captures | Per `task-3-no-module-capture.txt` — clean at audit time | ✅ |
| 10 | No deferring of security tasks (T6, T7, W2.1, W2.2) | All committed (`867c895`, `66ee3c6`, `b08e37f`, `9289d9d`) | ✅ |
| 11 | No light theme | Dark/system only — confirmed | ✅ |
| 12 | No file attachments | Not added | ✅ |
| 13 | No cycles/roadmap/templates | Not added | ✅ |
| 14 | No Tauri Rust changes | Not touched | ✅ |
| 15 | No OpenCode binary bundling | Not added | ✅ |
| 16 | No "fix everything in one mega-task" | All 48 tasks bounded with separate commits | ✅ |

**Score: 13/16**

---

## 3. Tasks (48/48)

48 implementation commits since baseline (T1=`88dbd92` through T48=`a81b72d`). All 48 plan checkboxes marked `[x]`. The 11 unchecked boxes in the plan are the Definition-of-Done meta-items + the F1-F4 review tasks themselves (this audit being one), not implementation tasks.

## 4. Evidence (62/48)

`ls .sisyphus/evidence/ | wc -l` → 62. All `task-N-*` slots filled for N=1..48 (some tasks have multiple files, e.g. `task-1-migration-success.txt` + `task-1-email-unique-error.txt`).

## 5. Concrete Deliverables — file existence audit

| Plan deliverable | File | Status |
|------------------|------|--------|
| `apiFetch()` wrapper | `apps/desktop-ui/lib/api/fetch.ts` | ✅ |
| Design tokens module | `apps/desktop-ui/lib/design-tokens.ts` | ✅ |
| Brand SVG logomark | `apps/desktop-ui/public/brand/logomark.svg` | ✅ |
| Brand SVG wordmark | `apps/desktop-ui/public/brand/wordmark.svg` | ✅ |
| `execFileAsync` helper | `apps/sidecar/src/services/execution/exec.ts` | ✅ |
| Ownership helper | `apps/api/src/services/ownership.ts` | ✅ |
| Comments API | `apps/api/src/routes/comments.ts` | ✅ |
| Search API | `apps/api/src/routes/search.ts` | ✅ |
| Notifications API | `apps/api/src/routes/notifications.ts` | ✅ |
| Activity Log API | `apps/api/src/routes/activity-log.ts` (plan said `activity.ts` — same surface, different filename) | ✅ |
| Cost analytics page | `apps/desktop-ui/app/usage/page.tsx` | ✅ |
| Command palette | `apps/desktop-ui/components/command-palette.tsx` | ✅ |
| Error boundaries | `apps/desktop-ui/app/{loading,error,not-found}.tsx` | ✅ |
| Schema migrated | `packages/db/prisma/schema.prisma` (Comment/AgentRun/Notification/ActivityLog + assigneeId/creatorId/parentId + indexes) | ✅ |

---

## REJECT items (with file:line + remediation)

### REJECT-1 — `localStorage.getItem('token')` outside `apiFetch()` (Must Have #3 + Must NOT #4)

**Files**:
- `apps/desktop-ui/components/layout/sidebar.tsx:198` — reads token to build EventSource URL for `/api/events` (SSE notification stream)
- `apps/desktop-ui/app/inbox/page.tsx:141` — `readToken()` helper for SSE EventSource

**Why it slipped**: Both are EventSource consumers. `apiFetch` does HTTP only; native `EventSource` cannot attach Authorization headers, so the codepath chose query-string token. The plan does not exempt SSE.

**Remediation** (Quick, ~15 min): Either
1. Add `getAuthToken()` exported from `lib/api/fetch.ts` and call it from these two sites (centralised access still goes through one module — satisfies the spirit), OR
2. Extract `createAuthedEventSource(path)` into `lib/api/sse.ts` and have both sites use it.

Option 2 is cleaner; bundles the lazy-URL + token-attach pattern that `apiFetch` enforces.

### REJECT-2 — `as any` introduced in sidecar (Must NOT #1)

**File**: `apps/sidecar/src/routes/opencode.ts:196`

```ts
allProviders.push({
  id: 'opencode',
  name: 'OpenCode',
  models: {},
} as any);
```

**Remediation** (Quick, ~5 min): Type the pushed object against the `OpenCode SDK Provider` type or define a local `type ProviderListEntry = typeof providerList.data.all[number]` and cast to that, or use `satisfies ProviderListEntry`. Since `models` is `{}` it likely needs `Record<string, never>` or the actual `ModelMap` type — check the SDK type.

### REJECT-3 — desktop-ui typecheck FAILS (Must Have #17, smoke-build criterion)

**File**: `apps/desktop-ui/components/ui/command.tsx:33`

```
error TS2322: Type 'ReactNode' is not assignable to type 'React.ReactNode'.
  Property 'children' is missing in type 'ReactElement<...>' but required in type 'ReactPortal'.
```

**Cause**: React 19 type duplication — `cmdk`/`@radix-ui` packages bundle a different `@types/react` version, producing two incompatible `ReactNode` types in the same graph.

**Remediation** (Short, ~30 min):
1. Pin a single `@types/react` version via `pnpm.overrides` in root `package.json`:
   ```json
   "pnpm": { "overrides": { "@types/react": "19.2.7" } }
   ```
2. Run `pnpm install` to dedupe.
3. If issue persists, wrap the offending portal child in `<>{child}</>` or add an explicit `ReactNode` import alias from one canonical location inside `command.tsx`.

### REJECT-4 — `console.log` in sidecar production code (Must NOT #2)

**Files (sample, 20+ total)**:
- `apps/sidecar/src/routes/execution.ts:33,37,180,183,191,196`
- `apps/sidecar/src/services/worktree.ts:34,40,44,47,53,77,80,97,118,122,133,163,172,179` (and more)

**Why it slipped**: T4 added `pino` to API + sidecar `app.ts`, but execution/worktree services were authored pre-pino and never migrated. They use a `[Worktree]`/`[Tasks]` prefix convention as a poor-man's structured log.

**Remediation** (Short, ~1h):
1. Export a `logger` from `apps/sidecar/src/lib/logger.ts` (pino instance).
2. Replace `console.log(\`[Worktree] X\`)` → `logger.info({ component: 'worktree' }, 'X')` via codemod or hand-edit.
3. ast-grep replace pattern:
   ```
   console.log(`[$NAME] $MSG`)  →  logger.info({ component: '$NAME' }, `$MSG`)
   ```
   (Note: needs `.toLowerCase()` on $NAME or post-fix.)

---

## Recommendation

**Do not approve until REJECT-1, REJECT-2, REJECT-3 land.** Total effort: **~1 hour**.

REJECT-4 (console.log) is technically a guardrail violation but is **low risk in a Tauri-bundled sidecar** (logs go to stderr regardless). Recommend either:
- (a) Fix in this audit cycle for clean compliance (~1h), or
- (b) File as a P2 follow-up ticket with explicit waiver — pino infrastructure already exists, so the migration is mechanical and doesn't change behaviour.

Everything else lines up with the plan. Schema migrated, security holes closed, brand identity shipped, landing truthful, 48/48 task commits visible in `git log`, evidence trail complete (62 files for 48 tasks).

After REJECT-1/2/3 fixes, re-run:
```bash
grep -rn "localStorage.getItem('token')" apps/desktop-ui/components/ apps/desktop-ui/app/   # expect 0
grep -rn "as any\|@ts-ignore" apps/api/src apps/sidecar/src apps/desktop-ui/{lib,components,hooks,providers,app}   # expect 0
pnpm --filter @openlinear/desktop-ui typecheck   # expect exit 0
```

Then this verdict flips to **APPROVE**.
