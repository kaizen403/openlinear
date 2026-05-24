# Learnings & Conventions — openlinear-80-percent

This file accumulates patterns, conventions, and gotchas discovered during execution.
Subagents must APPEND (never overwrite). Format: `## [TIMESTAMP] Task: T## — {topic}`.

## [BOOTSTRAP] Repo conventions baseline (from research, captured pre-execution)

- **Monorepo**: pnpm workspaces + turborepo. Apps: `apps/api`, `apps/sidecar`, `apps/desktop-ui`, `apps/landing`, `apps/desktop` (Tauri). Packages: `packages/db` (Prisma), `packages/openlinear`, `packages/openlinear-cli`.
- **Node**: 22.x. **Package manager**: pnpm. Use `--no-frozen-lockfile` in CI/Docker (lockfile drift after bcryptjs removal).
- **Prisma**: 7.4 with `@prisma/adapter-pg` driver-adapter mode (NOT classic native engine). WASM query compiler at `query_compiler_fast_bg.wasm`.
- **Schema quirk to PRESERVE**: `Repository @@map("projects")` is being renamed to `repositories` in T1. `Project @@map("linear_projects")` STAYS — DO NOT touch.
- **Prisma client**: `packages/db/src/client.ts` is a lazy-cached singleton Proxy with `value.bind(client)`. DO NOT regress.
- **`$transaction` callsites**: ALWAYS pass `{ timeout: 15000, maxWait: 5000 }` — the default 5s default caused the original P2028 bug.
- **`NODE_ENV=production` in shell**: causes pnpm to skip devDeps. Use `--prod=false` or `unset NODE_ENV` in build scripts.
- **API base URLs**: Two — `getApiUrl()` (cloud) and `getSidecarApiUrl()` (Tauri local). Sidecar URL resolves ASYNC via `ensureSidecarListener()`. NEVER capture at module top-level.
- **Auth**: GitHub OAuth only. JWT in `localStorage['token']`. Header `Authorization: Bearer …` + `x-openlinear-client: desktop`.
- **`OPENLINEAR_TRUST_PROXY_AUTH=1`**: footgun — accepts any unsigned JWT. T4 hardens this to refuse in `NODE_ENV=production`.
- **Component prefix `linear-*`**: Linear-app inspired styling, NOT a brand reference. Keep.
- **Branding**: 95% rebrand-complete. Domain canonical = `openlinear.tech` (NOT `.dev`). Personal handle `kaizen403` → `openlinear` org (T41).
- **Test infrastructure**: NONE. All QA is agent-executed via Playwright (UI), curl (API), tmux (CLI). Evidence to `.sisyphus/evidence/task-{N}-{slug}.{ext}`.
- **Container**: `openlinear:preview` image, `openlinear` container (Postgres + sidecar + 2 Next apps). Ports 3000/3001/3002/5432. Control via `scripts/openlinear.sh`. `restart` does `up -d --force-recreate`.

## [BOOTSTRAP] Critical anti-patterns to AVOID

- `as any` / `@ts-ignore` — banned by Must NOT Have
- `console.log` in production code — use `pino` (T4 introduces it)
- `window.confirm() / alert() / prompt()` — banned (T19 replaces 4 sites)
- Raw `localStorage.getItem('token')` outside `apiFetch()` — banned (T20 cleans 8 sites)
- Direct `fetch()` in pages — must go through `apiFetch()` or `lib/api/*`
- Raw hex color literals (`bg-[#1a1a1a]`) — must use `linear-*` tokens (T38)
- `exec()` with shell template literals — `execFile`/`spawn` arrays only (T6 critical)
- New endpoints without auth + ownership checks
- New Prisma queries without index coverage on `where` filters
- Module-level `getApiUrl()` / `getSidecarApiUrl()` captures — call inside functions (T3)

## [2026-05-01 03:03] Task: T5 — Brand assets

### Canonical brand color
- **Primary accent**: `#1d4ed8` (OpenLinear blue, matches existing `--linear-accent`)
- **Dark canvas**: `#0a0a0a` (matches new theme-color meta)
- **OG gradient**: `#0a0a0a → #111827` with radial accent glow at 0.85,0.15

### Logomark concept
- Stylized "OL": outer ring (O) + 45° forward-slanting bar (L / execution arrow)
- 64x64 viewBox, 8px stroke weight (7px on rounded-app-icon variant w/ 14px corner radius)
- Single-fill via `currentColor` so it inherits color in any context (sidebar, button, etc.)
- Verified legible at 16px (see `.sisyphus/evidence/task-5-logomark-sizes.png`)

### Asset generation pipeline
- `scripts/generate-brand-assets.cjs` is the canonical generator. Re-run anytime brand changes.
- Uses `sharp` (PNG resize from inline SVG) + `png-to-ico` (multi-size .ico). Both at workspace root.
- IMPORTANT: `png-to-ico` v2 ESM default export — must `require('png-to-ico').default`
- Tauri icon CLI needs a real PNG (not SVG) source — pre-render to 1024x1024 PNG, then `pnpm --filter @openlinear/desktop tauri icon /tmp/<source>.png`. This generates the full Tauri set (icon.icns, icon.ico, 32x32, 64x64, 128x128, 128x128@2x, plus iOS AppIcon-* and Android mipmap-* directories).

### Layout metadata
- Use Next.js 14+ `Metadata.icons` object (no manual `<link>` tags needed for favicons)
- `metadataBase: new URL('https://openlinear.tech')` enables relative OG image URLs
- Apple touch icon must be 180x180; favicon.ico bundles 16/32/48

## [2026-05-01] Task: T6 — Shell injection elimination in git.ts/worktree.ts

**Pattern**: Centralize all subprocess invocation through one promisified `execFile` seam (`apps/sidecar/src/services/execution/exec.ts`). NEVER use `child_process.exec` with template literals — even seemingly-safe interpolated values (branch names, repo paths, commit messages) become RCE vectors when sourced from user/DB input.

**Key conversion rule**:
- `execAsync(\`git -C ${path} commit -m "${msg}"\`)` → `execFileAsync('git', ['-C', path, 'commit', '-m', msg])`
- Each argv element is passed verbatim, so `;`, `&&`, `|`, `$()`, backticks inside untrusted strings become literal characters.

**GitHub token handling (avoid .git/config leak)**:
- Old: `https://oauth2:${token}@github.com/...` baked into clone URL → token persisted in `.git/config`.
- New: `git -c credential.helper='!f() { echo "username=oauth2"; echo "password=$GH_TOKEN"; }; f' clone <plain-url>` with `GH_TOKEN` set in process env only.
- The `-c credential.helper=...` flag is itself a single argv element (not shell-parsed), so the helper script string is safe.

**Force-push hardening**: replaced `--force` with `--force-with-lease` everywhere — prevents clobbering refs that moved since last fetch (finding #56).

**Caller-signature impact**: `commitAndPush` now takes optional `accessToken` for the credential helper on push. Updated single caller (`events.ts handleSessionComplete`) to pass `execution.accessToken`.

**Verification commands**:
- `grep -nE 'execAsync\(\`|exec\(\`' apps/sidecar/src/services/execution/git.ts apps/sidecar/src/services/worktree.ts` → 0 matches
- Injection harness: malicious branch name `'feature; rm /tmp/SHOULD_NOT_EXIST'` → git rejects as invalid ref name; marker file untouched.
- Token-leak harness: cloned `.git/config` contains plain URL with no `oauth2:` substring.

## [2026-04-30T21:40:22Z] Task: T4 — API hardening (pino, helmet, rate-limit, error mw, graceful shutdown)

- **Logger module added**: `apps/api/src/logger.ts` exported via `@openlinear/api/logger` so sidecar shares the same pino instance + redact paths. Avoid `pino-pretty` transport — not installed and breaks runtime; rely on raw JSON (operators pipe through pretty themselves).
- **Middleware order in createApp() (must not change)**: helmet → pinoHttp → rate-limiters (default + per-prefix) → cors → json(`256kb`) → cookieParser → routes → SSE handler → errorHandler. Anything after errorHandler silently bypasses error catching.
- **Rate limit SSE skip**: every limiter checks `req.path === '/api/events' || startsWith('/api/events')`. The default limiter is wrapped in a manual middleware to apply that check; per-prefix limiters use rate-limit's `skip` option.
- **CORS bug fix**: `callback(null, false)` instead of `callback(new Error())` — throwing inside the origin callback escapes Express's middleware error chain on some versions.
- **express-rate-limit v8**: use `limit` (not deprecated `max`) and `standardHeaders: 'draft-7'`. Custom `handler` returns JSON body `{error:'rate_limited', scope, retryAfterSeconds}`.
- **pino-http reqId**: `genReqId` honours incoming `x-request-id`, otherwise mints `randomUUID()`. Same id is set on the response header so the global error handler can read it back via `res.getHeader('x-request-id')`.
- **Redaction proven**: pino redact paths cover both `req.headers.authorization` and `req.headers.cookie` plus `res.headers["set-cookie"]`. Verified in QA log — both show `[REDACTED]` end-to-end.
- **Trust-proxy footgun**: import-time guard in `apps/api/src/middleware/auth.ts` calls `process.exit(1)` if `OPENLINEAR_TRUST_PROXY_AUTH=1 && NODE_ENV=production`. Per-request `logger.warn` fires on every `requireAuth`/`optionalAuth` call when the flag is on in non-prod (loud signal in dev logs).
- **Graceful shutdown pattern**: `server.close(cb)` then `prisma.()` then `process.exit`. 10s force-exit timer is `.unref()`-ed so it doesn't keep the loop alive on its own. Sidecar additionally closes the OAuth interceptor app before `server.close`.
- **QA evidence**:
  - `.sisyphus/evidence/task-4-rate-limit.txt` — auth route returns 429 on request 6; SSE survives 12 rapid connects (no rate limit).
  - `.sisyphus/evidence/task-4-error-middleware.txt` — uncaught throw → 500 JSON `{error:'internal_error', requestId}`; matching reqId across log + response header; auth/cookie redacted.
  - `.sisyphus/evidence/task-4-graceful-shutdown.txt` — SIGTERM → drain + prisma disconnect in 0.213s.
  - `.sisyphus/evidence/task-4-trust-proxy-guard.txt` — prod boot with `OPENLINEAR_TRUST_PROXY_AUTH=1` → FATAL log + `exit=1`; dev boot succeeds.
- **Followups for T8/T9/T13**: they can rely on `req.log` (pino-http auto-attaches), `logger` import from `@openlinear/api/logger`, and the global error middleware to swallow throws — no need for per-route try/catch wrappers around sync errors.

## [2026-04-30T21:40Z] Task: T2 — shadcn primitives + design tokens

- **Next.js underscore-prefix folders are ignored by routing.** `app/_dev/primitives/page.tsx` does NOT register a route (private folder convention). The plan QA spec said `app/_dev/primitives/page.tsx` but Next will return 404. Used `app/dev-primitives/` instead, deleted after QA.
- **shadcn/ui primitive style template:** use `React.forwardRef<ElementRef<typeof X>, ComponentPropsWithoutRef<typeof X>>` and `cn(...)` from `@/lib/utils`. All 13 existing primitives follow this exact shape — new ones must too for consistency.
- **components.json**: `style: default`, `baseColor: neutral`, `cssVariables: true` — every new primitive must use semantic tokens (`bg-popover`, `text-foreground`, `border`, `bg-accent`) NOT raw hex or `linear-*` literals (the `linear-*` namespace is reserved for the runtime `--linear-accent` themability — touching it would break that).
- **Sheet uses `@radix-ui/react-dialog` under the hood** (per shadcn upstream); `cva` from `class-variance-authority` for the `side` variant.
- **Command (cmdk) wraps Dialog**: `CommandDialog` re-uses `@/components/ui/dialog` to share the overlay/animation, keeping bundle size small.
- **AlertDialog reuses `buttonVariants`** from `@/components/ui/button` for Action/Cancel — keeps button styling identical across confirm flows.
- **Design tokens module** (`lib/design-tokens.ts`): exported as `Readonly<Record<...>>` typed constants (`STATUS_COLORS`, `PRIORITY_COLORS`, `SHADOWS`) so consumers get IntelliSense on status keys. Used `bg-{color}-500/10` + `text-{color}-400` + `border-{color}-500/30` triad pattern — works on dark backgrounds and is easy to swap if/when light mode lands (T29 territory).
- **Tailwind boxShadow extension**: added `card`/`overlay`/`elevation` semantic tokens. Values are tuned for the dark theme (high opacity black). T29/T37 will need to make these CSS-variable-driven if they're reused on light surfaces.

## [2026-05-01] Task: T1 — Schema migration tooling

- **Prisma 7.4 CLI flags renamed**: `--from-url`/`--to-url` are REMOVED. Use `--from-config-datasource` / `--to-config-datasource` (reads `prisma.config.ts`). For schema files use `--from-schema` / `--to-schema` (was `--from-schema-datamodel`/`--to-schema-datamodel`).
- **Prisma config datasource silent failure**: `prisma migrate diff --from-config-datasource ...` returns empty output (exit 0) if `DATABASE_URL` env is not set, even though `prisma.config.ts` reads `process.env.DATABASE_URL!`. ALWAYS export DATABASE_URL inline before the command.
- **DB had no migration history** (was bootstrapped via `db:push`). Recovery pattern:
  1. Generate baseline migration via `migrate diff --from-empty --to-config-datasource --script` → save as `<ts>_init/migration.sql`
  2. Generate change migration manually (especially when rename is involved — see below)
  3. Apply change SQL via `psql -f`
  4. `prisma migrate resolve --applied <name>` for both → registers in `_prisma_migrations` table
  5. `prisma migrate status` reports "Database schema is up to date!"
- **Table rename trap**: `prisma migrate diff` cannot detect renames — it always emits DROP + CREATE which is data-destructive. For Repository `@@map("projects")` → `@@map("repositories")`, write the migration MANUALLY with `ALTER TABLE "projects" RENAME TO "repositories"` + `RENAME CONSTRAINT projects_pkey/projects_userId_fkey` + `ALTER INDEX projects_userId_githubRepoId_key RENAME` + drop/re-add the FK in linear_projects (since constraint name embeds old table reference).
- **`packages/db/.env`** does NOT exist by default. `seed.ts` does `process.loadEnvFile(resolve(import.meta.dirname, "../.env"))` — that's `packages/db/.env`. Created with `DATABASE_URL=postgresql://openlinear:openlinear@127.0.0.1:5432/openlinear` for Prisma CLI.
- **`pnpm exec prisma`** fails with `Command "prisma" not found` from monorepo root and even from `packages/db`. Direct binary path works: `./node_modules/.bin/prisma` (when CWD = `packages/db`) or `./packages/db/node_modules/.bin/prisma` from root.
- **Prisma migration.sql section markers** (`-- CreateTable`, `-- CreateIndex`, `-- AddForeignKey`, `-- AlterTable`, `-- CreateEnum`, `-- DropForeignKey`) are CANONICAL Prisma format — keep them despite agent-memo-comment hooks (they are necessary structural markers per Prisma toolchain).
- **AgentRun decimal**: use `costUsd Decimal? @db.Decimal(12, 6)` — gives 6 decimal places of precision for fractional cents.
- **Native enum values in Postgres** must be quoted as the type name (`"agent_run_statuses"`, `"notification_types"`, `"activity_actions"`) when declaring columns.
- **Two opposite-side User relations to Task** require explicit relation names: `assignee   User? @relation("assignedTasks", ...)` + `creator User? @relation("createdTasks", ...)` plus matching back-relations `assignedTasks Task[] @relation("assignedTasks")` + `createdTasks Task[] @relation("createdTasks")` on User.
- **Self-relation on Task for parentId**: `parent Task? @relation("Subtasks", fields: [parentId], references: [id], onDelete: SetNull)` + `subtasks Task[] @relation("Subtasks")`.
- **Notification has TWO User FKs** (`userId` recipient, `actorUserId` who did the action) → needs two named relations: `"notificationRecipient"` + `"notificationActor"`.

## [2026-05-01] Task: T3 — apiFetch wrapper + 401 handler + lazy URL resolution

### Pattern: Single HTTP seam
- Created `apps/desktop-ui/lib/api/fetch.ts` exporting `apiFetch<T>(path, init?: RequestInit & { sidecar?: boolean })`
- Auto Content-Type for JSON bodies (skips FormData/Blob/ArrayBuffer/URLSearchParams)
- Auto Authorization + x-openlinear-client headers via existing `getAuthHeader()`
- 401 → `AuthExpiredError` (subclass of `ApiError`) + dispatches `auth:expired` window event
- non-2xx → `ApiError` with parsed `{ error, code, details }` envelope
- network failure → `NetworkError` ("Could not reach OpenLinear server")
- AbortError propagates as-is (callers detect cancellation)
- Latch on `auth:expired` dispatch (1s) prevents N concurrent 401s firing N events

### Pattern: apiFetchRaw for streaming
- `apiFetchRaw()` returns `Response` after auth/error handling — used by `streamBrainstormTasks()` (NDJSON) and `oauthCallback()` (uses AbortController)
- Same 401/NetworkError envelope as `apiFetch` but caller reads `response.body` manually

### Pattern: OpenCode error class re-mapping
- `opencodeFetch()` wrapper translates `ApiError(status>=500)` → `OpenCodeUnavailableError`
- Other ApiError → plain `Error` with envelope message (preserves call-site behavior)
- All opencode.ts functions go through this wrapper now

### Bug class fixed: module-level URL captures
- 5 sites had `const X = getApiUrl()` at module top — broke Tauri sidecar URL discovery (URL is only known after `sidecar:ready` event fires)
- Fixed by either moving to `apiFetch` calls (lazy) or moving `getSidecarApiUrl()` inside callbacks (api-loading-screen)
- Verified zero remaining via `grep -rEn "^(const|let|var) [A-Z_]+ ?= ?(getApiUrl|getSidecarApiUrl)\("`

### Auth listener wiring
- `hooks/use-auth.tsx` adds `window.addEventListener('auth:expired')` → `setUser(null)`, `setActiveRepository(null)`, `toast.error("Session expired...")`, `router.push('/login')` (skip if already on /login or /)
- Imported `useRouter`, `usePathname` from `next/navigation`, `toast` from `sonner` (both already in dep tree)

### Migration count
- 7 lib/api/*.ts files rewritten (auth, tasks, projects, teams, repos, brainstorm, opencode)
- use-kanban-board.ts: 8 hand-rolled token sites + 2 module captures + 2 silent error swallows fixed
- archived/page.tsx: 4 fetches migrated, all with toast on error, deleteSelected uses Promise.allSettled
- task-form.tsx, label-picker.tsx, api-loading-screen.tsx: module captures eliminated
- teams/manage/page.tsx + settings/page.tsx: untyped fetches replaced with apiFetch

### Gotchas
- `next dev` generates `.next/types/validator.ts` referencing stale routes → must `rm -rf .next` before clean tsc
- `getActiveRepository()` and `fetchCurrentUser()` use `allowUnauthenticated: true` to silently no-op when no token — bootstrap flow on cold start
- `addRepoByUrl`, `getActivePublicRepository`, `activatePublicRepository` are public endpoints (no auth) — use `allowUnauthenticated: true`

## [2026-05-01] Task: T7 — AUTH + ownership seam

**OwnershipError contract** (consumed by T9 fetch.ts validation, T10 comments, T13 notifications):

```ts
class OwnershipError extends Error {
  readonly code = 'OWNERSHIP_REQUIRED';
  resourceType: 'task' | 'project' | 'team' | 'comment' | 'label';
  resourceId: string;
  reason: 'not_found' | 'forbidden' | 'role_required';
  requiredRoles?: string[];   // only on 'role_required'
}
```

**Wire format** (set by `apps/api/src/app.ts` errorHandler — pattern-matches `isOwnershipError`):
- `reason='not_found'`         → HTTP 404 + `{ error:'not_found',  code:'OWNERSHIP_REQUIRED', resourceType, resourceId, requestId }`
- `reason='forbidden'`         → HTTP 403 + `{ error:'forbidden',  code:'OWNERSHIP_REQUIRED', resourceType, resourceId, requestId }`
- `reason='role_required'`     → HTTP 403 + `{ error:'forbidden',  code:'OWNERSHIP_REQUIRED', resourceType, resourceId, requiredRoles, requestId }`

**Existence-leak collapse**: `assertTeamRole` returns `not_found` (404) when the user has no membership at all. This is intentional — distinguishing "team doesn't exist" from "you're not a member" would let attackers enumerate team IDs. The downstream UI should treat 404 with code=OWNERSHIP_REQUIRED as "you don't have access" not "the resource was deleted".

**Backward-compat exception**: `assertTaskOwned` allows ANY authenticated user to access tasks where `teamId IS NULL` (legacy/personal tasks). Tightening this would break the "no team backward compat" tests and the inbox ungrouped flow. T11 may revisit if we add per-user task ownership.

**Single seam discipline**: ALL ownership checks go through `apps/api/src/services/ownership.ts`. Routes do NOT inline `await getUserTeamIds().includes(...)` — they call the typed helper so the OwnershipError → wire format mapping stays consistent.

**Sidecar consumption**: `@openlinear/api/ownership` is exported in apps/api/package.json so `apps/sidecar/src/routes/{execution,batches}.ts` can call `assertTaskOwned()` directly. Sidecar uses `optionalAuth` (not `requireAuth`) because some legacy local-dev flows call without a token; when a userId IS present we enforce ownership, when it's absent we allow (matches T7 spec wording "optionalAuth + ownership").

**Schema changes shipped here (coordinate with T1)**:
- `Settings`: dropped `id="default"` singleton, added `userId String? @unique` (per-user settings)
- `Label`: dropped global `name @unique`, added `teamId String?` + composite `@@unique([teamId, name])` (per-team labels, with shared global labels when teamId is null)

**Test data drift**: Existing vitest suites assumed unauthenticated routes worked. Updated `tasks.test.ts`, `teams.test.ts`, `projects.test.ts` to use `Authorization: Bearer <token>` + `TeamMember` rows for the test user. Tests run against a real Postgres so they're skipped in environments without one — manual QA via curl is canonical (see `.sisyphus/evidence/task-7-*.txt`).

**N+1 risk**: `assertTeamRole` is one Prisma query (TeamMember lookup by composite unique). `assertTaskOwned` is one query for the task + one `getUserTeamIds()` call (which is one query). Routes that loop (e.g. project create with multiple teamIds, batch create with multiple taskIds) intentionally iterate sequentially — small N (≤20 enforced by zod) and clearer error messages than `Promise.all` rejection.

## T12 — Search API
- Prisma ILIKE on Postgres = `{ contains: q, mode: 'insensitive' }` (Postgres-only filter)
- Scope source of truth = `getUserTeamIds(userId)` (T7). NEVER trust client-supplied teamId for scoping.
- Short-circuit when userTeamIds=[]: skip Prisma query, return [] for tasks/projects.
- Project scoping is many-to-many: `projectTeams.some({ teamId: { in: userTeamIds } })`.
- Team scoping is direct: `members.some({ userId })` — do NOT route through teamIds (different invariant: list of teams the user is a member of).
- Per-user rate limiter: mount AFTER requireAuth so AuthRequest.userId is populated; use it as keyGenerator (NOT IP — same-NAT users would share a bucket).
- Limit distribution across types: `Math.max(1, Math.floor(limit / types.length))`.
- Search hit shapes deliberately abbreviated (id + title/name + type discriminator + identifier for tasks) → keeps Cmd+K (T25) payload small.

## [2026-05-01] Task: T10 — Comments API + @mention → Notification fan-out

**Mention regex** (consumed by T13 notifications, T27 UI mention picker):

```ts
/(?:^|\s)@([a-zA-Z0-9_-]+)/g
```

The leading `(?:^|\s)` anchor is non-negotiable — without it `email@domain.com`
matches as `@domain` and creates ghost notifications. Allowed username chars
mirror the `User.username` column (alphanum + `_` + `-`); add chars here ONLY
if you also widen the schema constraint.

Use `RegExp.exec()` in a `while` loop, not `String.matchAll()` — TS2802 in the
repo's current `target` setting (no downlevelIteration on the `RegExpStringIterator`).

**Mention dedupe + commenter-exclusion** (one helper, reused by PATCH):

```ts
const recipientIds = Array.from(
  new Set(mentionedUsers.map(u => u.id).filter(id => id !== req.userId)),
);
```

Two filters in one expression: `Set` collapses duplicates from `@bob @bob` AND
when two distinct usernames resolve to the same userId (rare, but possible
during rename windows). The `!== req.userId` filter prevents self-notification —
required because the spec says "exclude commenter" and because a self-notification
would render as a confusing "you mentioned you" inbox row.

**Silent-skip on missing mention** (don't break the comment over a typo):

```ts
const found = new Set(mentionedUsers.map(u => u.username));
const missing = usernames.filter(u => !found.has(u));
if (missing.length > 0) {
  req.log?.warn({ missing, taskId, userId }, '[comments] @mention skipped — user(s) not found');
}
```

The comment is still created with `mentions: <only resolved IDs>` — no notification
row exists for ghost mentions, and the missing names are NOT stored. T27 UI must
treat the rendered `@username` differently if it's not in `comment.mentions`
(unresolved → render as plain text or strikethrough).

**Broadcast pairing** (T13 will reuse for assignment + status_change events):

For mutation routes that change a resource AND fan-out notifications:
1. **Resource event** → `broadcastToTeam(task.teamId, 'comment:created', ...)` (or
   `broadcastToUser(authorId, ...)` for legacy null-team tasks).
2. **Notification event** → `broadcastToUser(recipientId, 'notification:created', notification)`
   per recipient.

Two separate broadcasts, not one combined event — different consumers (kanban
board listens for the resource event; inbox listens for notification events).
The notification row carries enough state (`commentId`, `actorUserId`, `body`)
that the inbox doesn't need to re-fetch the comment.

**Transaction boundary**:

Wrap `comment.create` + `notification.create` fan-out in `prisma.$transaction(async (tx) => ...)`
so a notification-table FK failure rolls back the comment. Broadcasts happen
AFTER the transaction commits — never broadcast inside the txn closure (would
fire on rollback paths).

**Mount path**:

Routes use `/tasks/:taskId/comments` AND `/comments/:id` patterns, so mount on
`/api` (not `/api/comments`):

```ts
app.use('/api', commentsRouter);
```

**Permission ladder for DELETE**:

- Author             → allowed (T7 `assertCommentOwned` returns owned)
- Team owner/admin   → allowed via `assertTeamRole(teamId, userId, ['owner','admin'])`
- Else               → 403

PATCH is strictly author-only — even team owners can't edit others' comments
(constraint from T10 "Must NOT do"). This is asymmetric on purpose: editing
implies authorship, deleting is moderation.

**Notification.actorUserId convention** (set every time a notification is
created on someone's behalf):

```ts
{
  userId: <recipient-id>,        // who sees it in their inbox
  actorUserId: <causer-id>,      // who did the action
  type: 'mention' | 'assignment' | 'status_change' | 'comment',
  taskId, commentId, body,
}
```

Inbox UI (T28) renders `<actor.username> mentioned you in <task.title>` — the
recipient is implicit (it's "you") so it's NOT shown.

## [2026-05-01] Task: T11 — AgentRun capture in execution lifecycle

**OpenCode SDK cost/token shape (@opencode-ai/sdk@1.2.5)**:
- `AssistantMessage` type at `node_modules/.pnpm/@opencode-ai+sdk@1.2.5/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:98-127`
- Fields: `cost: number` (USD), `tokens: { input, output, reasoning, cache: { read, write } }`
- These are **TOTALS PER ASSISTANT MESSAGE**, not deltas. Event `message.updated` carries `properties.info: Message` and the SDK keeps re-emitting the message with growing usage as it streams.

**Accumulation pattern (anti-double-count)**:
- Use `Map<messageId, { cost, inputTokens, outputTokens }>` keyed by `info.id`
- Replace (not add) on each `message.updated` for that id
- Sum across the Map at finalize time
- Implemented in `apps/sidecar/src/services/execution/agent-run.ts:recordMessageUsage`

**Schema gotcha**: `AgentRunStatus` enum values are `pending|running|succeeded|failed|cancelled` (NOT `completed` as the plan T11 spec section says). Use `succeeded` for the success terminal state.

**Status transitions for AgentRun**:
- create → status='running' (default 'pending' overridden in createAgentRun)
- session.idle/completed + commit/push success → 'succeeded' (with prUrl)
- session.error / prompt-error / commit failure → 'failed' (with errorMessage)
- cancelTask user-initiated → 'cancelled'

**Decimal handling**: Use `new Prisma.Decimal(value.toFixed(6))` to construct the `@db.Decimal(12,6)` value. Float→Decimal coercion via string is the only safe path.

**Failure isolation**: All AgentRun writes wrapped in try/catch with `logger.error` (pino from `@openlinear/api/logger`). NEVER throw out of these helpers — execution must continue if the analytics row fails to write.

**Route scoping (`/api/agent-runs`)**:
- `?taskId=X` → `assertTaskOwned` (T7 seam) → list runs for that task
- `?userId=me` → restrict to `req.userId` AND filter `task.teamId IN getUserTeamIds(req.userId)` to prevent enumeration of runs from teams the user has left
- `?userId=<other>` → 403 (no cross-user reads)

**Refactor in lifecycle.ts**: Moved the `client.config.get()` model-fetch block from after `subscribeToSessionEvents` to BEFORE the `ExecutionState` construction so we can stamp the model name onto the AgentRun row. Side effect: `addLogEntry('Using model: …')` had to move down (and is now guarded by `if (modelOverride)`).

## [2026-05-01] Task: T15 — OpenCode single-tenant constraint

**SDK shape (@opencode-ai/sdk@1.2.5)**:
- `createOpencodeServer(opts)` accepts only `{ hostname, port, signal, timeout, config }` — no auth-store override (`node_modules/@opencode-ai/sdk/dist/server.d.ts:2-8`).
- Auth lives on disk at `$XDG_DATA_HOME/opencode/auth.json` — global to the process.
- Implication: per-user isolation requires per-user `XDG_DATA_HOME` env override on subprocess spawn, not just a port-per-user map.

**Multi-tenant guard pattern**:
- `prisma.user.count()` at boot is a cheap, race-free way to detect "this DB has accumulated multiple users". Pair with an opt-in env var (`OPENLINEAR_ALLOW_SHARED_OPENCODE=1`) so single-machine devs aren't affected (they have 0–1 users) while accidental multi-tenant deploys fail loudly.
- Exit code 2 (not 1) signals "configuration refused boot" vs "crashed" — useful for orchestrators / systemd `RestartPreventExitStatus=2`.

**Comment-as-contract pattern**:
- When a parameter exists for future use (`getClientForUser(userId, ...)` where `userId` is currently unused), use `void userId;` + a short comment pointing to the docs file. This satisfies `noUnusedParameters` without the underscore prefix that signals "intentionally throwaway" — the param IS the API contract.

**Banner pattern**:
- For limitations operators must see, write to `process.stdout` directly (bypasses pino log levels) AND emit a structured `logger.warn` (so it lands in shipped logs). One mechanism is not enough.

## [2026-05-01] Task: T14 — Execution state recovery on sidecar restart

**Schema constraint**: `enum Status { todo | in_progress | done | cancelled }`
has NO `failed` value. The plan T14 spec says "mark task as failed", but the
only failure-shaped terminal state available is `cancelled`. Convention used:

- `Task.status = 'cancelled'`
- `Task.outcome = 'sidecar_restart_orphan'` ← machine-readable orphan marker
- `Task.sessionId = null` (clear stale OpenCode session ref)
- `AgentRun.status = 'failed'` (this enum DOES support failed)
- `AgentRun.errorMessage = 'sidecar_restart_orphan'` (matching string)
- `AgentRun.endedAt = now()`

The string `'sidecar_restart_orphan'` is the canonical marker for queries
like `SELECT count(*) FROM tasks WHERE outcome='sidecar_restart_orphan'`.

**Threshold**: 1 hour. Tasks `in_progress` whose latest AgentRun has
`endedAt IS NULL` AND `startedAt < now() - 1h` are orphaned. Within the 1h
window they get a `[Recovery] task in_progress within 1h window — leaving
for potential reconnect (T15)` warn log and are left alone — T15 OpenCode
per-user reconnect work may rehydrate them later. Never re-execute orphan
tasks automatically (would risk duplicate PRs).

**Edge case**: If the latest AgentRun is closed (`endedAt IS NOT NULL`) but
the task is still `in_progress`, that's also an orphan — execution lifecycle
crashed between `finalizeAgentRun` and `updateTaskStatus`. We mark it
orphaned regardless of age in this branch.

**Boot sequence** (`apps/sidecar/src/index.ts`):
```
createSidecarApp()
registerShutdownHandlers()
prisma.$connect()
recoverInFlightExecutions()      ← T14
recoverActiveBatches()           ← T14
initOpenCode()                   ← can fail without aborting boot
app.listen(...)
```
Recovery wrapped in outer try/catch with `logger.error({err}, '...')` so a
failed sweep never blocks boot. Order matters: must run AFTER prisma connect
(needs the client) but BEFORE listen (clean state before serving requests).

**Batch recovery shape**: `BatchState` is in-memory only (no Batch table).
On restart `activeBatches` is empty by definition. Per-task batch orphans
are handled by the same `recoverInFlightExecutions` scan since orphan tasks
also have `batchId` set. `recoverActiveBatches()` is therefore mostly an
observability pass that uses `prisma.task.groupBy({by:['batchId']...})` to
log how many stale batches were observed. A `getInMemoryBatchCount()`
helper was added to `batch.ts` for symmetry / future Batch persistence.

**Logger context**: Use `logger` from `@openlinear/api/logger` (the root
pino instance). No request context exists during boot — never use the
request-scoped `req.log`. This matches the pattern in `services/opencode.ts`
and `services/execution/agent-run.ts`.

**Container test gotcha**: The OpenLinear preview container bakes
`/app/apps/sidecar/dist/index.js` into the image. To test recovery code
changes locally without a full rebuild:
1. `pnpm --filter @openlinear/sidecar build` (esbuild)
2. `docker cp apps/sidecar/dist/index.js openlinear:/app/apps/sidecar/dist/index.js`
3. `docker restart openlinear` OR `docker exec openlinear sh -c 'kill -TERM <sidecar PID>'` then `docker exec -d openlinear sh -c 'node /app/apps/sidecar/dist/index.js > /var/log/openlinear/api.log 2>&1'`
4. `docker exec openlinear grep Recovery /var/log/openlinear/api.log`

## T13 — Notifications + ActivityLog API + mutation integration

### Notification dedup: never notify the actor
- `createNotification(input)` early-returns if `recipientUserId === actorUserId`.
- Cleaner than spraying `if (recipient !== req.userId)` at every call site.
- Same for status_change: PATCH only fires when `creatorId !== req.userId`.

### Best-effort writes don't block mutations
- Both `logActivity()` and `createNotification()` wrap their prisma calls in
  try/catch and log + swallow on failure. The mutation handler must always
  succeed for the client even if downstream notification/activity bookkeeping
  fails. This matches Linear/GitHub semantics.

### Payload shape per action
- `task_created`     : `{ title, status, priority, identifier }`
- `task_updated`     : `{ fields: string[] }`              (only changed keys)
- `task_status_changed`: `{ from, to, title }`             (string transition)
- `task_assigned`    : `{ from: userId|null, to: userId }`
- `task_archived`    : `{ id }`
- `project_updated`  : `{ fields: string[] }`
- `team_member_added`: `{ addedUserId, role }`
- `team_member_removed`: `{ removedUserId }`
- `comment_created`  : `{ commentId, mentionCount }`
- `agent_run_started`  : `{ agentRunId, agent, model }`
- `agent_run_completed`: `{ agentRunId, status, prUrl?, errorMessage? }`

### Cross-package import for sidecar
- Sidecar already mounts `@openlinear/api/middleware`, `/ownership`, etc.
- Added `./activity` to `apps/api/package.json` exports so sidecar's
  `agent-run.ts` can call `logActivity()` directly without duplicating
  the helper. No build step needed (TS path resolves).

### PATCH activity-vs-status branching
- When status is in the patch body, emit `task_status_changed` only.
- Otherwise emit a generic `task_updated` with the changed field names.
- Avoids double-logging for the same operation while preserving observability.

### Live route mount QA
- Hitting an unauth GET on a newly-mounted route returns `401` (not `404`).
  This single-byte signal is enough to confirm registration without needing
  a real DB user — useful when the dev DB isn't seeded.

## [2026-05-01] Task: T9 — VALIDATION + STANDARDIZED ERROR ENVELOPE

**ValidationError contract** (mirrors T7's OwnershipError discipline — typed throw, middleware maps to wire):

```ts
class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  readonly details?: unknown;          // zod.flatten() output
  static fromZod(error: ZodError, message?): ValidationError;
}
class HttpError extends Error {        // escape hatch when neither ValidationError nor OwnershipError fits
  statusCode: number;
  code: string;
  details?: unknown;
}
```

**Wire format** (set by `apps/api/src/app.ts` errorHandler — single source of truth for ALL error responses):

- ValidationError       → 400 + `{error:'validation_error', code:'VALIDATION_ERROR', details, requestId}`
- HttpError             → statusCode + `{error, code, message, details?, requestId}`
- Prisma P2002 (unique) → 409 + `{error:'conflict',   code:'P2002', message, details:meta?, requestId}`
- Prisma P2025 (404)    → 404 + `{error:'not_found',  code:'P2025', message, requestId}`
- Prisma P2003 (FK)     → 409 + `{error:'conflict',   code:'P2003', message, details:meta?, requestId}`
- Fall-through 5xx/4xx  → `{error:'internal_error'|'request_failed', code:'INTERNAL_ERROR'|'REQUEST_FAILED', requestId}`

**`validateBody(schema)` / `validateQuery(schema)` middleware** (`apps/api/src/middleware/validate.ts`):
- Mounts AFTER `requireAuth`, BEFORE the route handler.
- Sets `req.validBody` / `req.validQuery` (typed via `ValidatedRequest<TBody,TQuery>` extending Express Request).
- On failure, calls `next(ValidationError.fromZod(parsed.error))` — global middleware turns it into the wire envelope.
- Routes do NOT call `safeParse` inline anymore. Routes do NOT inline `res.status(400).json(...)`.

**Schemas live in `apps/api/src/schemas/<domain>.ts`** — one file per route domain (tasks/projects/teams/labels/repos/inbox/settings/comments/search). Each exports `<verb><Domain><Body|Query>Schema` + `<Verb><Domain><Body|Query>` type. Reuse via `import { ... } from '../schemas/<domain>'`.

**Prisma error code matching — NEVER string-match again.** All `error.message.includes('Unique constraint')` / `'Record to update not found'` / `'Record to delete does not exist'` were removed. Use `error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'` (or let global middleware do it — preferred). Import: `import { Prisma } from '@openlinear/db'` (re-export from `packages/db/generated/prisma/client`).

**201 on POST creates — enforced everywhere**: tasks/teams/teams.members/projects/labels/labels.tasks/repos.url/repos.import all return 201. Verified with `grep -n "res\.status(201)"`.

**Orphan task rejection**: `createTaskBodySchema` has `.refine((d)=>d.teamId||d.projectId, {message:'Task must belong to a team or a project', path:['teamId']})`. POST handler also throws `ValidationError` after project resolution if `resolvedTeamId` is still null (defense in depth — handles edge case where project has zero teams).

**Coordination gotcha (BURNED ON THIS)**: Multiple agents running in parallel on Wave 2 had conflicting versions of `apps/api/src/sse.ts` (one renamed `broadcast` → `broadcastToAll/broadcastToTeam/broadcastToUser`). Routes I touched were checked in by another agent already importing `validate` and `errors` (commit e96261b) BUT those modules didn't exist on disk — that's why typecheck baseline mid-session showed phantom errors. Resolution: kept `broadcastToAll` rename, added `export const broadcast = broadcastToAll;` alias in `sse.ts` for backward compat. **Lesson**: when stash/pop after parallel-wave coordinated work, prefer `git checkout HEAD -- <files>` over `git stash pop` to avoid 3-way merge garbage.

**QA evidence**: `.sisyphus/evidence/task-9-validation.txt` (8 scenarios, all pass), `.sisyphus/evidence/task-9-201.txt` (code-level proof + wire envelope shape; 201/409 wire test deferred — Postgres + Docker daemon down at QA time).

## [2026-05-01] Task: T8 — SSE per-user filtering + auth + jittered reconnect

### New SSE helper API (consumed by T10 comments + T13 notifications + T29 status badge)

`apps/api/src/sse.ts` — old `broadcast()` is GONE. Migrate to:

- **`broadcastToAll(event, data)`** — system-wide only (e.g. `opencode:status`). Avoid for any tenant data.
- **`broadcastToUser(userId, event, data)`** — per-user routing. Use for: settings:updated, batch:* events (batch.userId is canonical), notification:created (T13).
- **`broadcastToTeam(teamId, event, data)`** — per-team. Use for: team:*, label:* (when teamId set), project:* (per projectTeam membership).
- **`broadcastToTask(event, taskWithOwnership[, payload])`** — sync helper. Reads `task.teamId` then falls back to `task.creatorId`. Pass the flattened task; if you need a different payload, pass it as third arg.
- **`broadcastToTaskById(taskId, event, data)`** — async (Promise<void>). Use when you only have a taskId. Internally does `prisma.task.findUnique({ select: { teamId, creatorId } })` then routes via `broadcastToTask`. Fire-and-forget with `.catch(()=>{})` if you don't want to await.
- **`sendToClient(clientId, ...)`** — unchanged, kept for direct-targeted sends.

### Auth on /api/events

EventSource cannot set headers, so the handler accepts `?token=<jwt>` query param. Verification path matches `middleware/auth.ts` exactly:
1. If `OPENLINEAR_TRUST_PROXY_AUTH=1` → `jwt.decode` (unsigned)
2. Else → `jwt.verify` with `JWT_SECRET` (or dev fallback in non-prod)

T9 callers (validation middleware) and T13 (notifications) should NOT need to construct SSE URLs — frontend handles that.

### SSEClient shape change (BREAKING)

Was `{ id, res }`, now `{ id, res, userId, teamIds: string[] }`. T29 (status badge) and any future SSE management endpoints reading `clients` map must handle the new fields.

### Cleanup hardening

- `clientId` is server-generated UUID — query param ignored. No collision risk.
- Cleanup attached to BOTH `req.on('close'|'error')` AND `res.on('close'|'error')` with a `cleaned` latch so heartbeat-failed cleanup doesn't double-fire.
- `safeWrite()` wraps every `res.write` in try/catch; failures drop the client from the map immediately.

### Frontend reconnect (sse-provider.tsx)

- Backoff: `min(30000, 1000 * 2^min(attempt-1,5) + Math.random()*1000)` — caps exponent at 2^5=32 to avoid integer overflow concerns; jitter prevents thundering-herd
- NO max-retries cap — retries forever (matches plan spec)
- New context value: `isReconnecting: boolean` (true when no streams open AND at least one is in retry state). Exposed via `useSSEStatus()` hook for T29 badge.
- URL constructed via `URL` builder so other query params can be appended later without quoting issues.

### Task ownership routing rules (when migrating future broadcasts)

- **Has teamId** → `broadcastToTeam(teamId, ...)` 
- **No teamId, has creatorId** → `broadcastToUser(creatorId, ...)` (per T1, all new tasks have creatorId)
- **Neither** → drop the event (logged at warn). Don't fall through to `broadcastToAll`.

### task:deleted needs ownership lookup BEFORE archive

`assertTaskOwned` returns `OwnedTask` with teamId but NOT creatorId. For deletes, do an extra `findUnique({ select: { teamId, creatorId } })` BEFORE the update to capture both. After the update the task still exists (archived=true), but doing the read upfront is cleaner than re-reading.

### team:deleted needs member capture BEFORE delete

Once `teamMember.deleteMany` runs, the connected EventSource clients still have the OLD teamIds in memory but the team is gone. Since `broadcastToTeam` filters on `client.teamIds.includes(teamId)`, the message would still reach them — but to be explicit and forward-safe, capture `members.map(m=>m.userId)` inside the transaction and `broadcastToUser(uid, 'team:deleted', ...)` for each.

### Sidecar broadcast routing (state.ts, batch.ts)

- `broadcastProgress(taskId, ...)` and `addLogEntry(taskId, ...)` now use `broadcastToTaskById(taskId, ...)` — they're sync APIs (don't await) but fire-and-forget the underlying Promise via `void` or `.catch(()=>{})`.
- `broadcastBatchEvent` in batch.ts looks up `activeBatches.get(batchId).userId` and uses `broadcastToUser(batch.userId)`. Falls silently if batch not found (defensive, since batches can be cleaned up mid-event).

### Live curl test deferred — preview container does NOT bind-mount source

`docker-compose.preview.yml` builds source into the image; restart picks up old code. To live-test: `bash scripts/openlinear.sh rebuild` (~5min) or run API outside docker. Unit-level verification (typecheck + grep -c "broadcast(" = 0) is the canonical proof for now. Future tasks should rebuild the container if they need live SSE testing.

## T20 — use-kanban-board apiFetch migration (NO-OP)
- Verified: `grep "localStorage.getItem('token')" apps/desktop-ui/components/board/use-kanban-board.ts` → 0 matches.
- File already uses `apiFetch` in 11 sites (migrated as part of T3 scope).
- No code changes required. Evidence: `.sisyphus/evidence/task-20-grep-clean.txt`.
- No commit needed.

## T21 — focus-visible + prefers-reduced-motion (2026-05-01)
- desktop-ui uses `var(--linear-accent)` (raw color), landing uses `hsl(var(--ring))` (HSL triplet) — different token systems, must use each app's convention
- desktop-ui had `outline: none` on inputs/textareas/selects (a11y violation) — replaced with 2px ring
- Reduced-motion override uses `0.01ms` (not `0`) to preserve transition end events firing
- Used `*,*::before,*::after` selector to catch pseudo-element animations
- landing/app/globals.css had NO focus styles at all — added `:focus-visible` for the entire page

## [2026-05-01] Task: T16 — Header search → KanbanBoard client-side filter

### Pattern: useDeferredValue for free debouncing
- React's `useDeferredValue(searchQuery)` defers the value during high-priority renders (keystroke → input update) and serves the new value during low-priority renders (the expensive filter+map of N tasks).
- No `setTimeout`, no `useDebounce` library, no manual `useEffect` cleanup — React's concurrent scheduler handles it. Smoother than a fixed 200ms debounce because urgent updates (typing) stay snappy regardless of filter cost.

### Pattern: Filter derivation, NOT state
- `filteredTasks` is a `useMemo` over `tasks` + `deferredSearchQuery`. NEVER mirror filtered list into state — would desync on SSE task:created/updated.
- Only `getTasksByStatus()` consumes `filteredTasks`. Selection state, batch state, drag handlers all keep operating on raw `tasks` (correct: search is a presentation filter, not a data scope).

### Pattern: Empty-query short circuit
- `q.length < 1 → return tasks` (identity). Saves the per-task allocations on the common case (empty search). Guard with `.trim()` so a single-space query still returns full set.

### Wiring discipline
- `KanbanBoard(props)` already spreads to `useKanbanBoard(props)` — adding optional prop to `KanbanBoardProps` auto-propagates without touching the component file. Keep this seam tight: any new prop is one edit in `use-kanban-board.ts`, one in the parent.

### What this does NOT do
- No backend fetch with `q` param. T12 owns the search API (Cmd+K palette territory). The board filter is purely about narrowing what's already loaded — it does NOT broaden beyond the current `projectId` / `teamId` scope.
- No fuzzy match. Plain `String.includes()` against title + identifier. If users complain, T25 (Cmd+K) is the right place to add fuzzy/Fuse.js.

## [2026-05-01] Task: T18 — Optimistic update rollback for use-kanban-board

### Pattern: Snapshot-via-functional-setter
- `let snapshot: Task[] = []; setTasks(prev => { snapshot = prev; return optimistic(prev); })`
- Captures the previous state ATOMICALLY with the optimistic mutation — avoids stale-closure
  bugs that would happen if you snapshot via `const prev = tasks` (because `tasks` is a closure
  capture from render time, may be stale if multiple updates queue).
- On error: `setTasks(snapshot)` restores cleanly. SSE re-syncs eventually on success.

### Pattern: Collapse N optimistic mutations into one
- Old code had `for (id of ids) setTasks(...)` followed by `Promise.all(ids.map(updateTaskStatus))`.
- Each update created its own snapshot/race window; partial failures left the UI inconsistent.
- New: single updateTaskStatus(ids[], status) with one snapshot, one rollback. All-or-nothing.

### Pattern: Restore selection state too
- handleBatchExecute and handleDelete both snapshot `selectedTaskIds` / `selectedTaskId` IN ADDITION
  to `tasks`, so a failed batch leaves the user's selection intact (they can retry without
  re-selecting). This is a UX-critical detail — the spec called it out explicitly.

### Anti-pattern killed: 3s "safety timeout"
- Was force-setting `loading=false` after 3s "no matter what". Pure cargo-cult — fetchTasks's
  finally block ALWAYS sets loading=false because apiFetch (T3) always resolves or rejects.
- The timeout existed because pre-T3 code had hand-rolled fetches that could hang on network
  error without rejecting. T3 fixed the root cause; T18 removes the bandage.

### ApiError + apiFetch surfacing (from T3)
- All thrown errors are `Error` subclasses (ApiError, AuthExpiredError, NetworkError) so
  `err instanceof Error ? err.message : 'Operation failed'` is the correct one-liner.
- The server's `{ error, code, details }` envelope flows through `.message` automatically.
- No need to type-narrow on ApiError specifically unless you need `.status` or `.code`.

### SSE + optimistic interaction (from T8)
- On SUCCESS: don't re-fetch. SSE task:updated / task:deleted will push canonical state.
- On FAILURE: snapshot rollback may briefly revert an SSE update if SSE arrived mid-flight.
  Acceptable — SSE re-fires eventually-consistent updates. Documented in evidence file.

### Files for downstream tasks
- T20 still needs to delete the leftover `localStorage.getItem('token')` calls — but T18 didn't
  touch any of those (all the call sites already used apiFetch).
- T31 (bulk actions) can reuse `updateTaskStatus(string[], status)` directly for batch status changes.

## T23 — Sidebar per-user teams + nested HTML

- Module-level `let cachedTeams` in `sidebar.tsx` was a cross-user leak; replaced with `TeamsProvider` context (`apps/desktop-ui/providers/teams-provider.tsx`).
- `TeamsProvider` subscribes to `auth:expired` (dispatched by T3's apiFetch on 401) and clears state. Defense-in-depth: AuthProvider already does this for user/repo.
- `useTeams()` derives reload from `user?.id` change → automatic per-user fetch on identity transitions, including after re-login.
- Provider order in `app/layout.tsx`: AuthProvider > SSEProvider > TeamsProvider (TeamsProvider needs both).
- TeamSection's "nested button" worry was a false alarm: `<div className="flex items-center">` already wraps two SIBLING buttons (chevron-toggle and Popover trigger via `asChild`). Radix `Trigger asChild` clones the child — does NOT add an extra `<button>`.
- Sidebar `handleClose` was a bug: red macOS traffic-light was calling `minimize()`. Fixed to call `getCurrentWindow().close()` from `@tauri-apps/api/window`.
- `apps/desktop-ui` has no `typecheck` script — use `npx tsc --noEmit` directly.

## T19 — AlertDialog replaces window.confirm (4 sites)

- T2's `<AlertDialogAction>` defaults to `buttonVariants()` (NOT destructive). For delete/remove
  flows you MUST pass `className={cn(buttonVariants({ variant: "destructive" }))}` — there's no
  prop API to override the variant directly. The Action element still uses Radix internals (it's
  just a styled button) so className override works cleanly.
- Pattern for "controlled AlertDialog with async action that should show loading state":
  ```tsx
  <AlertDialogAction
    onClick={(e) => { e.preventDefault(); void confirmAction() }}
    disabled={isLoading}
    className={cn(buttonVariants({ variant: "destructive" }))}
  >
    {isLoading ? "Deleting..." : "Delete"}
  </AlertDialogAction>
  ```
  The `e.preventDefault()` is REQUIRED — without it Radix auto-closes the dialog on click,
  unmounting the loading state before the request finishes. Caller controls dismissal via
  `setTarget(null)` in the success branch of the async handler.
- For "delete X by id with confirmation" pattern with a name to show in the prompt, use
  `useState<{ id: string; name: string } | null>(null)` rather than two separate states —
  one atomic update keeps the dialog body and pending action in sync.
- For sidebar dialogs that mount inside scrolling `<aside>`: AlertDialog uses Radix Portal so
  it escapes to body anyway; the location of `<AlertDialog>` in the JSX tree doesn't matter for
  layout, only for context propagation.
- `confirm()` is the global `window.confirm` — grep for both `window.confirm` and bare `confirm(`
  with negative-lookbehind `(^|[^.\w])confirm\(` to catch all forms. Same for alert/prompt.
- `apps/desktop-ui` typecheck: `cd apps/desktop-ui && npx tsc --noEmit` (no script defined).

## [2026-05-05] Task: T24 — Animation polish (useReducedMotion + transform-only sidebar + backdrop-filter gating)

### Pattern: framer-motion `useReducedMotion` complements T21 CSS
- T21 landed `@media (prefers-reduced-motion)` CSS overrides (`transition-duration: 0.01ms`).
  That handles CSS-driven motion. The JS-driven framer-motion animations bypass CSS — they use
  `requestAnimationFrame` directly. So even with T21's CSS in place, framer would still schedule
  frames and burn CPU.
- The hook returns `boolean | null`. Treat `null` as "no preference" (animate normally). Use as
  `reduceMotion ? { duration: 0 } : SPRING` for transitions, and `initial={reduceMotion ? false : {...}}`
  to skip the entrance entirely (passing `false` short-circuits all initial-frame work).

### Anti-pattern: animating `width` / `box-shadow` / `border-color` / `filter`
- `width` triggers layout (reflow of every flex sibling). Even one CSS transition adds ~16ms of
  layout work per frame on a moderately complex page.
- `box-shadow` triggers paint (GPU readback for the blur). Animating via `whileHover={{ boxShadow }}`
  in framer-motion creates an inline-style write per frame.
- `border-color` triggers paint of the border edge.
- Replacement rule: stick to `transform` (translate/scale) and `opacity`. Both are composite-only —
  the GPU just reuses cached layer textures, no CPU layout/paint involvement.
- For hover effects use CSS `:hover` (zero JS overhead) when the target style is composite-friendly.

### Sidebar transform-on-inner pattern (with shared CSS variable for layout coordination)
- Outer container: `width: var(--sidebar-width)` set instantly (no CSS transition). This means
  the layout reflow happens once per open/close, not per frame.
- Inner panel: fixed `width: ${width}px` + `transform: translateX(open ? 0 : -${width}px)` with
  CSS transition. The slide is purely composite — no layout work during the animation frames.
- Trade-off: the content area "snaps" wider on close (instant) while the sidebar slides out
  (animated). Reads as "fast and snappy" rather than jarring because the slide direction matches
  the snap direction. If true coordination is desired, transition `padding-left` on content
  with the same easing — but that's also layout, defeating the point.
- `willChange: 'transform'` only when actively animating (`willChange: 'auto'` otherwise) avoids
  permanent GPU layer promotion for the whole sidebar (which would consume VRAM proportional to
  sidebar pixel area).

### Shared CSS variable pattern for sidebar/content coordination
- Set `--sidebar-width` on the root flex container in app-shell. Sidebar reads it directly
  via `width: var(--sidebar-width, 0px)`. No prop drill needed for layout consumers.
- The numeric `width` prop is still passed to the sidebar component because it's needed for the
  inner panel's fixed width and the `translateX(-${width}px)` calc, which can't be expressed in
  pure CSS (we'd need `calc(-1 * var(--sidebar-width))` which works, but mixing the two systems
  for one value is messier than just passing the number).

### Brain-pulse "infinite animation while invisible" pitfall
- `motion.button` with `animate={[1,1.05,1]}` + `transition={{ repeat: Infinity }}` keeps
  scheduling frames even when the button is covered by another overlay or off-screen. framer-motion
  doesn't auto-pause based on intersection-observer.
- Fix: gate the `animate` and `transition` props on the visibility/state condition. When
  `state === "pill"` (overlay open), set `animate={{ scale: 1 }}` + `transition={{ duration: 0 }}` —
  the animation stops scheduling entirely.

### `backdrop-filter` is the most expensive paint property at scale
- Each element with `backdrop-blur` triggers an offscreen render pass of everything behind it,
  blurred. Stack 10+ blurred labels on a dragged card and frame rate drops noticeably even on
  M1.
- Defensive pattern: gate `backdrop-blur-*` classes with `!isDragging && "backdrop-blur-sm"`.
  During drag (high frame rate, animated transform), drop the blur. After drag, restore.
- This applies recursively to children of dragged elements — the parent dropping blur isn't enough
  if children still apply `backdrop-blur-sm`.

### Verification gotcha: desktop-ui has no `typecheck` script
- `pnpm --filter @openlinear/desktop-ui typecheck` returns "no script". Direct `npx tsc --noEmit`
  from the package dir works. Workspace `pnpm typecheck` runs api/sidecar/db/types via turbo.
- Recommend adding `"typecheck": "tsc --noEmit"` to apps/desktop-ui/package.json so it's covered
  by the turbo pipeline (filed mentally for a future T-task).

## [2026-05-05] Task: T17 — TaskDetailView Sheet wrap (RETRY, no-op)

- **Already-applied state**: All T17 surgery present in HEAD before retry. Earlier commits `307d68c` (AlertDialog refactor) and `95b706c` (kanban+detail polish) folded the changes in. No code diff needed.
- **Verification convention**: When plan task overlaps prior work, run `npx tsc --noEmit` from `apps/desktop-ui` (no `typecheck` script defined in package.json — just `dev/build/lint`). Clean exit = green.
- **Sheet primitive integration**: `Sheet open onOpenChange` with `onOpenAutoFocus={(e) => e.preventDefault()}` is the right pattern when the sheet contains its own header/close button — prevents Radix from stealing focus to first focusable, lets inline editors (title input) keep their focus contract.
- **Double-save guard**: Pattern `titleSavedRef.current = true` set at start of save fn AND in cancel paths; reset to `false` in the `useEffect` that runs when `editing*` flips true. Prevents blur-after-Enter from firing onUpdate twice without needing debounce.
- **Anchor-skip on click-to-edit**: `target.tagName === 'A' || target.closest('a')` — covers both direct anchor clicks and clicks on text/img inside anchors.
- **Caller signature**: `kanban-board.tsx:367` passes `project={selectedProject ? { id, name } : null}`. Keep prop nullable in TaskDetailView since selection can be cleared.

## [2026-05-05] Task: T29 — Functional theme switcher (next-themes)

- **`pnpm install` + `NODE_ENV=production` trap**: Repo env may have `NODE_ENV=production` set; `pnpm install` then strips devDependencies (including `@types/react`), making `tsc --noEmit` fail with hundreds of bogus "Cannot find declaration for react" errors. Workaround: `yes | NODE_ENV=development pnpm install`. After every `pnpm add` in this repo, verify `apps/desktop-ui/node_modules/@types/react` still exists; if missing, re-run with `NODE_ENV=development`.
- **`pnpm add` on dirty store**: Got `ERR_PNPM_INCLUDED_DEPS_CONFLICT` until a fresh `pnpm install` ran — symptoms appear when prior installs used different `--prod` flags. Fix: clean `pnpm install` first, then `pnpm --filter <pkg> add <dep>`.
- **`git stash` + concurrent file writes**: Stashed edits were lost across `git stash && cmd && git stash pop` when stash pop encountered no conflicts but the working tree had been mutated by a sibling process. Lesson: do NOT use `git stash` for interim verification; instead, just count errors before/after on disk, or commit-then-revert. Lost ~3 edits this way and had to redo from memory/grep output.
- **next-themes wiring**: ThemeProvider must wrap *body* content (not html) since it sets `class` on `documentElement`. Removed hardcoded `dark` className from `<html>` since ThemeProvider now manages it. `suppressHydrationWarning` on `<html>` was already there — required for next-themes to avoid hydration mismatch.
- **Reactive Toaster**: `sonner` accepts `theme` prop but it's set at mount; needs a client wrapper using `useTheme().resolvedTheme` to update reactively. Same pattern for `<meta name="theme-color">` — small `useEffect`-based client component.
- **Disabled-but-visible**: Light theme button kept in UI with `disabled` + opacity-50 + "Coming soon" badge instead of removed — preserves layout (3-col grid) and signals roadmap intent.

## [2026-05-05] Task: T25 — Cmd+K Command Palette

- **Stash trap (again)**: Same `git stash --keep-index` lost-edits problem as T29. Stashing other concurrent task work to isolate T25 typecheck dropped my own working-tree edits to layout.tsx. Lesson reinforced: instead of `stash --keep-index`, physically move files I want to exclude to `/tmp` and `git stash -- <paths>` only what's tracked. Even safer: commit T25 files first, then verify, then unstash.
- **Concurrent task overlap**: Working tree had mid-flight T29 changes (next-themes integration) sitting in layout.tsx that I initially Read and adapted to. When that work disappeared (was stashed by another agent), my CommandPalette wired to `useTheme()` from `next-themes` broke since the ThemeProvider wasn't mounted. Fix: degrade gracefully — palette toggles `documentElement.classList` directly. Loses next-themes persistence but works in any layout state. Future task can swap in `useTheme()` once T29 lands stably.
- **cmdk filter + dynamic items**: Default cmdk fuzzy filter folds items whose displayed text matches similarly. For search-result items I gave each a unique `value="task-${id}-${title}"` so identical titles across types don't collapse and keyboard nav stays predictable.
- **runCommand defer pattern**: `setOpen(false); setTimeout(fn, 0)` for actions that navigate. Without it, Radix Dialog's focus restore fights `router.push`'s focus reset and you get a brief flash of the old route. The 0-tick defer lets the dialog unmount first.
- **useDeferredValue + setTimeout debounce**: Stacked them deliberately. `useDeferredValue` keeps typing responsive (concurrent rendering deprioritizes the search list), then 200ms `setTimeout` on the deferred value rate-limits the actual fetch. Single 200ms debounce alone would block the input UI on slow CPU; deferred-only would hammer the API every keystroke.
- **Hotkey check order**: `e.key === "k" && (e.metaKey || e.ctrlKey)` catches both mac (Cmd) and windows/linux (Ctrl). Don't sniff `navigator.platform` — let the modifier key match itself. Avoids matching Ctrl+K on mac (which some users still hit out of habit).
- **god-mode unbind**: Replaced ternary with `isMac && Alt+Space` only — windows users now have NO god-mode shortcut, which is fine since T46 will cull it. Left a comment pointing to T25 owner so future maintainers don't "fix" the asymmetry.

## [2026-05-05] Task: T30 — Global keyboard shortcuts + ? overlay

- **Stash/reset churn for the third time**: External automation kept resetting my working tree to HEAD between tool calls (saw 7 reflog entries `reset: moving to HEAD` in this session). Lost shortcuts-overlay.tsx and layout.tsx edits twice. Lesson: write the file, add+commit it within the same response window; do NOT typecheck-then-commit if the typecheck is slow. For tasks that get resharded into other agents' workspaces, think "atomic write -> stage -> commit" as one unit.
- **react-hotkeys-hook v5 option drift**: `filter: (e) => boolean` from v4 docs is gone in v5. The right knob is `enabled` (which can be a function returning boolean) plus `enableOnFormTags: false` and `enableOnContentEditable: false`. TS catches it (`OptionsOrDependencyArray`); JS would silently no-op the filter and bind in inputs. Read the d.ts not the README.
- **Sequence keys (g+i, g+m, ...)**: Skipped react-hotkeys-hook for these; raw `window.addEventListener("keydown")` with a `pendingG` flag + 1.2s timeout is simpler than chaining `useHotkeys("g>i")` strings. Cleared on each non-match key, so `g x` doesn't poison the next real `g i`.
- **Custom event for `c`**: Rather than reaching into GlobalQuickCapture's setState, dispatch `window.dispatchEvent(new CustomEvent("openlinear:new-task"))`. Loose coupling — overlay component knows nothing about capture's internals; capture (or any future task-creator) just adds a `window.addEventListener` if it wants to respond. Makes T30 mergeable independent of capture changes.
- **`document.activeElement` vs `e.target`**: For `useHotkeys`'s `enabled` callback, no event is passed — query `document.activeElement` instead. For raw keydown handlers I still use `e.target` since it's more accurate for the actual key event. Two different APIs, two different access patterns.

### T22 — error-surfacing patterns
- `mapErrorToForm` (projects) and `describeApiError` (teams) are local helpers per page —
  not shared. Both inspect `ApiError.code === "OWNERSHIP_REQUIRED"` and `details.fieldErrors`
  (a `Record<string, string[]>` from zod-on-the-server). Reuse the local helper rather than
  inventing a third shape. If a third page needs the same logic, extract to `@/lib/api/errors.ts`.
- React-hook-form: `form.setError("root", { type, message })` renders via
  `form.formState.errors.root?.message` — there's no `<FormMessage name="root" />` because
  root has no FormField. Render a manual `<div>` adjacent to the form footer.
- Promise.allSettled UX: per-task failure toasts get noisy past ~5 items, but users need to
  know *which* titles failed. Pattern: per-failure toast + 1 summary toast. For >10 failures,
  a future improvement would batch into a single toast with a "View details" action.
- `keyof FormValues` narrowing: when iterating `Object.entries(fieldErrors)` you can't pass
  the loose `string` key to `form.setError` directly — TS rejects it. Solution: explicit
  string-equality narrowing to the known field names (`if (field === "title" || …)`). Keeps
  it type-safe without `as any` and survives schema additions (TS will complain when adding
  a new field to the schema if it's missing from the narrowing list).
- Working tree volatility: when editing across many files in a long session, periodically
  `git status` + grep verification is essential — concurrent edits (other agents, hooks,
  IDE autosave) can silently revert chunks. Apply edits in tight bursts, then verify
  with the same grep pattern used to find the original problem before commit.

## [2026-05-05] Task: T28 — Inbox backed by real notifications

- **`git rm` via tool `rm` then re-`write`**: When I shelled `rm apps/desktop-ui/app/inbox/page.tsx` to allow `write` (which refuses to overwrite), the file became `?? ` (untracked) rather than `M`. Caused brief panic when `git diff --stat` showed only sidebar.tsx changed. Fix: stage with `git add` and the new content lands as a fresh file. Lesson: prefer `edit` for in-place rewrites, or accept that `write` after `rm` produces "untracked-new" status — both are valid for git.
- **Concurrent task pipelines committing**: While I worked, a sibling pipeline committed `5ca18e6` which deleted `app/inbox/page.tsx` (likely intending the same refactor). My re-creation lined up cleanly because the old file was already removed from HEAD. Always re-check `git log --oneline -5` and `git status` before committing — base may have shifted.
- **Constraint-driven SSE workaround**: T28 forbade touching `providers/sse-provider.tsx` and `hooks/use-sse.ts`. The shared SSE provider's `ALL_EVENT_TYPES` doesn't include `notification:created`, so a clean reusable subscription via `useSSESubscription` was impossible. Solution: open a dedicated `EventSource` directly inside `inbox/page.tsx` and `sidebar.tsx`, reusing the existing `?token=` query-param auth path. Two extra long-lived connections per logged-in user (one cloud + one sidecar) — acceptable for now, but worth consolidating into the provider in a follow-up task that's allowed to touch it.
- **`Intl.RelativeTimeFormat` works without polyfills in Tauri's webview**: Replaced custom `timeAgo` with `new Intl.RelativeTimeFormat('en', { numeric: 'auto' })` — produces "in 5 minutes", "yesterday", etc. with proper i18n. Bucketing into Today / This week / Older done with native `Date.setHours(0,0,0,0)` and `MS_DAY` arithmetic — date-fns not needed.
- **Click → navigate → scroll-to-comment pattern**: `router.push('/?task=...')` is async with respect to the destination component mounting. A `setTimeout(400)` before `document.getElementById(\`comment-\${id}\`).scrollIntoView()` is the simplest reliable pattern. A more robust version would observe DOM mutations or use a global event bus, but 400ms covers the common case.
- **T33 — Prisma `groupBy` orderBy on aggregates**: When using `prisma.agentRun.groupBy({ by: ['taskId'], orderBy })` with aggregate ordering (`{ _sum: {...} }`, `{ _count: {...} }`, `{ _max: {...} }`), TypeScript rejects an `orderBy: Prisma.AgentRunOrderByWithAggregationInput`-typed variable because Prisma's generated type is a strict conditional union that emits literal error strings like `"Error: Field \"errorMessage\" in \"orderBy\" needs to be provided in \"by\""` for any branch that doesn't fully satisfy the constraint. Workaround: build each `orderBy` literal with `as const` and inline it into a single ternary — this preserves the narrow shape and lets Prisma's conditional accept it. Don't extract into a typed variable.
- **T33 — Decimal → number serialization for analytics**: AgentRun.costUsd is `Decimal? @db.Decimal(12,6)`. Prisma returns a `Decimal` instance with `.toNumber()`. For per-row aggregation (zero-fill into a daily bucket) and JSON response, convert via a small helper that calls `.toNumber()` and falls back to `Number(d.toString())`. Round to 6 decimals before sending — matches DB precision and avoids floating-point noise like `0.012300000000001` in the chart tooltip.
- **T33 — pnpm `ERR_PNPM_INCLUDED_DEPS_CONFLICT` on add**: After previous workspace installs that included dev deps, a fresh `pnpm --filter ... add <pkg>` fails because the modules dir was installed with `optional + dependencies + devDependencies` but the new install only requests a subset. Fix: pass `--include-workspace-root=false --prod=false` to force inclusion of all dep types, matching the existing modules layout. No package.json or .npmrc change needed.
- **T33 — Multi-tenant scope for analytics**: Canonical pattern `{ OR: [{ userId }, { task: { teamId: { in: teamIds } } }] }` covers both cases (user's own runs + team-scoped runs) in a single Prisma where clause. Crucially, when `teamIds` is empty the OR still includes the userId clause — so a user without team memberships still sees their own runs. Building the where as a function (`buildScopeWhere`) and reusing it in both `/summary` and `/by-task` keeps the security invariant in one place.

### T31 — inline create + bulk-select on kanban board
- Optimistic insert pattern for create (vs T18 which was for update): generate
  `temp-${Date.now()}-${random}` id, push into tasks immediately, then on
  success swap with server-returned task by id (`prev.map(t => t.id === tempId
  ? created : t)`). On failure: filter out the temp by id. Cleaner than full
  snapshot/restore because nothing else depended on the missing row.
- `Draggable.isDragDisabled` is the correct knob — not `<DragDropContext>`
  enabled, not removing Draggable wrappers. Per-task disable lets us also block
  drag on optimistic temp-id rows (avoids racing the POST that returns the real
  id) while keeping non-selected, non-temp rows draggable.
- Range select needs an "anchor" — store last toggled id in a ref (not state),
  else every range-select rerender re-anchors. Compute the visible order by
  iterating COLUMNS × tasks (matches what the user sees top-down per column),
  not by `tasks` insertion order which is mostly createdAt and would feel wrong
  for users who manually reorder columns.
- Cmd-click on card body should NOT open the detail Sheet — it should toggle
  selection. Pattern: in `handleCardClick`, if `e.shiftKey || e.metaKey ||
  e.ctrlKey`, preventDefault + stopPropagation + call onToggleSelect, return
  early. Plain click still opens detail. Single handler, no separate keymap.
- Global `cmd+a` keydown listener: must check `e.target` for INPUT/TEXTAREA/
  contentEditable and bail — otherwise typing in the inline-create input
  selects all kanban cards on every keystroke.
- Inline input UX: keep input focused after successful submit (don't close)
  for fast successive entry. Cancel-on-blur ONLY when value is empty —
  otherwise accidental clicks lose typed content. Both behaviors mirror Linear.
- Stacking two toolbars (BatchControls execute + BulkSelectionToolbar archive)
  needs `pointer-events-none` on the outer flex-center wrapper and
  `pointer-events-auto` on the inner pill — otherwise the wrapper eats clicks
  for the rest of the page even though it's visually empty.
- `Promise.allSettled` for bulk mutations: count rejected, snapshot-rollback
  ONLY if any failed (don't rollback successes — they're confirmed by SSE).
  For partial failures, single summary toast with "Failed N of M" beats N
  individual error toasts (which become unreadable at scale).

T26 (markdown rendering):
- pnpm install conflict "ERR_PNPM_INCLUDED_DEPS_CONFLICT modules dir installed
  with optionalDependencies, dependencies, devDependencies. Current install
  wants optionalDependencies, dependencies" is caused by `NODE_ENV=production`
  in the env. Fix: `NODE_ENV=development pnpm --filter <pkg> add ...`. The
  --include flag does NOT override; the env var wins.
- react-markdown 9.x ships ESM-only and types `Components` from the top-level
  export. Use `import ReactMarkdown, { type Components } from "react-markdown"`.
  Default config is XSS-safe — raw HTML in markdown is dropped unless you
  opt into rehype-raw. NEVER enable it for user-submitted content.
- This repo has no @tailwindcss/typography. Inline component map is the right
  call: ~15 element overrides covers descriptions+comments and stays themed
  with the existing linear-* tokens. `prose prose-invert` would have required
  installing+configuring the plugin, plus the dark variants override most
  prose classes anyway — net zero benefit at higher install cost.
- For embedded links inside a click-to-edit container, the `target.tagName ===
  'A' || target.closest('a')` guard from existing code is the right pattern;
  reuse it verbatim when wrapping <MarkdownView> in a clickable surface.

## T34 - PNG → SVG logo migration

- Plan listed header.tsx + footer.tsx as targets but landing app uses
  text-only branding (no `<img src="/logo.png">` anywhere). Always grep
  before assuming planned edit sites exist.
- `grep -rn "logo.png" apps/` returns matches inside
  `apps/desktop-ui/out/**` (Next.js export artifacts). These are gitignored
  build output — narrow grep to source dirs (`components`, `app`, `lib`)
  to get a meaningful "0 matches" verification.
- Sidebar uses logomark (square, 16px), login splash uses wordmark (h-12,
  needs horizontal lockup) — picking the right SVG variant per spatial
  context matters more than uniformity.
- 4MB PNG placeholder → ~400 byte SVG. Always check file sizes before
  shipping placeholder assets to prod.
