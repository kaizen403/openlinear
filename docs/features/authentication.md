# Authentication

OpenLinear supports three distinct authentication modes: email/password, GitHub OAuth (web flow), and GitHub device flow (desktop). A fourth mode, local desktop session, creates an anonymous user tied to the OS username without any credentials. All modes produce a JWT that subsequent requests carry as a Bearer token.

## Data Model

The `User` model in `packages/db/prisma/schema.prisma` stores all auth-relevant fields:

```prisma
model User {
  id           String   @id @default(uuid())
  githubId     Int?     @unique
  username     String   @unique
  email        String?
  avatarUrl    String?
  accessToken  String?
  passwordHash String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  repositories    Repository[]
  teamMemberships TeamMember[]
  ledProjects     Project[]    @relation("projectLead")
}
```

Key points:
- `githubId` is nullable. A user created via email/password has no GitHub identity until they connect one.
- `passwordHash` is a bcrypt hash (cost factor 10). GitHub-only users have `null` here.
- `accessToken` stores the GitHub OAuth access token when present.
- A user with `githubId = null`, `passwordHash = null`, and a username starting with `local-` is a local desktop session user.

## API Endpoints

All auth routes are mounted at `/api/auth` in `apps/api/src/app.ts`.

| Method | Path | Auth required | Description |
|--------|------|---------------|-------------|
| `POST` | `/api/auth/register` | No | Create email/password account |
| `POST` | `/api/auth/login` | No | Email/password login |
| `POST` | `/api/auth/local/session` | No (desktop header) | Create or retrieve local desktop user |
| `GET` | `/api/auth/github` | No | Start GitHub OAuth web flow |
| `GET` | `/api/auth/github/desktop/check` | No (desktop header) | Check if `gh` CLI or `GITHUB_TOKEN` is available |
| `POST` | `/api/auth/github/desktop/login` | No (desktop header) | Login using local GitHub token |
| `POST` | `/api/auth/github/device/start` | No (desktop header) | Start GitHub device flow |
| `POST` | `/api/auth/github/device/poll` | No (desktop header) | Poll device flow for completion |
| `GET` | `/api/auth/github/connect` | Yes | Get URL to connect GitHub to existing account |
| `GET` | `/api/auth/github/callback` | No | OAuth callback handler |
| `POST` | `/api/auth/github/connect/confirm` | Yes | Confirm GitHub connection using temp token |
| `GET` | `/api/auth/me` | Yes | Return current user profile |
| `POST` | `/api/auth/logout` | No | No-op (client discards token) |

## JWT Structure

Tokens are signed with HS256. The payload contains:

```json
{ "userId": "<uuid>", "username": "<string>" }
```

Expiry is 7 days for session tokens. A short-lived 15-minute token is used during the GitHub connect flow to carry GitHub identity between the OAuth callback and the confirm step.

The secret is read from `JWT_SECRET` env var. In development it falls back to `openlinear-dev-secret-change-in-production`. In production the server throws if the env var is missing.

## Middleware

`apps/api/src/middleware/auth.ts` exports two middleware functions:

**`requireAuth`** — Verifies the Bearer token and attaches `req.userId` and `req.username` to the request. Returns `401` if the header is missing or the token is invalid.

**`optionalAuth`** — Same verification, but calls `next()` regardless of outcome. Routes that want to scope results to the authenticated user but also work anonymously use this.

Both extend `Request` with the `AuthRequest` interface:

```typescript
export interface AuthRequest extends Request {
  userId?: string;
  username?: string;
}
```

## Email/Password Flow

**Registration** (`POST /api/auth/register`):

1. Validates the request body with Zod: `username` (2-50 chars, alphanumeric/hyphen/underscore), `password` (3-100 chars), optional `email`.
2. Checks for username uniqueness.
3. Hashes the password with `bcrypt.hash(password, 10)`.
4. Runs a Prisma transaction that creates the `User`, a default `Team` named `"<username>'s Team"`, and a `TeamMember` record with `role: 'owner'`. The team key is derived from the username (uppercased, max 5 chars) with a numeric suffix if needed.
5. Signs a 7-day JWT and returns `{ token, user }`.

**Login** (`POST /api/auth/login`):

1. Looks up the user by username.
2. Returns `401` if the user doesn't exist or has no `passwordHash` (i.e., is a GitHub-only account).
3. Compares the submitted password with `bcrypt.compare`.
4. Signs and returns a JWT on success.

## GitHub OAuth Web Flow

**Start** (`GET /api/auth/github`):

The handler calls `getGitHubOAuthConfigError()` from `apps/api/src/services/github.ts` to verify that `OPENLINEAR_GITHUB_CLIENT_ID` (or `GITHUB_CLIENT_ID`) and `OPENLINEAR_GITHUB_CLIENT_SECRET` (or `GITHUB_CLIENT_SECRET`) are set.

A `state` value is generated with `crypto.randomUUID()`. For desktop clients (detected via `?source=desktop`, the `x-openlinear-client: desktop` header, or a state prefix), the state is prefixed with `desktop:`. The handler redirects to GitHub's authorization URL:

```
https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=read:user+user:email+repo&state=...
```

Desktop clients use `http://localhost:1455/callback` as the redirect URI; web clients use `http://localhost:3001/api/auth/github/callback`.

**Callback** (`GET /api/auth/github/callback`):

1. Reads `code`, `state`, and any `error` from the query string.
2. Determines whether this is a desktop login, desktop connect, or web login from the state prefix.
3. Calls `exchangeCodeForToken(code, isDesktop)` which POSTs to `https://github.com/login/oauth/access_token` with the client secret.
4. For a plain login: calls `getGitHubUser(accessToken)` then `createOrUpdateUser(githubUser)` (an upsert on `githubId`), signs a JWT, and redirects to `openlinear://callback?token=<jwt>` (desktop) or `http://localhost:3000?token=<jwt>` (web).
5. For a connect flow: signs a short-lived 15-minute JWT containing the GitHub identity and redirects with `github_connect_token=<temp_jwt>`.

## GitHub Desktop Login (Local Token)

`GET /api/auth/github/desktop/check` calls `getDesktopGitHubAuthSource()` from `apps/api/src/services/github.ts`, which:

1. Tries `gh auth token` via `spawnSync`. If the `gh` CLI is authenticated, returns the token with `source: 'gh'`.
2. Falls back to `OPENLINEAR_GITHUB_TOKEN` or `GITHUB_TOKEN` env vars with `source: 'env'`.
3. Returns `null` if neither is available.

`POST /api/auth/github/desktop/login` uses the same source to call `completeGitHubLogin(accessToken)`, which fetches the GitHub user profile and upserts the database record, then returns a session JWT.

## GitHub Device Flow

For desktop environments where neither the `gh` CLI nor a local token is available, the device flow lets users authenticate by visiting a URL on any browser.

**Start** (`POST /api/auth/github/device/start`):

POSTs to `https://github.com/login/device/code` with the client ID and scopes. Returns `{ device_code, user_code, verification_uri, expires_in, interval }`.

**Poll** (`POST /api/auth/github/device/poll`):

Accepts `{ deviceCode }`. POSTs to `https://github.com/login/oauth/access_token` with `grant_type: urn:ietf:params:oauth:grant-type:device_code`. Returns `202` with `{ status: 'pending' }` while the user hasn't approved, or `200` with `{ status: 'complete', token, user }` once they have. GitHub's `slow_down` error adds a 10-second retry hint.

## GitHub Account Connect

An existing email/password user can link their GitHub account without losing their data.

1. `GET /api/auth/github/connect` — verifies the user's session JWT, then returns a GitHub authorization URL with a `connect:` or `desktop_connect:` state prefix.
2. After the OAuth callback, a 15-minute temp token is issued containing `{ githubId, githubLogin, githubEmail, githubAvatarUrl }`.
3. `POST /api/auth/github/connect/confirm` — verifies both the session JWT and the temp token, calls `connectGitHubToUser(userId, githubUser)` which checks that the GitHub account isn't already linked to a different user, then updates the `User` record. Issues a fresh 7-day session JWT.

## Local Desktop Session

`POST /api/auth/local/session` is only accessible when the `x-openlinear-client: desktop` header is present.

It calls `getOrCreateLocalDesktopUser()`, which:

1. Looks for an existing user with `githubId = null`, `passwordHash = null`, and a username starting with `local-`.
2. If none exists, reads the OS username via `os.userInfo().username`, sanitizes it (lowercase, alphanumeric/hyphen only, max 32 chars), and creates a user as `local-<osusername>`. Appends a numeric suffix if the username is taken.

This allows the desktop app to work offline without any credentials.

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/auth.ts` | All auth route handlers |
| `apps/api/src/middleware/auth.ts` | `requireAuth` and `optionalAuth` middleware |
| `apps/api/src/services/github.ts` | GitHub API calls, token exchange, user upsert, repo helpers |
| `apps/api/src/app.ts` | Express app setup, route mounting |
| `packages/db/prisma/schema.prisma` | `User` and `Repository` models |
