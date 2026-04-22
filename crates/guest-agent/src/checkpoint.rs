//! Checkpoint creation — reads session history and calls checkpoint API.

use crate::artifact;
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http;
use crate::paths;
use crate::urls;
use bytes::Bytes;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Log the message, record a failed `sandbox_op`, and build a matching
/// `Checkpoint` error — all three channels share the same message so
/// telemetry and logs stay in sync.
fn fail(op: &str, start: std::time::Instant, msg: impl Into<String>) -> AgentError {
    let msg = msg.into();
    log_error!(LOG_TAG, "{msg}");
    record_sandbox_op(op, start.elapsed(), false, Some(&msg));
    AgentError::Checkpoint(msg)
}

/// Create a checkpoint after a successful run.
pub async fn create_checkpoint() -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl().await;
    record_sandbox_op("checkpoint_total", start.elapsed(), result.is_ok(), None);
    result
}

async fn create_checkpoint_impl() -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Creating checkpoint...");

    // Read session ID. Let `read_to_string` surface `NotFound` directly — an
    // explicit `exists()` check would be a redundant stat plus a TOCTOU race
    // between check and read.
    let session_id_start = std::time::Instant::now();
    let session_id = match std::fs::read_to_string(paths::session_id_file()) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(fail(
                "session_id_read",
                session_id_start,
                "No session ID found",
            ));
        }
        Err(e) => {
            return Err(fail(
                "session_id_read",
                session_id_start,
                format!("Failed to read session ID: {e}"),
            ));
        }
    };
    if session_id.is_empty() {
        return Err(fail(
            "session_id_read",
            session_id_start,
            "Session ID is empty",
        ));
    }
    record_sandbox_op("session_id_read", session_id_start.elapsed(), true, None);

    // Read session history path file then the history file itself. Both
    // steps record under `session_history_read` with a shared start instant
    // so the duration covers the end-to-end read.
    let history_read_start = std::time::Instant::now();
    let session_history_path = match std::fs::read_to_string(paths::session_history_path_file()) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(fail(
                "session_history_read",
                history_read_start,
                "No session history path found",
            ));
        }
        Err(e) => {
            return Err(fail(
                "session_history_read",
                history_read_start,
                format!("Failed to read history path: {e}"),
            ));
        }
    };

    let session_history = match std::fs::read_to_string(&session_history_path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(fail(
                "session_history_read",
                history_read_start,
                format!("Session history file not found at {session_history_path}"),
            ));
        }
        Err(e) => {
            return Err(fail(
                "session_history_read",
                history_read_start,
                format!("Failed to read session history: {e}"),
            ));
        }
    };

    if session_history.trim().is_empty() {
        return Err(fail(
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    let line_count = session_history.lines().count();
    log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    // Compute SHA-256 hash of session history for presigned URL upload
    let history_bytes = session_history.as_bytes();
    let history_hash = hex::encode(Sha256::digest(history_bytes));
    let history_size = history_bytes.len() as u64;
    log_info!(
        LOG_TAG,
        "Session history hash={}, size={history_size}",
        &history_hash[..8]
    );

    // Upload session history via presigned URL (bypasses Vercel 4.5MB body limit)
    let prep_start = std::time::Instant::now();
    let prep_result = http::post_json(
        urls::checkpoint_prepare_history_url(),
        &json!({
            "runId": env::run_id(),
            "hash": history_hash,
            "size": history_size,
        }),
        constants::HTTP_MAX_RETRIES,
    )
    .await;
    let prep_resp = match prep_result {
        Ok(Some(v)) => v,
        Ok(None) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint(
                "Empty prepare-history response".into(),
            ));
        }
        Err(e) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), false, None);
            return Err(e);
        }
    };
    record_sandbox_op("session_history_prepare", prep_start.elapsed(), true, None);

    let existing = prep_resp
        .get("existing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if existing {
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated)"
        );
    } else {
        let presigned_url = prep_resp
            .get("presignedUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
            })?;

        log_info!(LOG_TAG, "Uploading session history to S3...");
        let upload_start = std::time::Instant::now();
        if let Err(e) = http::put_presigned(
            presigned_url,
            Bytes::from(session_history.into_bytes()),
            "application/octet-stream",
        )
        .await
        {
            record_sandbox_op(
                "session_history_s3_upload",
                upload_start.elapsed(),
                false,
                None,
            );
            return Err(e);
        }
        record_sandbox_op(
            "session_history_s3_upload",
            upload_start.elapsed(),
            true,
            None,
        );
        log_info!(LOG_TAG, "Session history uploaded to S3");
    }

    // Snapshot all configured artifacts. Memory rides in env::artifacts()
    // post-#10602, so there is no longer a separate memory arm.
    let artifact_snapshots: Option<serde_json::Map<String, serde_json::Value>> = {
        let entries = env::artifacts();
        if entries.is_empty() {
            log_info!(
                LOG_TAG,
                "No artifact configured, creating checkpoint without artifact snapshot"
            );
            None
        } else {
            let mut results = serde_json::Map::new();
            for entry in entries {
                log_info!(
                    LOG_TAG,
                    "Creating VAS snapshot for artifact '{}' at {}",
                    entry.name,
                    entry.mount_path
                );
                let files = artifact::walk_files(&entry.mount_path).await?;
                let snapshot = artifact::create_snapshot(
                    &entry.mount_path,
                    files,
                    &entry.name,
                    "artifact",
                    env::run_id(),
                    &format!("Checkpoint from run {}", env::run_id()),
                    &entry.version_id,
                )
                .await?;
                log_info!(
                    LOG_TAG,
                    "VAS artifact snapshot created: {}@{}",
                    entry.name,
                    snapshot.version_id
                );
                results.insert(
                    entry.name.clone(),
                    serde_json::Value::String(snapshot.version_id),
                );
            }
            Some(results)
        }
    };

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let mut payload = json!({
        "runId": env::run_id(),
        "cliAgentType": "claude-code",
        "cliAgentSessionId": session_id,
        "cliAgentSessionHistoryHash": history_hash,
    });

    if let Some(snaps) = artifact_snapshots
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert(
            "artifactSnapshots".to_string(),
            serde_json::Value::Object(snaps),
        );
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
