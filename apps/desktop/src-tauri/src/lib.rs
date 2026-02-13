mod deeplink;
mod opencode;
mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            deeplink::setup_deep_link_handler(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            opencode::check_opencode,
            sidecar::start_api_server,
            sidecar::stop_api_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
