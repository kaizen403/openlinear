# Desktop Integration (Tauri)

## Overview

The OpenLinear desktop app is built with Tauri 2. The Rust backend handles OS-level concerns: spawning the API sidecar process, deep linking for OAuth, secure credential storage, and native file dialogs. The webview runs the Next.js UI from `apps/desktop-ui`.

---

## Key Files

| File | Role |
|------|------|
| `apps/desktop/src-tauri/src/lib.rs` | App entry point, plugin registration, command handler registration |
| `apps/desktop/src-tauri/src/sidecar.rs` | Spawns and manages the bundled API server process |
| `apps/desktop/src-tauri/src/deeplink.rs` | Handles `openlinear://` URL scheme for OAuth |
| `apps/desktop/src-tauri/src/opencode.rs` | Checks for `opencode` CLI, native folder picker |
| `apps/desktop/src-tauri/src/secure_storage.rs` | OS keychain integration for API keys |
| `apps/desktop/src-tauri/tauri.conf.json` | App config: window, bundle targets, plugins, deep link scheme |
| `apps/desktop-ui/lib/pick-local-folder.ts` | TypeScript wrapper for the native folder picker |
| `apps/desktop-ui/components/desktop/database-settings.tsx` | UI for configuring the PostgreSQL connection URL |

---

## App Configuration

**File:** `apps/desktop/src-tauri/tauri.conf.json`

```json
{
  "productName": "OpenLinear",
  "identifier": "com.openlinear.app",
  "app": {
    "windows": [{
      "title": "OpenLinear",
      "width": 1200,
      "height": 800,
      "center": true,
      "decorations": false
    }]
  },
  "bundle": {
    "targets": ["dmg", "app", "appimage", "deb"],
    "externalBin": ["binaries/openlinear-sidecar"]
  },
  "plugins": {
    "shell": { "open": true },
    "deep-link": {
      "desktop": { "schemes": ["openlinear"] }
    }
  }
}
```

Key points:
- `decorations: false` — the window has no native title bar; the UI renders its own.
- `externalBin` — the sidecar binary is bundled alongside the app.
- The `openlinear://` URL scheme is registered at the OS level for deep linking.
- Build targets cover macOS (`.dmg`, `.app`) and Linux (`.appimage`, `.deb`).

---

## Sidecar: Bundled API Server

**File:** `apps/desktop/src-tauri/src/sidecar.rs`

The API server runs as a child process (sidecar) inside the Tauri app. This keeps the full Express/Prisma stack running locally without requiring the user to start it manually.

### Process lifecycle

A `Mutex<Option<CommandChild>>` holds the running process handle:

```rust
static API_SERVER_PROCESS: Mutex<Option<CommandChild>> = Mutex::new(None);
```

On app startup (`lib.rs` `setup` hook), the sidecar starts automatically:

```rust
tauri::async_runtime::spawn(async move {
    sidecar::start_api_server_with_saved_database_url(app_handle).await
});
```

On app exit (`RunEvent::ExitRequested` or `RunEvent::Exit`), the sidecar is killed:

```rust
app.run(|_app_handle, event| {
    if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        let _ = sidecar::stop_api_server_sync();
    }
});
```

### Database URL resolution

`start_api_server_with_saved_database_url` resolves the database URL in this order:

1. `DATABASE_URL` environment variable (if set and non-empty)
2. `database_url` key in `{app_data_dir}/settings.json` (persisted by the UI via `tauri-plugin-store`)
3. Fallback: `postgresql://openlinear:openlinear@localhost:5432/openlinear`

```rust
const DEFAULT_DATABASE_URL: &str = "postgresql://openlinear:openlinear@localhost:5432/openlinear";
```

### Sidecar output forwarding

stdout and stderr from the sidecar are forwarded to the webview as Tauri events:

```rust
CommandEvent::Stdout(line) => {
    app_handle.emit("sidecar:output", SidecarOutput { stream: "stdout", data })
}
CommandEvent::Stderr(line) => {
    app_handle.emit("sidecar:output", SidecarOutput { stream: "stderr", data })
}
CommandEvent::Terminated(payload) => {
    app_handle.emit("sidecar:exit", SidecarExit { code, signal })
}
```

### Tauri commands

| Command | Description |
|---------|-------------|
| `start_api_server(database_url)` | Start the sidecar with a given database URL |
| `stop_api_server()` | Kill the running sidecar process |

---

## Deep Linking: OAuth Callback

**File:** `apps/desktop/src-tauri/src/deeplink.rs`

GitHub OAuth uses the `openlinear://callback` URL scheme. When GitHub redirects after authorization, the OS opens the app with the callback URL.

### Registration

On Linux and Windows, the scheme is registered at runtime:

```rust
#[cfg(any(target_os = "linux", windows))]
app.deep_link().register_all()
```

On macOS, registration happens via the app bundle's `Info.plist` (generated from `tauri.conf.json`).

### Handling flow

1. `setup_deep_link_handler` is called during app setup.
2. It checks `get_current()` for URLs passed at launch (handles the case where the app was not running when the link was clicked).
3. It also scans command-line arguments for `openlinear://` URLs (fallback for some Linux environments).
4. It registers `on_open_url` for URLs received while the app is already running.

```rust
app.deep_link().on_open_url(move |event| {
    for url in event.urls() {
        handle_deep_link_url(&handle, &url);
    }
});
```

### OAuth callback processing

`process_oauth_callback` handles three cases:

| URL pattern | Action |
|-------------|--------|
| `openlinear://callback?token=...` | Token is already in the URL (direct token flow) |
| `openlinear://callback?github_connect_token=...` | GitHub connect token flow |
| `openlinear://callback?code=...&state=...` | Standard OAuth code exchange |

For the code exchange case, the Rust code calls the local Express API:

```
GET http://localhost:3001/api/auth/github/callback?code=...&state=...
```

The Express endpoint redirects to `FRONTEND_URL?token=JWT`. The Rust HTTP client is configured with `redirect::Policy::none()` so it can intercept the `Location` header and extract the token without following the redirect.

The result is emitted to the webview as a Tauri event:

```rust
handle_clone.emit("auth:callback", result)
```

`AuthCallbackResult` carries `{ success, token, github_connect_token, error }`.

### Single-instance handling

The `tauri_plugin_single_instance` plugin ensures only one app instance runs. If a second instance is launched (e.g., by clicking a deep link while the app is open), the plugin forwards the arguments to the running instance:

```rust
.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
    for arg in argv {
        deeplink::handle_deep_link_arg(app, &arg);
    }
    // bring window to front
    window.show();
    window.set_focus();
}))
```

---

## File System Access: Folder Picker

### Rust command

**File:** `apps/desktop/src-tauri/src/opencode.rs`

```rust
#[tauri::command]
pub fn pick_local_folder() -> Option<String> {
    let dialog = match default_home_dir() {
        Some(path) => rfd::FileDialog::new().set_directory(path),
        None => rfd::FileDialog::new(),
    };
    dialog.pick_folder().map(|path| path.to_string_lossy().to_string())
}
```

Uses the `rfd` (Rusty File Dialog) crate for a native OS folder picker. Defaults to the user's home directory (`$HOME` or `%USERPROFILE%`).

### TypeScript wrapper

**File:** `apps/desktop-ui/lib/pick-local-folder.ts`

The UI calls `pickLocalFolder()`, which tries two approaches in sequence:

1. `@tauri-apps/plugin-dialog` `open({ directory: true })` — the preferred Tauri 2 plugin API.
2. `invoke('pick_local_folder')` — falls back to the Rust command if the plugin fails.

```typescript
export async function pickLocalFolder(): Promise<string | null> {
  if (!isDesktopRuntime()) return null

  try {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selectedPath = await open({ directory: true, multiple: false })
    if (typeof selectedPath === "string") return selectedPath
  } catch (error) { /* fall through */ }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<string | null>("pick_local_folder")
  } catch (error) { /* fall through */ }

  return null
}
```

`isDesktopRuntime()` checks whether the code is running inside Tauri (vs. a browser). If not in Tauri, the function returns `null` immediately.

---

## Secure Storage

**File:** `apps/desktop/src-tauri/src/secure_storage.rs`

API keys and tokens are stored in the OS keychain using the `keyring` crate. The service name is `com.openlinear.app`.

### Allowed keys

```rust
pub mod keys {
    pub const GITHUB_TOKEN: &str = "github_token";
    pub const OPENAI_API_KEY: &str = "openai_api_key";
    pub const ANTHROPIC_API_KEY: &str = "anthropic_api_key";
    pub const CUSTOM_API_KEY: &str = "custom_api_key";
}
```

Any key not in this list is rejected with `"Invalid secret key provided"`.

### Tauri commands

| Command | Signature | Description |
|---------|-----------|-------------|
| `store_secret` | `(key, value) -> SecureStorageResult` | Write to keychain |
| `retrieve_secret` | `(key) -> Result<String>` | Read from keychain |
| `remove_secret` | `(key) -> SecureStorageResult` | Delete from keychain |
| `check_secret_exists` | `(key) -> bool` | Check if key exists |
| `get_all_secret_keys` | `() -> Result<Vec<String>>` | List stored keys |

---

## OpenCode CLI Detection

**File:** `apps/desktop/src-tauri/src/opencode.rs`

The `check_opencode` command checks whether the `opencode` CLI is installed and returns its version and path:

```rust
#[tauri::command]
pub fn check_opencode() -> OpenCodeStatus {
    match which("opencode") {
        Ok(path) => OpenCodeStatus {
            found: true,
            version: get_opencode_version(&path),
            path: Some(path.to_string_lossy().to_string()),
        },
        Err(_) => OpenCodeStatus::default(),
    }
}
```

`get_opencode_version` runs `opencode --version` and captures stdout (or stderr if stdout is empty).

The UI uses this in `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx` to show setup instructions if `opencode` is not found.

---

## Database Settings UI

**File:** `apps/desktop-ui/components/desktop/database-settings.tsx`

The `DatabaseSettings` component lets users configure the PostgreSQL connection URL. It only renders inside Tauri (returns `null` in a browser).

Settings are persisted via `tauri-plugin-store` to `settings.json` in the app data directory:

```typescript
const { load } = await import("@tauri-apps/plugin-store")
const store = await load("settings.json")
await store.set("database_url", databaseUrl)
await store.save()
```

The sidecar reads this file on startup (see `load_saved_database_url` in `sidecar.rs`).

---

## Registered Tauri Commands

All commands are registered in `lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    opencode::check_opencode,
    opencode::pick_local_folder,
    sidecar::start_api_server,
    sidecar::stop_api_server,
    secure_storage::store_secret,
    secure_storage::retrieve_secret,
    secure_storage::remove_secret,
    secure_storage::check_secret_exists,
    secure_storage::get_all_secret_keys,
])
```

---

## Registered Plugins

| Plugin | Purpose |
|--------|---------|
| `tauri_plugin_single_instance` | Prevent multiple app instances; forward deep links to running instance |
| `tauri_plugin_shell` | Shell `open` for external URLs |
| `tauri_plugin_dialog` | Native file/folder dialogs |
| `tauri_plugin_deep_link` | `openlinear://` URL scheme handling |
| `tauri_plugin_fs` | File system access from the webview |
| `tauri_plugin_store` | Persistent JSON key-value store (settings.json) |
| `tauri_plugin_os` | OS information |

---

## Build Pipeline

```
scripts/build-sidecar-cjs.sh   →  builds sidecar-entry.cjs
pnpm --filter @openlinear/desktop-ui build  →  Next.js static export to desktop-ui/out/
tauri build  →  bundles everything into .dmg / .app / .appimage / .deb
```

The sidecar binary (`openlinear-sidecar`) is placed in `src-tauri/binaries/` and listed under `bundle.externalBin` so Tauri includes it in the app bundle.
