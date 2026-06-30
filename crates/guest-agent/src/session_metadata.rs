//! Session metadata capture and resolution helpers.
//!
//! Event capture writes run-scoped metadata files. Checkpoint and diagnostics
//! resolve missing history markers from the stored session id when needed.

use crate::env;
use crate::env::Framework;
use crate::error::AgentError;
use crate::paths;
use crate::session_history;
use guest_common::{log_error, log_info};
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use std::io;
use std::path::{Component, Path, PathBuf};

const LOG_TAG: &str = "sandbox:guest-agent";

pub(crate) fn history_marker_payload_for_session_id(session_id: &str) -> Option<String> {
    history_marker_payload_for_session_id_with_home(
        Framework::from_env(),
        env::home_dir(),
        session_id,
    )
}

pub(crate) fn history_marker_payload_for_session_id_with_home(
    framework: Framework,
    home_dir: &str,
    session_id: &str,
) -> Option<String> {
    match framework {
        Framework::ClaudeCode => claude_history_path_payload_for_home(home_dir, session_id),
        Framework::Codex => {
            let thread_id = canonical_codex_thread_id(session_id)?;
            Some(codex_history_marker_payload_for_home(
                Path::new(home_dir),
                &thread_id,
            ))
        }
    }
}

fn claude_history_path_payload_for_home(home: &str, session_id: &str) -> Option<String> {
    if !is_valid_session_history_id(session_id) {
        return None;
    }

    let project_name = paths::CANONICAL_WORKING_DIR
        .strip_prefix('/')
        .unwrap_or(paths::CANONICAL_WORKING_DIR)
        .replace('/', "-");
    Some(format!(
        "{home}/.claude/projects/-{project_name}/{session_id}.jsonl"
    ))
}

pub(crate) fn codex_history_marker_payload(thread_id: &str) -> String {
    codex_history_marker_payload_for_home(Path::new(env::home_dir()), thread_id)
}

fn codex_history_marker_payload_for_home(home_dir: &Path, thread_id: &str) -> String {
    let sessions_dir = codex_sessions_dir(home_dir);
    session_history::codex_marker_payload(&sessions_dir, thread_id)
}

fn codex_sessions_dir(home_dir: &Path) -> PathBuf {
    crate::codex_auth::codex_home_path(home_dir).join("sessions")
}

pub(crate) fn is_valid_session_history_id(session_id: &str) -> bool {
    if session_id.is_empty()
        || session_id == "."
        || session_id == ".."
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.chars().any(char::is_control)
    {
        return false;
    }

    let mut components = Path::new(session_id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

pub(crate) fn session_history_marker_kind(history_path_payload: &str) -> &'static str {
    if session_history::is_codex_marker(history_path_payload) {
        "codex"
    } else {
        "claude"
    }
}

pub(crate) fn read_existing_history_marker_payload() -> io::Result<Option<String>> {
    read_existing_history_marker_payload_from(paths::session_history_path_file())
}

pub(crate) fn read_existing_history_marker_payload_from(
    session_history_path_file: &str,
) -> io::Result<Option<String>> {
    match std::fs::read_to_string(session_history_path_file) {
        Ok(existing) => {
            let existing = existing.trim();
            if existing.is_empty() {
                Ok(None)
            } else {
                Ok(Some(existing.to_string()))
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn ensure_history_marker_payload_at(
    session_history_path_file: &str,
    history_path_payload: &str,
) {
    match read_existing_history_marker_payload_from(session_history_path_file) {
        Ok(Some(_)) => {}
        Ok(None) => {
            write_session_history_marker_at(session_history_path_file, history_path_payload)
        }
        Err(e) => log_error!(
            LOG_TAG,
            "Failed to read existing session history marker from {}: {e}",
            session_history_path_file
        ),
    }
}

pub(crate) fn resolve_history_marker_payload(session_id: &str) -> Result<String, AgentError> {
    match read_existing_history_marker_payload() {
        Ok(Some(payload)) => return Ok(payload),
        Ok(None) => {}
        Err(e) => {
            return Err(AgentError::Checkpoint(format!(
                "Failed to read history-path file {}: {e}",
                paths::session_history_path_file()
            )));
        }
    }

    let payload = history_marker_payload_for_session_id(session_id).ok_or_else(|| {
        AgentError::Checkpoint(
            "Failed to derive session history marker from session ID".to_string(),
        )
    })?;
    write_session_history_marker(&payload);
    Ok(payload)
}

pub fn resolve_history_marker_payload_for_diagnostics() -> io::Result<Option<String>> {
    if let Some(payload) = read_existing_history_marker_payload()? {
        return Ok(Some(payload));
    }

    match std::fs::read_to_string(paths::session_id_file()) {
        Ok(session_id) => {
            let session_id = session_id.trim();
            if session_id.is_empty() {
                Ok(None)
            } else {
                Ok(history_marker_payload_for_session_id(session_id))
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn write_session_history_marker(history_path_payload: &str) {
    write_session_history_marker_at(paths::session_history_path_file(), history_path_payload);
}

pub(crate) fn write_session_history_marker_at(
    session_history_path_file: &str,
    history_path_payload: &str,
) {
    match paths::write_private(session_history_path_file, history_path_payload) {
        Ok(()) => log_info!(
            LOG_TAG,
            "Session history marker written to {} ({})",
            session_history_path_file,
            session_history_marker_kind(history_path_payload)
        ),
        Err(e) => log_error!(
            LOG_TAG,
            "Failed to write session history marker to {}: {e}",
            session_history_path_file
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_history_marker_payload_for_empty_home_uses_same_home_resolution_as_codex_auth() {
        let marker = codex_history_marker_payload_for_home(
            Path::new(""),
            "0193abcd-ef01-7234-89ab-cdef01234567",
        );

        assert!(
            marker.starts_with("CODEX_SEARCH:15:.codex/sessions:"),
            "marker should use relative .codex sessions dir for empty HOME, got {marker}"
        );
    }
}
