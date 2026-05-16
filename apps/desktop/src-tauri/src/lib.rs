mod deeplink;
mod opencode;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            deeplink::setup_deep_link_handler(app);

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = sidecar::launch_sidecar(app_handle).await {
                    eprintln!("[Setup] Failed to auto-start sidecar: {}", err);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            opencode::check_opencode,
            opencode::pick_local_folder,
            deeplink::consume_pending_auth_callback,
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
