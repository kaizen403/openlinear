# Draft: GitHub Auth — Wire Up & Polish

## Requirements (confirmed from user spec)
- Add `.env.example` with all required env vars → ALREADY EXISTS at `apps/api/.env.example`
- Add `.env` with placeholder credentials → Currently only has DATABASE_URL
- Add sign-in entry point to sidebar bottom (below Settings)
- When authenticated: show user avatar + username + sign-out in sidebar
- Remove UserMenu from header (page.tsx)
- "Implement best level auth" — AMBIGUOUS, needs clarification

## Existing Implementation (fully built)

### Backend (Complete)
- `apps/api/src/routes/auth.ts` — OAuth routes: /github (redirect), /github/callback (exchange code + JWT), /me, /logout
- `apps/api/src/services/github.ts` — Full GitHub service: auth URL, token exchange, user/repo fetching, Prisma operations
- `apps/api/src/middleware/auth.ts` — optionalAuth() and requireAuth() middleware
- `apps/api/src/routes/repos.ts` — Authenticated repo operations
- `apps/api/src/app.ts` — Express app with CORS, cookieParser, all routes registered

### Frontend (Complete)
- `apps/desktop-ui/hooks/use-auth.tsx` — AuthContext: user, activeProject, isLoading, isAuthenticated, token in localStorage
- `apps/desktop-ui/lib/api.ts` — Full API client with Bearer token auth
- `apps/desktop-ui/components/auth/user-menu.tsx` — Sign in / avatar+logout component
- `apps/desktop-ui/components/auth/project-selector.tsx` — ProjectSelector dialog

### Environment
- `apps/api/.env.example` — All vars documented (GITHUB_CLIENT_ID, SECRET, REDIRECT_URI, JWT_SECRET, FRONTEND_URL, etc.)
- `.env` — Only DATABASE_URL (no GitHub vars)
- `.gitignore` — `.env` is gitignored

### UI Layout
- `app-shell.tsx` — Sidebar + main content layout with drag-resize
- `sidebar.tsx` — ProjectSelector (when auth'd), nav links, Settings at bottom (line 202-215)
- `page.tsx` — Header with UserMenu at line 50

## Security Audit Findings

### CRITICAL Issues in Existing Code:
1. **JWT passed via URL query param** (auth.ts:51) — `?token=${token}` visible in browser history, logs, referrer
2. **No OAuth state validation** (auth.ts:20-24) — State generated but NEVER verified on callback → CSRF vulnerability
3. **GitHub accessToken stored in plain text** (schema.prisma:84) — If DB compromised, all tokens exposed
4. **JWT_SECRET hardcoded fallback in 3 files** — auth.ts:13, middleware/auth.ts:4, repos.ts:15 — should be centralized
5. **JWT stored in localStorage** — XSS-vulnerable (though less critical for desktop app)
6. **Logout is a no-op** (auth.ts:84-86) — No server-side invalidation
7. **The /me endpoint duplicates auth middleware logic** — Manual header parsing instead of using requireAuth

### Minor Issues:
- cookieParser imported and configured but unused
- CORS credentials:true set but no cookies used
- No token refresh mechanism (7-day hard expiry)

## Technical Decisions
- PENDING: Scope of "best level auth"
- CONFIRMED: Use Tailwind CSS, lucide-react icons, shadcn/ui components (matching existing patterns)
- CONFIRMED: Express backend with Prisma ORM
- CONFIRMED: Next.js frontend with AuthContext

## Open Questions
1. What does "Implement best level auth" mean? Security hardening or just functional wiring?
2. Test strategy — vitest exists, should we add auth tests?

## Scope Boundaries
- INCLUDE: Env vars, sidebar auth UI, header cleanup
- INCLUDE?: Security fixes (state validation, token delivery, JWT centralization)
- EXCLUDE: Probably don't need token encryption at rest for a local dev tool
