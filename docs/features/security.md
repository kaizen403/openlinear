# Security Model

Overview of authentication, authorization, and security measures in OpenLinear.

## Authentication Methods

OpenLinear supports two authentication methods:

### 1. Local Authentication (Username + Password)

- Passwords hashed with bcrypt (12 rounds)
- JWT tokens issued on login with 7-day expiry
- Tokens stored as httpOnly cookies

### 2. GitHub OAuth

- Authorization code flow for web/desktop
- Device flow for CLI authentication
- GitHub access tokens encrypted at rest
- Token refresh handled automatically

## Authorization Model

### Middleware Stack

The API uses two auth middleware functions defined in `apps/api/src/middleware/auth.ts`:

**`requireAuth`** — Rejects requests without a valid JWT. Attaches `req.userId` for downstream handlers.

**`optionalAuth`** — Allows unauthenticated access but attaches `req.userId` if a valid token is present. Used for public-readable endpoints.

### Endpoint Security Matrix

| Resource | Read | Create | Update | Delete |
|----------|------|--------|--------|--------|
| Tasks | Optional | Required | Required | Required |
| Projects | Optional | Required | Required | Required |
| Teams | Optional | Required | Required | Required |
| Team Members | Optional | Required | — | Required |
| Repositories | Required | Required | Required | Required |
| Labels | Optional | Required | Required | Required |
| Settings | Optional | — | Required | — |
| Inbox | Required | — | Required | — |

### Team Scoping

Team-scoped queries use the `team-scope` service (`apps/api/src/services/team-scope.ts`) to resolve the correct team context from request parameters. This ensures users only access resources within their team membership.

## Input Validation

### Payload Sanitization

The `@openlinear/openlinear` package provides payload sanitization via forbidden field stripping. The following fields are automatically removed from any execution metadata payload:

**Credential fields:** `accessToken`, `apiKey`, `passwordHash`, `jwt`, `refreshToken`, `sessionToken`

**Internal fields:** `prompt`, `logs`, `toolLogs`, `executionLogs`, `rawOutput`, `diff`, `fileContents`

**Runtime fields:** `client`, `timeoutId`, `env`, `environment`, `processEnv`, `repoPath`

See `packages/openlinear/src/validation/security.ts` for the complete list.

### Request Provenance

The provenance middleware (`apps/api/src/middleware/provenance.ts`) tracks the origin of API requests (desktop app, CLI, or external) for audit purposes.

## Security Headers

The Express API configures:
- CORS with configurable allowed origins
- JSON body parsing with size limits
- Cookie security (httpOnly, secure in production, sameSite)

## Known Security Considerations

1. **Local-first model**: The sidecar API runs on localhost without authentication, relying on OS-level access control
2. **GitHub tokens**: Stored in the database — ensure database encryption at rest in production
3. **JWT secret**: Configured via `JWT_SECRET` environment variable — must be strong and unique per deployment
