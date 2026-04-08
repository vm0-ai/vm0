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

    let session_history_path = raw_path;

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

    // Validate drivers before starting parallel snapshot creation.
    // Driver validation uses early return, which cannot be done inside async blocks.
    let has_artifact =
        !env::artifact_driver().is_empty() && !env::artifact_volume_name().is_empty();
    let has_memory = !env::memory_driver().is_empty() && !env::memory_name().is_empty();

    if has_artifact && env::artifact_driver() != "vas" {
        return Err(AgentError::Checkpoint(format!(
            "Unknown artifact driver: {} (only 'vas' is supported)",
            env::artifact_driver()
        )));
    }
    if has_memory && env::memory_driver() != "vas" {
        return Err(AgentError::Checkpoint(format!(
            "Unknown memory driver: {} (only 'vas' is supported)",
            env::memory_driver()
        )));
    }

    // Create artifact and memory snapshots in parallel (independent directories + APIs).
    let (artifact_snapshot, memory_snapshot) = tokio::join!(
        async {
            if !has_artifact {
                log_info!(
                    LOG_TAG,
                    "No artifact configured, creating checkpoint without artifact snapshot"
                );
                return Ok::<_, AgentError>(None);
            }
            log_info!(
                LOG_TAG,
                "Creating VAS snapshot for artifact '{}' at {}",
                env::artifact_volume_name(),
                env::artifact_mount_path()
            );
            let snapshot = artifact::create_snapshot(
                env::artifact_mount_path(),
                env::artifact_volume_name(),
                "artifact",
                env::run_id(),
                &format!("Checkpoint from run {}", env::run_id()),
                env::artifact_version_id(),
            )
            .await?;
            log_info!(
                LOG_TAG,
                "VAS artifact snapshot created: {}@{}",
                env::artifact_volume_name(),
                snapshot.version_id
            );
            Ok(Some(json!({
                "artifactName": env::artifact_volume_name(),
                "artifactVersion": snapshot.version_id,
            })))
        },
        async {
            if !has_memory {
                return Ok::<_, AgentError>(None);
            }
            if !Path::new(env::memory_mount_path()).exists() {
                log_info!(
                    LOG_TAG,
                    "Memory directory does not exist, skipping memory snapshot"
                );
                return Ok(None);
            }
            log_info!(
                LOG_TAG,
                "Creating VAS snapshot for memory '{}' at {}",
                env::memory_name(),
                env::memory_mount_path()
            );
            let snapshot = artifact::create_snapshot(
                env::memory_mount_path(),
                env::memory_name(),
                "memory",
                env::run_id(),
                &format!("Memory checkpoint from run {}", env::run_id()),
                env::memory_version_id(),
            )
            .await?;
            log_info!(
                LOG_TAG,
                "VAS memory snapshot created: {}@{}",
                env::memory_name(),
                snapshot.version_id
            );
            Ok(Some(json!({
                "memoryName": env::memory_name(),
                "memoryVersion": snapshot.version_id,
            })))
        },
    );
    let artifact_snapshot = artifact_snapshot?;
    let memory_snapshot = memory_snapshot?;

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let mut payload = json!({
        "runId": env::run_id(),
        "cliAgentType": "claude-code",
        "cliAgentSessionId": session_id,
        "cliAgentSessionHistoryHash": history_hash,
    });

    if let Some(snap) = artifact_snapshot
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert("artifactSnapshot".to_string(), snap);
    }

    if let Some(snap) = memory_snapshot
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert("memorySnapshot".to_string(), snap);
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
