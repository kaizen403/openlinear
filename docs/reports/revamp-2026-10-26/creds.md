# W10a — GitHub App repository credentials per git effect

Date: 2026-10-26. Engineer id: `creds` (partial by a worktree agent, finished
and validated in the coordinator workspace). Status: **implemented and
locally validated; not committed, not deployed. No real GitHub App exists
yet; every GitHub call in tests goes to a loopback fake.**

Operator guide: `docs/runbooks/github-app.md`.

## 1. Problem

Before W10a every sidecar git operation (clone, fetch, push, PR API) used the
initiating user's OAuth token: account-wide, long-lived, with every scope the
user granted at login. A compromised or confused run could read or push to
any repository the user can reach, and the token sat in a temporary
credential-helper file on disk for the length of the run.

## 2. What changed

### API (control plane)

| Piece | File | Behaviour |
|---|---|---|
| Config | `services/github-app-config.ts` | Optional `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (RSA ≥ 2048; PEM, `\n`-escaped or base64), `GITHUB_APP_SLUG`, `GITHUB_APP_WEBHOOK_SECRET`, `OPENLINEAR_GIT_CREDENTIAL_FALLBACK` (`user_oauth` default / `deny`). Validated at boot; errors never echo key material. Loopback API override only under `NODE_ENV=test`. |
| GitHub client | `services/github-app.ts` | RS256 App JWT (`iat` −60 s, `exp` +9 min, `iss` App ID, cached); installation lookup per repository (cached 5 min / 1 min negative); mint with `repository_ids: [githubRepoId]` (or `repositories: [name]`) and exactly `EFFECT_PERMISSIONS[effect]`; **response verification** — one repository, same name and id, no permission beyond the request except `metadata:read`, expiry ≤ 1 h — anything else is revoked and refused; `DELETE /installation/token`. |
| Broker | `services/github-app-credentials.ts` | Per attempt+effect: reuse a recorded token with > 10 min left, else mint; record (`execution_git_credentials`: hash + ciphertext for revocation only) and audit; fallbacks per policy; `revokeAttemptGitCredentials` (never throws, clears ciphertext whatever GitHub answers); `describeProjectGitHubApp` for admins. |
| Route | `POST /api/executions/attempts/:id/git-credential` | Body `{ effect: 'fetch' \| 'push' \| 'pull_request' }` (legacy `{ purpose }` maps clone→fetch, publish→pull_request). `fetch` in preparing/running; `push`/`pull_request` only while running and the task is still bound to the attempt. Re-authorizes the initiator on every call. |
| Route | `GET /api/github-app/projects/:projectId/installation` | Owner/admin: configured / installed / suspended / missing permissions / install + manage URLs / policy. In `registry.ts` (`project:github-app`, binding enforced). |
| Revocation | `execution-control.ts`, `execution-sweeper.ts` | Close, release, rejected claim and — added while finishing — **the lease sweeper** after it fences a lost attempt. |
| Schema | migration `20261026140000_w10a_git_credential_grants` | Additive table, CHECKs: effect/kind/revocation enums, hash format, ciphertext format, *token material only for installation tokens*, *revoked rows hold no ciphertext*. |

Effect permissions: `fetch` → `contents:read`; `push` → `contents:write`;
`pull_request` → `contents:write, pull_requests:write`. `workflows` is never
requested.

### Sidecar

- `services/git-credentials.ts`: the token reaches git only as a URL-scoped
  `http.<scheme>://<host>/<owner>/<repo>.git.extraHeader` via
  `GIT_CONFIG_COUNT/KEY/VALUE` in the child environment — not argv, not a
  remote URL, not `.git/config`, no credential-helper file (the old
  `createGitCredentialConfig` temp file is gone). Requires git ≥ 2.31;
  header-unsafe tokens refused; `acquireGitCredential` logs the kind only and
  refuses a credential past `notAfter`.
- v2 run engine (`run/service.ts`): `fetch` right before the clone, `push`
  right before the push, a separate `pull_request` token for the PR API.
- `persistence/api-store.ts` (legacy engine) uses the same broker.

## 3. Evidence

| Gate | Result |
|---|---|
| `apps/api/src/__tests__/github-app.credentials.test.ts` (new) | 19/19 — config validation (half config, 1024-bit RSA, EC key, garbage PEM without echo, escaped/base64 PEM, override only loopback+test); mint scoped to repo id + effect permissions, JWT RS256/iss/600 s verified by the fake with the public key; hash + ciphertext only; audit without token; reuse / per-effect sets / 10-min refresh; close revokes all 4 tokens and clears ciphertext; push/PR need running; over-broad repos / permissions / expiry → 502 `GITHUB_APP_TOKEN_REJECTED` and the token revoked; bound-PAT attempt gets installation token; **sweeper revokes**; not installed → OAuth fallback (no token stored); not configured → GitHub never called; deny → 403 `GITHUB_APP_REQUIRED` + install URL; suspended → manage URL; insufficient permissions and 422; bound PAT never gets OAuth (403 `PAT_WORKSPACE_RESTRICTED`); wrong key / lookup 500 / mint 503 → 502, never fallback; discovery route. |
| `apps/sidecar/src/services/git-credentials.test.mjs` | 34/34 (6 stale tests replaced: header env, no userinfo/query in scope, injection refused, token only in child env and `JWT_SECRET` dropped, git < 2.31 refused, log kind not token, expired refused) |
| `apps/sidecar/src/services/git-credentials.realgit.test.ts` (new) | 2/2 — real `git ls-remote` against a loopback server: Authorization sent to `/acme/repo.git` only, not `/other/repo.git`, none without a token |
| API full suite | 69 files, 761 passed, 3 skipped |
| Sidecar unit / integration | 1057 passed (3 skipped) / 26 passed |
| Typecheck api + sidecar, `pnpm lint` (317 files incl. the W10a files), fresh-DB migrate + drift | clean, `No difference detected` |
| Test hygiene | `applyTestEnv` now deletes `GITHUB_APP_*` / `OPENLINEAR_GITHUB_API_URL` / fallback policy so a developer `.env` can never make the suite mint real tokens |

## 4. Not done / owed

- **No real App yet** (owner action): create it per the runbook, install on
  a test repository and run one task end to end; only then consider
  `OPENLINEAR_GIT_CREDENTIAL_FALLBACK=deny`.
- Desktop UI: surface `installUrl` / `GITHUB_APP_REQUIRED` /
  `PAT_WORKSPACE_RESTRICTED` in the run drawer and project settings (API is
  ready: the discovery route).
- Installation webhook (`installation`, `installation_repositories`) to drop
  cached lookups immediately; today caches expire in 1–5 min.
- Desktop-local runs without the control plane still use the local user's
  own git setup; out of W10a scope.
