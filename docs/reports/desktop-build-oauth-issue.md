# OpenLinear Desktop App Production Build Issue Report

## Issue Summary

When running the **production-built desktop app** (Tauri + bundled sidecar), the application attempts to connect to `http://localhost:3001` for GitHub OAuth authentication, but the API server is not running on that port. This causes Firefox/Chrome to show a "Can't connect" error at `http://localhost:3001/api/auth/github?client=desktop`.

**Error Page:**
```
Firefox can't connect to the server at localhost:3001
```

---

## Root Cause Analysis

### 1. Build-Time URL Baking

The desktop app uses **two different API URLs** depending on the context:

| URL Type | Purpose | In Production Desktop |
|----------|---------|----------------------|
| `NEXT_PUBLIC_CLOUD_API_URL` | OAuth login, cloud features | Baked at **build time** |
| Sidecar URL (ephemeral port) | Task execution, local API | Resolved at **runtime** via Tauri events |

**The Problem:**

The file `apps/desktop-ui/lib/api/auth.ts` (lines 35-39) constructs the OAuth URL using `CLOUD_AUTH_URL`:

```typescript
// lib/api/auth.ts
export function getLoginUrl(): string {
  if (isTauriRuntime()) {
    return `${CLOUD_AUTH_URL}/api/auth/github?client=desktop`;
  }
  return `${getApiUrl()}/api/auth/github`;
}
```

Where `CLOUD_AUTH_URL` is set at **build time** from `NEXT_PUBLIC_CLOUD_API_URL`:

```typescript
const CLOUD_AUTH_URL =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CLOUD_API_URL) ||
  'https://openlinear.tech';
```

**Current `.env` setting:**
```
NEXT_PUBLIC_CLOUD_API_URL=http://localhost:3001
```

This value was baked into the production build, so every user running the built app gets `localhost:3001` hardcoded for OAuth.

### 2. Runtime Port Mismatch

In production mode, the **sidecar API server** uses an **ephemeral (random) port**, not 3001. The port is picked at startup via `pick_free_port()` in `apps/desktop/src-tauri/src/sidecar.rs`:

```rust
fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral port: {}", e))?;
    let port = listener.local_addr()?.port();
    // ...
}
```

The UI discovers the actual port via Tauri events (`sidecar:ready`), but this **only works for task execution APIs** — not for OAuth, which uses the statically-baked cloud URL.

### 3. The Architecture Gap

```
┌─────────────────────────────────────────────────────────┐
│  Desktop App (Tauri)                                    │
│  ┌──────────────┐   ┌─────────────────────────────────┐│
│  │ WebView (UI) │   │ Sidecar Process                 ││
│  │              │   │ (Bundled API + OpenCode agent)  ││
│  │ OAuth URL:   │◄──│ Port: RANDOM (e.g., 45678)      ││
│  │ localhost:3001│   │ (Dynamically assigned)          ││
│  │ (BAKED IN!)  │   │                                 ││
│  │              │   │ For task execution: ✓ Works     ││
│  │ For login:   │   │ For OAuth: ✗ Wrong URL!         ││
│  │ ✗ BROKEN     │   │                                 ││
│  └──────────────┘   └─────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

---

## Reproduction Steps

1. Build the desktop app with `NEXT_PUBLIC_CLOUD_API_URL=http://localhost:3001` in `.env`
2. Run the production binary: `./openlinear-desktop`
3. Click "Login with GitHub" in the app
4. Browser opens to `http://localhost:3001/api/auth/github?client=desktop`
5. **Error:** Connection refused (no server on port 3001)

---

## Affected Files

| File | Role |
|------|------|
| `apps/desktop-ui/lib/api/auth.ts` | OAuth URL construction using baked cloud URL |
| `apps/desktop-ui/lib/api/client.ts` | `getCloudApiUrl()` returns baked URL in Tauri runtime |
| `apps/desktop/src-tauri/src/sidecar.rs` | Sidecar starts on ephemeral port |
| `apps/desktop/src-tauri/tauri.conf.json` | Build configuration |
| `.env` | Contains `NEXT_PUBLIC_CLOUD_API_URL` |

---

## Potential Solutions (To Evaluate)

### Option A: Separate OAuth Server
Run a dedicated OAuth callback server on a **fixed port** (e.g., 3001) that handles only the OAuth redirect and proxies/communicates with the ephemeral sidecar.

**Pros:** Simple, matches current architecture assumption
**Cons:** Requires another process, port conflicts possible

### Option B: OAuth-Only Fixed Port
Modify the sidecar to **always use port 3001 for OAuth endpoints only**, while keeping ephemeral ports for task execution APIs.

**Pros:** Minimal changes
**Cons:** Port 3001 might be in use; two listeners in sidecar

### Option C: Build-Time vs Runtime Detection
Change the desktop UI to detect at runtime whether to use:
- The baked cloud URL for **actual cloud deployments**
- A hardcoded `http://localhost:3001` only when running in **dev mode** (where API is manually started on 3001)
- The discovered sidecar URL for **bundled production builds**

**Implementation idea:**
```typescript
function getOAuthUrl(): string {
  if (isTauriRuntime()) {
    // In production Tauri build, we need to know if API is bundled or external
    const sidecarUrl = loadCachedSidecarUrl();
    if (sidecarUrl) {
      return `${sidecarUrl}/api/auth/github?client=desktop`;
    }
    // Fallback: dev mode with manually-started API
    return `${DEFAULT_API_URL}/api/auth/github?client=desktop`;
  }
  // Web mode: use cloud or configured URL
  return `${getApiUrl()}/api/auth/github`;
}
```

**Pros:** Correct behavior in all modes
**Cons:** Requires the OAuth callback handler to work on ephemeral ports (GitHub OAuth app config needs to allow all localhost ports or use `openlinear://` deep link)

### Option D: Deep Link for OAuth Callback
Use the `openlinear://` deep link scheme (already registered in Tauri) for OAuth callbacks instead of HTTP.

**Implementation:**
1. Register `openlinear://auth/callback` as the OAuth redirect URI in GitHub
2. The sidecar's OAuth endpoint redirects to `openlinear://auth/callback?code=...`
3. Tauri intercepts the deep link and passes the code to the UI

**Pros:** No port dependency at all; works with any sidecar port
**Cons:** Requires GitHub OAuth app configuration change; more complex flow

---

## Current Workarounds

### Workaround 1: Dev Mode (Not Production)
Start the API manually on port 3001 before running the desktop app:
```bash
API_PORT=3001 pnpm --filter @openlinear/api dev  # Terminal 1
pnpm --filter @openlinear/desktop tauri dev       # Terminal 2
```

### Workaround 2: Use Cloud URL for Production Builds
Set the correct cloud URL before building:
```bash
echo "NEXT_PUBLIC_CLOUD_API_URL=https://openlinear.tech" >> .env
pnpm build:desktop
```
**Note:** This requires the cloud API to be running and accessible, and users need internet connectivity for OAuth even when using the desktop app for local task execution.

---

## Diagnostic Commands

```bash
# Check what URL is baked into the built app
grep -r "localhost:3001" apps/desktop-ui/out/ || echo "Not found in static files"

# Check current .env setting
grep NEXT_PUBLIC_CLOUD_API_URL .env

# Verify sidecar port assignment
cd apps/desktop/src-tauri/target/release
./openlinear-desktop &
sleep 5
netstat -tlnp | grep openlinear
```

---

## Build Notes

- **AppImage bundling fails** on modern Linux due to `linuxdeploy` using an old `strip` binary that doesn't recognize `.relr.dyn` ELF sections.
- **Workaround:** Set `APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1` before running linuxdeploy, or skip AppImage and use the raw binary.
- The **raw binary** (`target/release/openlinear-desktop`) works correctly for launching the sidecar and UI.

---

## Recommendation

The cleanest fix is **Option D (Deep Link OAuth)** combined with **Option C (Runtime URL Detection)**:

1. Use the sidecar's ephemeral port for OAuth by default in bundled mode
2. Fall back to `openlinear://` deep links for the callback if GitHub doesn't support arbitrary localhost ports
3. Keep `NEXT_PUBLIC_CLOUD_API_URL` for actual cloud deployments only

This requires:
- Modifying `apps/desktop-ui/lib/api/auth.ts` to use `getSidecarApiUrl()` instead of `getCloudApiUrl()` when in Tauri runtime
- Ensuring the sidecar's OAuth endpoint can handle the callback on any port
- Testing the GitHub OAuth flow with ephemeral ports

---

*Report generated for architecture review and GPT-5.5 analysis.*
