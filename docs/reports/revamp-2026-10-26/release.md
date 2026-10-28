# Release — make a desktop release buildable and trustworthy

**Round:** 3 (2026-10-26) · **Engineer ID:** release · **Status:** done for the local scope
**Owner constraint honoured:** local work only. No workflow was triggered, dispatched or re-run;
no tag, release, upload, publish or deploy. GitHub was used read-only (`gh release list/view`,
`gh run list/view`, `gh api` GETs). Everything below that needs a real release run is listed in §6.

## 1. Outcome

- `release.yml` now builds a complete desktop app for every target **inside the job**: the Node 22
  sidecar executable (pkg) and the pinned OpenCode binary, each verified before bundling. The
  retired `macos-13` runner is replaced by `macos-15-intel`.
- **The packaged sidecar could not be built at all before this change.** `pkg` 5.16.1 aborts on
  `require("node:sqlite")` (`Error! Cannot read file, ENOENT node:sqlite`), because its walker
  decides "is this a built-in?" with the host's `module.builtinModules`, which omits prefix-only
  built-ins. `scripts/build-sidecar.sh` now loads prefix-only built-ins through
  `process.getBuiltinModule()` after bundling. The resulting binary starts with an empty
  environment and no `DATABASE_URL`, opens its `node:sqlite` journal, answers `/health`, returns 401
  without a token and 503 `CLOUD_API_UNREACHABLE` with one, exits on SIGTERM, and refuses to boot
  with `DATABASE_URL` set. It does the same after being re-signed with hardened runtime and the
  shipped entitlements.
- OpenCode is accepted only when four things agree: our committed pin, the upstream release's
  published digest, the downloaded bytes, and GitHub's signed immutable-release attestation
  (`gh release verify-asset`). The attestation is required in CI. All four assets were also
  cross-checked against upstream's npm packages (an independent channel). Every check passed.
- Linux ships both a `.deb` (Tauri) and an AppImage (the existing linuxdeploy workaround, now with
  a pinned and checksummed `appimagetool`). This matches what `release.yml` publishes.
- Signing and notarization are wired to secrets but optional. Absent secrets are not exported:
  Tauri treats an empty `APPLE_CERTIFICATE` as configured. A partial group fails the job with a
  clear error. The release gets `SHA256SUMS` (verified across jobs) and build-provenance
  attestations. It is a **draft** by default.
- CLI installer: downloads from `kaizen403/openlinear`, where releases actually live (the
  `openlinear` org does not exist). It verifies the AppImage against `SHA256SUMS` and installs
  atomically. It never fails `npm install` for a missing artifact or a network problem; only a
  checksum mismatch fails. It skips inside the source checkout. 9 tests.
- Packaging bug found and fixed in the launcher. Bundles install `externalBin` **without** the
  target-triple suffix, but the sidecar and `check_opencode` looked for `opencode-<triple>`. A
  packaged app would therefore have used whatever `opencode` was on `PATH`, or none (Finder-launched
  apps have no shell `PATH`). The launcher now passes `OPENCODE_BIN` for the bundled binary.
- Hardening:
  - production CSP drops `script-src 'unsafe-inline'` and `http://localhost:*`, and adds
    `object-src 'none'` and `base-uri 'self'`;
  - shell `open` is limited to `https:`/`mailto:`;
  - `fs:default` is removed and `os:default` narrowed;
  - the `allow-dyld-environment-variables` entitlement is removed;
  - the launcher env allowlist can no longer carry secrets through its prefixes, and
    model-provider keys, `CARTESIA_API_KEY` and `SSH_AUTH_SOCK` are opt-in only.
- **Rust compiled and tested** in a Linux container: 0 warnings, 21/21 tests (§3.6). This also covers round 1's previously uncompiled `sidecar.rs`/`deeplink.rs`.

## 2. Changes

| File | Change | Why |
|---|---|---|
| `.github/workflows/release.yml` | Rewritten. **Matrix** `build` job: `ubuntu-22.04` / `macos-14` / `macos-15-intel`. Checks out `refs/tags/<tag>` (workflow_dispatch builds the tag, not the branch). Validates the tag. Stamps the version into `tauri.conf.json`, and adds the `NEXT_PUBLIC_CLOUD_API_URL` origin to the production `connect-src` (https only; otherwise a custom cloud URL would be blocked by the CSP). Builds the sidecar, then smoke-tests it. Fetches OpenCode with `OPENCODE_REQUIRE_ATTESTATION=1`. Linux: pins `appimagetool` 1.9.1 by SHA-256, builds the `.deb`, then the AppImage. macOS: optional signing step, then `--bundles app,dmg`. Verifies every bundle (`verify-desktop-bundle.sh`). Writes per-target checksums. **`release` job** (needs all three builds): re-verifies the checksums, writes `SHA256SUMS`, runs `attest-build-provenance`, then `softprops/action-gh-release` with an explicit `tag_name`, draft unless `OPENLINEAR_RELEASE_DRAFT=false`, prerelease for `-` tags, `fail_on_unmatched_files`. **`publish-cli`** is opt-in, only for non-draft releases, and sets the CLI version from the tag. Top-level `permissions: {}` with per-job grants, `concurrency` per tag, `timeout-minutes`. Actions are pinned to commit SHAs. Untrusted inputs reach `run:` only through env. | The old job never built the sidecar or OpenCode, so bundles shipped nothing runnable. It used a retired runner. It expected an AppImage that `tauri.linux.conf.json` does not build. It passed empty signing secrets. A dispatch built the branch and named artifacts `openlinear-dev-…`. It published the CLI with version 0.1.0. History confirms this: v0.1.61 has Linux assets only, macOS never produced a DMG, `publish-cli` failed on v0.1.60, and dispatch runs hung for 24 h. |
| `scripts/build-sidecar.sh` | `--target`/`SIDECAR_TARGET` (4 triples, incl. linux-arm64). Prefix-only built-in rewrite. `pnpm exec pkg` (lockfile-pinned; `npx` silently fetched latest). Output `dist/openlinear-sidecar-<triple>`. Installs by copy plus rename. `SKIP_OPENCODE_DOWNLOAD=1`. | pkg crash (above). Overwriting a signed Mach-O in place makes macOS SIGKILL it (exit 137, reproduced). |
| `scripts/download-opencode.sh` | Rewritten. Four-way verification (§1). `--target`, `--all`, `--verify-only`, `--cross-check-npm`. `OPENCODE_VERSION` must equal the pinned `# Version:` line (`latest` removed). Authenticated API calls when `GH_TOKEN` is set. After install, checks `--version` on the host. Installs by copy plus rename. | Single-source checksum (W03a note); reproducibility; the same SIGKILL bug. |
| `scripts/opencode.sha256` | Provenance block updated with the re-verification. Hashes unchanged. | |
| `scripts/release/smoke-sidecar-binary.sh` (new) | Starts a packaged sidecar the way the launcher does (`env -i` plus launcher vars). Asserts `/health` with `persistence:"api"`, the journal file created (`node:sqlite`), 401, 503, SIGTERM, and refusal with `DATABASE_URL`. | Used per target in CI and in `build-and-test-desktop.sh`. |
| `scripts/release/verify-desktop-bundle.sh` (new) | `.app`/`.deb`/AppImage: binaries present where the launcher looks, OpenCode reports the pinned version, the bundled sidecar passes the smoke test. macOS: `codesign --verify --deep --strict` plus the signing mode and stapling. | Proves bundling (codesign, linuxdeploy/patchelf) did not corrupt the self-contained executables. |
| `scripts/release/configure-macos-signing.sh` (new) | Exports only complete secret groups to `$GITHUB_ENV` (delimiter-safe). Writes the `.p8` to `$RUNNER_TEMP` with mode 0600. `signed`/`notarized` outputs. `REQUIRE_SIGNED`. | See §4. |
| `scripts/build-and-test-desktop.sh` | No Docker, Postgres, `.env` or `db:push` (the sidecar is API-only). Builds via `build-sidecar.sh`, smoke-tests the sidecar, verifies the bundle. | The script required a database to build a desktop app that no longer has one. |
| `apps/desktop/src-tauri/src/sidecar.rs` | Allowlists are slices. `is_inheritable()` adds `ALL_PROXY`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `LANGUAGE` and `TZ`. A secret-name filter applies to prefix matches (`OPENCODE_SERVER_PASSWORD`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG_CONTENT`, `XDG_SESSION_*`, … are dropped; `OPENLINEAR_GIT_AUTHOR_*` is kept). `vars_os()` (non-UTF-8 values no longer panic). Opt-in passthrough from the settings key `sidecar_env_passthrough`, limited to `OPT_IN_ENV`. `CARTESIA_API_KEY` is no longer forwarded by default. `OPENCODE_BIN` points at the bundled binary unless already set. 2 new unit tests. | §5.1. |
| `apps/desktop/src-tauri/src/opencode.rs` | `bundled_opencode_path()` (shared): `opencode` or `opencode-<TARGET>` next to the executable. `check_opencode` uses it. | Bundle naming bug (§1). |
| `apps/desktop/src-tauri/tauri.conf.json` | CSP and shell `open` scope (§5.2). | |
| `apps/desktop/src-tauri/capabilities/default.json` | Removes `fs:default`. `os:default` becomes `os:allow-platform` and `os:allow-arch`. | The UI never imports `plugin-fs`. `platform()`/`arch()` read injected internals, not IPC. |
| `apps/desktop/src-tauri/entitlements.plist` | Removes `com.apple.security.cs.allow-dyld-environment-variables`. | Lets any launcher inject dylibs (`DYLD_INSERT_LIBRARIES`) into a hardened app. Not needed (§3.5). |
| `packages/openlinear-cli/lib/installer.js` (new), `scripts/postinstall.js`, `bin/openlinear.js`, `package.json`, `test/installer.test.js` (new) | Installer library (https only, at most 5 redirects, 30 s socket timeout, streaming SHA-256, `.download` then rename, mode 0755). Postinstall policy (§1). `openlinear install` subcommand. Clear messages per platform. `repository` points at `kaizen403/openlinear`. `files` includes `lib`. `test` script. | Wrong org, no checksum, no timeout (a stalled download hung installs), and a hard-coded 0.1.0 version with no such release. |
| `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx` | `OPENCODE_RELEASES_URL` → `https://github.com/anomalyco/opencode/releases`. | Old link pointed at the archived Go CLI. |

`tauri.linux.conf.json` is intentionally unchanged (deb only). A plain `tauri build` AppImage
still breaks in linuxdeploy, so the AppImage comes only from the workaround script, in CI and in
`build:app`.

## 3. Verification evidence (this Mac, darwin arm64)

### 3.1 Sidecar executable

| Command | Result |
|---|---|
| Original flow: `node esbuild.config.js --packaged && npx @yao-pkg/pkg dist/bundle.cjs --target node22-macos-arm64 …` | **exit 2**: `Error! Cannot read file, ENOENT node:sqlite` (pkg-fetch first downloaded `fetched-v22.10.0-macos-arm64`) |
| `SKIP_OPENCODE_DOWNLOAD=1 scripts/build-sidecar.sh` | ok; `prefix-only built-ins loaded via process.getBuiltinModule: sqlite`; 69 MB binary, pkg ad-hoc signature |
| `scripts/release/smoke-sidecar-binary.sh apps/desktop/src-tauri/binaries/openlinear-sidecar-aarch64-apple-darwin` | `/health 200 {"ok":true,"service":"sidecar","persistence":"api"}`; journal `Library/Application Support/OpenLinear/journal/runs.sqlite` created; no token → 401; bearer token with API down → 503 `CLOUD_API_UNREACHABLE`; SIGTERM → exited; `DATABASE_URL` set → refused (exit 1) |
| `scripts/build-sidecar.sh` (full, twice in a row) | both exit 0; OpenCode verified and `--version` → `1.18.30`. The run before the copy-plus-rename fix hit exit 137 (SIGKILL) on the overwritten binary. |

### 3.2 OpenCode

| Command | Result |
|---|---|
| `scripts/download-opencode.sh` (host) | pin == upstream digest; bytes `a5e43d68…b1e8`; `gh release verify-asset` ok; installed 138 MB; `--version` → 1.18.30 |
| `scripts/download-opencode.sh --all --verify-only --cross-check-npm` | all four assets (darwin-arm64/x64, linux-x64/arm64): pin == digest == bytes; attestation verified; npm `opencode-<os>-<arch>@1.18.30` tarball matches registry sha512 **and** carries the byte-identical binary |
| Negative: pin altered to zeros (copy of the script) | exit 1 `upstream digest … differs from the pinned checksum` |
| Negative: `OPENCODE_VERSION=v1.18.29` | exit 1 `… pins v1.18.30; regenerate the checksums file …` |
| Negative: `gh release verify-asset v1.18.30 <tampered file> -R anomalyco/opencode` | exit 1 `attestation for v1.18.30 does not contain subject sha256:20cb…` |

Upstream publishes no checksum file. What it does publish is per-asset `digest` values and a
GitHub-signed `https://in-toto.io/attestation/release/v0.2` attestation listing every asset digest
(immutable release). Those are the "published checksums" CI verifies against.

### 3.3 appimagetool pin

`curl …/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage | shasum -a 256`
→ `ed4ce84f…4eb0`, which equals the release API digest. This is the pin in `release.yml`.

### 3.4 CLI

- `pnpm --filter @openlinear/cli test`: **9/9 pass**. Covers:
  - repo/URL;
  - https-only;
  - platform matrix;
  - `sha256sum` parsing;
  - skip reasons;
  - missing release → unavailable;
  - release without the AppImage → unavailable;
  - verified atomic install (mode 0755, no `.download` left);
  - mismatch keeps the previous AppImage and throws `IntegrityError`;
  - skipped installs make no requests.
- Real network checks:
  - `install({version:'0.1.0'|'0.1.61', platform:'linux'})` → `unavailable` (no `SHA256SUMS` on
    those releases), exit 0;
  - `httpsTransport.download()` of an `anomalyco/opencode` asset followed the GitHub redirect,
    and its streaming SHA-256 equals the upstream digest;
  - `node scripts/postinstall.js` in the checkout skips ("running inside the OpenLinear source
    checkout") with exit 0;
  - `node bin/openlinear.js` on macOS prints the releases page and exits 1.
- `biome check packages/openlinear-cli`: clean.

### 3.5 Bundle verifier and entitlements (simulated .app)

I built a fake `OpenLinear.app` with the real sidecar and OpenCode binaries in `Contents/MacOS`.

- **Ad-hoc signed:** `verify-desktop-bundle.sh macos-app` passed: binaries present, OpenCode
  1.18.30, `codesign --verify --deep --strict` valid, full sidecar smoke.
- **Re-signed with `--options runtime --entitlements apps/desktop/src-tauri/entitlements.plist`**
  (the new plist, without the DYLD entitlement), flags `0x10002(adhoc,runtime)`: the whole verifier
  passed again. Both pkg Node and Bun-compiled OpenCode run under hardened runtime with the reduced
  entitlements.

### 3.6 Rust (compiled in Docker; there is no cargo on the Mac)

`rust:1-bookworm` (linux/arm64) plus the Tauri apt deps, on a staged copy of `src-tauri` with the
real `desktop-ui/out` export (so codegen hashed the 299 inline scripts under the new CSP) and stub
`externalBin` files. Command: `cargo test --locked` (rustc 1.99.1).

Result: **compiled with 0 warnings; 21/21 unit tests pass.** That includes the two new env tests (`test_inherited_env_allowlist_carries_no_secrets_by_default`, rewritten `test_sidecar_never_inherits_cloud_only_credentials`). It also includes the round-1 `deeplink.rs` and `sidecar.rs` changes, which had never been compiled. tauri-build accepted the new CSP, the shell `open` regex and the narrowed capabilities (`os:allow-platform`, `os:allow-arch` resolve).

macOS-only code paths (`cfg(target_os = "macos")` in plugins) and the macOS link step were not
compiled. `sidecar.rs`/`opencode.rs` have no platform-specific code in the changed parts.

### 3.7 Static checks

- `release.yml`:
  - PyYAML parse ok (jobs `build`, `release`, `publish-cli`);
  - **actionlint 1.7.12 (Docker, with shellcheck): 0 findings**. The one SC2016 info, on the
    intentional single-quoted JavaScript, is annotated.
- **shellcheck (Docker, stable): 0 findings** on `build-sidecar.sh`, `download-opencode.sh`,
  `build-and-test-desktop.sh` and the three `scripts/release/*.sh`.
- `/bin/bash -n` (macOS bash 3.2) ok on all of them.
- `configure-macos-signing.sh` was run under bash 3.2 in 8 scenarios, all as intended:
  - none / empty-string secrets → ad-hoc, exit 0, nothing exported;
  - partial → exit 1;
  - signing only → 3 vars exported, notarized=false;
  - plus Apple ID or API key → 6 vars exported;
  - notarization without signing → skipped with a warning;
  - `REQUIRE_SIGNED=true` without secrets → exit 1.
- Stamp step, extracted from the YAML and run against a copy of `tauri.conf.json`: default origin → no CSP change; custom `https://api.example.dev/v1` → origin appended to `connect-src`; `http://…` → exit 1.
- `tauri.conf.json`, `tauri.linux.conf.json` and `capabilities/default.json`: valid JSON.
- `entitlements.plist`: `plutil -lint` OK.
- `pnpm typecheck` 10/10. `pnpm lint` 162 files clean.

### 3.8 CSP scan of the static export (`BUILD_FOR_TAURI=1 next build`)

| Item | Count |
|---|---|
| HTML files | 21 |
| Inline `<script>` elements (RSC flight data, next-themes, accent bootstrap) | 299 |
| Inline event-handler attributes | 0 |
| `javascript:` URLs | 0 |
| `<style>` tags | 0 |
| `style="…"` attributes | 47 |
| `.wasm` files | 0 |

## 4. What the owner must add (GitHub → Settings)

**Secrets (all optional; each group is all-or-nothing):**

| Group | Secrets | Notes |
|---|---|---|
| macOS Developer ID signing | `APPLE_CERTIFICATE` (base64 of the "Developer ID Application" `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`) | Without these: ad-hoc signature. The app runs on Apple Silicon but Gatekeeper blocks a downloaded copy (users must right-click → Open). |
| Notarization, preferred | `APPLE_API_ISSUER`, `APPLE_API_KEY` (key ID), `APPLE_API_KEY_P8` (full contents of `AuthKey_<ID>.p8`) | App Store Connect API key with the Developer role. Used only when signing is configured. |
| Notarization, alternative | `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` | Ignored if the API-key group is set. |

The old workflow referenced only the Apple ID group, and passed it even when empty.

**Variables:**

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_CLOUD_API_URL` | Baked into the UI and into the launcher's compile-time `OPENLINEAR_API_URL`; its origin is added to the production CSP `connect-src`; must be https. **Set it.** The default `https://openlinear.tech` is the landing site, and `api.openlinear.tech` is dead (see the production-state memory). |
| `OPENLINEAR_RELEASE_DRAFT=false` | Publish releases immediately (default: draft, for review). |
| `OPENLINEAR_REQUIRE_SIGNED_RELEASE=true` | Fail macOS builds that would not be signed and notarized. |
| `OPENLINEAR_PUBLISH_CLI=true` | Publish the CLI (needs draft=false). See the next item. |

**Repository settings and decisions:**

- Enable **immutable releases**, so OpenLinear's own assets get GitHub release attestations
  (`gh release verify-asset`), as upstream OpenCode's do.
- **CLI publishing:** GitHub Packages only accepts a scope that equals the repository owner. Publishing
  `@openlinear/cli` from `kaizen403/openlinear` therefore fails; this is the likely cause of the
  v0.1.60 `publish-cli` failure (logs expired). Pick one:
  - rename to `@kaizen403/cli`;
  - move the repo to an `openlinear` org;
  - publish to npmjs.org with an `NPM_TOKEN` (which also enables `--provenance`).
- No secret is needed for Linux. `GITHUB_TOKEN` covers attestation verification, provenance and
  the release.

## 5. Decisions

### 5.1 Launcher environment (Tauri → sidecar)

Options considered:

1. Forward nothing secret (W03a). Safest, but the sidecar can't use shell-only keys.
2. Forward a fixed list of model-provider keys by default. This helps only terminal-launched apps:
   a macOS app opened from Finder never sees shell variables. Any non-sandboxed child, crash report
   or same-user process can read the sidecar's environment; the sandbox report showed
   `KERN_PROCARGS2` exposes it.
3. **Explicit per-variable opt-in (chosen)**, on top of 1.
4. An OS keychain or credential broker. That is future work: W10 broker, `keyring` crate.

What is implemented:

- **Default, no secrets:**
  - process basics, locale, TZ;
  - proxies (`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`, both cases) and CA bundles;
  - `LOG_LEVEL`;
  - `LC_*`, `XDG_*`, `OPENCODE_*` and `OPENLINEAR_GIT_*` **minus any name that looks like a
    credential**.

  Trade-off: a proxy URL can embed credentials. Proxies stay on by default because without them the
  sidecar cannot reach the cloud API on corporate networks.
- **Opt-in only** (`OPT_IN_ENV`):
  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
    `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`,
    `XAI_API_KEY`, `FIREWORKS_API_KEY`;
  - `CARTESIA_API_KEY` (transcription);
  - `SSH_AUTH_SOCK`. Git uses an HTTPS token, so SSH is not needed. Forwarding the socket would let
    the sidecar, and anything it starts outside the sandbox, sign with every loaded SSH key.

  OpenCode keeps using its own auth store (`OPENCODE_AUTH_CONTENT` per attempt). Codex can use its
  `~/.codex` login.
- **How to opt in until a settings UI exists:** add
  `"sidecar_env_passthrough": ["ANTHROPIC_API_KEY"]` to `settings.json` in the Tauri app-data
  directory:
  - `~/Library/Application Support/com.openlinear.app/` on macOS;
  - `~/.local/share/com.openlinear.app/` on Linux.

  Then launch the app from an environment where the variable is set. Unknown names are ignored.
- **Never forwarded:** `DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
  `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN`, `BRAINSTORM_API_KEY`, `OPENLINEAR_WITH_CLOUD_API`. Neither
  is `OPENLINEAR_SANDBOX_*`, so desktop runs fail closed without a verified sandbox. A trusted-host
  grant should become a settings opt-in with UI, not ambient env.
- **Behaviour change:** `CARTESIA_API_KEY` from the launch environment no longer reaches the sidecar
  unless opted in.

### 5.2 CSP and capabilities

- **`script-src 'self'` (removed `'unsafe-inline'`).**
  - Tauri 2.10's codegen hashes every non-empty inline `<script>` in the embedded HTML
    (`tauri-codegen` `inject_script_hashes`), and at runtime it adds those hashes to `script-src`
    (`tauri` `manager::set_csp`).
  - Per CSP2+, `'unsafe-inline'` is ignored once a hash is present. It was therefore already inert
    for all 299 inline scripts.
  - Removing it only blocks *dynamically injected* inline scripts and pages without hashes. The
    scan in §3.8 found nothing else that needs it.
- **`style-src 'unsafe-inline'` stays.** The export has 47 `style="…"` attributes. **Hazard:** if
  a `<style>` element ever appears in the export, Tauri injects a style nonce, which silently
  disables `'unsafe-inline'` for styles and blocks those attributes. Keep styles in CSS files.
- **`connect-src`:**
  - Dropped `http://localhost:*`; the UI normalizes loopback to `127.0.0.1`.
  - **Kept `http://127.0.0.1:*`.** CSP cannot express port ranges, and the launcher binds an
    ephemeral port. A fixed, published port set would make the sidecar port predictable to other
    local users. One of them could bind it in the window between the launcher's probe and the
    sidecar's bind (hundreds of ms of Node startup), and the UI, which trusts whatever answers on
    the reported port, would hand it the cloud bearer token.
  - **Follow-up**, in order: a sidecar identity nonce (launcher generates it, passes it via env,
    `/health` echoes it, the UI checks it over IPC before sending tokens); then a small fixed port
    set enumerated in the CSP.
- Added `object-src 'none'` and `base-uri 'self'`.
- `devCsp` is unchanged; dev needs eval, inline and ws.
- Shell `open` scope: `(https://|mailto:)\S+` (anchored by the plugin). The plugin default also
  allowed `http:` and `tel:`. The UI opens only https (PR/branch links, GitHub sign-in, the
  OpenCode page) and mailto.
- **Capabilities:**
  - removed `fs:default` (it granted app-dir reads and mkdir to the webview, unused). The Rust
    plugin is still registered with no capability; removing the crate is a follow-up;
  - `os:` narrowed to platform and arch;
  - `shell:allow-open`, `store:default`, `deep-link:default` and the window permissions are
    used and kept.
- **Entitlements:**
  - removed `allow-dyld-environment-variables`;
  - kept `allow-jit` and `allow-unsigned-executable-memory` (V8 in pkg Node, JSC in Bun);
  - kept `disable-library-validation` (pkg and Bun may `dlopen` extracted native modules). Revisit
    with a Developer ID build;
  - the App Sandbox keys (`network.*`, `files.*`, `inherit`) are inert without `app-sandbox`.
- **Keychain (follow-up, not done):** the desktop refresh token stays in the Tauri store (a JSON
  file in app data). Migrate it to the OS keychain with a `keyring`-based Tauri command (or
  `tauri-plugin-stronghold`):
  - on first launch, read the store value, write it to the keychain, delete it from the store;
  - `token-store.ts` switches to `invoke`.

  This needs a new crate plus Cargo.lock change and a macOS keychain-access test with a signed build.

### 5.3 Other

- **Releases are drafts by default.** A human reviews the assets (signed or not) before users can
  download them. `OPENLINEAR_RELEASE_DRAFT=false` restores immediate publishing.
- **The version comes from the tag.** It is stamped into `tauri.conf.json` in CI.
  `scripts/bump-version.js` is broken (§7), and `tauri.conf.json` still says 0.1.0 while tags are at
  0.1.61.
- **The `node:sqlite` workaround lives in `build-sidecar.sh`, not `apps/sidecar/esbuild.config.js`.**
  This keeps it inside my ownership. The proper home is a 6-line esbuild plugin; a pkg upgrade
  (6.x) would also remove the need.

## 6. Verifiable only by a real release run

- The three runners exist and build: `macos-15-intel` label, Xcode/DMG creation on a headless
  runner, pkg on Intel macOS and on ubuntu-22.04 glibc.
- Tauri 2.10 `--bundles deb`, and the AppImage workaround's assumptions (the
  `bundle/appimage/OpenLinear.AppDir` layout, `NO_STRIP`, the AppRun patch).
  `verify-desktop-bundle.sh` will fail the job if either bundle is wrong.
- Real Developer ID signing and notarization:
  - Tauri importing the certificate, and signing `externalBin` with the entitlements;
  - Apple accepting the pkg and Bun binaries under hardened runtime (validated only ad-hoc here);
  - stapling.
- The runner's `gh` supports `release verify-asset` (fail-closed if not).
- `actions/attest-build-provenance` and the release-creation permissions.
- `softprops` draft and prerelease behaviour.
- The CLI publish (and its scope problem).
- The packaged app end to end: Tauri launching the sidecar with the new env, the UI reaching it
  under the new CSP, and OpenCode resolved via `OPENCODE_BIN` in a real `.app`/`.deb`/AppImage.

## 7. Leftovers (not mine or out of scope)

- `scripts/bump-version.js` (used by `just release`) writes the deleted
  `packages/openlinear/package.json` and the AUR files. `docs/CICD.md` still describes `macos-13`,
  the old jobs and `publish-cli`.
- Sidecar owner (`apps/sidecar/src`):
  - `resolveOpencodeBinary()` should also accept an unsuffixed `opencode` next to `execPath` (the
    launcher's `OPENCODE_BIN` covers packaged apps today);
  - `journal/sqlite.ts` and `catalogue/models-dev.ts` default to `~/Library/Application Support/OpenLinear`
    on Linux too, while worktrees and the sandbox use XDG. Either fix the defaults, or have the
    launcher set `OPENLINEAR_APP_DATA`;
  - move the prefix-only built-in rewrite into `esbuild.config.js`.
- `@yao-pkg/pkg` 5.16.1 / pkg-fetch 3.5.16 ships Node 22.10 (needs `--experimental-sqlite`).
  Upgrade to pkg 6.x for Node ≥ 22.13 or 24.
- `scripts/build-appimage-workaround.sh` (not mine) still downloads the unpinned `continuous`
  `appimagetool` when its cache is empty. `release.yml` pre-seeds the pinned 1.9.1; the script
  should pin it itself.
- Desktop: remove `tauri-plugin-fs` (crate and `lib.rs`); keychain migration (§5.2); sidecar
  identity nonce plus fixed ports (§5.2); a settings UI for `sidecar_env_passthrough`; a trusted-host
  grant opt-in.
- No Windows or Linux-arm64 release targets. The scripts already support `aarch64-unknown-linux-gnu`.
- OpenCode x64 assets require AVX2. Pre-2013 Intel Macs (still within `minimumSystemVersion`
  10.15) would need the `-baseline` asset.
- `dev.yml` never builds the desktop app, so packaging breaks are found only at release time.
  Consider a PR job running `build-sidecar.sh` plus `smoke-sidecar-binary.sh` on ubuntu (no Rust
  needed).

## 8. Merge hazards

- Rust status: compiled and tested on Linux (Docker, §3.6); **not compiled for macOS** (no cargo on the Mac). Run `cargo test` on a Mac before release.
- `apps/desktop/src-tauri/src/sidecar.rs`: env allowlists became slices, plus new
  `looks_secret`/`is_inheritable`/`opted_in_env`. `build_sidecar_env` tail rewritten (Cartesia
  loop, `OPENCODE_BIN`, opt-in). The W03a test was rewritten for slices. Conflicts with any edit to
  the sidecar spawn environment.
- `apps/desktop/src-tauri/src/opencode.rs`: new `pub(crate) fn bundled_opencode_path`, used by
  `sidecar.rs`.
- `apps/desktop/src-tauri/tauri.conf.json`: the production `csp` string and `plugins.shell.open`
  (desk touched the CSP in round 1). `capabilities/default.json` and `entitlements.plist` changed.
- `scripts/build-sidecar.sh`:
  - output is `apps/sidecar/dist/openlinear-sidecar-<triple>` (was `sidecar-macos-arm64` etc.);
  - takes `--target`;
  - downloads OpenCode with `--target`.
- `scripts/download-opencode.sh`: new flags. `OPENCODE_VERSION=latest` no longer works, and any
  version must match the pinned `# Version:` line in `scripts/opencode.sha256`.
- `scripts/build-and-test-desktop.sh` no longer starts Postgres or loads `.env`.
- `packages/openlinear-cli` gained a `test` script, so the root `pnpm test` (turbo) now runs it.
  Its postinstall no longer downloads anything inside the monorepo.
- `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx`: one line.
- `apps/desktop-ui/next-env.d.ts` was rewritten by `next build` and restored by hand; it is not in
  the patch.
