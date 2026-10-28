use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

static API_SERVER_PROCESS: Mutex<Option<CommandChild>> = Mutex::new(None);
static API_SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

const STORE_FILE: &str = "settings.json";
const STORE_KEY_CLOUD_API_URL: &str = "cloud_api_url";
const STORE_KEY_FRONTEND_URL: &str = "frontend_url";
const STORE_KEY_REPOS_DIR: &str = "repos_dir";
/// Settings-store key: JSON array of environment variable names the user has
/// chosen to forward to the sidecar (e.g. `["ANTHROPIC_API_KEY"]`). Only
/// names in `OPT_IN_ENV` are honoured; nothing secret is forwarded by default.
const STORE_KEY_SIDECAR_ENV_PASSTHROUGH: &str = "sidecar_env_passthrough";

/// W03a: the sidecar authenticates callers and persists through the cloud
/// API. Same default as the desktop UI's cloud URL (`CLOUD_DEFAULT`).
const DEFAULT_CLOUD_API_URL: &str = "https://openlinear.tech";
const DEFAULT_FRONTEND_URL: &str = "http://127.0.0.1:3000";

/// Cloud-only credentials the sidecar must never receive (W03a): no
/// database URL, no JWT signing secret, no token-encryption key, no OAuth
/// client secret, no ambient GitHub token. They are explicitly removed from
/// the inherited environment of the spawned sidecar as well.
const SIDECAR_FORBIDDEN_ENV: &[&str] = &[
    "DATABASE_URL",
    "JWT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_TOKEN",
    "BRAINSTORM_API_KEY",
    "OPENLINEAR_WITH_CLOUD_API",
];
const PIDFILE_NAME: &str = "sidecar.pid";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
pub struct SidecarOutput {
    pub stream: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct SidecarExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct SidecarReady {
    pub port: u16,
    pub api_url: String,
    pub health_url: String,
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral port: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read bound port: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

fn read_store_string(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    let value = store.get(key)?;
    value.as_str().map(|s| s.to_string())
}

/// Environment variables the sidecar may inherit from the desktop process
/// (W03a): process basics, locale, proxies and CA bundles needed to reach the
/// cloud API, and the OpenCode/git identity knobs. Everything else — notably
/// any database URL, signing/encryption secret, model-provider key or
/// SSH_AUTH_SOCK in the user's shell — is dropped by `env_clear()` before the
/// sidecar starts (see `OPT_IN_ENV` for the explicit opt-in path).
const INHERITED_ENV_EXACT: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR",
    "TMP", "TEMP", "SystemRoot", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "LOG_LEVEL",
];
const INHERITED_ENV_PREFIXES: &[&str] = &["LC_", "XDG_", "OPENCODE_", "OPENLINEAR_GIT_"];

/// Name fragments that mark a variable as a credential. A prefix match never
/// carries one of these (e.g. `OPENCODE_SERVER_PASSWORD`,
/// `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG_CONTENT` with an inline key).
const SECRET_NAME_MARKERS: &[&str] = &[
    "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "PRIVATE", "API_KEY",
    "APIKEY", "ACCESS_KEY", "SESSION", "COOKIE", "DATABASE", "DSN", "AUTH", "CONFIG_CONTENT",
];

/// Secrets the user may forward explicitly through the settings store
/// (`sidecar_env_passthrough`). Never forwarded by default.
const OPT_IN_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "FIREWORKS_API_KEY",
    "CARTESIA_API_KEY",
    "SSH_AUTH_SOCK",
];

fn looks_secret(name: &str) -> bool {
    // "AUTHOR" (OPENLINEAR_GIT_AUTHOR_NAME/EMAIL) is identity, not a credential.
    let upper = name.to_ascii_uppercase().replace("AUTHOR", "");
    SECRET_NAME_MARKERS.iter().any(|marker| upper.contains(*marker))
}

fn is_inheritable(key: &str) -> bool {
    if SIDECAR_FORBIDDEN_ENV.iter().any(|forbidden| *forbidden == key) {
        return false;
    }
    if INHERITED_ENV_EXACT.iter().any(|name| *name == key) {
        return true;
    }
    INHERITED_ENV_PREFIXES.iter().any(|prefix| key.starts_with(*prefix)) && !looks_secret(key)
}

fn inherited_env() -> Vec<(String, String)> {
    // vars_os: a non-UTF-8 variable is skipped instead of panicking the launcher.
    std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(key, _)| is_inheritable(key))
        .collect()
}

/// The opt-in secrets the user listed in the settings store, if they are set
/// in the desktop process environment.
fn opted_in_env(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    let Some(value) = store.get(STORE_KEY_SIDECAR_ENV_PASSTHROUGH) else {
        return Vec::new();
    };
    let Some(names) = value.as_array() else {
        return Vec::new();
    };
    let forwarded: Vec<(String, String)> = names
        .iter()
        .filter_map(|name| name.as_str())
        .filter(|name| OPT_IN_ENV.iter().any(|allowed| allowed == name))
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.to_string(), value)))
        .collect();
    forwarded
}

/// The cloud API the sidecar authenticates and persists through: settings
/// store, then `OPENLINEAR_API_URL`, then the build-time value, then the
/// desktop UI's default cloud URL.
fn cloud_api_url(app: &AppHandle) -> String {
    read_store_string(app, STORE_KEY_CLOUD_API_URL)
        .or_else(|| std::env::var("OPENLINEAR_API_URL").ok())
        .or_else(|| option_env!("OPENLINEAR_API_URL").map(|s| s.to_string()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLOUD_API_URL.to_string())
}

fn build_sidecar_env(app: &AppHandle, port: u16) -> Result<Vec<(String, String)>, String> {
    let frontend_url = read_store_string(app, STORE_KEY_FRONTEND_URL)
        .or_else(|| std::env::var("FRONTEND_URL").ok())
        .unwrap_or_else(|| DEFAULT_FRONTEND_URL.to_string());

    // No default here on purpose: the sidecar's own repo-storage.ts now
    // picks a safe per-user app-data default (mode 0700, symlink/ownership
    // checked) when REPOS_DIR is unset. Forcing a `/tmp`-based path from the
    // launcher would silently override that hardening (C6a F9).
    let repos_dir =
        read_store_string(app, STORE_KEY_REPOS_DIR).or_else(|| std::env::var("REPOS_DIR").ok());

    let cors_origin = std::env::var("CORS_ORIGIN")
        .unwrap_or_else(|_| format!("{},tauri://localhost,https://tauri.localhost", frontend_url));

    // W03a: no DATABASE_URL, no JWT_SECRET, no TOKEN_ENCRYPTION_KEY. The
    // sidecar validates the desktop's bearer token and persists through the
    // cloud API named here; it never holds a database or signing credential.
    let mut env = inherited_env();
    env.extend(vec![
        ("API_PORT".to_string(), port.to_string()),
        ("OPENLINEAR_API_URL".to_string(), cloud_api_url(app)),
        ("FRONTEND_URL".to_string(), frontend_url),
        ("CORS_ORIGIN".to_string(), cors_origin),
        ("OPENLINEAR_SKIP_DOTENV".to_string(), "1".to_string()),
    ]);

    if let Some(repos_dir) = repos_dir {
        env.push(("REPOS_DIR".to_string(), repos_dir));
    }

    // Packaged (release) builds run the sidecar as production; `tauri dev`
    // keeps it in the default (development) mode.
    if !cfg!(debug_assertions) {
        env.push(("NODE_ENV".to_string(), "production".to_string()));
    }

    // NOTE: OPENLINEAR_TRUST_PROXY_AUTH is deliberately NOT set here — the
    // sidecar hard-rejects it at startup. See C6a F2 / C2 C-09.

    if let Ok(value) = std::env::var("OAUTH_INTERCEPTOR_PORT") {
        env.push(("OAUTH_INTERCEPTOR_PORT".to_string(), value));
    }

    // The sidecar looks for `opencode-<triple>` next to its own executable,
    // but bundles install externalBin without the suffix, so point it at the
    // shipped binary unless the user already chose one via OPENCODE_BIN.
    if !env.iter().any(|(key, _)| key == "OPENCODE_BIN") {
        if let Some(bin) = crate::opencode::bundled_opencode_path() {
            env.push(("OPENCODE_BIN".to_string(), bin.to_string_lossy().into_owned()));
        }
    }

    // Explicit, user-chosen secrets only (model-provider keys, CARTESIA_API_KEY,
    // SSH_AUTH_SOCK): see OPT_IN_ENV and docs/reports/revamp-2026-10-26/release.md.
    env.extend(opted_in_env(app));

    Ok(env)
}

// ---------------------------------------------------------------------------
// Process lifecycle: stale-PID sweep on boot, graceful SIGTERM -> wait ->
// SIGKILL shutdown, best-effort process-group signalling so OpenCode and any
// in-flight git subprocess die with the sidecar instead of being orphaned.
// See C6a F18.
// ---------------------------------------------------------------------------

fn pidfile_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(PIDFILE_NAME))
}

fn write_pidfile(app: &AppHandle, pid: u32) {
    if let Some(path) = pidfile_path(app) {
        let _ = std::fs::write(path, pid.to_string());
    }
}

fn remove_pidfile(app: &AppHandle) {
    if let Some(path) = pidfile_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // Signal 0 delivers nothing — it's the portable way to probe whether a
    // PID exists (and that we have permission to signal it) without
    // disturbing it.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn process_is_alive(_pid: u32) -> bool {
    // No portable liveness probe wired up for non-Unix targets; treat as
    // "can't confirm it's alive" so the stale-pidfile sweep degrades to
    // "just remove the file" instead of looping forever.
    false
}

#[cfg(unix)]
fn set_own_process_group(pid: u32) {
    // Best-effort: make the sidecar the leader of its own process group so
    // whatever it spawns (OpenCode, git) lands in a group distinct from the
    // Tauri app's own — letting us signal that whole group on shutdown
    // without ever touching the app process itself. Calling this from the
    // parent right after spawn (in addition to whatever the child does on
    // its own) avoids the classic fork/exec race described in setpgid(2).
    unsafe {
        let _ = libc::setpgid(pid as libc::pid_t, pid as libc::pid_t);
    }
}

#[cfg(not(unix))]
fn set_own_process_group(_pid: u32) {}

#[cfg(unix)]
fn terminate_process_group(pid: u32, hard: bool) {
    let sig = if hard { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        // Negative pid targets the whole process group; this silently no-ops
        // (ESRCH/EPERM) if the group is already gone or if
        // set_own_process_group() didn't take effect for some reason — the
        // direct single-pid signal below still covers the sidecar process
        // itself in that case.
        libc::kill(-(pid as libc::pid_t), sig);
        libc::kill(pid as libc::pid_t, sig);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: u32, _hard: bool) {}

fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_is_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !process_is_alive(pid)
}

/// Cleans up after a previous run that didn't shut down cleanly (e.g. the
/// app was force-quit before `shutdown_sidecar` could run, or the process
/// crashed). If the recorded PID is still alive, ask it — and its process
/// group — to exit before a fresh sidecar is spawned on top of it; either
/// way the stale pidfile is removed.
fn sweep_stale_pidfile(app: &AppHandle) {
    let Some(path) = pidfile_path(app) else {
        return;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };

    if let Ok(pid) = contents.trim().parse::<u32>() {
        if process_is_alive(pid) {
            terminate_process_group(pid, false);
            if !wait_for_exit(pid, SHUTDOWN_GRACE) {
                terminate_process_group(pid, true);
            }
        }
    }

    let _ = std::fs::remove_file(&path);
}

pub async fn launch_sidecar(app: AppHandle) -> Result<(), String> {
    if std::env::var("OPENLINEAR_SKIP_SIDECAR").ok().as_deref() == Some("1") {
        let port: u16 = std::env::var("API_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3001);
        {
            let mut guard = API_SERVER_PORT.lock().map_err(|e| e.to_string())?;
            *guard = Some(port);
        }
        let api_url = format!("http://127.0.0.1:{}", port);
        let health_url = format!("{}/health", api_url);
        let _ = app.emit(
            "sidecar:ready",
            SidecarReady {
                port,
                api_url,
                health_url,
            },
        );
        return Ok(());
    }

    {
        let guard = API_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
    }

    sweep_stale_pidfile(&app);

    let port = pick_free_port()?;
    let env = build_sidecar_env(&app, port)?;

    // W03a: start from an empty environment so no ambient DATABASE_URL or
    // signing/encryption secret reaches the sidecar; `env` carries the
    // allowlisted inherited variables plus the sidecar's own configuration.
    let mut sidecar_command = app
        .shell()
        .sidecar("openlinear-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .env_clear();

    for (key, value) in env {
        sidecar_command = sidecar_command.env(key, value);
    }

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn API server: {}", e))?;

    let child_pid = child.pid();
    set_own_process_group(child_pid);
    write_pidfile(&app, child_pid);

    {
        let mut guard = API_SERVER_PROCESS.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }
    {
        let mut guard = API_SERVER_PORT.lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
    }

    let app_handle = app.clone();
    let api_url = format!("http://127.0.0.1:{}", port);
    let health_url = format!("{}/health", api_url);

    tauri::async_runtime::spawn(async move {
        let _ = app_handle.emit(
            "sidecar:ready",
            SidecarReady {
                port,
                api_url: api_url.clone(),
                health_url: health_url.clone(),
            },
        );

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let data = String::from_utf8_lossy(&line).to_string();
                    let _ = app_handle.emit(
                        "sidecar:output",
                        SidecarOutput {
                            stream: "stdout".to_string(),
                            data,
                        },
                    );
                }
                CommandEvent::Stderr(line) => {
                    let data = String::from_utf8_lossy(&line).to_string();
                    let _ = app_handle.emit(
                        "sidecar:output",
                        SidecarOutput {
                            stream: "stderr".to_string(),
                            data,
                        },
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_handle.emit(
                        "sidecar:exit",
                        SidecarExit {
                            code: payload.code,
                            signal: payload.signal,
                        },
                    );
                    if let Ok(mut guard) = API_SERVER_PROCESS.lock() {
                        *guard = None;
                    }
                    if let Ok(mut guard) = API_SERVER_PORT.lock() {
                        *guard = None;
                    }
                    remove_pidfile(&app_handle);
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app_handle.emit(
                        "sidecar:output",
                        SidecarOutput {
                            stream: "stderr".to_string(),
                            data: format!("Error: {}", err),
                        },
                    );
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn start_api_server(app: tauri::AppHandle) -> Result<u16, String> {
    launch_sidecar(app.clone()).await?;
    let guard = API_SERVER_PORT.lock().map_err(|e| e.to_string())?;
    guard.ok_or_else(|| "Sidecar started but port unavailable".to_string())
}

#[tauri::command]
pub async fn stop_api_server(app: tauri::AppHandle) -> Result<(), String> {
    shutdown_sidecar(&app);
    Ok(())
}

#[tauri::command]
pub async fn get_api_server_port() -> Result<Option<u16>, String> {
    let guard = API_SERVER_PORT.lock().map_err(|e| e.to_string())?;
    Ok(*guard)
}

/// Graceful shutdown: SIGTERM the sidecar (and, best-effort, its process
/// group — OpenCode, in-flight git) first, giving the Node process up to
/// `SHUTDOWN_GRACE` to run its own handlers (closing the HTTP server,
/// disconnecting Prisma, cleaning up temp credential files) before
/// escalating to SIGKILL. Idempotent — safe to call more than once (e.g.
/// from both `ExitRequested` and a final `Exit` catch-all) and safe to call
/// after the child has already exited on its own.
pub fn shutdown_sidecar(app: &AppHandle) {
    let child_opt = match API_SERVER_PROCESS.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };

    if let Ok(mut guard) = API_SERVER_PORT.lock() {
        *guard = None;
    }

    let Some(child) = child_opt else {
        remove_pidfile(app);
        return;
    };

    let pid = child.pid();

    terminate_process_group(pid, false);
    if !wait_for_exit(pid, SHUTDOWN_GRACE) {
        terminate_process_group(pid, true);
    }

    // Always follow up with the plugin's own kill path too: on non-Unix
    // targets terminate_process_group()/wait_for_exit() above are no-ops
    // (process_is_alive() always reports false there), and even on Unix this
    // is a safe no-op once the process has already exited — see
    // `SharedChild::kill`'s doc comment in the tauri-plugin-shell/
    // shared_child crates.
    let _ = child.kill();

    remove_pidfile(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pick_free_port_returns_nonzero() {
        let port = pick_free_port().expect("should bind ephemeral port");
        assert!(port > 0);
    }

    #[test]
    fn test_sidecar_output_serialization() {
        let output = SidecarOutput {
            stream: "stdout".to_string(),
            data: "Server started".to_string(),
        };
        let json = serde_json::to_string(&output).expect("Should serialize");
        assert!(json.contains("\"stream\":\"stdout\""));
    }

    #[test]
    fn test_sidecar_ready_serialization() {
        let ready = SidecarReady {
            port: 12345,
            api_url: "http://127.0.0.1:12345".to_string(),
            health_url: "http://127.0.0.1:12345/health".to_string(),
        };
        let json = serde_json::to_string(&ready).expect("Should serialize");
        assert!(json.contains("\"port\":12345"));
        assert!(json.contains("\"api_url\":\"http://127.0.0.1:12345\""));
    }

    #[test]
    fn test_sidecar_exit_serialization() {
        let exit = SidecarExit {
            code: Some(0),
            signal: None,
        };
        let json = serde_json::to_string(&exit).expect("Should serialize");
        assert!(json.contains("\"code\":0"));
        assert!(json.contains("\"signal\":null"));
    }

    #[test]
    fn test_sidecar_never_inherits_cloud_only_credentials() {
        // W03a: the forbidden list wins over every allowlist entry/prefix.
        for key in SIDECAR_FORBIDDEN_ENV.iter() {
            assert!(!is_inheritable(key), "{} must not be inheritable", key);
            assert!(!OPT_IN_ENV.iter().any(|name| name == key), "{} must not be opt-in", key);
        }
        for key in ["DATABASE_URL", "JWT_SECRET", "TOKEN_ENCRYPTION_KEY"] {
            assert!(SIDECAR_FORBIDDEN_ENV.iter().any(|name| *name == key));
        }
    }

    #[test]
    fn test_inherited_env_allowlist_carries_no_secrets_by_default() {
        for key in ["PATH", "HOME", "HTTPS_PROXY", "LC_ALL", "XDG_DATA_HOME", "OPENCODE_BIN"] {
            assert!(is_inheritable(key), "{} should be inherited", key);
        }
        // Git identity is not a credential, despite containing "AUTH".
        assert!(is_inheritable("OPENLINEAR_GIT_AUTHOR_NAME"));
        assert!(is_inheritable("OPENLINEAR_GIT_COMMITTER_EMAIL"));
        // Prefix matches never smuggle credentials.
        for key in [
            "OPENCODE_SERVER_PASSWORD",
            "OPENCODE_AUTH_CONTENT",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_API_KEY",
            "XDG_SESSION_COOKIE",
            "OPENLINEAR_GIT_TOKEN",
        ] {
            assert!(!is_inheritable(key), "{} must not be inherited", key);
        }
        // Opt-in secrets are never inherited implicitly.
        for key in OPT_IN_ENV.iter() {
            assert!(!is_inheritable(key), "{} must be opt-in only", key);
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_process_is_alive_reports_the_current_process_and_a_nonexistent_pid() {
        let self_pid = std::process::id();
        assert!(process_is_alive(self_pid));

        // A positive pid essentially guaranteed not to correspond to a real
        // process on any test machine. (Deliberately not pid 0 — per
        // `kill(2)`, pid 0 targets the caller's own process group rather
        // than meaning "no such process", so it would report `true`.)
        assert!(!process_is_alive(999_999));
    }

    #[test]
    fn test_wait_for_exit_returns_true_once_the_process_is_gone() {
        // A pid essentially guaranteed not to be alive (or checkable) at
        // test time — wait_for_exit should return promptly rather than
        // block for the full timeout.
        let started = Instant::now();
        assert!(wait_for_exit(999_999, Duration::from_millis(50)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
