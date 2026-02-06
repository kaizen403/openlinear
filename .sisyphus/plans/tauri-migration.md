# OpenLinear Tauri Desktop Migration

## TL;DR

> **Quick Summary**: Migrate OpenLinear from web app to Tauri desktop app for Mac + Linux, bundling Express API as a Node.js sidecar compiled with `pkg`.
> 
> **Deliverables**:
> - Tauri desktop app with React UI in WebView
> - Express API bundled as standalone sidecar binary
> - OpenCode auto-detection with download prompt
> - GitHub OAuth via deep links
> - Mac (.dmg, .app) and Linux (.AppImage, .deb) distributions
> 
> **Estimated Effort**: Large (multi-week project)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 3 → Task 5 → Task 8 → Task 10

---

## Context

### Original Request
Migrate OpenLinear to a desktop app that can run scripts, terminal actions, and interact with the locally-installed OpenCode agent. Target Mac and Linux platforms.

### Interview Summary
**Key Discussions**:
- Backend Strategy: Bundle Express as Node.js sidecar (fastest migration path)
- OpenCode: Auto-detect in PATH, download if missing
- Database: Cloud PostgreSQL (user provides DATABASE_URL)
- Auth: GitHub OAuth via deep links + local accounts
- UI: Simplified log view (no full terminal emulation)
- Platforms: Mac + Linux only

**Research Findings**:
- Tauri shell plugin fully supports Node.js sidecar spawning
- Use `@yao-pkg/pkg` to compile Express into standalone binary
- Deep links (`openlinear://callback`) for OAuth flow
- Sidecar binaries need platform-specific suffixes

### Metis Review
**Identified Gaps** (addressed):
- Sidecar naming: Must use target triple suffixes (e.g., `-x86_64-apple-darwin`)
- OAuth redirect: User will manually update GitHub OAuth app
- Health check: Parse Express stdout for "Server running on" message
- Linux builds: Need Ubuntu 18.04 or Docker for glibc compatibility

---

## Work Objectives

### Core Objective
Create a production-ready Tauri desktop app that wraps the existing OpenLinear UI and Express API, enabling local OpenCode agent execution on Mac and Linux.

### Concrete Deliverables
- `apps/desktop/` - New Tauri app directory
- `apps/desktop/src-tauri/` - Rust backend with sidecar management
- `apps/desktop/src-tauri/binaries/` - Compiled Express sidecar binaries
- `apps/api/` - Modified to support `pkg` compilation
- Build scripts for cross-platform sidecar compilation
- Distribution bundles: `.dmg`, `.app`, `.AppImage`, `.deb`

### Definition of Done
- [ ] App launches on Mac (Intel + ARM) and Linux
- [ ] Express sidecar starts automatically on app launch
- [ ] Frontend connects to localhost:3001 and displays tasks
- [ ] GitHub OAuth flow works via deep links
- [ ] OpenCode execution works end-to-end
- [ ] `bun run build:desktop` produces distributable bundles

### Must Have
- Tauri v2 with shell plugin
- Express compiled with `pkg` as sidecar
- Health check before showing UI
- Deep link handler for OAuth
- Graceful sidecar shutdown on app exit

### Must NOT Have (Guardrails)
- NO Windows support in this phase
- NO Rust rewrite of Express logic
- NO SQLite migration (keep cloud PostgreSQL)
- NO full terminal emulation (xterm.js)
- NO changes to existing Express API logic
- NO auto-update mechanism in first version

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: YES (existing Express tests)
- **User wants tests**: TDD for new Tauri code
- **Framework**: Rust tests for Tauri commands, Vitest for JS

### TDD Approach for Tauri Code

Each new Tauri command/feature:
1. **RED**: Write failing test first
2. **GREEN**: Implement minimum code to pass
3. **REFACTOR**: Clean up while keeping green

### Automated Verification

| Deliverable Type | Verification Method |
|------------------|---------------------|
| Tauri commands | `cargo test` in src-tauri |
| Sidecar startup | Health check HTTP request |
| Deep links | Manual test with `open openlinear://test` |
| Full app | Launch and verify Express responds |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Initialize Tauri in monorepo
├── Task 2: Configure pkg for Express compilation
└── Task 6: Create OpenCode detection utility

Wave 2 (After Wave 1):
├── Task 3: Implement sidecar spawning
├── Task 4: Create cross-platform build scripts
├── Task 7: OpenCode download manager
└── Task 9: Settings page for DATABASE_URL

Wave 3 (After Wave 2):
├── Task 5: Health check and loading state
├── Task 8: Deep link OAuth handler
├── Task 10: Build and bundle configuration
└── Task 11: Distribution and testing

Critical Path: Task 1 → Task 3 → Task 5 → Task 8 → Task 10
Parallel Speedup: ~35% faster than sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 3, 4, 5, 8, 9 | 2, 6 |
| 2 | None | 3, 4 | 1, 6 |
| 3 | 1, 2 | 5 | 7, 9 |
| 4 | 1, 2 | 10 | 3, 7, 9 |
| 5 | 3 | 8 | 7, 9 |
| 6 | None | 7 | 1, 2 |
| 7 | 6 | 11 | 3, 4, 9 |
| 8 | 1, 5 | 11 | 9, 10 |
| 9 | 1 | 11 | 3, 4, 7, 8 |
| 10 | 1, 4 | 11 | 8, 9 |
| 11 | 7, 8, 9, 10 | None | None (final) |

---

## TODOs

- [ ] 1. Initialize Tauri in monorepo

  **What to do**:
  - Create `apps/desktop/` directory structure
  - Initialize Tauri v2 project with `pnpm create tauri-app`
  - Configure to use existing `apps/web` as frontend source
  - Add required plugins: `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-deep-link`, `@tauri-apps/plugin-fs`
  - Configure `tauri.conf.json` for Mac + Linux only
  - Verify `pnpm tauri dev` launches empty window

  **Must NOT do**:
  - Do NOT add Windows targets
  - Do NOT modify existing apps/web or apps/api

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`pnpm`]
    - `pnpm`: Monorepo workspace configuration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 6)
  - **Blocks**: Tasks 3, 4, 5, 8, 9, 10
  - **Blocked By**: None

  **References**:
  - Tauri v2 Getting Started: https://v2.tauri.app/start/
  - Shell plugin: https://v2.tauri.app/plugin/shell/
  - Deep link plugin: https://v2.tauri.app/plugin/deep-link/
  - Current monorepo structure: `/home/kaizen/openlinear/apps/`
  - Turborepo config: `/home/kaizen/openlinear/turbo.json`

  **Acceptance Criteria**:
  - [ ] `apps/desktop/` directory exists with Tauri structure
  - [ ] `apps/desktop/src-tauri/Cargo.toml` includes required plugins
  - [ ] `apps/desktop/src-tauri/tauri.conf.json` targets only Mac + Linux
  - [ ] `pnpm tauri dev` from apps/desktop launches window (may be blank)
  ```bash
  # Verify Tauri initialized
  test -f /home/kaizen/openlinear/apps/desktop/src-tauri/tauri.conf.json && echo "PASS"
  # Assert: PASS
  
  # Verify plugins in Cargo.toml
  grep -q "tauri-plugin-shell" /home/kaizen/openlinear/apps/desktop/src-tauri/Cargo.toml && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `feat(desktop): initialize Tauri v2 app with shell and deep-link plugins`
  - Files: `apps/desktop/**`

---

- [ ] 2. Configure pkg for Express compilation

  **What to do**:
  - Add `@yao-pkg/pkg` as dev dependency to `apps/api`
  - Create `pkg` configuration in `apps/api/package.json`
  - Configure to output standalone binary with Node.js bundled
  - Test compilation: `pnpm pkg .` produces working binary
  - Verify binary runs Express server standalone

  **Must NOT do**:
  - Do NOT change Express API logic
  - Do NOT modify database connections

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: [`pnpm`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 6)
  - **Blocks**: Tasks 3, 4
  - **Blocked By**: None

  **References**:
  - pkg documentation: https://github.com/yao-pkg/pkg
  - Express app entry: `/home/kaizen/openlinear/apps/api/src/index.ts`
  - Express package.json: `/home/kaizen/openlinear/apps/api/package.json`

  **Acceptance Criteria**:
  - [ ] `@yao-pkg/pkg` in devDependencies
  - [ ] `pkg` config in package.json with targets for Mac + Linux
  - [ ] `pnpm run build:pkg` produces binary in `apps/api/dist/`
  - [ ] Binary runs standalone: `./dist/openlinear-api` starts server
  ```bash
  # Verify pkg installed
  grep -q "@yao-pkg/pkg" /home/kaizen/openlinear/apps/api/package.json && echo "PASS"
  # Assert: PASS
  
  # Verify build script exists
  grep -q "build:pkg" /home/kaizen/openlinear/apps/api/package.json && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `build(api): add pkg configuration for standalone binary compilation`
  - Files: `apps/api/package.json`

---

- [ ] 3. Implement sidecar spawning in Tauri

  **What to do**:
  - Create Rust command to spawn Express sidecar on app start
  - Configure `tauri.conf.json` with `bundle.externalBin` for sidecar
  - Create binaries directory structure with platform suffixes
  - Implement stdout/stderr streaming from sidecar to frontend
  - Handle sidecar process lifecycle (start, monitor, kill on exit)
  - Add TDD tests for sidecar management

  **Must NOT do**:
  - Do NOT bundle actual binary yet (use placeholder or dev mode)
  - Do NOT implement health check (separate task)

  **Recommended Agent Profile**:
  - **Category**: `ultrabrain`
  - **Skills**: []
    - Rust/Tauri expertise needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 7, 9)
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2

  **References**:
  - Tauri sidecar docs: https://v2.tauri.app/develop/sidecar/
  - Shell plugin spawn: https://v2.tauri.app/plugin/shell/
  - Sidecar naming convention: `binary-name-{target-triple}`
  - Target triples: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`

  **Acceptance Criteria**:
  - [ ] `src-tauri/src/sidecar.rs` module created
  - [ ] Tauri command `start_api_server` spawns sidecar
  - [ ] Tauri command `stop_api_server` kills sidecar
  - [ ] Stdout/stderr events emitted to frontend
  - [ ] `cargo test` passes for sidecar module
  ```bash
  # Verify sidecar module exists
  test -f /home/kaizen/openlinear/apps/desktop/src-tauri/src/sidecar.rs && echo "PASS"
  # Assert: PASS
  
  # Verify externalBin configured
  grep -q "externalBin" /home/kaizen/openlinear/apps/desktop/src-tauri/tauri.conf.json && echo "PASS"
  # Assert: PASS
  
  # Run Rust tests
  cd /home/kaizen/openlinear/apps/desktop/src-tauri && cargo test
  # Assert: All tests pass
  ```

  **Commit**: YES
  - Message: `feat(desktop): implement sidecar spawning for Express API`
  - Files: `apps/desktop/src-tauri/**`

---

- [ ] 4. Create cross-platform build scripts

  **What to do**:
  - Create `scripts/build-sidecar.sh` for building Express binaries
  - Build for Mac Intel: `openlinear-api-x86_64-apple-darwin`
  - Build for Mac ARM: `openlinear-api-aarch64-apple-darwin`
  - Build for Linux: `openlinear-api-x86_64-unknown-linux-gnu`
  - Copy binaries to `apps/desktop/src-tauri/binaries/`
  - Add npm script `build:sidecar` to root package.json

  **Must NOT do**:
  - Do NOT set up CI/CD yet
  - Do NOT build Windows binaries

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 7, 9)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 1, 2

  **References**:
  - pkg targets: https://github.com/yao-pkg/pkg#targets
  - Tauri sidecar naming: https://v2.tauri.app/develop/sidecar/

  **Acceptance Criteria**:
  - [ ] `scripts/build-sidecar.sh` exists and is executable
  - [ ] Script builds binaries for all 3 targets
  - [ ] Binaries placed in correct location with correct names
  ```bash
  # Verify build script exists
  test -x /home/kaizen/openlinear/scripts/build-sidecar.sh && echo "PASS"
  # Assert: PASS
  
  # Run build (on current platform only for test)
  /home/kaizen/openlinear/scripts/build-sidecar.sh
  ls /home/kaizen/openlinear/apps/desktop/src-tauri/binaries/openlinear-api-*
  # Assert: At least one binary exists
  ```

  **Commit**: YES
  - Message: `build: add cross-platform sidecar build scripts`
  - Files: `scripts/build-sidecar.sh`, `package.json`

---

- [ ] 5. Implement health check and loading state

  **What to do**:
  - Create Rust function to poll `localhost:3001/health` until ready
  - Add loading UI component showing "Starting server..."
  - Only show main app after health check passes
  - Set timeout (30s) with error message if server fails to start
  - Emit `api-ready` event when health check passes

  **Must NOT do**:
  - Do NOT add retry logic beyond simple polling
  - Do NOT modify Express health endpoint (should already exist)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 9)
  - **Blocks**: Task 8
  - **Blocked By**: Task 3

  **References**:
  - Express health endpoint: Check if exists in `/home/kaizen/openlinear/apps/api/src/app.ts`
  - Tauri events: https://v2.tauri.app/develop/calling-frontend/

  **Acceptance Criteria**:
  - [ ] Loading component shows spinner and "Starting server..."
  - [ ] Main app only visible after health check passes
  - [ ] Timeout after 30s shows error with retry button
  ```bash
  # Verify health endpoint exists in Express
  grep -q "health" /home/kaizen/openlinear/apps/api/src/app.ts && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `feat(desktop): add health check and loading state`
  - Files: `apps/desktop/**`

---

- [ ] 6. Create OpenCode detection utility

  **What to do**:
  - Create Rust utility to check if `opencode` exists in PATH
  - Use `which opencode` or equivalent cross-platform check
  - Return version if found, null if not found
  - Create Tauri command `check_opencode` callable from frontend
  - Write tests for detection logic

  **Must NOT do**:
  - Do NOT implement download logic (separate task)
  - Do NOT bundle OpenCode binary

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 7
  - **Blocked By**: None

  **References**:
  - Rust which crate: https://crates.io/crates/which
  - OpenCode CLI: User has it installed locally

  **Acceptance Criteria**:
  - [ ] Tauri command `check_opencode` returns `{ found: boolean, version?: string }`
  - [ ] Works on Mac and Linux
  - [ ] `cargo test` passes for detection module
  ```bash
  # Verify command exists in Rust code
  grep -q "check_opencode" /home/kaizen/openlinear/apps/desktop/src-tauri/src/*.rs && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `feat(desktop): add OpenCode CLI detection utility`
  - Files: `apps/desktop/src-tauri/**`

---

- [ ] 7. Implement OpenCode download manager

  **What to do**:
  - Create UI dialog prompting user to download OpenCode if not found
  - Detect platform (Mac Intel, Mac ARM, Linux)
  - Provide download link or button to download correct binary
  - After download, re-check and update status
  - Store download preference in app settings

  **Must NOT do**:
  - Do NOT auto-install without user consent
  - Do NOT bundle OpenCode in the app

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`, `shadcn-ui`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 9)
  - **Blocks**: Task 11
  - **Blocked By**: Task 6

  **References**:
  - OpenCode releases: Check GitHub releases page
  - Tauri OS detection: https://v2.tauri.app/reference/javascript/api/os/

  **Acceptance Criteria**:
  - [ ] Dialog appears on first launch if OpenCode not found
  - [ ] Platform correctly detected and shown
  - [ ] Download link opens in system browser
  - [ ] "Check Again" button re-runs detection

  **Commit**: YES
  - Message: `feat(desktop): add OpenCode download manager dialog`
  - Files: `apps/desktop/**`, `apps/web/components/**`

---

- [ ] 8. Implement deep link OAuth handler

  **What to do**:
  - Register `openlinear://` URL scheme in Tauri config
  - Handle `openlinear://callback?code=...` deep link
  - Extract OAuth code and pass to Express for token exchange
  - Update frontend auth state after successful OAuth
  - Test flow: app opens browser → GitHub OAuth → redirect back to app

  **Must NOT do**:
  - Do NOT modify Express OAuth logic (just redirect URI)
  - Do NOT handle token storage differently

  **Recommended Agent Profile**:
  - **Category**: `ultrabrain`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 10)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 1, 5

  **References**:
  - Deep link plugin: https://v2.tauri.app/plugin/deep-link/
  - Current OAuth flow: `/home/kaizen/openlinear/apps/api/src/routes/auth.ts`
  - Frontend auth hook: `/home/kaizen/openlinear/apps/web/hooks/use-auth.tsx`

  **Acceptance Criteria**:
  - [ ] `openlinear://` scheme registered in tauri.conf.json
  - [ ] Deep link handler in Rust listens for callbacks
  - [ ] OAuth code extracted and sent to Express
  - [ ] Frontend updates auth state after success
  ```bash
  # Verify deep link scheme configured
  grep -q '"schemes".*"openlinear"' /home/kaizen/openlinear/apps/desktop/src-tauri/tauri.conf.json && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `feat(desktop): implement GitHub OAuth via deep links`
  - Files: `apps/desktop/**`

---

- [ ] 9. Add settings page for DATABASE_URL

  **What to do**:
  - Add settings input for PostgreSQL connection string
  - Store in Tauri app data directory (secure storage)
  - Pass DATABASE_URL as environment variable when spawning sidecar
  - Add validation for connection string format
  - Show connection status (connected/error)

  **Must NOT do**:
  - Do NOT store credentials in plain text files
  - Do NOT modify Prisma schema

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`, `shadcn-ui`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2/3 (with Tasks 3, 4, 7, 8)
  - **Blocks**: Task 11
  - **Blocked By**: Task 1

  **References**:
  - Existing settings page: `/home/kaizen/openlinear/apps/web/app/settings/page.tsx`
  - Tauri store plugin: https://v2.tauri.app/plugin/store/

  **Acceptance Criteria**:
  - [ ] DATABASE_URL input field in settings
  - [ ] Value persisted securely across app restarts
  - [ ] Sidecar spawned with DATABASE_URL env var
  - [ ] Connection test button with status indicator

  **Commit**: YES
  - Message: `feat(desktop): add DATABASE_URL configuration in settings`
  - Files: `apps/desktop/**`, `apps/web/app/settings/**`

---

- [ ] 10. Configure build and bundle settings

  **What to do**:
  - Configure `tauri.conf.json` bundle settings for Mac and Linux
  - Set app icon, identifier, version
  - Configure DMG settings for Mac (icon positions, background)
  - Configure AppImage and .deb for Linux
  - Add `build:desktop` script to root package.json
  - Test build produces distributable files

  **Must NOT do**:
  - Do NOT set up code signing (requires certificates)
  - Do NOT configure auto-update

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8, 9)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 1, 4

  **References**:
  - Tauri bundling: https://v2.tauri.app/distribute/
  - Bundle config: https://v2.tauri.app/reference/config/#bundleconfig

  **Acceptance Criteria**:
  - [ ] App identifier set (e.g., `com.openlinear.app`)
  - [ ] App icon configured
  - [ ] `pnpm build:desktop` produces .dmg on Mac
  - [ ] `pnpm build:desktop` produces .AppImage on Linux
  ```bash
  # Verify bundle identifier
  grep -q "identifier" /home/kaizen/openlinear/apps/desktop/src-tauri/tauri.conf.json && echo "PASS"
  # Assert: PASS
  ```

  **Commit**: YES
  - Message: `build(desktop): configure bundle settings for Mac and Linux`
  - Files: `apps/desktop/src-tauri/tauri.conf.json`, `package.json`

---

- [ ] 11. Integration testing and final verification

  **What to do**:
  - Build complete app with all sidecars
  - Test on Mac (if available) - launch, OAuth, task execution
  - Test on Linux - launch, OAuth, task execution
  - Verify OpenCode detection and download flow
  - Fix any integration issues discovered
  - Document known issues and limitations

  **Must NOT do**:
  - Do NOT add new features
  - Do NOT refactor working code

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Final (sequential)
  - **Blocks**: None
  - **Blocked By**: Tasks 7, 8, 9, 10

  **References**:
  - All previous tasks' outputs

  **Acceptance Criteria**:
  - [ ] App launches without errors on Mac
  - [ ] App launches without errors on Linux
  - [ ] Express API responds at localhost:3001
  - [ ] GitHub OAuth completes successfully
  - [ ] Task creation and execution works end-to-end
  - [ ] OpenCode agent interaction works

  **Commit**: YES
  - Message: `test(desktop): complete integration testing`
  - Files: Any bug fixes discovered

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(desktop): initialize Tauri v2 app` | apps/desktop/** | tauri dev launches |
| 2 | `build(api): add pkg configuration` | apps/api/package.json | pkg builds binary |
| 3 | `feat(desktop): implement sidecar spawning` | apps/desktop/src-tauri/** | cargo test |
| 4 | `build: add sidecar build scripts` | scripts/**, package.json | script runs |
| 5 | `feat(desktop): add health check` | apps/desktop/** | loading shows |
| 6 | `feat(desktop): add OpenCode detection` | apps/desktop/src-tauri/** | cargo test |
| 7 | `feat(desktop): add OpenCode download dialog` | apps/desktop/**, apps/web/** | dialog appears |
| 8 | `feat(desktop): implement deep link OAuth` | apps/desktop/** | oauth works |
| 9 | `feat(desktop): add DATABASE_URL settings` | apps/desktop/**, apps/web/** | setting persists |
| 10 | `build(desktop): configure bundling` | apps/desktop/**, package.json | build produces files |
| 11 | `test(desktop): integration testing` | various | e2e works |

---

## Success Criteria

### Verification Commands
```bash
# Build sidecar
pnpm build:sidecar
# Expected: Binaries in apps/desktop/src-tauri/binaries/

# Build desktop app
pnpm build:desktop
# Expected: .dmg or .AppImage in apps/desktop/src-tauri/target/release/bundle/

# Run in dev mode
cd apps/desktop && pnpm tauri dev
# Expected: App window opens, Express starts, UI loads
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] Tauri tests pass (`cargo test`)
- [ ] Express tests pass (`pnpm test`)
- [ ] App builds for Mac (.dmg)
- [ ] App builds for Linux (.AppImage)
- [ ] OAuth flow works
- [ ] Task execution works
