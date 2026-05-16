use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[derive(Clone, Serialize)]
pub struct AuthCallbackResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
pub struct PendingAuthCallback(Mutex<Option<AuthCallbackResult>>);

#[tauri::command]
pub fn consume_pending_auth_callback(
    state: tauri::State<'_, PendingAuthCallback>,
) -> Option<AuthCallbackResult> {
    match state.0.lock() {
        Ok(mut pending) => pending.take(),
        Err(_) => None,
    }
}

pub fn setup_deep_link_handler(app: &tauri::App) {
    app.manage(PendingAuthCallback::default());

    let handle = app.handle().clone();

    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_callback_url(&handle, url.as_str());
        }
    });

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let handle = app.handle().clone();
        for url in urls {
            handle_callback_url(&handle, url.as_str());
        }
    }
}

fn handle_callback_url(handle: &AppHandle, url_str: &str) {
    println!("[DeepLink] Received: {}", url_str);

    if !is_auth_callback_url(url_str) {
        return;
    }

    let result = parse_callback(url_str);
    if let Some(state) = handle.try_state::<PendingAuthCallback>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.replace(result.clone());
        }
    }

    focus_main_window(handle);
    let _ = handle.emit("auth:callback", result);
}

fn focus_main_window(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn is_auth_callback_url(url_str: &str) -> bool {
    match Url::parse(url_str) {
        Ok(url) => {
            url.scheme() == "openlinear"
                && url.host_str() == Some("callback")
                && matches!(url.path(), "" | "/")
        }
        Err(_) => false,
    }
}

fn parse_callback(url_str: &str) -> AuthCallbackResult {
    let url = match Url::parse(url_str) {
        Ok(u) => u,
        Err(e) => {
            return AuthCallbackResult {
                success: false,
                token: None,
                error: Some(format!("Failed to parse callback URL: {}", e)),
            };
        }
    };

    for (key, value) in url.query_pairs() {
        if key == "error" {
            return AuthCallbackResult {
                success: false,
                token: None,
                error: Some(value.to_string()),
            };
        }
    }

    match url.query_pairs().find(|(k, _)| k == "token") {
        Some((_, token)) => AuthCallbackResult {
            success: true,
            token: Some(token.to_string()),
            error: None,
        },
        None => AuthCallbackResult {
            success: false,
            token: None,
            error: Some("Missing 'token' parameter in callback URL".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_callback_with_token() {
        let result = parse_callback("openlinear://callback?token=abc.def.ghi");
        assert!(result.success);
        assert_eq!(result.token.as_deref(), Some("abc.def.ghi"));
        assert!(result.error.is_none());
    }

    #[test]
    fn test_parse_callback_with_error() {
        let result = parse_callback("openlinear://callback?error=access_denied");
        assert!(!result.success);
        assert!(result.token.is_none());
        assert_eq!(result.error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn test_parse_callback_missing_token() {
        let result = parse_callback("openlinear://callback");
        assert!(!result.success);
        assert!(result.token.is_none());
        assert!(result.error.as_deref().unwrap().contains("Missing 'token'"));
    }

    #[test]
    fn test_parse_callback_url_encoded_token() {
        let result = parse_callback("openlinear://callback?token=eyJhbGc%3D");
        assert!(result.success);
        assert_eq!(result.token.as_deref(), Some("eyJhbGc="));
    }

    #[test]
    fn test_parse_callback_invalid_url() {
        let result = parse_callback("not a url");
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_is_auth_callback_url_only_matches_callback_host() {
        assert!(is_auth_callback_url("openlinear://callback?token=abc"));
        assert!(is_auth_callback_url("openlinear://callback/?token=abc"));
        assert!(!is_auth_callback_url(
            "openlinear://callback-extra?token=abc"
        ));
        assert!(!is_auth_callback_url(
            "https://openlinear.tech/callback?token=abc"
        ));
    }
}
