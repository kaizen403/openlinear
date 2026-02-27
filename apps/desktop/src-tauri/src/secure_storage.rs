use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "com.openlinear.app";

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct StoredSecret {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct SecureStorageResult {
    pub success: bool,
    pub error: Option<String>,
}

pub fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_secret(key: String) -> Result<String, String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

pub fn delete_secret(key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn has_secret(key: String) -> bool {
    let entry = match Entry::new(SERVICE_NAME, &key) {
        Ok(e) => e,
        Err(_) => return false,
    };
    entry.get_password().is_ok()
}

pub fn list_secrets() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[tauri::command]
pub fn store_secret(key: String, value: String) -> SecureStorageResult {
    match set_secret(key, value) {
        Ok(_) => SecureStorageResult {
            success: true,
            error: None,
        },
        Err(e) => SecureStorageResult {
            success: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn retrieve_secret(key: String) -> Result<String, String> {
    get_secret(key)
}

#[tauri::command]
pub fn remove_secret(key: String) -> SecureStorageResult {
    match delete_secret(key) {
        Ok(_) => SecureStorageResult {
            success: true,
            error: None,
        },
        Err(e) => SecureStorageResult {
            success: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn check_secret_exists(key: String) -> bool {
    has_secret(key)
}

#[tauri::command]
pub fn get_all_secret_keys() -> Result<Vec<String>, String> {
    list_secrets()
}

#[allow(dead_code)]
pub fn register_commands(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        store_secret,
        retrieve_secret,
        remove_secret,
        check_secret_exists,
        get_all_secret_keys,
    ])
}

#[allow(dead_code)]
pub mod keys {
    pub const GITHUB_TOKEN: &str = "github_token";
    pub const OPENAI_API_KEY: &str = "openai_api_key";
    pub const ANTHROPIC_API_KEY: &str = "anthropic_api_key";
    pub const CUSTOM_API_KEY: &str = "custom_api_key";
}
