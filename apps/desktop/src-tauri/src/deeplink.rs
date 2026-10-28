use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

/// Upper bound for the `code` / `state` / `error` values we forward to the
/// webview. Real values are 43–128 characters; anything longer is not ours.
const MAX_PARAM_LEN: usize = 512;

/// What the webview receives for an `openlinear://callback` deep link.
///
/// Sign-in hands the app a one-time `code` and echoes the `state` the app
/// generated; the webview redeems the code with its PKCE verifier at the
/// cloud API. Tokens never travel in the deep link, and the link is never
/// logged.
#[derive(Clone, Serialize)]
pub struct AuthCallbackResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
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

    #[cfg(target_os = "linux")]
    if let Err(err) = app.deep_link().register_all() {
        eprintln!("[DeepLink] Failed to register protocol handler: {}", err);
    }

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
    // Never print the URL: its query carries the one-time sign-in code.
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

fn failure(error: String, state: Option<String>) -> AuthCallbackResult {
    AuthCallbackResult {
        success: false,
        code: None,
        state,
        error: Some(error),
    }
}

fn bounded(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > MAX_PARAM_LEN {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_callback(url_str: &str) -> AuthCallbackResult {
    let url = match Url::parse(url_str) {
        Ok(u) => u,
        Err(_) => {
            return failure("Failed to parse callback URL".to_string(), None);
        }
    };

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = bounded(&value),
            "state" if state.is_none() => state = bounded(&value),
            "error" if error.is_none() => error = bounded(&value),
            _ => {}
        }
    }

    if let Some(error) = error {
        return failure(error, state);
    }

    match (code, state) {
        (Some(code), Some(state)) => AuthCallbackResult {
            success: true,
            code: Some(code),
            state: Some(state),
            error: None,
        },
        (_, state) => failure(
            "Missing 'code' or 'state' parameter in callback URL".to_string(),
            state,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_callback_with_code_and_state() {
        let result = parse_callback("openlinear://callback?code=abc_DEF-123&state=xyz_456");
        assert!(result.success);
        assert_eq!(result.code.as_deref(), Some("abc_DEF-123"));
        assert_eq!(result.state.as_deref(), Some("xyz_456"));
        assert!(result.error.is_none());
    }

    #[test]
    fn test_parse_callback_never_forwards_a_token() {
        let result = parse_callback("openlinear://callback?token=abc.def.ghi&refreshToken=r");
        assert!(!result.success);
        assert!(result.code.is_none());
        let json = serde_json::to_string(&result).expect("Should serialize");
        assert!(!json.contains("abc.def.ghi"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn test_parse_callback_with_error_keeps_state() {
        let result = parse_callback("openlinear://callback?error=access_denied&state=xyz");
        assert!(!result.success);
        assert!(result.code.is_none());
        assert_eq!(result.error.as_deref(), Some("access_denied"));
        assert_eq!(result.state.as_deref(), Some("xyz"));
    }

    #[test]
    fn test_parse_callback_requires_code_and_state() {
        let missing_state = parse_callback("openlinear://callback?code=abc");
        assert!(!missing_state.success);
        assert!(missing_state.code.is_none());

        let missing_both = parse_callback("openlinear://callback");
        assert!(!missing_both.success);
        assert!(missing_both.error.as_deref().unwrap().contains("Missing 'code'"));
    }

    #[test]
    fn test_parse_callback_url_decodes_values() {
        let result = parse_callback("openlinear://callback?code=a%2Db&state=s%5Ft");
        assert!(result.success);
        assert_eq!(result.code.as_deref(), Some("a-b"));
        assert_eq!(result.state.as_deref(), Some("s_t"));
    }

    #[test]
    fn test_parse_callback_rejects_oversized_values() {
        let long = "a".repeat(MAX_PARAM_LEN + 1);
        let result = parse_callback(&format!("openlinear://callback?code={}&state=xyz", long));
        assert!(!result.success);
        assert!(result.code.is_none());
    }

    #[test]
    fn test_parse_callback_invalid_url() {
        let result = parse_callback("not a url");
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_is_auth_callback_url_only_matches_callback_host() {
        assert!(is_auth_callback_url("openlinear://callback?code=abc&state=x"));
        assert!(is_auth_callback_url("openlinear://callback/?code=abc&state=x"));
        assert!(!is_auth_callback_url(
            "openlinear://callback-extra?code=abc&state=x"
        ));
        assert!(!is_auth_callback_url(
            "https://openlinear.tech/callback?code=abc&state=x"
        ));
    }
}
