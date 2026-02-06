//! Deep link OAuth handler for GitHub authentication
//!
//! Handles `openlinear://callback?code=...` deep links from GitHub OAuth flow.
//! On receiving a callback, extracts the auth code and forwards it to the Express
//! API to exchange for a token, then emits the result to the frontend.

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const API_BASE_URL: &str = "http://localhost:3001";

/// Payload emitted to frontend after OAuth callback processing
#[derive(Clone, Serialize)]
pub struct AuthCallbackResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Set up the deep link handler on app startup.
/// Registers a listener for `openlinear://` URL scheme.
pub fn setup_deep_link_handler(app: &tauri::App) {
    let handle = app.handle().clone();

    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let url_str = url.as_str();
            println!("[DeepLink] Received: {}", url_str);

            // Only handle callback URLs
            if url_str.starts_with("openlinear://callback") {
                let handle_clone = handle.clone();
                let url_owned = url_str.to_string();

                // Spawn async task to process the OAuth callback
                tauri::async_runtime::spawn(async move {
                    let result = process_oauth_callback(&url_owned).await;
                    let _ = handle_clone.emit("auth:callback", result);
                });
            }
        }
    });
}

/// Parse the OAuth callback URL and exchange the code for a token
async fn process_oauth_callback(url_str: &str) -> AuthCallbackResult {
    // Parse the deep link URL to extract the code parameter
    let code = match extract_code_from_url(url_str) {
        Ok(code) => code,
        Err(e) => {
            return AuthCallbackResult {
                success: false,
                token: None,
                error: Some(e),
            };
        }
    };

    // Call the Express API to exchange code for token
    match exchange_code_for_token(&code).await {
        Ok(token) => AuthCallbackResult {
            success: true,
            token: Some(token),
            error: None,
        },
        Err(e) => AuthCallbackResult {
            success: false,
            token: None,
            error: Some(e),
        },
    }
}

/// Extract the OAuth code from the callback URL
fn extract_code_from_url(url_str: &str) -> Result<String, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Failed to parse URL: {}", e))?;

    // Check for error parameter first
    for (key, value) in url.query_pairs() {
        if key == "error" {
            let error_desc = url
                .query_pairs()
                .find(|(k, _)| k == "error_description")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| value.to_string());
            return Err(error_desc);
        }
    }

    // Extract the code parameter
    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| "Missing 'code' parameter in callback URL".to_string())
}

/// Call the Express API to exchange the OAuth code for a JWT token.
/// The Express endpoint redirects with the token in the URL, so we intercept
/// the redirect and extract the token from the Location header.
async fn exchange_code_for_token(code: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let callback_url = format!("{}/api/auth/github/callback?code={}", API_BASE_URL, code);

    let response = client
        .get(&callback_url)
        .send()
        .await
        .map_err(|e| format!("Failed to call auth API: {}", e))?;

    // The Express endpoint redirects to FRONTEND_URL?token=XXX or ?error=XXX
    // We need to parse the Location header to extract the token
    let status = response.status();

    if status.is_redirection() {
        if let Some(location) = response.headers().get("location") {
            let location_str = location
                .to_str()
                .map_err(|_| "Invalid Location header")?;

            return extract_token_from_redirect(location_str);
        }
        return Err("Redirect response missing Location header".to_string());
    }

    // If not a redirect, the call likely failed
    Err(format!("Unexpected response status: {}", status))
}

/// Extract the token (or error) from the redirect URL
fn extract_token_from_redirect(location: &str) -> Result<String, String> {
    let url = Url::parse(location).map_err(|e| format!("Failed to parse redirect URL: {}", e))?;

    // Check for error first
    for (key, value) in url.query_pairs() {
        if key == "error" {
            return Err(value.to_string());
        }
    }

    // Extract the token
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| "Token not found in redirect URL".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_code_from_url_success() {
        let url = "openlinear://callback?code=abc123&state=xyz";
        let code = extract_code_from_url(url).unwrap();
        assert_eq!(code, "abc123");
    }

    #[test]
    fn test_extract_code_from_url_missing_code() {
        let url = "openlinear://callback?state=xyz";
        let result = extract_code_from_url(url);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing 'code' parameter"));
    }

    #[test]
    fn test_extract_code_from_url_with_error() {
        let url = "openlinear://callback?error=access_denied&error_description=User+denied+access";
        let result = extract_code_from_url(url);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("User denied access"));
    }

    #[test]
    fn test_extract_token_from_redirect_success() {
        let location = "http://localhost:3000?token=jwt.token.here";
        let token = extract_token_from_redirect(location).unwrap();
        assert_eq!(token, "jwt.token.here");
    }

    #[test]
    fn test_extract_token_from_redirect_with_error() {
        let location = "http://localhost:3000?error=auth_failed";
        let result = extract_token_from_redirect(location);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("auth_failed"));
    }
}
