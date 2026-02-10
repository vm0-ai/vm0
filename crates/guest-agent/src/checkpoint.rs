//! Checkpoint creation — reads session history and calls checkpoint API.
//!
//! For Codex, searches for the session file in date-organized directories.

use crate::artifact;
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http;
use crate::paths;
use crate::urls;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use serde_json::json;
use std::path::Path;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Create a checkpoint after a successful run.
pub async fn create_checkpoint() -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(start).await;
    record_sandbox_op("checkpoint_total", start.elapsed(), result.is_ok(), None);
    result
}

async fn create_checkpoint_impl(start: std::time::Instant) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Creating checkpoint...");

    // Read session ID
    let session_id_path = paths::session_id_file();
    if !Path::new(session_id_path).exists() {
        log_error!(LOG_TAG, "No session ID found, checkpoint creation failed");
        record_sandbox_op(
            "session_id_read",
            start.elapsed(),
            false,
            Some("Session ID file not found"),
        );
        return Err(AgentError::Checkpoint("No session ID found".into()));
    }
    let session_id = std::fs::read_to_string(session_id_path)
        .map_err(|e| AgentError::Checkpoint(format!("Failed to read session ID: {e}")))?
        .trim()
        .to_string();
    record_sandbox_op("session_id_read", start.elapsed(), true, None);

    // Read session history path
    let history_path_file = paths::session_history_path_file();
    if !Path::new(history_path_file).exists() {
        log_error!(LOG_TAG, "No session history path found");
        record_sandbox_op(
            "session_history_read",
            start.elapsed(),
            false,
            Some("Path file not found"),
        );
        return Err(AgentError::Checkpoint(
            "No session history path found".into(),
        ));
    }
    let raw_path = std::fs::read_to_string(history_path_file)
        .map_err(|e| AgentError::Checkpoint(format!("Failed to read history path: {e}")))?
        .trim()
        .to_string();

    // Handle Codex session search marker: CODEX_SEARCH:{dir}:{id}
    let session_history_path = if let Some(rest) = raw_path.strip_prefix("CODEX_SEARCH:") {
        let Some((sessions_dir, codex_session_id)) = rest.split_once(':') else {
            record_sandbox_op(
                "session_history_read",
                start.elapsed(),
                false,
                Some("Invalid Codex search marker"),
            );
            return Err(AgentError::Checkpoint(format!(
                "Invalid Codex search marker: {raw_path}"
            )));
        };
        log_info!(LOG_TAG, "Searching for Codex session in {sessions_dir}");
        match find_codex_session_file(sessions_dir, codex_session_id) {
            Some(path) => path,
            None => {
                record_sandbox_op(
                    "session_history_read",
                    start.elapsed(),
                    false,
                    Some("Codex session file not found"),
                );
                return Err(AgentError::Checkpoint(format!(
                    "Could not find Codex session file for {codex_session_id}"
                )));
            }
        }
    } else {
        raw_path
    };

    // Read session history
    if !Path::new(&session_history_path).exists() {
        log_error!(
            LOG_TAG,
            "Session history file not found at {session_history_path}"
        );
        record_sandbox_op(
            "session_history_read",
            start.elapsed(),
            false,
            Some("File not found"),
        );
        return Err(AgentError::Checkpoint(
            "Session history file not found".into(),
        ));
    }

    let session_history = match std::fs::read_to_string(&session_history_path) {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("Failed to read session history: {e}");
            record_sandbox_op("session_history_read", start.elapsed(), false, Some(&msg));
            return Err(AgentError::Checkpoint(msg));
        }
    };

    if session_history.trim().is_empty() {
        log_error!(LOG_TAG, "Session history is empty");
        record_sandbox_op(
            "session_history_read",
            start.elapsed(),
            false,
            Some("Empty"),
        );
        return Err(AgentError::Checkpoint("Session history is empty".into()));
    }

    let line_count = session_history.lines().count();
    log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    record_sandbox_op("session_history_read", start.elapsed(), true, None);

    // Artifact snapshot (VAS only, optional)
    let artifact_snapshot =
        if !env::artifact_driver().is_empty() && !env::artifact_volume_name().is_empty() {
            let driver = env::artifact_driver();
            log_info!(LOG_TAG, "Processing artifact with driver: {driver}");

            if driver != "vas" {
                return Err(AgentError::Checkpoint(format!(
                    "Unknown artifact driver: {driver} (only 'vas' is supported)"
                )));
            }

            log_info!(
                LOG_TAG,
                "Creating VAS snapshot for artifact '{}' at {}",
                env::artifact_volume_name(),
                env::artifact_mount_path()
            );
            log_info!(LOG_TAG, "Using direct S3 upload...");

            let snapshot = artifact::create_snapshot(
                env::artifact_mount_path(),
                env::artifact_volume_name(),
                env::run_id(),
                &format!("Checkpoint from run {}", env::run_id()),
            )
            .await?;

            log_info!(
                LOG_TAG,
                "VAS artifact snapshot created: {}@{}",
                env::artifact_volume_name(),
                snapshot.version_id
            );

            Some(json!({
                "artifactName": env::artifact_volume_name(),
                "artifactVersion": snapshot.version_id,
            }))
        } else {
            log_info!(
                LOG_TAG,
                "No artifact configured, creating checkpoint without artifact snapshot"
            );
            None
        };

    // Build and send checkpoint payload
    let mut payload = json!({
        "runId": env::run_id(),
        "cliAgentType": env::cli_agent_type(),
        "cliAgentSessionId": session_id,
        "cliAgentSessionHistory": session_history,
    });

    if let Some(snap) = artifact_snapshot
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert("artifactSnapshot".to_string(), snap);
    }

    log_info!(LOG_TAG, "Calling checkpoint API...");
    let api_start = std::time::Instant::now();
    let result = match http::post_json(
        urls::checkpoint_url(),
        &payload,
        constants::HTTP_MAX_RETRIES,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            record_sandbox_op("checkpoint_api_call", api_start.elapsed(), false, None);
            return Err(e);
        }
    };

    // Validate response
    let checkpoint_id = result
        .as_ref()
        .and_then(|v| v.get("checkpointId"))
        .and_then(|v| v.as_str());

    if let Some(id) = checkpoint_id {
        log_info!(LOG_TAG, "Checkpoint created successfully: {id}");
        record_sandbox_op("checkpoint_api_call", api_start.elapsed(), true, None);
        Ok(())
    } else {
        log_error!(LOG_TAG, "Checkpoint API returned invalid response");
        record_sandbox_op(
            "checkpoint_api_call",
            api_start.elapsed(),
            false,
            Some("Invalid response"),
        );
        Err(AgentError::Checkpoint(
            "Invalid checkpoint API response".into(),
        ))
    }
}

/// Find Codex session file by searching recursively for JSONL files.
fn find_codex_session_file(sessions_dir: &str, session_id: &str) -> Option<String> {
    let files = find_jsonl_files(sessions_dir);
    log_info!(
        LOG_TAG,
        "Searching for Codex session {session_id} in {} files",
        files.len()
    );

    // Try matching session ID in filename
    let normalized_id = session_id.replace('-', "");
    for f in &files {
        let filename = Path::new(f)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if filename.contains(session_id) || filename.replace('-', "").contains(&normalized_id) {
            log_info!(LOG_TAG, "Found Codex session file: {f}");
            return Some(f.clone());
        }
    }

    // Fallback: most recent file
    if let Some(most_recent) = files.into_iter().max_by_key(|f| {
        std::fs::metadata(f)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    }) {
        log_info!(
            LOG_TAG,
            "Session ID not found in filenames, using most recent: {most_recent}"
        );
        return Some(most_recent);
    }

    None
}

/// Recursively find all `.jsonl` files in a directory.
fn find_jsonl_files(dir: &str) -> Vec<String> {
    let mut files = Vec::new();
    walk_jsonl(dir, &mut files);
    files
}

fn walk_jsonl(dir: &str, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir()
            && let Some(s) = path.to_str()
        {
            walk_jsonl(s, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| ext == "jsonl")
            && let Some(s) = path.to_str()
        {
            out.push(s.to_string());
        }
    }
}
