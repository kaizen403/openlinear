//! OpenCode CLI detection module

use serde::Serialize;
use std::process::Command;
use which::which;

/// Status of OpenCode CLI installation
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OpenCodeStatus {
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

impl Default for OpenCodeStatus {
    fn default() -> Self {
        Self {
            found: false,
            version: None,
            path: None,
        }
    }
}

#[tauri::command]
pub fn check_opencode() -> OpenCodeStatus {
    match which("opencode") {
        Ok(path) => {
            let version = Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .and_then(|output| {
                    if output.status.success() {
                        String::from_utf8(output.stdout).ok()
                    } else {
                        String::from_utf8(output.stderr).ok()
                    }
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            OpenCodeStatus {
                found: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        Err(_) => OpenCodeStatus::default(),
    }
}

#[tauri::command]
pub fn pick_local_folder() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[allow(dead_code)]
fn check_binary_exists(binary_name: &str) -> bool {
    which(binary_name).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_opencode_status_default() {
        let status = OpenCodeStatus::default();
        assert!(!status.found);
        assert!(status.version.is_none());
        assert!(status.path.is_none());
    }

    #[test]
    fn test_check_binary_exists_with_common_binary() {
        assert!(check_binary_exists("ls"));
    }

    #[test]
    fn test_check_binary_exists_with_nonexistent_binary() {
        assert!(!check_binary_exists(
            "this-binary-definitely-does-not-exist-12345"
        ));
    }

    #[test]
    fn test_check_opencode_returns_valid_structure() {
        let status = check_opencode();

        if status.found {
            assert!(status.path.is_some());
        } else {
            assert!(status.path.is_none());
        }
    }

    #[test]
    fn test_opencode_status_serialization() {
        let status = OpenCodeStatus {
            found: true,
            version: Some("1.0.0".to_string()),
            path: Some("/usr/local/bin/opencode".to_string()),
        };

        let json = serde_json::to_string(&status).expect("Should serialize");
        assert!(json.contains("\"found\":true"));
        assert!(json.contains("\"version\":\"1.0.0\""));
        assert!(json.contains("\"path\":\"/usr/local/bin/opencode\""));
    }
}
