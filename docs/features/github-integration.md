# GitHub Integration

OpenLinear integrates with GitHub for authentication, repository management, and pull request creation.

## OAuth Authentication

### Flow

1. User clicks "Sign in with GitHub" in the sidebar
2. `GET /api/auth/github` redirects to GitHub's authorization page
3. User authorizes the app (scopes: `read:user user:email repo`)
4. GitHub redirects to `/api/auth/github/callback` with a code
5. The API exchanges the code for an access token
6. Creates or updates the user record in the database
7. Returns a JWT (7-day expiry) via redirect to the frontend

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_CLIENT_ID` | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret |
| `GITHUB_REDIRECT_URI` | Callback URL (default: `http://localhost:3001/api/auth/github/callback`) |

### Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/github` | Start OAuth flow |
| `GET` | `/api/auth/github/callback` | Handle OAuth callback |
| `GET` | `/api/auth/me` | Get current user (Bearer token) |
| `POST` | `/api/auth/logout` | Logout (client clears token) |

## Repository Management

### With Authentication (private + public repos)

1. `GET /api/repos/github` -- fetch all repos from GitHub (paginated, sorted by updated)
2. `POST /api/repos/import` -- import a repo into OpenLinear
3. `POST /api/repos/:id/activate` -- set as active repository
4. `GET /api/repos/active` -- get current active repository
5. `GET /api/repos` -- list all imported repositories

### Without Authentication (public repos only)

1. `POST /api/repos/url` -- add a public repo by URL
   - Accepts: `https://github.com/owner/repo`, `git@github.com:owner/repo`, or `owner/repo`
   - Fetches metadata from GitHub API
   - Rejects private repositories
2. `POST /api/repos/:id/activate/public` -- set active public repository
3. `GET /api/repos/active/public` -- get active public repository
4. `GET /api/repos/public` -- list all public repositories

### Rate Limits

Public API calls use unauthenticated GitHub API access (60 requests/hour). Set `GITHUB_TOKEN` in your environment for authenticated access (5000 requests/hour).

## Pull Request Creation

When a task execution finishes with changes:

1. If the user has a GitHub access token:
   - `POST https://api.github.com/repos/:owner/:repo/pulls` with the task title and branch
   - PR body: task title and description
   - Returns the PR URL
2. If no token or the API call fails:
   - Returns a compare URL: `https://github.com/:owner/:repo/compare/:base...:branch`
   - User can manually create a PR from this link

### PR Refresh

`POST /api/tasks/:id/refresh-pr` checks whether a PR was created for a task that only has a compare URL. If GitHub returns a PR for that branch, the task's `prUrl` is updated to the real PR URL. For batch tasks, all tasks in the same batch sharing the old compare URL are updated.
