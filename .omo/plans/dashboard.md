# Dashboard Implementation Plan: `dash.openlinear.tech`

## Overview

Build a standalone analytics dashboard web app at `dash.openlinear.tech` for OpenLinear users. Phase 1 focuses on AI execution cost analytics and Personal Access Token (PAT) management. The dashboard is a read-only view of existing data with PAT CRUD operations.

---

## Architecture

### New App: `apps/dashboard/`

A Next.js 16 app (same stack as `apps/desktop-ui` and `apps/landing`):
- **Framework**: Next.js 16 App Router
- **Styling**: Tailwind CSS, shadcn/ui components
- **Auth**: GitHub OAuth via `?token=` URL callback (same pattern as desktop-ui)
- **Data**: Consumes existing API routes, no new backend code needed for Phase 1

### Monorepo Integration

```
apps/
  dashboard/              ← NEW
    app/
      (app)/
        page.tsx            # Main dashboard
        layout.tsx          # Auth gate + shell
      login/
        page.tsx            # Login redirect + callback handler
    components/
      auth/
        auth-provider.tsx   # localStorage token + /api/auth/me
        login-button.tsx    # GitHub OAuth link with client=dashboard
      usage/
        summary-card.tsx    # Cost/runs/tokens summary
        daily-chart.tsx     # 30-day bar chart (recharts)
        task-table.tsx      # Per-task cost breakdown table
      pats/
        pat-list.tsx        # PAT cards with scopes/lastUsed
        pat-create-form.tsx # Name + scopes + expiry
    lib/
      api.ts                # apiFetch + usage + PAT helpers
      config.ts             # API_URL, DASHBOARD_ORIGIN
    next.config.ts
    package.json
    tsconfig.json
    tailwind.config.ts
    postcss.config.mjs
```

---

## Auth Flow Modifications

### 1. API: OAuth `client=dashboard` Support

**File**: `apps/api/src/routes/auth.ts`

Current `OAuthClient` is `'web' | 'desktop'`. Add `'dashboard'`:

```typescript
type OAuthClient = 'web' | 'desktop' | 'dashboard';
```

Update `verifyState()` to accept `'dashboard'`.

Add `DASHBOARD_URL` env support:

```typescript
function getDashboardUrl() {
  return process.env.DASHBOARD_URL || 'http://localhost:3005';
}
```

Update `buildWebSuccessRedirect()` to branch on client:

```typescript
function buildWebSuccessRedirect(client: OAuthClient, token: string): string {
  if (client === 'dashboard') {
    return `${getDashboardUrl()}?token=${encodeURIComponent(token)}`;
  }
  return `${getFrontendUrl()}?token=${encodeURIComponent(token)}`;
}
```

Update `respondWithError()` for dashboard:

```typescript
function respondWithError(client: OAuthClient, error: string, res: Response): void {
  // ...existing desktop branch...
  if (client === 'dashboard') {
    res.redirect(`${getDashboardUrl()}?error=${encodeURIComponent(error)}`);
    return;
  }
  res.redirect(`${getFrontendUrl()}?error=${encoded}`);
}
```

Update the `/github` endpoint to accept `?client=dashboard`:

```typescript
const requestedClient = req.query.client === 'desktop' ? 'desktop' 
  : req.query.client === 'dashboard' ? 'dashboard' 
  : 'web';
```

Update `/github/callback` to use `buildWebSuccessRedirect(client, token)`.

### 2. Dashboard: Auth Pattern

**Pattern**: Copy `desktop-ui/hooks/use-auth.tsx` + `lib/api/fetch.ts` + `lib/api/auth.ts` into `apps/dashboard/lib/api.ts`.

Simplified version:
- On mount: check `localStorage.getItem('token')`
- If `?token=` in URL: store it, strip it, reload user
- Call `GET /api/auth/me` with `Authorization: Bearer <token>`
- If 401: redirect to `/login`
- Logout: remove token, redirect to `/login`

Login page: link to `/api/auth/github?client=dashboard`

---

## Pages & Components

### Page 1: `/login`

- Clean centered layout with OpenLinear branding
- "Sign in with GitHub" button → links to `https://api.openlinear.tech/api/auth/github?client=dashboard`
- Handles `?token=` and `?error=` query params on load
- No auth required

### Page 2: `/` (Dashboard)

Protected by auth gate. Layout:

```
+--------------------------------------------------+
|  OpenLinear  |  Dashboard                    [User ▼] |
+--------------------------------------------------+
|                                                  |
|  [Summary Cards]  [Summary Cards]  [Summary Cards] |
|  $12.34 total    45 runs          1.2M tokens    |
|                                                  |
|  [Daily Cost Chart - 30 days]                     |
|                                                  |
|  [Per-Task Costs Table]                          |
|  Task        | Runs | Cost | Tokens | Last Run    |
|  ENG-1 Fix   |  3   | $2.1 | 120k  | 2h ago      |
|                                                  |
+--------------------------------------------------+
|  [Personal Access Tokens]                        |
|  Name    | Prefix    | Scopes  | Last Used | [Revoke] |
|  + [Create New PAT]                             |
+--------------------------------------------------+
```

#### Components

**`summary-card.tsx`**: 3 cards showing `totalCostUsd`, `totalRuns`, `totalInputTokens` + `totalOutputTokens`

**`daily-chart.tsx`**: Bar chart from `recharts` or `shadcn/ui` chart component. Data from `GET /api/usage/summary` → `daily[]`

**`task-table.tsx`**: Sortable table from `GET /api/usage/by-task`. Columns: taskIdentifier, taskTitle, runs, totalCostUsd, totalInputTokens, totalOutputTokens, lastRunAt

**`pat-list.tsx`**: Card list from `GET /api/pats`. Shows name, prefix, scopes badges, lastUsedAt, expiresAt, createdAt. Revoke button calls `DELETE /api/pats/:id`

**`pat-create-form.tsx`**: Dialog form. Fields:
- name (text, required)
- scopes (multi-select, default `["*"]`)
- expiresAt (optional date picker)
- On submit: `POST /api/pats` → display the token once (copy to clipboard), refresh list

---

## API Routes Used (No New Routes Needed)

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/me` | GET | Current user info |
| `/api/usage/summary` | GET | 30-day cost/run/token summary + daily breakdown |
| `/api/usage/by-task` | GET | Per-task aggregated costs, paginated |
| `/api/pats` | GET | List user's PATs |
| `/api/pats` | POST | Create new PAT |
| `/api/pats/:id` | DELETE | Revoke PAT |

---

## Environment Variables

### Production

```bash
# API (.env.production additions)
DASHBOARD_URL=https://dash.openlinear.tech
CORS_ORIGIN=https://openlinear.tech,https://dash.openlinear.tech,https://mcp-docs-one.vercel.app
```

### Development

```bash
# API (.env additions)
DASHBOARD_URL=http://localhost:3005
```

---

## Implementation Steps

### Step 1: Extract Shared Auth Primitives (Optional but Recommended)

Create `packages/ui-auth/` or add to `packages/openlinear/`:
- `apiFetch(baseUrl, path, init)` — fetch with Bearer token from localStorage
- `useAuth()` hook — context provider, token storage, `/api/auth/me` loader
- `getLoginUrl(client)` — returns `/api/auth/github?client=<client>`

This prevents drift between `desktop-ui` and `dashboard` auth code.

**If skipping extraction**: Copy `lib/api/fetch.ts`, `lib/api/auth.ts`, and `hooks/use-auth.tsx` from `desktop-ui` into `dashboard/lib/`.

### Step 2: Scaffold `apps/dashboard/`

```bash
cd apps/dashboard
# Copy base config from apps/landing or apps/mcp-docs
# next.config.ts, tailwind.config.ts, postcss.config.mjs, tsconfig.json
# package.json with @openlinear/ui-auth dependency
```

Install dependencies:
```bash
pnpm add next react react-dom tailwindcss @tailwindcss/postcss postcss
pnpm add lucide-react recharts
pnpm add -D typescript @types/react @types/node
```

### Step 3: Build Auth Layer

- `lib/config.ts` — exports `API_URL` and `DASHBOARD_ORIGIN`
- `lib/api.ts` — `apiFetch()` + `fetchCurrentUser()` + `fetchUsageSummary()` + `fetchUsageByTask()` + PAT helpers
- `components/auth/auth-provider.tsx` — React context for auth state
- `app/login/page.tsx` — login page with GitHub link
- `app/(app)/layout.tsx` — auth gate: if no token/user, redirect to `/login`

### Step 4: Build Analytics Components

- `components/usage/summary-card.tsx` — stat cards
- `components/usage/daily-chart.tsx` — recharts bar chart
- `components/usage/task-table.tsx` — sortable table with pagination
- `app/(app)/page.tsx` — compose components, fetch data on mount

### Step 5: Build PAT Management Components

- `components/pats/pat-list.tsx` — list existing PATs
- `components/pats/pat-create-form.tsx` — dialog to create new PAT
- `app/(app)/page.tsx` — add PAT section below analytics

### Step 6: API OAuth Updates

- `apps/api/src/routes/auth.ts` — add `dashboard` client support
- Verify `CORS_ORIGIN` includes dashboard origin

### Step 7: Typecheck & Build

```bash
pnpm --filter @openlinear/dashboard typecheck
pnpm --filter @openlinear/api typecheck
```

### Step 8: Deploy

**Option A: Vercel** (recommended, same as landing/mcp-docs)
- Add `apps/dashboard` to Vercel
- Set `NEXT_PUBLIC_API_URL=https://api.openlinear.tech`
- Alias to `dash.openlinear.tech`

**Option B: VPS (PM2 + nginx)**
- Add PM2 entry for dashboard (static export or Next.js server)
- Add nginx vhost for `dash.openlinear.tech`
- Update deploy script

---

## QA Checklist

### Auth Flow
- [ ] `GET /api/auth/github?client=dashboard` redirects to GitHub with `state` containing `client:dashboard`
- [ ] After OAuth approval, redirects back to `dash.openlinear.tech?token=<jwt>`
- [ ] Dashboard stores token, calls `/api/auth/me`, displays user info
- [ ] `GET /api/auth/github` (without `client`) still redirects to `openlinear.tech` (desktop-ui unchanged)
- [ ] Logout clears token and redirects to `/login`

### CORS
- [ ] `curl -H "Origin: https://dash.openlinear.tech" ... /api/usage/summary` returns `Access-Control-Allow-Origin: https://dash.openlinear.tech`

### Analytics
- [ ] Dashboard displays `totalCostUsd`, `totalRuns`, `totalInputTokens`, `totalOutputTokens` from `/api/usage/summary`
- [ ] Daily chart renders 30 bars from `summary.daily[]`
- [ ] Task table paginates and sorts correctly from `/api/usage/by-task`

### PATs
- [ ] `GET /api/pats` lists user's PATs with correct prefixes/scopes
- [ ] Create PAT form generates token, displays it once, allows copy
- [ ] Revoke button removes PAT from list (calls `DELETE /api/pats/:id`)
- [ ] Revoked PAT no longer works for MCP authentication

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Auth code drift between desktop-ui and dashboard | Extract shared auth primitives to `packages/` (Step 1) |
| GitHub OAuth single callback URL | Reuse existing OAuth App with `client=dashboard` state param |
| CORS origin not added | Add `dash.openlinear.tech` to `CORS_ORIGIN` in production env |
| Token exposure in URL | Accept existing `?token=` pattern used by desktop-ui |
| Desktop-ui auth breaks | Do not change `FRONTEND_URL`; add `DASHBOARD_URL` instead |

---

## Future Phases (Out of Scope for Phase 1)

- **Task/project health metrics**: Status distributions, completion velocity, overdue counts (needs new API routes)
- **Activity log timeline**: Visual feed of `ActivityLog` events (needs API aggregation)
- **MCP usage tracking**: Tool call counts, latency, error rates (needs new `McpCallLog` model)
- **Team/workspace admin view**: Multi-user aggregates, permission management
- **Public/unauthenticated view**: Marketing showcase of platform stats
- **Real-time updates**: SSE integration for live analytics

---

## Files to Create/Modify

### New Files
- `apps/dashboard/` — entire app directory (~20 files)
- `packages/ui-auth/` — shared auth primitives (optional, recommended)

### Modified Files
- `apps/api/src/routes/auth.ts` — add `dashboard` client support
- `.env.example` — add `DASHBOARD_URL`
- `.env.production` — add `DASHBOARD_URL` and update `CORS_ORIGIN`
- `turbo.json` — add dashboard to build pipeline (auto-detected via package.json)
