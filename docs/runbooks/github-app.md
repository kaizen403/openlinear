# Runbook — OpenLinear GitHub App (W10a repository credentials)

The execution control plane hands each sidecar git effect (`fetch`, `push`,
`pull_request`) the narrowest credential available: a GitHub App
installation token restricted to the attempt's repository and the effect's
permissions, expiring within an hour and revoked when the attempt closes.
Without the App, the initiating user's OAuth token is used — only if
`OPENLINEAR_GIT_CREDENTIAL_FALLBACK` allows it.

Code: `apps/api/src/services/github-app*.ts`, sidecar
`apps/sidecar/src/services/git-credentials.ts`. Design and evidence:
`docs/reports/revamp-2026-10-26/creds.md`.

## 1. Create the App (once, per environment)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
(under the organization that owns it).

| Setting | Value |
|---|---|
| Homepage URL | the product URL |
| Webhook | inactive (the installation webhook is not routed yet) |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, Metadata: Read (mandatory). Nothing else — in particular **not Workflows**, so a run can never push `.github/workflows/*`. |
| Organization / account permissions | none |
| Where can it be installed | Any account (users install it on their repositories) |

Generate a private key (Settings → Private keys). GitHub gives a PEM once;
store it only in the secret store.

## 2. Configure the API

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_APP_ID` | yes (with the key) | numeric App ID, or the client ID (`Iv…`) |
| `GITHUB_APP_PRIVATE_KEY` | yes (with the ID) | RSA ≥ 2048 bits; PEM with real newlines, with literal `\n`, or base64 of the PEM |
| `GITHUB_APP_SLUG` | no | URL name for install links; otherwise `GET /app` (cached) |
| `GITHUB_APP_WEBHOOK_SECRET` | no | ≥ 32 chars when set; reserved |
| `OPENLINEAR_GIT_CREDENTIAL_FALLBACK` | no | `user_oauth` (default) or `deny` |

Boot validation (`validateStartupEnv` → `validateGitHubAppEnv`) refuses to
start on a half-configured App, a non-RSA or short key, a malformed ID/slug or
an unknown policy. Messages never contain key material.

`OPENLINEAR_GITHUB_API_URL` is a test hook: honoured only when
`NODE_ENV=test` and the URL is `http://127.0.0.1|localhost`. Never set it in
production.

## 3. Install on a repository

A workspace owner/admin can check a project:

```
GET /api/github-app/projects/<projectId>/installation
```

Returns `configured`, `installed`, `suspended`, `installationId`,
`missingPermissions`, `installUrl` (`https://github.com/apps/<slug>/installations/new`),
`manageUrl`, `fallbackPolicy` and the per-effect permission table. Send the
user to `installUrl`, select the repository, then re-check (installation
lookups are cached 5 min when installed, 1 min when not).

## 4. Fallback policy

| Situation | `user_oauth` (default) | `deny` |
|---|---|---|
| App not configured | user OAuth token, reason `app_not_configured` | 403 `GITHUB_APP_REQUIRED` |
| App not installed on the repo | user OAuth, `app_not_installed` | 403 + `installUrl` |
| Installation suspended | user OAuth, `installation_suspended` | 403 + manage URL |
| Installation lacks contents/pull_requests write (or GitHub answers 422) | user OAuth, `installation_permissions_insufficient` | 403 + manage URL |
| Task without a linked repository | no credential (`kind: none`) | no credential |
| Workspace-bound PAT started the run | **403 `PAT_WORKSPACE_RESTRICTED`** (never the account-wide token) | 403 `GITHUB_APP_REQUIRED` |
| GitHub down, or GitHub refuses the App JWT | **502 `GITHUB_APP_UNAVAILABLE`** — never a fallback | same |
| GitHub returns a broader token than requested | token revoked, **502 `GITHUB_APP_TOKEN_REJECTED`** | same |

Switch to `deny` once every active repository has the App: from then on no
run can act with a user's account-wide token.

## 5. Operations

**What is recorded.** `execution_git_credentials` holds one row per issued
credential: effect, kind, repository, installation, permissions, fallback
reason, SHA-256 of an installation token and its ciphertext (for revocation
only), expiry, revocation status. The user's OAuth token is never copied
there (DB CHECK). Workspace audit actions:
`execution.git_credential_issued` / `_denied` / `_revoked`.

**Revocation.** At attempt close, release, rejected claim, and when the
lease sweeper fences a lost attempt, every still-recorded installation token
is revoked with `DELETE /installation/token` and its ciphertext cleared
(`revocationStatus` `revoked` / `already_invalid` / `expired` / `failed`). A
failed revocation leaves a token that dies on its own within the hour.

Useful queries (read-only):

```sql
-- credentials issued in the last day, by kind and fallback reason
SELECT kind, fallback_reason, count(*) FROM (
  SELECT kind, "fallbackReason" AS fallback_reason FROM execution_git_credentials
  WHERE "createdAt" > now() - interval '1 day') t GROUP BY 1, 2;

-- installation tokens that were not revoked cleanly
SELECT id, "attemptId", effect, "revocationStatus", "expiresAt"
FROM execution_git_credentials
WHERE kind = 'installation' AND ("revocationStatus" = 'failed'
  OR ("revokedAt" IS NULL AND "expiresAt" < now()));
```

**Key rotation.** Generate a second key in the App settings, deploy it as
`GITHUB_APP_PRIVATE_KEY`, verify a run (an `execution.git_credential_issued`
audit row with `kind: installation`), then delete the old key on GitHub.
The API re-reads the configuration when the environment changes; JWT and
installation caches are keyed by App ID and API URL.

**GitHub refuses the App (502, log `GitHub refused the App credentials`).**
Check the App ID, that the key has not been deleted on GitHub, and the host
clock (JWTs are backdated 60 s and live 9 min).

**A token was refused as over-broad (log `refused an over-broad installation
token`).** The installation granted more than requested (other repositories,
extra permissions, or an expiry beyond one hour). The token was revoked and
never used. Inspect the installation's repository selection and permissions;
report to GitHub if the request body was correct.

## 6. Sidecar requirements

The sidecar passes the token to git as a URL-scoped
`http.<origin>/<owner>/<repo>.git.extraHeader` through `GIT_CONFIG_COUNT`
environment variables: never in argv, a remote URL, `.git/config` or a
credential-helper file. This needs **git ≥ 2.31**; older git is refused with
`GIT_CREDENTIAL_UNUSABLE`. Tokens past their `notAfter` are refused before
use.
