# Final Verification F3 — Real Manual QA

**Date:** 2026-05-06
**Environment:** macOS, postgresql@18 (Homebrew), Node + pnpm, no Docker

## Setup

- **Postgres:** Docker daemon down → started Homebrew `postgresql@18` instead. Created role `openlinear`/db `openlinear`.
- **Migrations:** `pnpm --filter @openlinear/db db:migrate:deploy` → 2 migrations applied successfully (`init`, `80_percent_foundation`).
- **API:** Started via `pnpm --filter @openlinear/api dev` with `DATABASE_URL=postgresql://openlinear:openlinear@127.0.0.1:5432/openlinear JWT_SECRET=test-secret`. Listening on port 3001.
- Boot warning: `ERR_ERL_KEY_GEN_IPV6` from `express-rate-limit` in `routes/search.ts:11` (custom `keyGenerator` should call `ipKeyGenerator` helper for IPv6). Non-fatal — server still listened.

## Smoke Tests

| Endpoint | Method | Expected | Got | Body | Result |
|---|---|---|---|---|---|
| `/health` | GET | 200 | **200** | `{"status":"ok","timestamp":"...","clients":0}` | ✅ |
| `/api/tasks` | POST (no auth) | 401 | **401** | `{"error":"Unauthorized"}` | ✅ |
| `/api/search?q=test` | GET (no auth) | 401 | **401** | `{"error":"Unauthorized"}` | ✅ |
| `/api/projects` | POST (no auth) | 401 | **401** | `{"error":"Unauthorized"}` | ✅ |
| `/api/auth/me` | GET (no auth) | 401 | **401** | `{"error":"rate_limited","scope":"auth","retryAfterSeconds":60}` | ✅ (rate limit fired first) |
| `/api/projects/:id` | GET (no auth) | 401 | **401** | `{"error":"unauthorized","code":"UNAUTHORIZED"}` | ✅ |
| `/nonexistent` | GET | 404 | 404 | Express default HTML | ⚠️ no JSON envelope on unknown routes |
| `/api/tasks/:id` w/ bad token | GET | 401 | **401** | `{"error":"Invalid token"}` | ✅ |

All security headers present (Helmet): HSTS, X-Frame-Options, X-Content-Type-Options, COOP, CORP, Referrer-Policy, X-XSS-Protection. CORS, rate limit headers, `x-request-id` set on every response.

## T4 Error Envelope (`{error, code, requestId}`)

Inspected `apps/api/src/app.ts:253-353` — global `errorHandler` returns `{error, code, message?, details?, requestId}` for all `HttpError`, `ValidationError`, `OwnershipError`, and Prisma errors (`P2002`, `P2025`, `P2003`). `requestId` is propagated from `x-request-id` header or generated via `randomUUID()`.

**Caveat:** Auth middleware (401) and Express's default 404 handler short-circuit before reaching the global error handler, so they emit a minimal `{error}` envelope without `code`/`requestId`. Ownership/validation/prisma error paths are fully T4-compliant. Recommend follow-up to route auth + 404 through the same envelope for consistency.

## T7 Auth Enforcement

- `POST /api/tasks` → **401** ✅
- `POST /api/projects` → **401** ✅
- `GET /api/search` → **401** ✅
- `GET /api/projects/:id` → **401** ✅ (uses `optionalAuth` + ownership; ownership guard returned `unauthorized/UNAUTHORIZED` for unauthenticated request to a specific resource)

Unauthenticated mutating routes are blocked. `GET /api/projects` with no auth correctly returns `[]` (uses `optionalAuth`, intentional). `GET /api/inbox` returned 200 with empty paginated body — also `optionalAuth` for read.

## Build

`pnpm --filter @openlinear/desktop-ui build` → **success**. Next.js compiled in 4.4s, 13 static pages generated (`/`, `/archived`, `/auth/callback`, `/inbox`, `/login`, `/my-issues`, `/projects`, `/settings`, `/teams`, `/teams/manage`, `/usage`, `/_not-found`).

## Evidence Files

`ls .sisyphus/evidence/ | wc -l` → **62** (≥ 48 required) ✅

## Cleanup

Killed API process (PID 72431). Port 3001 free.

## Verdict

```
API boot [PASS] | Auth enforcement [PASS] | Build [PASS] | Evidence files [62/48+] | VERDICT: APPROVE
```

**Notes / follow-ups (non-blocking):**
1. `express-rate-limit` IPv6 keyGenerator warning in `routes/search.ts:11` — fix per https://express-rate-limit.github.io/ERR_ERL_KEY_GEN_IPV6/
2. Auth middleware 401 and unknown-route 404 don't go through the T4 error envelope (return minimal `{error}` / Express HTML respectively). Functionally fine, cosmetically inconsistent.
