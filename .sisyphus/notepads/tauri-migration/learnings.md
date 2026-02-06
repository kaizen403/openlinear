## Task 3: Sidecar Spawning

### Learnings
- Tauri shell plugin uses `app.shell().sidecar("name")` to spawn bundled binaries
- Sidecar binaries must exist in `src-tauri/binaries/` with target-triple suffix: `{name}-{target-triple}`
- Target triples: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`
- `tauri.conf.json` needs `bundle.externalBin` config pointing to binary path (without triple suffix)
- CommandEvent variants: Stdout, Stderr, Terminated, Error
- Use `Mutex<Option<CommandChild>>` to track running process globally
- Emitting events to frontend: `app_handle.emit("event-name", payload)`
- Tauri build requires placeholder binaries to exist even for `cargo check`
- Placeholder icon.png must be valid RGBA PNG format

### Patterns Used
- Followed `opencode.rs` pattern for Tauri commands
- Used `tauri::async_runtime::spawn` for async event handling
- Serializable structs for event payloads with `#[derive(Clone, Serialize)]`

## Task 5: Health Check and Loading State

### Learnings
- Health endpoint already exists at `GET /health` returning `{ status: "ok", timestamp, clients }`
- Linear-inspired dark theme uses custom Tailwind colors in `tailwind.config.ts`:
  - `bg-linear-bg` (#1a1a1a) - main background
  - `text-linear-text` (#f5f5f5) - primary text
  - `text-linear-text-secondary` (#a0a0a0) - muted text
  - `text-linear-text-tertiary` (#6a6a6a) - very muted text
  - `text-linear-accent` (#3b82f6) - accent color (blue)
  - `bg-linear-border` (#2a2a2a) - borders
- Polling pattern: Use `setInterval` for 500ms checks, `setTimeout` for 30s timeout
- Always cleanup timers in useEffect cleanup and when success/failure occurs
- Use `useCallback` with proper dependency arrays for timer functions
- Multiple concurrent timers need separate refs to clear them properly

### Patterns Used
- Component pattern similar to `opencode-setup-dialog.tsx`
- Button component from `@/components/ui/button`
- Lucide icons: `Loader2`, `RefreshCw`, `Server`, `AlertCircle`
- Fullscreen centered overlay with `fixed inset-0 z-50`
- Progress bar showing elapsed time
- Animated dots using string repetition with non-breaking spaces

## Task 8: Deep Link OAuth Handler (2026-02-06)

### Key Patterns Learned

1. **Tauri deep-link plugin (v2) API**:
   - Use `DeepLinkExt` trait with `app.deep_link().on_open_url()` 
   - Event provides `event.urls()` iterator
   - On Windows/Linux, URL comes as CLI args (different behavior than macOS)
   - For cross-platform consistency, consider single-instance plugin with deep-link feature

2. **OAuth Redirect Handling**:
   - Express OAuth endpoint redirects with `?token=XXX` or `?error=XXX`
   - Use `reqwest` with `redirect(Policy::none())` to capture redirect Location
   - Parse Location header to extract token from redirect URL

3. **Async in Tauri Event Handlers**:
   - Use `tauri::async_runtime::spawn()` for async work in sync callbacks
   - Clone the app handle before moving into async block
   - Emit events to frontend with `handle.emit("event-name", payload)`

4. **Event Naming**:
   - Frontend listens with `listen('auth:callback', ...)` from `@tauri-apps/api/event`
   - Payload struct needs `#[derive(Clone, Serialize)]` 
   - Use `skip_serializing_if` for optional fields

5. **Dependencies Added**:
   - `url = "2"` for URL parsing
   - `reqwest = { version = "0.11", features = ["json"] }` for HTTP calls
   - `tokio` features already included via Tauri

## Task 10: Bundle Configuration (2026-02-06)

### Tauri 2.0 Bundle Config Structure
- macOS settings go under `bundle.macOS` (not separate top-level)
- Linux settings go under `bundle.linux`
- Both are nested within the `bundle` object in tauri.conf.json

### Key Settings Added
- `macOS.minimumSystemVersion: "10.15"` - macOS Catalina minimum
- `macOS.dmg.windowSize` - controls DMG installer window
- `linux.appimage.bundleMediaFramework: false` - avoids unnecessary media libs
- `linux.deb.depends: []` - explicitly empty deps for minimal package

### Build Script Pattern
- `pnpm --filter @openlinear/desktop tauri build` runs desktop build
- Consistent with other filter patterns in monorepo

## 2026-02-06 - pkg ESM Bundling Solution

### Problem Solved
The `@yao-pkg/pkg` tool cannot directly bundle ES modules. The API uses `"type": "module"`.

### Solution
1. Use **esbuild** to bundle ESM → CJS first:
   ```bash
   npx esbuild src/index.ts --bundle --platform=node --target=node18 --outfile=dist/bundle.cjs --format=cjs
   ```

2. Then use **pkg** to compile the CJS bundle:
   ```bash
   npx @yao-pkg/pkg dist/bundle.cjs --target node18-linux-x64 --output dist/api-linux-x64
   ```

3. Copy Prisma engine files to dist/ before pkg runs

### Updated Build Script
`scripts/build-sidecar.sh` now follows this workflow.

### Binary Sizes
- Linux x64: 67MB
- Mac ARM: 60MB  
- Mac x64: 71MB

### Test Results
- Linux sidecar binary starts Express server successfully
- Desktop binary launches (GTK/WebKit confirmed)
- .deb bundle: 32MB built successfully
