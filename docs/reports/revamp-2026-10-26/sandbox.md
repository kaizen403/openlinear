# W09a — Verified, fail-closed sandbox for agent execution

Date: 2026-10-25. Engineer: `sandbox` (round 1). Base tree: `round1-base.patch` on `922dbd7`.
Status: **macOS done and verified on real Seatbelt. Linux implemented and unit-tested, but not run locally** (no Linux host here; it runs in the new `.github/workflows/sandbox.yml` CI job). Windows has no provider.

Sources: `tasks/prd-backend-agent-platform.md` §3, §6 and W09/W10; `docs/reports/backend-review-2026-10-15/sandbox.md` (threat model and acceptance corpus).

## 1. Outcome

- **One server per attempt.** Agent tool execution now runs only in an OpenCode server started for that attempt, under an OS sandbox whose guarantees were checked on this machine by live canary probes.
- **Fail closed.** With no verified provider and no explicit trusted-host grant, the attempt fails with `SANDBOX_UNAVAILABLE` (HTTP 503). Nothing is spawned for it.
- **Git hardening.** The sidecar's own git calls in agent-controlled worktrees no longer run code the agent planted in the repository config. The real-git corpus shows 13 such payload classes still executed under the old hardening; none execute now.
- **No inherited secrets.** Git child processes and the Codex CLI now get an explicit env allowlist instead of the sidecar's `process.env`.
- **Phantom plugin removed.** The `opencode-openlinear` plugin reference was dropped from the OpenCode server config.

## 2. Design

### Choosing between `@anthropic-ai/sandbox-runtime` and native

`npm view` shows 0.0.81, published 2026-10-20 under Apache-2.0, requiring node ≥ 22.12. I read its packaged README and type declarations. It was **not adopted**:

- **Process-global state.** `SandboxManager` is a singleton holding one mutable config, one HTTP/SOCKS proxy and one violation store. `reset()` tears all of them down at once. The threat model forbids one global mutable policy shared by concurrent tenants, so using it safely would mean one Node supervisor process per attempt.
- **Shell-string API.** `wrapWithSandboxArgv(command: string, …)` still takes shell text and wraps it in `<shell> -c`. The threat model asks for argv plus env, never concatenated strings.
- **Read model.** Reads are allowed by default, with deny regions carved out. We need a positive read allowlist so that `/var/folders` (where the sidecar writes 0600 git credential temp files), `/Volumes`, `/opt/homebrew/var` and similar stay closed.
- **Packaging.** It ships vendor binaries (seccomp helper, Windows exe, a jar) resolved relative to the module, which conflicts with the esbuild/pkg sidecar bundle. On Linux it also needs socat and ripgrep at runtime.

The native implementation uses the same OS primitives. It borrows srt's documented lessons: last-match-wins ordering, the Chrome-lineage base allowances, the CONNECT proxy with a resolved-address check, and loopback-port pinning.

### Layout of `apps/sidecar/src/sandbox/`

| File | Role |
|---|---|
| `types.ts` | `SandboxProvider { detect, preflight, wrap }`, plus `SandboxPolicy` (an ordered fs rule list, network, complete env) and `CapabilityReport` |
| `policy.ts` | `buildAttemptPolicy` (immutable per attempt, zod-validated) and `policyHash` (env *names* only) |
| `preflight.ts` | Canary corpus run through `provider.wrap()`. This is the only source of `enforced` |
| `macos-seatbelt.ts` | SBPL generator. Every path is a `-D` parameter, never profile text. Uses absolute `/usr/bin/sandbox-exec` |
| `linux-bwrap.ts`, `linux-seccomp.ts` | bubblewrap argv renderer, Node bridge launcher, and a cBPF filter assembled in-process (x64/arm64) |
| `egress-proxy.ts`, `egress-allowlist.ts` | Per-attempt CONNECT-only proxy, with allowlist defaults |
| `mode.ts` | `enforce` / `trusted-host` and grant validation |
| `provider.ts` | Platform provider choice. Verification is cached on success; failure is retried after 30 s |
| `opencode-attempts.ts` | Per-attempt OpenCode server manager |
| `git-hardening.ts` | Git `-c`/env hardening and the repository-config scan |
| `env.ts` | Env allowlists for the sandboxed agent, runner CLIs (Codex) and git |

### OpenCode process model and the per-attempt boundary

**Before:** one `opencode serve` ran per sidecar, unsandboxed. Every client named its directory per request, so one process tree served every worktree. Sandboxing that shared server would have had to grant every worktree to every run.

**Now:**

- **Routing.** `getClientForUser(user, directory)` asks `AttemptServerManager.route`. It returns one server per worktree realpath, started lazily, with concurrent starts deduplicated.
- **Server environment.** Each server runs under the verified provider with a random `OPENCODE_SERVER_PASSWORD`; the client sends Basic auth, and anonymous requests get 401 (verified). It has a private HOME/TMP/XDG root under `<app-data>/sandbox/attempts/<key>`, its own egress proxy, and `OPENCODE_DISABLE_PROJECT_CONFIG/MODELS_FETCH/LSP_DOWNLOAD/AUTOUPDATE/CLAUDE_CODE/SHARE=1`.
- **Model selection** is copied from the management server's config.
- **Unchanged paths.** Management calls with no directory (provider auth and config) still use the shared server, which never runs an agent session in enforce mode. Trusted-host mode keeps the legacy shared server.
- **Reaping.** A server is reaped after 15 min idle (`OPENLINEAR_SANDBOX_IDLE_MS`), but only when no request or open event stream is in flight and no session reports busy. It is also reaped when its worktree disappears, and on `shutdownOpenCode()`.
- **Private root lifetime.** The private root, which holds OpenCode's session DB, is kept while the worktree exists so a restarted sidecar can resume. It is deleted when the worktree goes.
- **Records.** Metadata records live in `<sandbox>/records`, which the agent cannot read or write.

## 3. Policy, modes and defaults

### Filesystem rules

Rules are ordered and later rules win. Anything not listed is denied.

1. **read:** system roots and toolchains.
   - Darwin system roots: `/usr`, `/bin`, `/sbin`, `/System`, `/Library/{Apple,Developer,Frameworks}`, `/private/etc`, `/private/var/{select,db/timezone}`, `/Applications/Xcode.app`, `/opt/homebrew`.
   - Linux system roots: `/usr`, `/bin`, `/lib*`, plus about 20 selected `/etc` entries.
   - Toolchains come from PATH. Install prefixes outside HOME qualify. Inside HOME only known managers qualify (bun, rustup/cargo `bin`, nvm, volta, fnm, asdf, mise, pyenv, rbenv, go/bin, deno, pnpm). The OpenCode binary is readable as a single file.
2. **deny:** `/opt/homebrew/var`, `/usr/local/var`, `/Library/Keychains`, and the sidecar state roots (repos dir, app data, `~/.openlinear`, the sandbox root).
3. **read:** this attempt's Git common dir. **deny:** `<common>/worktrees`. **read:** this attempt's own gitdir.
4. **write:** the worktree and the private attempt root.
5. **protect** (read-only): `<worktree>/.git`, the resolved gitdir and the common dir.
6. **deny (last):** credential and personal stores. These include `.ssh`, `.aws`, `.azure`, `.gnupg`, `.netrc`, `.git-credentials`, `.gitconfig`, `.config/{git,gh,gcloud,op,hub,opencode,openlinear}`, `.kube`, `.docker`, `.npmrc`, `.yarnrc*`, `.pypirc`, `.pgpass`, `.my.cnf`, cargo/gem/terraform credentials, OpenCode/Codex/Claude state, shell history, keychains, browser profiles, Mail, Messages and TCC.

Safety checks on the policy:
- A writable root may never be `/`, HOME, or an ancestor of HOME, and may not sit inside a credential store.
- A symlinked `.git` is protected but never followed.
- Git metadata is only opened when it resolves inside the repos dir or the worktree.

### Env, network and process

**Env.** The child env is exact, with no inheritance:
- locale variables,
- PATH filtered to readable directories,
- private HOME/TMP/XDG,
- proxy variables,
- the OpenCode settings listed above,
- the attempt's provider credential (`OPENCODE_AUTH_CONTENT`; see §6).

**Network.**
- **macOS:** Seatbelt allows outbound connections only to `localhost:<proxy>`, and bind/inbound only on the control port.
- **Linux:** `--unshare-net`. A launcher bridges `127.0.0.1:3128` to the proxy's Unix socket and exposes the server as `run/ctl.sock`.
- **Proxy:** CONNECT only, so TLS stays end to end. The default port is 443. Allowed hostnames that resolve to loopback, link-local, metadata or mapped forms are refused.
- **Allowlist:** the provider hosts you hold credentials or config for (built-in map plus custom `https` baseURLs), npm/yarn/PyPI/crates/Go registries (`OPENLINEAR_SANDBOX_REGISTRIES=0` disables them), and `OPENLINEAR_SANDBOX_ALLOW_HOSTS`.

**Process.**
- **macOS:** process-info, signal and task-port access are limited to the same sandbox. Setuid binaries cannot execute.
- **Linux:** user/pid/ipc/uts/cgroup/net namespaces, `--die-with-parent`, `--new-session`, `--cap-drop ALL`, `--disable-userns` (bwrap ≥ 0.8) and seccomp. Seccomp returns EPERM for ptrace, process_vm_*, io_uring_*, unshare/setns/mount family, clone with any CLONE_NEW* flag, bpf, perf, userfaultfd, keyctl, modules, kexec, open_by_handle_at and syslog. clone3 returns ENOSYS. x32 is refused, and a foreign architecture kills the process.

### Modes

- **`enforce`** is the default.
- **`trusted-host`** must be requested explicitly with `OPENLINEAR_SANDBOX_MODE=trusted-host` and a grant:
  - **Where the grant lives:** in `OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT` (JSON) or `OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT_FILE` (absolute path), in the sidecar environment (desktop launcher env or sidecar `.env`).
  - **Format:** `{"actor","reason" (≥10 chars),"expiresAt" (≤30 days),"paths"?}`.
  - **Effect:** every use is logged at warn level with its grant id, and the grant is included in the attempt metadata.
  - **Failure:** an invalid, expired or non-covering grant gives `SANDBOX_UNAVAILABLE`. A failed preflight never falls back to trusted-host.
- **Other overrides:** `OPENLINEAR_SANDBOX_DIR`, `OPENLINEAR_SANDBOX_EXTRA_READ` (colon-separated toolchain dirs), `OPENLINEAR_BWRAP_PATH`.

### Run metadata

`SandboxRunMetadata` contains:
- mode, provider and version,
- `policyHash`,
- the preflight time, the enforced dimensions and the unsupported ones,
- allowed egress hosts,
- startup ms,
- the grant, if any.

It is logged, broadcast as `sandbox:attempt`, written to `<sandbox>/records/<key>.json`, and available from `getSandboxRunMetadata(dir)`. It is **not yet stored on `AgentRun`**: that needs a two-line `lifecycle.ts` edit, which I left out of scope for this round.

## 4. Platform support

| Platform | Provider | Status |
|---|---|---|
| macOS 27 (arm64, here) | Seatbelt | **Verified on the real OS**: preflight 25/25, worktree, procargs and OpenCode corpus |
| Linux x64/arm64 | bubblewrap + seccomp | **Unverified locally.** Argv rendering, seccomp decisions and launcher syntax are unit-tested; the real boundary runs only in `sandbox.yml` (ubuntu-24.04, bubblewrap, AppArmor userns sysctl) |
| Windows / other | none | `SANDBOX_UNAVAILABLE`, or an explicit trusted-host grant |

## 5. Results

### Canary preflight on real Seatbelt (macOS 27.0.1)

All 25 probes passed, in about 0.5 s. The deny probes check that the planted fake secret is absent from the output, not only that the command failed.

| Dimension | Probes and expected result |
|---|---|
| Filesystem: allowed | read worktree, read own gitdir, write worktree, write private TMP |
| Filesystem: denied | fake `~/.ssh` key, `~/.aws`, cargo credential inside an over-broad allowed toolchain root, sibling worktree, sibling gitdir, `ls ~`, symlink escape, hardlink escape, write outside, write `~/.zshrc`, rewrite `.git` pointer, rename `.git`, write gitdir, plant `hooks/` in the common dir |
| Env | no planted `GITHUB_TOKEN`/`DATABASE_URL`/API key, and no secret-named sidecar values |
| Network | direct loopback denied, host Unix socket denied, proxy to an allowlisted target allowed (200), proxy to other targets refused (403) |
| Process | signalling a host process denied; reading a host process's argv/env via `pgrep -f` denied. This probe runs an **unsandboxed control first**: if the control cannot reproduce the read, the probe fails closed |

### Additional corpus tests

- **Real linked worktree:** `git status/log` and `node` (including child processes) work inside. `git commit` by the agent fails because the gitdir is read-only. Sibling worktree and fake key reads fail. Planted env secrets are absent.
- **KERN_PROCARGS2 (compiled reader, non-platform host process):** the control outside the sandbox reads the canary; inside it is refused.
- **OpenCode smoke** (local `opencode` 1.18.32, SDK 1.18.30, no model). This uses the real `AttemptServerManager` and `launchSandboxedServer`:
  - A `session.shell` bash tool call wrote inside the worktree, and got EPERM on the fake key.
  - `curl example.com` was refused by the proxy.
  - Anonymous requests got 401.
  - A prompt to a provider configured on an unresolvable `.invalid` host went through the attempt proxy (`dns-failure`). OpenCode's own provider egress is therefore proxied, and nothing can reach a real model.

### Finding fixed during this work

On macOS 27, `(deny default)` did **not** stop `sysctl(KERN_PROCARGS2)` on another same-user process. That call returns argv and environment, so it would expose the sidecar's secrets.
- The first probe used setuid `/bin/ps`, which simply cannot exec in the sandbox, so it gave a **false pass**. The control-run pattern above was added because of this.
- **Fix:** the profile now carries explicit `(deny process-info*)` (and signal, task-port, file, network, mach, iokit and sysctl-write denies) before the same-sandbox re-allows.

### Startup overhead

`opencode serve` under the sandbox, 12 starts each, measured twice:

| | p50 | p95 |
|---|---|---|
| Sandboxed attempt start, run 1 | 433 ms | 974 ms |
| Sandboxed attempt start, run 2 | 430 ms | 992 ms |
| Plain `opencode serve`, run 1 | 459 ms | 484 ms |
| Plain `opencode serve`, run 2 | 447 ms | 467 ms |

- The sandboxed figure covers the proxy, policy and spawn.
- The p95 sample is the first start in each process. It includes the one-time preflight (about 0.55 s); steady-state samples ran 416–493 ms.
- The Seatbelt wrapper adds no measurable time at p50.
- Caveat: the sandboxed runs reuse a warm private root, while the plain runs use a fresh HOME each time.

### Git hardening corpus (real git 2.49)

Each payload's marker file is checked under three conditions: plain git, the pre-W09a hardening, and W09a.

| Payload | Plain git | Pre-W09a | W09a |
|---|---|---|---|
| `hooks/pre-commit` | executed | no | no |
| `core.fsmonitor` | executed | no | no |
| `filter.<x>.clean` | executed | executed | no (scan) |
| `filter.<x>.process` | executed | executed | no (scan) |
| `diff.<x>.textconv` | executed | executed | no (scan) |
| `diff.<x>.command` | executed | executed | no (scan) |
| `diff.external` | executed | executed | no (scan + `diff.external=`) |
| `merge.<x>.driver` | executed | executed | no (scan) |
| `credential.helper` and `credential.<url>.helper` | executed | executed | no (scan + reset) |
| `core.askPass` | executed | executed | no (scan + `GIT_ASKPASS`) |
| `gpg.program` + `commit.gpgSign` | executed | executed | no |
| `include.path` / `includeIf` | executed | executed | no (scan) |
| `core.sshCommand` | executed | n/a | no |
| `remote.<n>.uploadpack` | executed | n/a | no |
| `refs/replace/*` | content swapped | content swapped | ignored |

`url.*.insteadOf`, `pushurl`, `http.<url>.*`, `core.worktree`, `alias.*` and `submodule.*` are all refused by the scan.

How the hardening works:

- **`-c`/env layer.** Every git call now passes this layer, all through `execGit`/`execGitWithCredentials`. I grepped `apps/sidecar` and there are no other git spawns. The layer:
  - disables system and global config, with a validated private HOME;
  - neutralises editor, pager, askpass, ssh, gpg, alternate-refs, attributes-file and external diff;
  - resets credential helpers;
  - turns off submodule recursion;
  - sets `GIT_NO_REPLACE_OBJECTS`;
  - allows https only.
- **Config scan.** Driver-style and URL-scoped keys cannot be out-ranked by `-c`. So `-C <dir>` calls first read `git config --list --show-scope` (which executes nothing) and refuse to run with `GIT_CONFIG_UNSAFE` if any local or worktree key falls outside the allowlist.
- **Push target check.** `commitAndPush` now checks the origin URL read back from the agent's repo with `assertSafeCloneUrl` before any token is used.

### Validation counts

| Check | Result |
|---|---|
| Root `pnpm typecheck` | 11/11 |
| `pnpm lint` | passed (41 files) |
| `biome check --error-on-warnings apps/sidecar/src/sandbox` | clean (18 files) |
| `pnpm --filter @openlinear/sidecar test` | 718 passed, 1 skipped (the env-gated bench), 41 files. Baseline was 661 |
| Sidecar Postgres integration | 26/26 (disposable `openlinear_sandbox_test`, dropped afterwards) |
| Flaky-test check | `sandbox.unit` ×8 runs, stable |

Seven existing tests changed because the behaviour changed on purpose. All seven were stale assertions, not regressions:
- `git-credentials.test.mjs` (3): the hardening prefix grew, and a call site's arbitrary env is now dropped.
- `execution/git.test.mjs` (1): the commit uses identity-only env, and the lease fetch now carries the run credential.
- `codex/index.test.ts` (1): the constructor now receives `env`.
- `opencode.test.mjs` (2): directory routing now goes to the per-attempt manager (mocked), and the phantom plugin is gone.

New tests:
- `sandbox.unit` (34)
- `git-hardening.realgit` (14)
- `sandbox.corpus` (6, including the gated bench)
- `opencode.test.mjs` routing (+3)
- `runners/opencode` fail-closed (+1)

## 6. What is and is not enforced

**Enforced:** read and write confinement, no inherited secrets, network egress, and process isolation, as listed in §3 and checked by probes.

**Not enforced:**

- **Resource limits.** CPU, memory, disk and process counts have no limits on either OS; they are reported as `unsupported`.
- **macOS reaping.** There is no reap-on-parent-death: a crashed sidecar leaves the attempt server running, as before. Process-group kill on normal shutdown works.
- **Path existence leak.** Paths under denied directories can be probed for existence (ENOENT vs EPERM); contents cannot be read.
- **Loopback for agent tests on macOS.** Only the proxy is reachable, so test suites that start local servers fail there. Linux has a private loopback.
- **Provider credential exposure.** The credential (`OPENCODE_AUTH_CONTENT`) is readable by the agent's tools. Egress limits where it can be sent, but data can still go to allowlisted hosts. An inference broker is W10.
- **Proxy limits.** It allows CONNECT only, so plain-HTTP registries and local model servers are not reachable.
- **Shared common dir.** The Git common dir is shared, so committed objects from sibling attempts on the same mirror are readable (read-only). Their uncommitted files and admin dirs are not. A dissociated per-run clone is W08.

## 7. Behaviour changes (verify manually)

1. **Execution can now fail.** Linux without bubblewrap (or without unprivileged user namespaces, e.g. stock Ubuntu 24.04), Windows, and broken preflights now fail with `SANDBOX_UNAVAILABLE` unless a grant is configured.
2. **Agents cannot run `git commit` or `git checkout`** in sidecar worktrees; the sidecar commits.
3. **Repository `opencode.json` is ignored** for sandboxed attempts. Global OpenCode `mcp`/`plugin`/`agent` config is not carried over; only model and provider selection are.
4. **Sidecar git ignores the user's global and system config.**
   - Global gitignore and attributes no longer apply.
   - LFS smudge does not run.
   - The keychain credential helper is no longer consulted.
   - Unauthenticated lease fetches now carry the run token.
5. **Unexpected repository config blocks publication.** A repository that carries non-allowlisted local config fails publication with `GIT_CONFIG_UNSAFE`.
6. **OAuth token refresh does not persist.** Refreshed provider OAuth tokens stay in the attempt's private data dir, not the shared `auth.json`.
7. **Recovery probes miss old sessions.** `recovery.ts` probes with `worktreePath: ''`, so it reaches the shared server and no longer finds attempt sessions.
8. **Ambient fallback removed.** `runners/opencode` `defaultClient` no longer falls back to the ambient `OPENCODE_BASE_URL` server on a sandbox refusal.

## 8. Leftovers

- **Lifecycle:** run the Linux corpus in CI and fix whatever it finds. Persist `SandboxRunMetadata` on `AgentRun`/journal. Pass `worktreePath` in recovery probes. Call `releaseAttemptServer` from worktree release.
- **Process control:** limits via cgroups (Linux) and a supervisor (macOS). Reconcile and reap orphaned attempt servers after a sidecar crash using a nonce-verified identity (W12).
- **Credentials and Git (W10, W08):** a credential/inference broker, which would also fix OAuth refresh and credential exposure. Per-project grants through the API with audit. A dissociated per-run snapshot (W08).
- **Network extras:** opt-in loopback ports for macOS agent tests, and plain-HTTP proxying if needed.
- **Codex:** it now gets the env allowlist only. It still uses its own `workspace-write` Seatbelt and is not wrapped by this provider.

## 9. Merge hazards

- **`services/opencode.ts`:** `buildAgentConfig` is now exported with the plugin removed; there is a new `launchSandboxedServer` and `awaitServerListening`; `getClientForUser` routes directory clients; `shutdownOpenCode` stops attempt servers; new exports `getSandboxRunMetadata` and `releaseAttemptServer`.
- **`services/git-credentials.ts`:** only the hardening block changed (`HARDENED_GIT_ENV`, `hardenedConfigArgs`, `mergeHardenedEnv`, the scan before `execGit` and `execGitWithCredentials`). Token functions are untouched.
- **One-line call-site edits:**
  - `services/execution/git.ts`: identity env, origin URL assert, credentialed lease fetch.
  - `services/worktree.ts`: identity env.
  - `services/batch/completion.ts`: identity env.
  - `runners/codex/index.ts`: `env` passed.
  - `runners/opencode/index.ts`: fail-closed rethrow.
- **Tests:** `opencode.test.mjs` now mocks `../sandbox/opencode-attempts`.
- **Errors:** `SandboxUnavailableError` extends `@openlinear/api/errors` `HttpError`. If W03 removes the sidecar's `@openlinear/api` dependency, re-home it.
- **Lint list:** the root `package.json` lint list does not include `apps/sidecar/src/sandbox` (it is not my file); biome passes on it, so the coordinator may add it.
