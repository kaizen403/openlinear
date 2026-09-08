# Runbook — Rotate the credentials exposed in this repository

**Severity: critical. Do this before the next deploy.**

Phase 0 code changes make the application *refuse to start* with a placeholder or
missing secret, but code cannot rotate a credential that has already been
published. Everything in this file requires a human with access to the relevant
console. Nothing here has been done automatically.

## 1. What is exposed, and where

| Credential | Where it leaked | Impact if unrotated |
|---|---|---|
| `JWT_SECRET` | `.env` and `.env.dev` contain the literal `openlinear-dev-secret-change-in-production`, which is also in `.env.example` and was hard-coded in five source files | Anyone can forge a session token for any user, offline. This is the single most urgent item. |
| `TOKEN_ENCRYPTION_KEY` | `.env`, `.env.dev` (committed) | Decrypts every stored GitHub OAuth token in the database. |
| Neon database passwords (dev **and** prod branches) | `.env.dev`, `.env.prod` (committed) | Direct read/write on production data. |
| GitHub OAuth client secret(s) | `.env.dev`, `.env.prod` (committed) | Impersonation of the OAuth app. |
| Personal access tokens (`ol_pat_…`) | Committed in `ISSUES.md`, `AGENTS.md`, and **published on the public MCP docs site** (`apps/mcp-docs/app/authentication/page.tsx`, `.../quickstart/page.tsx`); a second token in `docs/features/mcp-integration.md` | Full API access as the owning user; PATs defaulted to the `*` scope and never expire. |

`.env.dev` and `.env.prod` were tracked by git. Phase 0 fixed `.gitignore` (the
old rules enumerated suffixes and missed both names) and untracked them with
`git rm --cached`, so they stay on disk but leave the index. **They remain in
git history** — see step 5.

## 2. Order of operations

Rotate in this order so you do not lock yourself out.

1. **PATs first** (fastest, highest exposure). Revoke every `ol_pat_…` in
   `/api/pats`, then remove the literals from `ISSUES.md`, `AGENTS.md`,
   `docs/features/mcp-integration.md` and both `apps/mcp-docs` pages, replacing
   them with `ol_pat_` + 32 `x`. Redeploy the docs site — until you do, the
   token stays publicly readable. Then audit `audit_logs` and `mcp_tool_calls`
   for use you do not recognise.

2. **Neon passwords.** Reset the role password on both the dev and prod
   branches. Update `DATABASE_URL` in Azure Container Apps configuration (and
   your local `.env`). Note that Phase 0 also added `DIRECT_DATABASE_URL` usage
   for migrations — set both.

3. **`TOKEN_ENCRYPTION_KEY`.** Generate with `openssl rand -base64 48`.
   Stored GitHub tokens are encrypted under the *old* key, so you must
   re-encrypt rather than simply swap:
   ```bash
   # with BOTH the old and new key available
   pnpm --filter @openlinear/db db:encrypt-tokens
   ```
   Read `packages/db/scripts/encrypt-tokens.ts` before running it and take a
   database snapshot first. If re-encryption is not practical, the fallback is to
   null out `User.accessToken` for all users and have them reconnect GitHub —
   disruptive but safe.

4. **`JWT_SECRET`.** Generate with `openssl rand -base64 48`. Rotating it
   invalidates every existing session, which is the desired outcome here. Set it
   in Azure config. For the desktop app, the Tauri launcher now generates a
   per-install random secret into the OS keychain — no shared value ships.

5. **History.** The values above remain readable in every clone of this
   repository. Rotation makes them worthless, which is the real fix. Purging
   history (`git filter-repo`) additionally requires a force-push and coordination
   with everyone who has a clone; it was deliberately **not** done automatically.
   Decide explicitly whether to do it, and if the repo is public treat all five
   credential classes as compromised regardless.

6. **Prevent recurrence.** Enable GitHub secret scanning + push protection on
   the repository, and add `gitleaks` to pre-commit and CI (see
   `04-infrastructure/A5-observability-cicd-infra.md` §2 in the revamp plan).

## 3. Verifying the rotation

After rotating, the application should refuse to boot on a bad value rather than
silently accepting it:

```bash
# Should throw SecretConfigurationError, not start:
JWT_SECRET=openlinear-dev-secret-change-in-production pnpm --filter @openlinear/api dev
JWT_SECRET=short pnpm --filter @openlinear/api dev

# Should start:
JWT_SECRET="$(openssl rand -base64 48)" TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)" \
  pnpm --filter @openlinear/api dev
```

`GET /readyz` reports `secrets: "ok"` only when both are present and acceptable.

## 4. Session-revocation transition

`isSessionRevoked` now fails **closed**: a JWT with no `Session` row is rejected.
Every token-issuing path creates one, but tokens minted *before* this deploy do
not have rows. For one deploy window you may set:

```
OPENLINEAR_ALLOW_SESSIONLESS_JWT=1
```

Remove it after 7 days (one token lifetime). If you rotate `JWT_SECRET` as part
of this runbook, every old token is invalid anyway and you can skip the flag
entirely — preferred.
