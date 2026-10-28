# Runbook — Rotate the credentials exposed in this repository

**Severity: critical. Do this before the next deploy.**

Phase 0 code changes make the application *refuse to start* with a placeholder or
missing secret, but code cannot rotate a credential that has already been
published.

## Status (2026-09-10)

| Item | State |
|---|---|
| Public MCP docs PAT literals | **Done.** Redeployed `apps/mcp-docs` to Vercel production (`docs.openlinear.tech` and `mcp-docs-one.vercel.app`). Pages now use `ol_pat_` + 32 `x`. |
| Leaked PAT (`ol_pat_25897b3e…`) | **Owner revoked.** Still confirm `revoked_at` on every prod row when the prod DB is reachable. |
| Dev Neon (`ep-lively-tooth-…`) | **Done.** Password rotated; 3 GitHub tokens re-encrypted under a new `TOKEN_ENCRYPTION_KEY`. New values are in gitignored `.env.dev` (mode 0600). GitHub OAuth leftovers were blanked after the apps were removed. |
| Prod Neon (`ep-wild-feather-…`, `ep-muddy-butterfly-…`) | **Blocked.** Git-history password already rejected. Need Azure Container App `DATABASE_URL` (or Neon console) to confirm PAT revocation and rotate JWT / enc key. |
| GitHub OAuth | **Removed.** Leaked dev secret now 404s (app gone). Leaked prod secret 401s (dead). `/api/auth/github` returns `GITHUB_OAUTH_DISABLED`. Do not put new secrets in Azure until replacement apps exist. |
| `JWT_SECRET` in `.env.example` | **Done.** Placeholder removed so clones cannot copy a published value. |
| Secret scanning + push protection | **On** for `kaizen403/openlinear`. |
| gitleaks in CI | **Added 2026-10-26, not yet run on GitHub.** `dev.yml` job "Secret scan" scans only the commits a PR or push adds, with `.gitleaks.toml` (default rules + OpenLinear PAT and Postgres-URL rules). History is deliberately not scanned in CI (see §1.1). |
| History purge (`git filter-repo`) | **Not done** (force-push; coordinate clones). Rotation is the real fix. |

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
git history** — see step 6.

### 1.1 History scan (2026-10-26, gitleaks 8.30.1 + `.gitleaks.toml`, values redacted)

Scope: every commit reachable from `922dbd7` or from a release tag (the
`v0.1.x` tags are on the public remote and carry 233 commits that `dev` no
longer contains), plus the working tree. The working tree is clean. Findings in
history, excluding documented fixtures and false positives:

| Commit (date, UTC) | File | Rule | Note |
|---|---|---|---|
| `f37414b` (2026-05-31) | `.env.dev` | `generic-api-key` (`TOKEN_ENCRYPTION_KEY`), `postgres-url-password` (`DATABASE_URL`) | Listed above; dev Neon rotated |
| `f37414b` (2026-05-31) | `.env.prod` | `generic-api-key` (`GITHUB_CLIENT_SECRET`), `postgres-url-password` (`DATABASE_URL`) | Listed above; prod Neon rotation blocked |
| `d7aece7` (2026-05-21) | `AGENTS.md`, `ISSUES.md` | `openlinear-pat` | The leaked PAT; owner revoked |
| `c6bb0d5` (2026-05-22) | `apps/mcp-docs/app/authentication/page.tsx`, `.../quickstart/page.tsx` | `openlinear-pat` | Same PAT; pages since redeployed |
| `65373df` (2026-05-05) | `.env.docker` (deleted in `657a84c`) | `generic-api-key` (`GITHUB_CLIENT_SECRET`) | **Not in the table above.** A third GitHub OAuth client secret, different from the `.env.dev`/`.env.prod` values (compared by hash). The same file also carries a hyphenated dev `JWT_SECRET` phrase. Confirm the OAuth app whose client ID is in that file is deleted, and that the phrase was never used outside local Docker. |
| `7076fd7` (2026-02-08) | `apps/desktop-ui/app/settings/page.tsx` | `generic-api-key` | An `sk-ol-…` key hard-coded in a settings mock-up. OpenLinear never issued `sk-ol-` keys; most likely fake, listed for completeness. |
| `8193d28` (2026-03-01), tags only | `.github/workflows/deploy.yml:130` | `generic-api-key` | **Not in the table above.** A 64-hex value passed to `npm publish --otp=`. Removed the same day (`1876b72`), but still reachable from 44 public tags (up to `v0.1.61`). It is not a one-time-password shape: find out whether it was a registry or GitHub token, and revoke it if so. |
| `5d2534d` (2026-03-01), tags only | `apps/intro-video/build/318.bundle.js` | `algolia-api-key` | Committed Remotion build output. Algolia keys in client bundles are public search-only keys; low risk. |

The default gitleaks rules miss the PAT and the database URLs; the two custom
rules in `.gitleaks.toml` exist because of these leaks. Run locally (redacted):

```bash
gitleaks git --config .gitleaks.toml --redact .                  # full history, all refs incl. tags
# tracked files only (a plain `gitleaks dir .` also walks node_modules):
git checkout-index -a --prefix=/tmp/ol-tree/ && gitleaks dir --config .gitleaks.toml --redact /tmp/ol-tree
```

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
   your local `.env`). `DATABASE_URL` is the only database variable the API,
   worker and Prisma CLI read (`packages/db/prisma.config.ts`); there is no
   `DIRECT_DATABASE_URL` (an earlier version of this runbook said there was).
   `SHADOW_DATABASE_URL` exists only for the CI drift check's disposable
   database. To run `prisma migrate deploy` against Neon, give that one command
   a direct (non-`-pooler`) connection string in `DATABASE_URL`.

3. **`TOKEN_ENCRYPTION_KEY`.** Generate with `openssl rand -base64 48`.
   Stored GitHub tokens are encrypted under the *old* key, so you must
   re-encrypt rather than simply swap:
   ```bash
   # with BOTH the old and new key available
   OLD_TOKEN_ENCRYPTION_KEY='<old>' TOKEN_ENCRYPTION_KEY='<new>' \
     pnpm --filter @openlinear/db db:reencrypt-tokens
   ```
   `db:encrypt-tokens` only encrypts leftover **plaintext**. Use
   `packages/db/scripts/reencrypt-tokens.ts` when ciphertext already exists.
   Take a database snapshot first. If re-encryption is not practical, the
   fallback is to null out `User.accessToken` for all users. Reconnect-GitHub
   is not available until replacement OAuth apps exist.

4. **`JWT_SECRET`.** Generate with `openssl rand -base64 48`. Rotating it
   invalidates every existing session, which is the desired outcome here. Set it
   in Azure config. The desktop app needs no JWT secret: since W03a the sidecar
   validates tokens through the cloud API, and the Tauri launcher strips
   `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` from the sidecar's
   environment (`apps/desktop/src-tauri/src/sidecar.rs`, `SIDECAR_FORBIDDEN_ENV`).
   Skip `OPENLINEAR_ALLOW_SESSIONLESS_JWT`.

5. **GitHub OAuth.** The leaked apps are gone. Login stays 503
   (`GITHUB_OAUTH_DISABLED`). Clear `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
   from Azure when you can; the API no longer requires them to boot. Do not
   mint replacement apps unless you intend to turn login back on.

6. **History.** The values above remain readable in every clone of this
   repository. Rotation makes them worthless, which is the real fix. Purging
   history (`git filter-repo`) additionally requires a force-push and coordination
   with everyone who has a clone; it was deliberately **not** done automatically.
   Decide explicitly whether to do it, and if the repo is public treat all five
   credential classes as compromised regardless.

7. **Prevent recurrence.** GitHub secret scanning + push protection are on.
   gitleaks runs in CI on every PR and `dev` push (`.github/workflows/dev.yml`,
   job "Secret scan"; rules in `.gitleaks.toml`). A local pre-commit hook is
   optional: `gitleaks git --config .gitleaks.toml --staged --redact .`
   (gitleaks ≥ 8.19; the CI pin is 8.30.1).

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
