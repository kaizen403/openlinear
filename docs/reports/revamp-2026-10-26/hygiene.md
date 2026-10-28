# Hygiene — secret scanning, release scripts, Linux app-data path, record fixes

**Round:** 4 (2026-10-26) · **Engineer ID:** hygiene · **Status:** done for the local scope
**Owner constraint honoured:** local work only. No commit, push, tag, workflow run, publish or
deploy. GitHub was used read-only (`gh api` GET for release digests). No secret value was
printed, copied or written anywhere; every scan below ran with `--redact`, and the few values
inspected by hand were reduced to a character-class shape or a 12-hex hash prefix.
Base: `922dbd7` + `round4-base.patch` (tree `db77ae5`).

## 1. Outcome

| # | Item | Result |
|---|---|---|
| 1 | Secret scanning | `dev.yml` job **"Secret scan"**: gitleaks 8.30.1 (pinned, SHA-256 verified) on the commits a PR or push adds, never full history. Rules come from the **base** commit's `.gitleaks.toml`, a checked-in `.gitleaksignore` is ignored, findings are redacted. New `.gitleaks.toml`: default rules + two OpenLinear rules (PAT, Postgres URL with password) that catch leaks the defaults miss, and an allowlist of exact fixture values only. Local scans: working tree clean; history findings below. |
| 2 | `scripts/bump-version.js` | Was broken three ways (below). Rewritten: plan-then-write, fail before any write, bumps from the newest tag, `--dry-run`, never touches git. 10 `node:test` tests. |
| 3 | Linux app-data path | The run journal and models.dev cache defaulted to `~/Library/Application Support/OpenLinear` on **every** OS. New `apps/sidecar/src/config/app-data.ts` (XDG on Linux/Unix, `%LOCALAPPDATA%` on Windows, unchanged on macOS, `OPENLINEAR_APP_DATA` override). Journal and catalogue use it. No Rust change needed (§3.3). 9 tests; full sidecar suite green. |
| 4 | AppImage workaround | `scripts/build-appimage-workaround.sh` pins `appimagetool` 1.9.1 + SHA-256 itself (same pin as `release.yml`), verifies cached copies, replaces stale ones, fails on mismatch; `--tool-only`. 14 checks pass on macOS bash 3.2 and Debian bash 5. |
| 5 | Record fixes | Both runbooks corrected; `CODEBASE_INDEX.md` re-verified where it matters (19 MCP tools, counts, layout, W03a sidecar, desktop, CI, production status) and the off-repo revamp plan marked historical; stale "SDK 1.2.5" comment in `services/opencode.ts` fixed after checking the installed SDK. |

## 2. Changes

| File | Change |
|---|---|
| `.github/workflows/dev.yml` | New job `secret-scan` only (other jobs untouched). |
| `.gitleaks.toml` (new) | Config described in §3.1. |
| `scripts/bump-version.js` | Rewritten (§3.2). |
| `scripts/bump-version.test.js` (new) | 10 tests; run `node --test scripts/bump-version.test.js`. |
| `apps/sidecar/src/config/app-data.ts` (new) | `sidecarAppDataDir(env, platform)`. |
| `apps/sidecar/src/config/app-data.test.ts` (new) | 9 tests (helper, journal path, catalogue path). |
| `apps/sidecar/src/journal/sqlite.ts` | `RunJournal.defaultPath(env?, platform?)` uses the helper; `homedir` import removed. |
| `apps/sidecar/src/catalogue/models-dev.ts` | `cachePath()` → exported `modelsDevCachePath(env?, platform?)` using the helper. |
| `scripts/build-appimage-workaround.sh` | Pinned + verified `appimagetool` download (§3.4). |
| `docs/runbooks/rotate-leaked-secrets.md` | `DIRECT_DATABASE_URL` claim removed; stale desktop-keychain claim replaced with the W03a fact; gitleaks status; new §1.1 redacted history scan (incl. a leak the runbook did not list); step reference fixed (5 → 6). |
| `docs/runbooks/apply-hot-path-indexes.md` | "Do not apply as written" status with the 2026-10-26 measurement (9/10 indexes change no plan), corrected `linear_projects` table name, false drift-check claim replaced with what the check actually compares, `DIRECT_DATABASE_URL` replaced, EXPLAIN example uses today's `createdAt` ordering, per-index measured column. |
| `docs/CODEBASE_INDEX.md` | Banner + "which plan is current" table (revamp plan = historical); §5 MCP rewritten from code (19 tools, 2.4.0 server, auth/idempotency); counts (31 route files, 155 registry routes, 55 API test files, 5 Rust files); packages (`types` deleted; `api-client`, `api-core`, `telemetry`); sidecar W03a architecture + app-data paths; desktop rows (env allowlist, code+state deep link, `opencode.rs`, CSP, deb + AppImage, app-data dirs); CI table of all 5 workflows with real triggers; production status (API down, last release v0.1.61). |
| `apps/sidecar/src/services/opencode.ts` | Comments only (lines 84–104): "pinned @opencode-ai/sdk@1.2.5" → the v1 `Config` of the installed 1.18.30 (verified: no `permission.read`, no `compaction`; the `/v2` types have both). |
| `docs/reports/revamp-2026-10-26/hygiene.md` (new) | This ledger. |

## 3. Evidence

### 3.1 Secret scanning

**Tool provenance.** gitleaks v8.30.1 (latest, 2026-03-21). `gitleaks_8.30.1_linux_x64.tar.gz`
SHA-256 `551f6fc8…70eb`: equal in upstream's `gitleaks_8.30.1_checksums.txt` and the GitHub
release API asset digest. The darwin-arm64 and linux-arm64 binaries used locally were verified
the same way (`b40ab0ae…b6a5`, `e4a487ee…b080`) into temp dirs outside the repo.

**CI job design (`dev.yml` → `secret-scan`).**
- Range: PR → `base.sha..head.sha`; push → `before..sha`; unusable base (new branch, force push,
  dispatch) → only the head commit, with a warning. Same base logic as `migration-safety.sh`.
- Rules: `.gitleaks.toml` read from the base commit when it has one, so a PR or push cannot
  weaken the allowlist for its own scan. The first change that adds the file bootstraps with
  its own copy.
- `.gitleaksignore` is deleted in the job checkout before scanning. gitleaks reads it from the
  scanned directory even when `--gitleaks-ignore-path` points elsewhere (reproduced: the
  fingerprint suppressed the finding, exit 0). Inline `gitleaks:allow` comments still work and
  are visible in review.
- `--redact --verbose`: the log shows rule, file, line, commit and author, never the value.

**`.gitleaks.toml`.**
- `[extend] useDefault = true` (rules embedded in the pinned binary).
- Rule `openlinear-pat`: `\bol_pat_[0-9a-f]{32}\b`. The default rules miss the real PAT in
  `d7aece7`/`c6bb0d5`.
- Rule `postgres-url-password`: password group of `postgres(ql)://user:pass@host`. Local/CI/example
  hosts and placeholder passwords (`password`, `${…}`, `<…>`, `x+`, …) are allowlisted. The
  default rules miss the Neon URLs in `f37414b`.
- Allowlist: exact values only, never paths or directories. Synthetic PATs
  (`ol_pat_0{32}`, `ol_pat_0123456789abcdef×2`, `ol_pat_(a1)×16`); three synthetic JWTs, and only
  inside test files (`condition = "AND"` with a test-path regex); and four documented
  non-secrets, each as an exact file + value pair: the `.omo` placeholder `ol_pat_a1b2c3d4e5f6...`,
  the perf report heading `with-phase0-plus-probe`, prose `merge/publish`, and SHA-256 source
  digests in the 2026-10-15 benchmark artifacts.

**Behaviour tests (all pass).**

| Scenario | Result |
|---|---|
| Install step in Debian container: correct pin / wrong pin | `OK`, binary on `GITHUB_PATH` / `FAILED`, exit 1, nothing extracted |
| Step script extracted from the YAML (Ruby YAML) and run against this repo: PR range `ad7d6e7^..922dbd7` (docs false positives) | exit 0, 8 commits, no leaks |
| Push range = `f37414b` | exit 1, 4 findings (`generic-api-key` ×2, `postgres-url-password` ×2), redacted |
| Push range = `d7aece7` | exit 1, `openlinear-pat` ×2, redacted |
| Zero base (non-merge head) / dispatch | warning, head commit only, exit 0 |
| Scratch repo **inside a throwaway container** (no host repo involved): PR weakens allowlist + adds a PAT | exit 1 (base config used) |
| Same range as a push | exit 1 (before-commit config used) |
| PR adds `.gitleaksignore` with the leak's fingerprint | exit 1 after the fix (exit 0 before it) |
| Bootstrap (base has no config) | exit 1 with the PR's copy |
| Synthetic corpus: random PAT, Neon-style URL, fixture JWT in a non-test file, changed `.omo` value, local URLs, fixtures in `__tests__/` | first four flagged, last two not |
| `actionlint` 1.7.12 (Docker image with shellcheck) on `dev.yml` | 0 findings |

### Scan findings (redacted)

Working tree (tracked files of base + this patch, `git checkout-index` export, repo config):
**0 findings.** With the default rules alone it reports 11, all fixtures or false positives
(now allowlisted by exact value).

History, final config. **(a) Commits reachable from `922dbd7`** (736 commits, 720 with diffs):
10 findings.

| Commit (UTC date) | File | Rule | Assessment |
|---|---|---|---|
| `f37414b` (2026-05-31) | `.env.dev` | generic-api-key (`TOKEN_ENCRYPTION_KEY`), postgres-url-password (`DATABASE_URL`) | Known; dev rotated |
| `f37414b` (2026-05-31) | `.env.prod` | generic-api-key (`GITHUB_CLIENT_SECRET`), postgres-url-password (`DATABASE_URL`) | Known; prod rotation blocked (Azure) |
| `d7aece7` (2026-05-21) | `AGENTS.md`, `ISSUES.md` | openlinear-pat | Known PAT; owner revoked |
| `c6bb0d5` (2026-05-22) | `apps/mcp-docs/app/{authentication,quickstart}/page.tsx` | openlinear-pat | Same PAT |
| `65373df` (2026-05-05) | `.env.docker` (removed `657a84c`) | generic-api-key (`GITHUB_CLIENT_SECRET`) | **New to the runbook.** 40-hex OAuth client secret, hash-distinct from the `.env.dev`/`.env.prod` ones. The file also has a hyphenated dev `JWT_SECRET` phrase (no rule flags it). |
| `7076fd7` (2026-02-08) | `apps/desktop-ui/app/settings/page.tsx` | generic-api-key | `sk-ol-…` literal in a settings mock-up; OpenLinear issues no such keys, likely fake |

**(b) Commits reachable only from release tags** (233 commits; tags `v0.1.10`…`v0.1.61` are on
the public remote, so these are public too): 4 more findings.

| Commit (UTC date) | File | Rule | Assessment |
|---|---|---|---|
| `8193d28` (2026-03-01) | `.github/workflows/deploy.yml:130` | generic-api-key | **New to the runbook.** A 64-lowercase-hex value passed as `npm publish --otp=…`. Removed the same day (`1876b72`) but reachable from 44 public tags. Not a TOTP shape; it may have been a registry token. The owner should identify and revoke it. |
| `5d2534d` (2026-03-01) | `apps/intro-video/build/318.bundle.js` | algolia-api-key | Committed Remotion build output; client-bundle Algolia keys are public search-only keys by design. Low risk. |
| `ad4b62c` (2026-02-27) | `docs/security/trust-boundary.md`, `apps/api/src/types/execution-metadata.test.ts` | generic-api-key | `gho_` + 12 characters (real GitHub OAuth tokens have 36): fake fixtures |

**(c) Other local refs** (stash/worktree commits, 974 commits total with `--all`): no
additional classes.

The two documented-non-secret classes (`.omo` placeholder, `docs/reports` prose and digests)
appear in history only when scanned with the default rules; the final config allowlists them
by exact value.

Known leaks need the owner's decision on rotation or a history purge. I did not rewrite
history. `docs/runbooks/rotate-leaked-secrets.md` §1.1 now records (a) and (b).

### 3.2 `scripts/bump-version.js`

Reproduced on a temp copy of the original. `0.1.0 → 0.1.1`, then a crash:
`ENOENT … packages/openlinear/package.json` (exit 1), **after** `tauri.conf.json` had already
been rewritten to 0.1.1. Causes:
1. It writes the deleted `packages/openlinear/package.json`, so it crashes midway and leaves a
   partial bump.
2. It bumps from `tauri.conf.json` (0.1.0) while the tags are at v0.1.61, because `release.yml`
   stamps the version from the tag at build time. `patch` would propose 0.1.1, an old version.
3. It reformats `tauri.conf.json`, which does not round-trip through `JSON.stringify`, and
   rewrites `.SRCINFO` URLs based on the Tauri version rather than the AUR's own.
4. The `just release` / `just version` recipes that `docs/CICD.md` describes do not exist in the
   `Justfile`.

Fix:
- Targets: `tauri.conf.json`, `apps/desktop/package.json`, `packages/openlinear-cli/package.json`
  (the CLI downloads the AppImage of its own version), AUR `PKGBUILD` + `.SRCINFO` (pkgrel reset
  to 1; skipped for prereleases, since Arch pkgver cannot contain `-`).
- Every target is read and validated in memory first. A missing or malformed file throws before
  any write and names `TARGETS`. Files are replaced by temp file + rename. Only the version line
  of each JSON file changes.
- The base is the max of the file version and the newest stable `vX.Y.Z` tag (`--no-tags`
  ignores tags). It refuses a version that is already tagged or older than the newest tag.
- npm-style prerelease increments. `--dry-run`. It never commits, tags or pushes.

Evidence:
- `node --test scripts/bump-version.test.js`: **10/10**. Covers the increment rules; every real
  target exists and parses; a lagging file plus tags gives 0.1.62 everywhere with a one-line
  diff; existing/older/invalid versions write nothing; a missing or malformed target writes
  nothing; prerelease skips AUR; CLI dry-run against the real repo writes nothing (hashes
  compared); bad options exit 1; tags are read from git.
- Real dry run: `0.1.61 → 0.1.62` for all 5 files, with the note "tauri.conf.json says 0.1.0;
  newest tag is v0.1.61". `node scripts/bump-version.js 0.1.61 --dry-run` → `tag v0.1.61 already
  exists`, exit 1.
- biome clean on both files.

### 3.3 Linux app-data path

Where the path was computed (sidecar, 7 places):

| Site | Rule before |
|---|---|
| `journal/sqlite.ts` | macOS path on every OS (**bug**) |
| `catalogue/models-dev.ts` | macOS path on every OS (**bug**) |
| `workspace/local-worktree.ts`, `services/repo-storage.ts` | darwin / win32 / XDG |
| `sandbox/opencode-attempts.ts`, `runners/shared/sandboxed-process.ts`, `sandbox/policy.ts` | darwin / XDG (deny roots) |

In addition, `OPENLINEAR_APP_DATA=""` produced a cwd-relative journal path (`??` treats an
empty string as set).

The launcher (`sidecar.rs`) sets no app-data variable. It forwards `HOME` and `XDG_*`
(`INHERITED_ENV_PREFIXES`; `XDG_DATA_HOME` is asserted inheritable in its tests). Its own data
(`settings.json`, `sidecar.pid`) lives in Tauri's `app_data_dir()`, which is already XDG on Linux
(`$XDG_DATA_HOME/com.openlinear.app`). The sidecar computes its directory from the same `HOME` /
`XDG_DATA_HOME`, so both resolve the same base directory.

Decision: fix the sidecar defaults and do **not** have the launcher pass `OPENLINEAR_APP_DATA`.
- A Rust copy of the rule would be a second source of truth, and it would be uncompiled here.
- Pointing the sidecar at Tauri's `com.openlinear.app` instead would move macOS data and split it
  from `repos/`.

I kept one directory per OS rather than splitting into `XDG_STATE_HOME` (journal) and
`XDG_CACHE_HOME` (catalogue). That matches the worktree, repos and sandbox code, which the
sandbox deny-roots already cover. The split could be done later, but it must update
`sidecarStateRoots` too.

The helper also ignores an empty or relative `XDG_DATA_HOME` / `LOCALAPPDATA` (XDG spec) and an
empty `OPENLINEAR_APP_DATA`.

Evidence:
- `vitest run src/config/app-data.test.ts src/journal/sqlite.test.ts`: 13/13.
- Full `pnpm --filter @openlinear/sidecar test`: **52 files, 883 passed, 3 skipped**.
- The release smoke test (`smoke-sidecar-binary.sh`) finds the journal with
  `find "$WORK/home" -name runs.sqlite`, so on Linux it keeps passing (now
  `home/.local/share/openlinear/journal/runs.sqlite`).
- **Behaviour change (Linux/Windows only):** journals or catalogue caches created before this
  under `~/Library/Application Support/OpenLinear` on Linux are no longer read. No release
  shipped this code (journal added after v0.1.61), so there is no migration.

### 3.4 AppImage workaround

- The script pins `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage`
  with SHA-256 `ed4ce84f…4eb0`, the same pin as `release.yml`'s pre-seed step, which therefore
  now verifies as "cached".
- A cached file that does not match is replaced (the old unpinned `continuous` download).
  Downloads go to a temp file, are verified, then moved into place.
- `APPIMAGETOOL_URL` + `APPIMAGETOOL_SHA256` must be overridden together.
  `APPIMAGETOOL_CACHE_DIR` moves the cache. `--tool-only` fetches and verifies the tool, then
  exits.
- Test driver (14 checks): fresh download, cached verification without re-download, corrupted
  cache replaced, wrong pin → exit 1 and nothing installed and no temp file, half override →
  exit 2, bad argument → exit 2.
  - `/bin/bash` 3.2 on macOS (`shasum`): 14/14.
  - `rust:1-bookworm` container (`sha256sum`): 14/14.
- `bash -n` ok.
- shellcheck (Docker, stable): only the pre-existing intentional SC2016 info on the AppRun `sed`.
- The build part (tauri, linuxdeploy) was not run; it needs Linux + Rust.

### 3.5 Record fixes (verification)

- `DIRECT_DATABASE_URL`: no code reads it. The only mention is `apps/sidecar/src/index.ts:29`, the
  dotenv ignore list. Prisma reads `DATABASE_URL` (+ `SHADOW_DATABASE_URL` for CI) from
  `packages/db/prisma.config.ts`.
- Drift check: `deploy-azure.yml:79-82` runs
  `migrate diff --from-migrations ./prisma/migrations --to-schema ./prisma/schema.prisma`. That
  compares migrations with the schema and never touches a live database, so out-of-band indexes
  can never trip it.
- Index findings: copied from `docs/reports/perf-baseline-2026-10-26/README.md` ("With the
  phase-0 manual indexes"). The manual SQL file already carries the `linear_projects` correction
  and the measurement note in this base.
- MCP: 19 `name: 'openlinear_*'` registrations in `apps/mcp/src/mcp/tools/*`;
  `@modelcontextprotocol/server` 2.4.0.
- Counts:
  - routes: `ls apps/api/src/routes/*.ts` = 31;
  - `ROUTE_REGISTRY.length` = 155 (via tsx);
  - API test files = 55;
  - chat tools = 34 (unchanged);
  - `CHAT_MAX_TOOL_ROUNDS` default 16 (unchanged).
- Sidecar non-test sources no longer import `@openlinear/api`. The sidecar mounts 5 routers
  (`app.ts:142-146`). `services/batch/event-handler.ts` is gone.
- Desktop: `deeplink.rs` parses `code` + `state`. The production CSP has `script-src 'self'`.
  `tauri.linux.conf.json` targets `deb` only.
- Workflow triggers read from the YAML.
- Rotate runbook's "launcher generates a per-install secret into the OS keychain": false. No
  keychain code exists, and `SIDECAR_FORBIDDEN_ENV` strips `JWT_SECRET`.

## 4. Validation

| Check | Result |
|---|---|
| `pnpm typecheck` | 10/10 (after `db:generate`; `--ignore-scripts` install skips it) |
| `pnpm lint` | 194 files, clean (covers `apps/sidecar/src/config`) |
| biome on the other touched JS/TS | clean except a pre-existing warning in `journal/sqlite.ts:19` (not in the lint list, not mine) |
| `pnpm --filter @openlinear/sidecar test` | 883 passed, 3 skipped |
| `node --test scripts/bump-version.test.js` | 10/10 |
| `dev.yml` YAML parse (Ruby) | ok; jobs `lint-typecheck, secret-scan, test, build, changes, api-image` |
| actionlint (+shellcheck) on `dev.yml` | 0 |
| `bash -n` | `build-appimage-workaround.sh`, both extracted `dev.yml` steps |
| shellcheck `build-appimage-workaround.sh` | 1 pre-existing info |
| gitleaks: tracked working tree with repo config | 0 findings |

## 5. Leftovers (not mine or out of scope)

- **Owner:**
  - rotate or confirm-dead the `.env.docker` OAuth app (`65373df`);
  - identify and revoke the 64-hex `--otp` value in `deploy.yml` (`8193d28`, public via tags);
  - prod Neon / JWT / encryption-key rotation (Azure login);
  - history purge decision.
- **Not in my ownership:** stale `@opencode-ai/sdk@1.2.5` comments remain at
  `apps/sidecar/src/services/execution/lifecycle.ts:365` and
  `services/execution/event-stream-processor.ts:97` (the run-engine engineer's files).
- `ISSUES.md:224` still cites the old `~/Downloads/…` revamp-plan path, and the Phase 1–2
  "Done" labels in `ISSUES.md` are overstated (status report §8.10). ISSUES.md is append-only
  for agents; the coordinator's session entry should note the correction.
- `docs/CICD.md` describes `just release` / `just version`, which do not exist. It also
  describes the old `release.yml` (macos-13, 4 version files, `packages/openlinear`). Either add
  the recipes to the `Justfile` (wrapping `node scripts/bump-version.js`) or rewrite that
  section.
- `packaging/aur/openlinear-bin/{PKGBUILD,.SRCINFO}` download from `github.com/openlinear/openlinear`
  (an org that does not exist; releases live in `kaizen403/openlinear`). The AppImage asset name
  matches `release.yml`'s `openlinear-<v>-x86_64.AppImage`. `sha256sums=('SKIP' …)`: could pin
  from `SHA256SUMS`.
- `scripts/bump-version.test.js` is not run by CI: root `pnpm test` is turbo over workspaces.
  Wire it in via the root `package.json` (not mine) or a `dev.yml` step.
- App-data consolidation: `local-worktree.ts`, `repo-storage.ts`, `opencode-attempts.ts`,
  `sandboxed-process.ts` and `sandbox/policy.ts` keep their own copies of the rule. They could
  import `sidecarAppDataDir`. Not done, to avoid colliding with the run-engine and sandbox owners.
  Their copies use XDG on Linux already, but they don't ignore an empty or relative
  `XDG_DATA_HOME`. `opencode-attempts`/`sandboxed-process` also use the XDG path on Windows.
- `release.yml` could call `scripts/build-appimage-workaround.sh --tool-only` instead of its own
  pre-seed step (not mine).
- The `gitleaks:allow` escape hatch is accepted by design. If the owner wants it reviewed like
  `migration-safety: allow`, add `--ignore-gitleaks-allow` (then fixtures need allowlist
  entries, landed first).
- `CODEBASE_INDEX.md` §2 file map, §3 frontend and §6/§10 were not re-verified (the banner says
  so). A full regeneration is a separate task.

## 6. Merge hazards

- `.github/workflows/dev.yml`: one new job inserted between `lint-typecheck` and `test`; no
  other job touched. Anyone restructuring `dev.yml` must keep the job. Its `fetch-depth: 0` and
  both step scripts are self-contained. Editing `dev.yml` also triggers the API-image job in
  the next PR (its path filter includes the file).
- **Coordinator, before committing the merged round:** CI scans the merged PR's commits with
  this patch's `.gitleaks.toml` (bootstrap). Run
  `git checkout-index -a --prefix=/tmp/ol-tree/ && gitleaks dir --config .gitleaks.toml --redact /tmp/ol-tree`
  on the merged index. Any new fixture from another engineer needs an exact-value allowlist
  entry or an inline `gitleaks:allow`.
- `apps/sidecar/src/journal/sqlite.ts`: import block (−`homedir`, +`sidecarAppDataDir`) and
  `defaultPath` (now takes optional `env, platform`). Run-engine edits nearby will conflict
  textually; keep both.
- `apps/sidecar/src/catalogue/models-dev.ts`: `cachePath` renamed to the exported
  `modelsDevCachePath`; imports changed.
- `apps/sidecar/src/services/opencode.ts`: comment lines 84–104 only.
- `scripts/bump-version.js`: rewritten. CLI-compatible for `patch|minor|major|X.Y.Z`, but the
  default base is now the newest tag.
- `scripts/build-appimage-workaround.sh`: new header/pin block and `ensure_appimagetool`. The
  rest is unchanged.
- `docs/runbooks/*`, `docs/CODEBASE_INDEX.md`: prose. The rotate runbook gained §1.1.
