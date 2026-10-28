# Desktop backends and desktop sign-in (engineer `desk`, round 1)

Date: 2026-10-26. Base: `922dbd7` plus `round1-base.patch` (CI fixes, W02a, W04a). Local work only; nothing was deployed, pushed or run against a remote service.

## Outcome

- The desktop (Tauri) build now sends every cloud-owned call (sign-in, refresh, `/api/auth/me`, projects, tasks, chat, comments, events, …) to the cloud API, and only execution calls to the local sidecar. One route table decides this for every request.
- Desktop GitHub sign-in runs through the cloud API with a one-time code and PKCE. No access or refresh token travels in the `openlinear://` deep link, and the deep link is no longer printed.
- Token refresh always goes to the cloud API. On the web the refresh token is now only an HttpOnly cookie; on desktop it lives in the Tauri store and survives restarts (it was lost on every restart before).
- Desktop subscribes to two event streams (cloud domain events and local execution events), each with its own reconnect and resume cursor, deduplicated by (stream, event id).
- `'unsafe-eval'` is removed from the production Tauri CSP.

## What changed and why

### 1. Routing (apps/desktop-ui)

- **New `lib/api/routes.ts`**: `SIDECAR_ROUTES` + `resolveApiTarget(path)`. The sidecar serves only what `apps/sidecar/src/app.ts` mounts:
  - `/api/tasks/:id/{execute,cancel,logs,running,refresh-pr}`
  - `/api/batches/**`
  - `/api/opencode/**`
  - `/api/transcribe`

  Everything else goes to the cloud. The query string never affects routing.
- **`lib/api/client.ts`**:
  - `getCloudApiUrl()`:
    - desktop: `NEXT_PUBLIC_CLOUD_API_URL`, else `CLOUD_DEFAULT = https://openlinear.tech` (unchanged constant, still overridable);
    - web: `NEXT_PUBLIC_API_URL`, then `NEXT_PUBLIC_CLOUD_API_URL`, then `http://127.0.0.1:3001`.
  - `getSidecarApiUrl()`:
    - desktop: the port the shell reports, else `NEXT_PUBLIC_SIDECAR_URL`, else `:3003`;
    - web: `NEXT_PUBLIC_SIDECAR_URL`, else `http://127.0.0.1:3003`.

    Before, the web default wrongly pointed at the API port (3001).
  - `getApiUrl()` now always returns the cloud API. It is kept as a deprecated alias; before, it returned the sidecar in Tauri, which was the root bug.
  - New helpers:
    - `getApiBaseUrl(target)`;
    - `resolveApiBaseUrl(target)`, which waits for the Tauri-reported sidecar port;
    - `getApiUrlForPath`.
  - The sidecar health check accepts the sidecar's real `{ ok: true }` payload as well as `{ status: 'ok' }`. Before, it only accepted `status`, so `resolveSidecarApiUrl()` could never succeed.
  - `NEXT_PUBLIC_*` values are read in the literal form that Next inlines. The old `process.env?.X` form compiled to a runtime lookup; inlining is verified in the built export.
- **New `lib/api/runtime.ts`** `isDesktopRuntime()` checks for a truthy `window.__TAURI_INTERNALS__`, not just that the key exists. The unit-test setup defines the key as `undefined`, so tests silently ran in "desktop" mode before. `token-store.ts`, `auth.ts` and `use-auth.tsx` now share it.
- **`lib/api/fetch.ts`**:
  - `apiFetch` / `apiFetchRaw` route by the table, and share one core (`performRequest`).
  - The `sidecar?:` option is deprecated and ignored. A value that contradicts the table logs a warning once in development.
  - New options:
    - `authToken`: verify a candidate token without storing it, with no refresh and no `auth:expired`;
    - `anonymous`: public auth endpoints carry no stale bearer token and never trigger a refresh. This matters because the 2FA temp token is single-use.
- **Flags removed** from:
  - `chat.ts` (`transcribeChatAudio`);
  - `opencode.ts`;
  - `tasks.ts` (`executeTaskPublic`, `refreshTaskPr`).

  `fetchExecutionLogs` (last function in `tasks.ts`) keeps a redundant, now-ignored `sidecar: true` to avoid an end-of-file conflict with the board engineer's appended functions. Board code (`use-kanban-board.ts`, `use-batch-execution.ts`) still passes `sidecar: true`; it is consistent with the table and ignored.
- **`chat.ts` `sendChatMessage`** uses `apiFetchRaw`. It now gets cloud routing and refresh-on-401, and reports network failures through `onError`; before, network failures rejected the promise.

Call-site audit: every `fetch` / `apiFetch` / `EventSource` in `apps/desktop-ui`:
- `lib/api/*`;
- hooks;
- providers;
- `app/(app)/*`;
- `components/*`, including the unused `components/desktop/api-loading-screen.tsx`, which polls sidecar `/health`.

Every relative-path call goes through `apiFetch`, so the table classifies it. The direct `fetch` calls are:
- the refresh call (cloud);
- logout with keepalive (cloud);
- the sidecar health probe;
- the event-stream client (explicit per stream).

### 2. Desktop sign-in through the cloud API (RFC 8252 + RFC 7636)

Flow:
1. The app generates a verifier and a state (WebCrypto).
2. `POST /api/auth/desktop/authorize {codeChallenge, codeChallengeMethod:'S256', state}` returns the GitHub authorize URL. The API binds the challenge and the app's state into its HMAC-signed OAuth state.
3. The app opens the URL in the system browser (plugin-shell). It only opens `https://github.com`.
4. GitHub returns to the cloud `/api/auth/github/callback`. The API creates the user and stores a `DesktopAuthCode` (SHA-256 of a 32-byte code, challenge, 2-minute TTL). It then redirects to `openlinear://callback?code=…&state=…` with `Cache-Control: no-store`.
5. Rust `deeplink.rs` forwards only `code` / `state` / `error` to the webview.
6. The app accepts the callback only if `state` matches an attempt it started. Pending attempts are kept in memory plus `sessionStorage` for 10 minutes; anything else is dropped with no network call.
7. `POST /api/auth/desktop/token {code, codeVerifier}` consumes the code. One conditional `UPDATE … WHERE codeHash AND codeChallenge = S256(verifier) AND consumedAt IS NULL AND expiresAt > now` runs in the same transaction that mints the session. The response body carries `{token, refreshToken, tokenType}`; TOTP users get `{twoFactorRequired, tempToken}` instead and no session.

Files:
- API:
  - `routes/auth.ts`;
  - `schemas/auth.ts` (Zod);
  - `services/desktop-auth.ts`;
  - `lib/auth-tokens.ts` and `services/sessions.ts`, which gain an optional transaction client (additive);
  - `registry.ts`, with 3 new public rows.
- Migration `20261026040000_desktop_auth_codes`: additive table with CHECK constraints, `migration-safety: allow` with reason.
- Client:
  - `lib/api/desktop-auth.ts` (PKCE, pending attempts, callback parsing);
  - `lib/api/auth.ts`;
  - `hooks/use-auth.tsx` (deep-link handler; pending 2FA state);
  - `app/login/page.tsx`.

Server behaviour:
- **Enablement.** `githubOAuthEnabled()` requires `OPENLINEAR_ENABLE_GITHUB_OAUTH=1` **and** `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, and refuses the two revoked client-ID prefixes. It no longer hard-refuses `NODE_ENV=production`, so sign-in can work once replacement credentials are configured. Until then every GitHub and desktop endpoint answers 503 `GITHUB_OAUTH_DISABLED`.
- **New `GET /api/auth/providers`** returns `{ github: { enabled } }`. The login page enables its button from it.
- **Old desktop entry refused.** `GET /api/auth/github?client=desktop` is refused with 400 `DESKTOP_PKCE_REQUIRED`. That browser-started desktop flow put tokens in the deep link.
- **Redirect URI.** It is no longer derived from the request `Host` (removed `buildDesktopRedirectUri`); the configured callback is always used.
- **`POST /api/auth/refresh`.** Cookie clients get only `{ token }`, and the rotated refresh token stays in the HttpOnly cookie. Body clients (desktop) get the rotated token in the body, and no cookie is set for them. An invalid cookie is cleared.
- **`POST /api/auth/logout`** also clears the `ol_refresh` cookie.
- **Logging.** `app.ts` pino redaction adds `res.headers.location`. The web `/auth/session?token=` hand-off and OAuth codes were being logged.

### 3. Refresh and credential storage

- **Refresh call.** `refreshAccessToken()` always targets `getCloudApiUrl()`:
  - desktop: stored refresh token in the body, `credentials:'omit'`, rotated token stored back;
  - web: `credentials:'include'`, empty body.

  Concurrent 401s share one refresh. Requests that already see a newer token retry without refreshing. A sidecar 401 triggers refresh-and-retry, but never signs the user out (the cloud owns the session).
- **`token-store.ts`**:
  - web access token stays in `localStorage` (compatible; now read per call so all tabs see a refresh);
  - web refresh token is never stored, and the legacy `localStorage` copy is deleted;
  - desktop hydrates both tokens from the Tauri store, migrating from `localStorage` once;
  - any write made before or while the store loads wins over persisted values. A unit test caught this race.
- **`verifyCallbackToken`** (web `/auth/session`) verifies the token with an explicit header before storing it. It used to store first and roll back.
- **`logout()`** now revokes the server session (best effort, keepalive) and clears both tokens. It used to only drop the local token.

### 4. Event streams

- **New `lib/api/event-stream.ts`** — fetch-based SSE. Native `EventSource` cannot send the `Authorization` header the sidecar stream requires, and is absent in jsdom.
  - `SseParser` follows the WHATWG format: CR/LF/CRLF, chunk splits, comments, multi-line data, per-event id versus the last-event-id buffer, `retry`.
  - `EventStreamConnection` re-runs `prepare(cursor)` on every attempt, tracks its own cursor, and backs off from 1 s to 30 s with jitter.
  - `RecentEventIds` dedupes by (stream, id) and is bounded.
- **`providers/sse-provider.tsx`**:
  - **Cloud stream** (always). Uses a fresh single-use ticket per attempt from `POST /api/events/ticket`, minted through `apiFetch` so it refreshes. It sends `?ticket=…&lastEventId=<last numeric outbox id>`; execution-shaped ids are never used as the domain cursor. This consumes the existing server contract; `sse.ts` and `routes/events.ts` are unchanged.
  - **Local stream** (desktop, or web only when `NEXT_PUBLIC_SIDECAR_URL` is set). Uses `Authorization: Bearer <cloud access token>` + `Last-Event-ID`, and refreshes on 401. A browser tab in production therefore never probes `127.0.0.1`.
  - Listeners receive a third `meta {stream, id}` argument (backward compatible).
  - The provider now forwards server event types it previously dropped:
    - `comment:*` (which `comments-thread.tsx` already listened for);
    - `tasks:bulk-updated` / `tasks:bulk-deleted`;
    - `task:label:*`;
    - `activity:created`;
    - `chat:session:updated`.
  - It now emits `connected`. Both servers send it as a named event, which the old `onmessage` never saw.

### 5. Tauri (uncompiled — `cargo` is not installed)

- `src-tauri/src/deeplink.rs`:
  - the `println!` of the callback URL is removed;
  - the payload becomes `{success, code?, state?, error?}`, never a token;
  - values are bounded to 512 characters;
  - Rust unit tests are updated (token never forwarded, error keeps state, missing state rejected, oversized values rejected).

  The sidecar-spawn code (`sidecar.rs`) is untouched.
- `tauri.conf.json`:
  - production `csp` drops `'unsafe-eval'`;
  - a new `devCsp` keeps it (React dev mode uses eval) and adds `ws:` loopback for HMR;
  - both allow `https://api.openlinear.tech` in addition to `https://openlinear.tech`.

### 6. Dev topology

- `scripts/dev-live.sh` starts the cloud API on 3001 and the sidecar on 3003 (with `OPENLINEAR_API_URL` for the sidecar rewrite). It exports `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLOUD_API_URL` and `NEXT_PUBLIC_SIDECAR_URL`, and runs `tauri dev` with `API_PORT=$SIDECAR_PORT`. With `OPENLINEAR_SKIP_SIDECAR=1` the shell reports `API_PORT` as the sidecar port.
- `.env.example` is **not** changed (the output protocol excludes `.env*`), but its GitHub comment is now stale. Suggested replacement: "Sign-in stays off (503 `GITHUB_OAUTH_DISABLED`) until a replacement app is configured: set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OPENLINEAR_ENABLE_GITHUB_OAUTH=1`; revoked app IDs are refused." Also suggest `GITHUB_REDIRECT_URI=http://127.0.0.1:3001/...`, so the dev refresh cookie host matches `NEXT_PUBLIC_API_URL`.

## Coordinator addenda

- **(a)** Both tokens are out of the desktop callback URL (code + state only), and the deep-link `println!` is gone. API Location headers are also redacted from logs.
- **(b)** `'unsafe-eval'` is removed from the production CSP. I built the static export (`BUILD_FOR_TAURI=1 next build`) and searched every chunk:
  - zero `eval(`;
  - three `Function("return this")` global-object fallbacks (core-js, lodash, decimal.js). Each is short-circuited by `globalThis`/`self`, which every Tauri webview has, so they never run.

  Dev keeps eval through `devCsp`. Not done: removing `'unsafe-inline'` and narrowing the `127.0.0.1:*` connect-src (audit D-03), because both need runtime nonce/hash work and a fixed sidecar origin.
- **(c)** The web refresh token is HttpOnly-cookie only: the API already set `ol_refresh`; the client now uses it and the API stops echoing it. Desktop keeps it in `@tauri-apps/plugin-store`, which is a file in app data, not the OS keychain. A keychain needs a new Rust crate (`keyring` / stronghold), which cannot be compiled or verified here, so it is left as a follow-up. The access token's storage is unchanged.

## Client-visible behaviour changes

**Sign-in**
- The desktop app talks to `https://openlinear.tech` (or `NEXT_PUBLIC_CLOUD_API_URL`) for everything except execution. Its CSP also allows `https://api.openlinear.tech`.
- The "Sign in with GitHub" button is enabled when the API reports GitHub sign-in available (both web and desktop). The desktop shows "Continue in your browser…".
- The desktop "Trouble signing in?" box accepts only an `openlinear://callback?code=…&state=…` link from a sign-in started in that window in the last 10 minutes. Pasted raw tokens or JWTs are rejected before anything is stored. The box is hidden on the web.
- TOTP accounts get a code prompt on the login page.
- **Server:** an operator must set `OPENLINEAR_ENABLE_GITHUB_OAUTH=1` with new credentials to enable sign-in, now also in production.
- **Server:** `GET /api/auth/github?client=desktop` returns 400 `DESKTOP_PKCE_REQUIRED`.
- **Server:** the desktop deep link carries `code` and `state` instead of `token` / `refreshToken`.

**Sessions and requests**
- Web sessions now refresh silently through the cookie. Before, the web never refreshed, because the client had no refresh token, so users were signed out after the 1 h access-token lifetime.
- Desktop sessions survive restarts, because the refresh token is restored.
- Signing out revokes the server session and clears the refresh cookie.
- A 401 from the sidecar no longer signs the user out.
- **Server:** cookie-based refresh responses no longer include `refreshToken` in the body.

**Event streams**
- `comment:*` events reach comment threads live.
- `connected` fires on each stream (re)connect. `use-task-sse` then refetches tasks, refreshes the active repository and reconciles batches; before this never ran.

## Tests

**API** — new `auth.desktop.test.ts` (28 tests). GitHub is stubbed at the network boundary, and the real authorize → callback → token path runs against Postgres:
- availability: flag/credentials gate, revoked IDs, production enablement, 503 everywhere;
- authorize validation: PKCE `plain` and malformed challenge/state rejected;
- the redirect URI ignores `Host`;
- the deep link carries only `code` + `state`, with no token or JWT;
- only the hash is stored, bound to the challenge, with a TTL of ≤ 2 minutes;
- provider error with state; tampered state;
- redemption:
  - success, and the tokens work for `/me` and refresh;
  - single use and replay (the first session stays valid);
  - verifier mismatch is rejected and does not consume the code;
  - a code from another sign-in is rejected;
  - expiry;
  - unknown or malformed codes;
  - 8 concurrent redemptions give exactly one 200 and one session;
  - TOTP users get a 2FA challenge and no session;
- cookie refresh without a body token; body refresh with no cookie, reuse rejected; logout clears the cookie.

`auth.test.ts`: 8 tests were stale, none were regressions.
- 6 enabled sign-in with only the flag; enablement now also needs credentials (a deliberate gate change). They now call an `enableGitHubOAuth()` helper.
- 2 encoded the removed sidecar-hosted desktop flow: a `Host`-derived ephemeral redirect URI and a token-bearing deep link. They are rewritten to the new contract: the desktop GET is refused, and an error deep link carries `state`.

**Desktop-ui** — 518 tests, up from 242 (+276 net):
- `routes.test.mjs`: 185. Every exported `lib/api` request function is called for real in both the web and the desktop runtime, asserting the exact URL and method. A completeness guard fails on any unclassified export.
- `client.test.mjs`: URL resolution desktop vs web; regression checks for "cloud never resolves to the sidecar" and for the web sidecar default.
- `fetch.test.mjs`: routing; web cookie refresh; desktop body refresh; shared refresh; a sidecar 401 does not sign out; `anonymous` / `authToken`.
- `token-store.test.mjs`.
- `desktop-auth.test.mjs`: RFC 7636 appendix-B vector; pending store; callback parser rejects JWTs/tokens/other hosts.
- `auth.test.mjs`:
  - PKCE request;
  - only GitHub is opened;
  - redemption, and the attempt is spent;
  - unsolicited links make no request;
  - a link delivered twice is redeemed once;
  - rejected, network-retry, provider error, 2FA;
  - `verifyCallbackToken` stores nothing before verification.
- `event-stream.test.mjs`.
- `sse-provider.test.mjs`: desktop opens both streams; web opens only the cloud stream unless a dev sidecar is configured; independent cursors; replay delivered once; dedupe is per stream; refresh on a sidecar 401; streams stop on unmount.
- `use-auth.test.mjs` +4: deep link `code` + `state` redeemed; token payload ignored; unsolicited dropped quietly; 2FA state kept.

Stale desktop-ui tests (21, none regressions):
- 9 `extractCallbackToken` tests: the raw-token paste parser was removed on purpose (audit D-05), replaced by `parseDesktopCallbackUrl` tests.
- 5 tests asserted `sidecar: true` flags or mocked modules without the new exports.
- 1 expected the web sidecar default to be the API port; that is the bug fixed here.
- 6 `sendChatMessage` tests mocked `./fetch` without `apiFetchRaw`.

**Checks that the new tests fail without the fix:**

| Change removed | Tests failing |
|---|---|
| `consumedAt IS NULL` guard | single-use and concurrent-redemption API tests |
| Challenge predicate | verifier-mismatch and cross-sign-in tests |
| `execute` row from the route table | 4 tests (table row plus both runtimes for `executeTaskPublic`) |
| Old bug simulated (desktop cloud URL resolving to the sidecar) | 71 routing/client tests |

All were restored afterwards. The desktop refresh test failed on my first `token-store` version (a real hydration race), which was then fixed.

## Validation (local)

| Command | Result |
|---|---|
| `pnpm typecheck` (root) | 11/11 tasks successful |
| `pnpm lint` (root biome list) | clean. My new API files also pass `biome check --error-on-warnings` but are not in the list (see hazards). |
| `TEST_DATABASE_URL=…/openlinear_desk_test pnpm --filter @openlinear/api test` | 32 files, **314 passed, 2 skipped** (base 286 + 2 skipped; +28) |
| `pnpm --filter @openlinear/desktop-ui test` | 28 files, **518 passed** (base 242), fonts check ok, scroll benchmark p95 16.7 ms / max 16.8 ms |
| `pnpm --filter @openlinear/sidecar test` (untouched; consumes the API package) | 38 files, 661 passed |
| `prisma migrate deploy` + `migrate diff --from-config-datasource --to-schema --exit-code` on the private test DB | applied; "No difference detected" |
| `BUILD_FOR_TAURI=1 next build` with `NEXT_PUBLIC_CLOUD_API_URL` set | succeeds; value inlined into the chunk; no `eval(` |
| Rust (`deeplink.rs`, `tauri.conf.json`) | not compiled (no `cargo`); JSON validated |

Flake note: one full API run had 2 failures in the W02a `route-inventory` PAT probes, on unrelated routes that differed between runs. The failing requests never appear in our server log: only the unauthenticated 401 and the authenticated 403 for that route were logged. That is consistent with supertest's ephemeral port being answered by another engineer's server bound to `127.0.0.1:<same port>` on this shared machine. The file passes alone and in a 4-file run, and the immediate full rerun was green (numbers above).

## Decisions

- **Deep link, not loopback.** The scheme is already registered on all three platforms. A loopback listener would need new, uncompiled Rust. PKCE makes an intercepted code useless.
- **A wrong verifier does not consume the code.** The challenge is part of the conditional UPDATE. An interceptor without the verifier cannot burn the user's sign-in, and a 256-bit verifier with a 2-minute TTL and rate limiting makes guessing irrelevant.
- **Replay is rejected without revoking the first session.** The deep link can be delivered twice (event plus pending-consume); the client dedupes, and only the verifier holder could replay anyway.
- **Gate is flag + credentials, production allowed.** The task requires sign-in to work once env is configured. The explicit flag keeps an environment that still carries old values from silently re-enabling, and the revoked IDs are refused outright.
- **2FA for desktop is enforced at redemption.** The code is issued and the second factor is checked when it is redeemed.
- **The route table is authoritative.** Call-site flags are ignored, and a mismatch warns in development.
- **The Tauri store is not the keychain.** A keychain needs a new Rust crate; see addendum (c).
- **The local stream on web needs explicit `NEXT_PUBLIC_SIDECAR_URL`.** This avoids Private Network Access prompts and a retry loop in production browsers.
- **Execution events are not migrated.** The sidecar's journal `execution:progress {runId, seq, …}` payloads still are not consumed by `use-task-sse` (it needs `taskId`). That is the execution-drawer owner's area; the plumbing is in place.

## Left undone, and why

- OS keychain for desktop tokens (needs a Rust crate and `cargo`).
- CSP `'unsafe-inline'` and the loopback wildcard (needs nonce/hash work and a fixed sidecar origin).
- `scripts/dev.sh`, `dev-web.sh`, `debug.sh` and `start-prod-preview.sh` still start only the sidecar on 3001 and point `NEXT_PUBLIC_API_URL` at it. That is the pre-split topology: cloud routes 404 there, and execution now targets 3003. They need the same two-process change as `dev-live.sh`; I left them because they are shared scripts.
- Web login CSRF: the web OAuth `state` is not bound to the browser. It is out of scope; the desktop flow is bound by PKCE and state.
- A sweep job for `desktop_auth_codes`. Expired rows older than 1 h are deleted opportunistically on each issuance; there is no pg-boss job, to avoid touching `jobs/index.ts`.
- `components/desktop/api-loading-screen.tsx` (unused) still checks only `status === 'ok'`.
- Rust compile/test of `deeplink.rs` on a machine with `cargo`.

## Merge hazards

- `apps/desktop-ui/lib/api/tasks.ts`: two small hunks remove `sidecar: true` in `executeTaskPublic` and `refreshTaskPr`. The last function is untouched to stay clear of the board engineer's appended functions.
- `routes.test.mjs` has a completeness guard. The board engineer's new `tasks.ts` functions (bulk / idempotency) need rows in `CASES`; they are cloud, for example `/api/tasks/bulk`. Until then the guard fails with the function names.
- `apps/api/src/registry.ts`: 3 rows in the Auth block. Others will add rows elsewhere.
- `apps/api/src/app.ts`: one line in the pino redact list.
- `apps/api/src/lib/auth-tokens.ts`, `services/sessions.ts`: an optional trailing `db` parameter (additive).
- `packages/db/prisma/schema.prisma`:
  - `User.desktopAuthCodes` relation, plus the new model after `TwoFactorChallenge`;
  - migration `20261026040000_desktop_auth_codes`.
- `apps/desktop/src-tauri/tauri.conf.json`: CSP strings, plus a new `devCsp`. The sidecar engineer may touch other keys.
- `scripts/dev-live.sh`: rewritten startup block. The sidecar engineer may also set sidecar env there.
- `apps/desktop-ui/app/login/page.tsx` and `hooks/use-auth.tsx` are outside the listed ownership but required for desktop sign-in. The `useAuth()` context gains `pendingTwoFactorToken`, `clearPendingTwoFactor` and `completeDesktopCallback`.
- `useSSESubscription` listeners gain an optional third `meta` argument, and `SSEEventType` gains event types. This is additive.
- Root `package.json` `lint` list: not edited (single-line conflict magnet). Add `apps/api/src/services/desktop-auth.ts`, `apps/api/src/schemas/auth.ts` and `apps/api/src/__tests__/auth.desktop.test.ts` after merge; they pass biome.
- For the sidecar engineer:
  - the UI sends `Authorization: Bearer <cloud access token>` to execution routes and to the local `/api/events`, with `Last-Event-ID`;
  - a sidecar 401 makes the UI refresh at the cloud API and retry once;
  - the UI accepts `/health` returning `{ok:true}` or `{status:'ok'}`.
