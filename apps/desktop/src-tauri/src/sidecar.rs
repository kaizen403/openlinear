use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

static API_SERVER_PROCESS: Mutex<Option<CommandChild>> = Mutex::new(None);
static API_SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

const STORE_FILE: &str = "settings.json";
const STORE_KEY_DATABASE_URL: &str = "database_url";
const STORE_KEY_GITHUB_CLIENT_ID: &str = "github_client_id";
const STORE_KEY_FRONTEND_URL: &str = "frontend_url";
const STORE_KEY_REPOS_DIR: &str = "repos_dir";

const DEFAULT_DATABASE_URL: &str = "postgresql://openlinear:openlinear@localhost:5432/openlinear";
const DEFAULT_FRONTEND_URL: &str = "http://127.0.0.1:3000";

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

fn build_sidecar_env(app: &AppHandle, port: u16) -> Vec<(String, String)> {
    let database_url = read_store_string(app, STORE_KEY_DATABASE_URL)
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_DATABASE_URL.to_string());

    let frontend_url = read_store_string(app, STORE_KEY_FRONTEND_URL)
        .or_else(|| std::env::var("FRONTEND_URL").ok())
        .unwrap_or_else(|| DEFAULT_FRONTEND_URL.to_string());

    let github_client_id = read_store_string(app, STORE_KEY_GITHUB_CLIENT_ID)
        .or_else(|| std::env::var("GITHUB_CLIENT_ID").ok())
        .unwrap_or_default();

    let repos_dir = read_store_string(app, STORE_KEY_REPOS_DIR)
        .or_else(|| std::env::var("REPOS_DIR").ok())
        .unwrap_or_else(|| {
            let mut path = std::env::temp_dir();
            path.push("openlinear-repos");
            path.to_string_lossy().to_string()
        });

    let cors_origin = std::env::var("CORS_ORIGIN")
        .unwrap_or_else(|_| format!("{},tauri://localhost,https://tauri.localhost", frontend_url));

    let mut env = vec![
        ("API_PORT".to_string(), port.to_string()),
        ("DATABASE_URL".to_string(), database_url),
        ("FRONTEND_URL".to_string(), frontend_url),
        ("GITHUB_CLIENT_ID".to_string(), github_client_id),
        ("REPOS_DIR".to_string(), repos_dir),
        ("CORS_ORIGIN".to_string(), cors_origin),
        ("OPENLINEAR_TRUST_PROXY_AUTH".to_string(), "1".to_string()),
        ("OPENLINEAR_SKIP_DOTENV".to_string(), "1".to_string()),
    ];

    for key in [
        "GITHUB_CLIENT_SECRET",
        "GITHUB_REDIRECT_URI",
        "GITHUB_TOKEN",
        "JWT_SECRET",
        "BRAINSTORM_API_KEY",
        "BRAINSTORM_MODEL",
        "BRAINSTORM_PROVIDER",
        "BRAINSTORM_BASE_URL",
        "OAUTH_INTERCEPTOR_PORT",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.push((key.to_string(), value));
        }
    }

    env
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

    let port = pick_free_port()?;
    let env = build_sidecar_env(&app, port);

    let mut sidecar_command = app
        .shell()
        .sidecar("openlinear-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?;

    for (key, value) in env {
        sidecar_command = sidecar_command.env(key, value);
    }

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn API server: {}", e))?;

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
pub async fn stop_api_server() -> Result<(), String> {
    shutdown_sidecar();
    Ok(())
}

#[tauri::command]
pub async fn get_api_server_port() -> Result<Option<u16>, String> {
    let guard = API_SERVER_PORT.lock().map_err(|e| e.to_string())?;
    Ok(*guard)
}

pub fn shutdown_sidecar() {
    let child_opt = match API_SERVER_PROCESS.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };

    if let Some(child) = child_opt {
        let _ = child.kill();
    }

    if let Ok(mut guard) = API_SERVER_PORT.lock() {
        *guard = None;
    }

    std::thread::sleep(Duration::from_millis(100));
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
}
