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
            opencode::pick_local_folder,
            sidecar::start_api_server,
            sidecar::stop_api_server,
            sidecar::get_api_server_port,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                sidecar::shutdown_sidecar();
            }
        });
}
