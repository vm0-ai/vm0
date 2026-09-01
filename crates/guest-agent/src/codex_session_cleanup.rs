//! Fixed reused-Codex session cleanup helper.

use std::io;
use std::process::Command;

use api_contracts::generated::constants::runners::paths::CANONICAL_CODEX_HOME_DIR;
use guest_contracts::codex_session_cleanup::{
    CODEX_SESSION_CLEANUP_SCAN_BUDGET, CodexSessionCleanupRequest,
};

const CODEX_SESSION_CLEANUP_SCRIPT: &str = include_str!("../scripts/codex-session-cleanup.sh");

/// Execute the fixed cleanup shell contract and return its exit code.
pub fn run(request: &CodexSessionCleanupRequest) -> io::Result<i32> {
    request
        .validate()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let filename_key = request
        .filename_key()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let restore_path = format!(
        "{CANONICAL_CODEX_HOME_DIR}/{}",
        request.fallback_relative_path
    );
    let command =
        format!("codex_home='{CANONICAL_CODEX_HOME_DIR}'\n{CODEX_SESSION_CLEANUP_SCRIPT}");
    let status = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .env_clear()
        .env("LANG", "C.UTF-8")
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("OKOU_CODEX_RESTORE_SESSION_ID", &request.session_id)
        .env("OKOU_CODEX_RESTORE_SESSION_FILENAME_KEY", filename_key)
        .env("OKOU_CODEX_RESTORE_SESSION_PATH", restore_path)
        .env(
            "OKOU_CODEX_SESSION_CLEANUP_SCAN_BUDGET",
            CODEX_SESSION_CLEANUP_SCAN_BUDGET.to_string(),
        )
        .status()?;
    Ok(status.code().unwrap_or(1))
}
