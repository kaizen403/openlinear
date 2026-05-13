// Stub sidecar module.
//
// The hosted sidecar (apps/sidecar/) was removed when this repo pivoted to
// the local-first release direction. This module preserves the Tauri command
// surface so existing JS callsites (start_api_server, stop_api_server,
// get_api_server_port) keep compiling, but every operation is a no-op until
// a local-first replacement is wired in.

#[tauri::command]
pub async fn start_api_server(_app: tauri::AppHandle) -> Result<u16, String> {
    Err("sidecar removed in local-first pivot; api server not available".to_string())
}

#[tauri::command]
pub async fn stop_api_server() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn get_api_server_port() -> Result<Option<u16>, String> {
    Ok(None)
}

pub fn shutdown_sidecar() {}
