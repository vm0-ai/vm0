//! Checkpoint creation — reads session history and calls checkpoint API.

use crate::artifact;
use crate::constants;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_history;
use crate::session_history_identity::{
    FinalSessionHistoryIdentityBuildError, build_final_session_history_identity,
};
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use bytes::Bytes;
use flate2::{Compression, write::GzEncoder};
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use serde_json::json;
use std::borrow::Cow;
use std::io::{ErrorKind, Write};
use std::time::Duration;

const LOG_TAG: &str = "sandbox:guest-agent";
const SESSION_HISTORY_ENCODING_IDENTITY: &str = "identity";
const SESSION_HISTORY_ENCODING_GZIP: &str = "gzip";
const SESSION_HISTORY_GZIP_MIN_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy)]
enum CheckpointMode {
    Success,
    Recovery,
}

enum SessionHistoryUploadBody {
    Identity(Vec<u8>),
    Gzip { raw: Vec<u8>, gzip: Vec<u8> },
}

struct SessionHistoryUpload {
    raw_size: u64,
    body: SessionHistoryUploadBody,
}

impl SessionHistoryUpload {
    fn requested_encoding(&self) -> &'static str {
        match self.body {
            SessionHistoryUploadBody::Identity(_) => SESSION_HISTORY_ENCODING_IDENTITY,
            SessionHistoryUploadBody::Gzip { .. } => SESSION_HISTORY_ENCODING_GZIP,
        }
    }

    fn into_server_accepted_bytes(self, accepted_encoding: Option<&str>) -> (&'static str, Bytes) {
        match self.body {
            SessionHistoryUploadBody::Identity(raw) => {
                (SESSION_HISTORY_ENCODING_IDENTITY, Bytes::from(raw))
            }
            SessionHistoryUploadBody::Gzip { raw: _, gzip }
                if accepted_encoding == Some(SESSION_HISTORY_ENCODING_GZIP) =>
            {
                (SESSION_HISTORY_ENCODING_GZIP, Bytes::from(gzip))
            }
            SessionHistoryUploadBody::Gzip { raw, .. } => {
                (SESSION_HISTORY_ENCODING_IDENTITY, Bytes::from(raw))
            }
        }
    }
}

fn gzip_session_history(history_bytes: &[u8]) -> Result<Vec<u8>, AgentError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(history_bytes)
        .map_err(|error| AgentError::Checkpoint(format!("gzip session history: {error}")))?;
    encoder
        .finish()
        .map_err(|error| AgentError::Checkpoint(format!("finish gzip session history: {error}")))
}

fn build_session_history_upload(
    history_bytes: Vec<u8>,
) -> Result<SessionHistoryUpload, AgentError> {
    let raw_size = history_bytes.len() as u64;
    if history_bytes.len() < SESSION_HISTORY_GZIP_MIN_BYTES {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    let gzip_bytes = gzip_session_history(&history_bytes)?;
    if gzip_bytes.len() >= history_bytes.len() {
        return Ok(SessionHistoryUpload {
            raw_size,
            body: SessionHistoryUploadBody::Identity(history_bytes),
        });
    }

    Ok(SessionHistoryUpload {
        raw_size,
        body: SessionHistoryUploadBody::Gzip {
            raw: history_bytes,
            gzip: gzip_bytes,
        },
    })
}

impl CheckpointMode {
    fn total_op(self) -> &'static str {
        match self {
            Self::Success => "checkpoint_total",
            Self::Recovery => "recovery_checkpoint_total",
        }
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Success => "checkpoint",
            Self::Recovery => "recovery checkpoint",
        }
    }

    fn validate_history(self) -> bool {
        matches!(self, Self::Recovery)
    }
}

/// Log the message, record a failed `sandbox_op`, and build a matching
/// `Checkpoint` error. Success-path checkpoint failures are run-fatal and
/// logged as errors; recovery checkpoint skips are best-effort and stay warn.
fn fail(
    mode: CheckpointMode,
    op: &str,
    start: std::time::Instant,
    msg: impl Into<String>,
) -> AgentError {
    let msg = msg.into();
    match mode {
        CheckpointMode::Success => log_error!(LOG_TAG, "{msg}"),
        CheckpointMode::Recovery => log_warn!(LOG_TAG, "{msg}"),
    }
    record_sandbox_op(op, start.elapsed(), false, Some(&msg));
    AgentError::Checkpoint(msg)
}

/// Shape one entry of the `artifactSnapshots` payload. Keys are the
/// camelCase names the web Zod receiver (`artifactSnapshotsSchema`) expects.
fn build_artifact_snapshot_entry(
    name: &str,
    version: &str,
    mount_path: &str,
    missing_root_policy: Option<ArtifactEntryMissingRootPolicy>,
) -> serde_json::Value {
    let mut entry = json!({
        "name": name,
        "version": version,
        "mountPath": mount_path,
    });
    if let Some(policy) = missing_root_policy
        && let Some(object) = entry.as_object_mut()
    {
        object.insert("missingRootPolicy".to_string(), json!(policy));
    }
    entry
}

enum ArtifactSnapshotPlan<'a> {
    Snapshot {
        entry: &'a env::ArtifactEnv,
        files: Vec<artifact::FileEntry>,
    },
    PreserveParentVersion {
        entry: &'a env::ArtifactEnv,
    },
}

struct CheckpointInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    home_dir: &'a str,
    artifact_entries: &'a [env::ArtifactEnv],
    session_id_file: Cow<'a, str>,
    session_history_path_file: Cow<'a, str>,
    final_session_history_identity_file: Cow<'a, str>,
}

impl<'a> CheckpointInputs<'a> {
    fn from_runtime(runtime: &'a GuestRuntime) -> Self {
        Self {
            run_id: &runtime.config.run_id,
            framework: runtime.config.framework,
            home_dir: &runtime.config.home_dir,
            artifact_entries: &runtime.config.artifacts,
            session_id_file: Cow::Borrowed(runtime.paths.session_id_file()),
            session_history_path_file: Cow::Borrowed(runtime.paths.session_history_path_file()),
            final_session_history_identity_file: Cow::Borrowed(
                runtime.paths.final_session_history_identity_file(),
            ),
        }
    }
}

/// Prepare + upload the session history to S3 via a presigned URL. If the
/// prepare endpoint reports `existing=true`, skip the upload (content-addressed
/// dedup). Telemetry is recorded under `session_history_prepare` and
/// `session_history_s3_upload` to match the pre-parallelization op names.
async fn upload_session_history(
    http: &HttpClient,
    run_id: &str,
    history_hash: &str,
    history_upload: SessionHistoryUpload,
) -> Result<Option<&'static str>, AgentError> {
    let prep_start = std::time::Instant::now();
    let url = http.checkpoint_prepare_history_url()?;
    let requested_encoding = history_upload.requested_encoding();
    let prep_resp = match http
        .post_json(
            url,
            &json!({
                "runId": run_id,
                "hash": history_hash,
                "size": history_upload.raw_size,
                "encoding": requested_encoding,
            }),
            constants::HTTP_MAX_RETRIES,
        )
        .await
    {
        Ok(Some(v)) => {
            record_sandbox_op("session_history_prepare", prep_start.elapsed(), true, None);
            v
        }
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

    let existing = prep_resp
        .get("existing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let response_encoding = prep_resp.get("encoding").and_then(|v| v.as_str());
    let checkpoint_response_encoding = match response_encoding {
        Some(SESSION_HISTORY_ENCODING_GZIP) => Some(SESSION_HISTORY_ENCODING_GZIP),
        Some(SESSION_HISTORY_ENCODING_IDENTITY) => Some(SESSION_HISTORY_ENCODING_IDENTITY),
        _ => None,
    };
    if existing {
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated, encoding={requested_encoding})"
        );
        return Ok(checkpoint_response_encoding);
    }

    let presigned_url = prep_resp
        .get("presignedUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
        })?;

    let (upload_encoding, upload_bytes) =
        history_upload.into_server_accepted_bytes(response_encoding);
    if requested_encoding == SESSION_HISTORY_ENCODING_GZIP
        && upload_encoding == SESSION_HISTORY_ENCODING_IDENTITY
    {
        log_info!(
            LOG_TAG,
            "Prepare-history response did not acknowledge gzip; uploading identity session history"
        );
    }

    log_info!(
        LOG_TAG,
        "Uploading session history to S3 (encoding={upload_encoding})..."
    );
    let upload_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned(presigned_url, upload_bytes, "application/octet-stream")
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
    Ok(checkpoint_response_encoding.map(|_| upload_encoding))
}

/// Snapshot artifact entries. Memory rides in `VM0_ARTIFACTS` post-#10602, so
/// there is no longer a separate memory arm. Payload shape is
/// `Array<{name, version, mountPath}>`, matching the webhook
/// receiver's canonical artifact snapshot schema.
async fn snapshot_artifact_entries(
    http: &HttpClient,
    run_id: &str,
    entries: &[env::ArtifactEnv],
) -> Result<Option<serde_json::Value>, AgentError> {
    if entries.is_empty() {
        log_info!(
            LOG_TAG,
            "No artifact configured, creating checkpoint without artifact snapshot"
        );
        return Ok(None);
    }

    let mut plans = Vec::with_capacity(entries.len());
    for entry in entries {
        log_info!(
            LOG_TAG,
            "Processing artifact '{}' at {}",
            entry.name,
            entry.mount_path
        );
        match artifact::walk_files_for_checkpoint(&entry.mount_path).await {
            Ok(files) => {
                plans.push(ArtifactSnapshotPlan::Snapshot { entry, files });
            }
            Err(error)
                if error.is_missing_root()
                    && matches!(
                        entry.missing_root_policy,
                        Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
                    ) =>
            {
                error.record_preserved_missing_root(&entry.name, &entry.mount_path);
                plans.push(ArtifactSnapshotPlan::PreserveParentVersion { entry });
            }
            Err(error) => return Err(error.into_agent_error()),
        }
    }

    let mut results = Vec::with_capacity(plans.len());
    for plan in plans {
        let (entry, files) = match plan {
            ArtifactSnapshotPlan::Snapshot { entry, files } => (entry, files),
            ArtifactSnapshotPlan::PreserveParentVersion { entry } => {
                log_info!(
                    LOG_TAG,
                    "VAS artifact snapshot preserved parent version for missing root: {}@{}",
                    entry.name,
                    entry.version_id
                );
                results.push(build_artifact_snapshot_entry(
                    &entry.name,
                    &entry.version_id,
                    &entry.mount_path,
                    entry.missing_root_policy,
                ));
                continue;
            }
        };
        // Skip the VAS round-trips when the mount is byte-identical to what
        // was originally mounted. `version_id` in VAS *is* the content hash
        // (same SHA-256 the web producer emits), so an equality check on the
        // locally-recomputed hash is sufficient — no extra metadata needed.
        // See #10967 for the ~3.9s-per-checkpoint motivation.
        let skip_check_start = std::time::Instant::now();
        let content_hash_start = std::time::Instant::now();
        let local_hash = content_hash::compute_content_hash(
            &entry.storage_id,
            files.iter().map(|f| (f.path.as_str(), f.hash.as_str())),
        );
        record_sandbox_op(
            "artifact_content_hash_compute",
            content_hash_start.elapsed(),
            true,
            None,
        );
        if local_hash == entry.version_id {
            log_info!(
                LOG_TAG,
                "VAS artifact snapshot skipped (unchanged since mount): {}@{}",
                entry.name,
                entry.version_id
            );
            record_sandbox_op(
                "artifact_snapshot_skipped",
                skip_check_start.elapsed(),
                true,
                None,
            );
            results.push(build_artifact_snapshot_entry(
                &entry.name,
                &entry.version_id,
                &entry.mount_path,
                entry.missing_root_policy,
            ));
            continue;
        }

        log_info!(
            LOG_TAG,
            "Creating VAS snapshot for artifact '{}'",
            entry.name
        );
        let message = format!("Checkpoint from run {run_id}");
        let snapshot = artifact::create_snapshot(
            http,
            artifact::CreateSnapshotRequest {
                mount_path: &entry.mount_path,
                files,
                storage_name: &entry.name,
                storage_type: "artifact",
                run_id,
                message: &message,
                parent_version_id: &entry.version_id,
            },
        )
        .await?;
        log_info!(
            LOG_TAG,
            "VAS artifact snapshot created: {}@{}",
            entry.name,
            snapshot.version_id
        );
        results.push(build_artifact_snapshot_entry(
            &entry.name,
            &snapshot.version_id,
            &entry.mount_path,
            entry.missing_root_policy,
        ));
    }
    Ok(Some(serde_json::Value::Array(results)))
}

/// Create a checkpoint after a successful run using the explicit runtime snapshot.
pub async fn create_checkpoint_for_runtime(runtime: &GuestRuntime) -> Result<(), AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime);
    create_checkpoint_with_inputs(&runtime.http, &inputs).await
}

/// Create a best-effort recovery checkpoint using the explicit runtime snapshot.
pub async fn create_recovery_checkpoint_for_runtime(
    runtime: &GuestRuntime,
) -> Result<(), AgentError> {
    let inputs = CheckpointInputs::from_runtime(runtime);
    create_recovery_checkpoint_with_inputs(&runtime.http, &inputs).await
}

async fn create_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Success, inputs).await;
    record_sandbox_op(
        CheckpointMode::Success.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

async fn create_recovery_checkpoint_with_inputs(
    http: &HttpClient,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Recovery, inputs).await;
    record_sandbox_op(
        CheckpointMode::Recovery.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

async fn create_checkpoint_impl(
    http: &HttpClient,
    mode: CheckpointMode,
    inputs: &CheckpointInputs<'_>,
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Creating {}...", mode.log_label());

    // Read the CLI agent session id. Let `read_to_string` surface `NotFound`
    // directly — an explicit `exists()` check would be a redundant stat plus a
    // TOCTOU race between check and read.
    let session_id_start = std::time::Instant::now();
    let cli_agent_session_id = match std::fs::read_to_string(inputs.session_id_file.as_ref()) {
        Ok(s) => s.trim().to_string(),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(fail(
                mode,
                "session_id_read",
                session_id_start,
                "No session ID found",
            ));
        }
        Err(e) => {
            return Err(fail(
                mode,
                "session_id_read",
                session_id_start,
                format!("Failed to read session ID: {e}"),
            ));
        }
    };
    if cli_agent_session_id.is_empty() {
        return Err(fail(
            mode,
            "session_id_read",
            session_id_start,
            "Session ID is empty",
        ));
    }
    record_sandbox_op("session_id_read", session_id_start.elapsed(), true, None);

    // Read session history. The persisted or derived marker payload is either
    // a literal jsonl path (Claude) or a codex marker. `session_history`
    // abstracts the difference and decompresses zstd-compressed codex sessions.
    let history_read_start = std::time::Instant::now();
    let history_marker_payload = match crate::session_metadata::resolve_history_marker_payload_from(
        inputs.framework,
        inputs.home_dir,
        inputs.session_history_path_file.as_ref(),
        &cli_agent_session_id,
    ) {
        Ok(payload) => payload,
        Err(e) => {
            return Err(fail(
                mode,
                "session_history_read",
                history_read_start,
                e.to_string(),
            ));
        }
    };
    let history_bytes =
        match session_history::read_session_history_from_payload(&history_marker_payload) {
            Ok(b) => b,
            Err(e) => {
                return Err(fail(
                    mode,
                    "session_history_read",
                    history_read_start,
                    e.to_string(),
                ));
            }
        };

    let session_history_text = match std::str::from_utf8(&history_bytes) {
        Ok(s) => Some(s),
        Err(e) => {
            let msg = format!("Session history is not valid UTF-8: {e}");
            if mode.validate_history() {
                return Err(fail(mode, "session_history_read", history_read_start, msg));
            }
            log_warn!(LOG_TAG, "{msg}; preserving raw bytes for checkpoint");
            None
        }
    };

    let history_is_empty = session_history_text.map_or_else(
        || history_bytes.iter().all(|byte| byte.is_ascii_whitespace()),
        |session_history| session_history.trim().is_empty(),
    );
    if history_is_empty {
        return Err(fail(
            mode,
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    if let Some(session_history) = session_history_text {
        if mode.validate_history() {
            validate_recoverable_session_history(session_history)
                .map_err(|msg| fail(mode, "session_history_validate", history_read_start, msg))?;
        }

        let line_count = session_history.lines().count();
        log_info!(LOG_TAG, "Session history loaded ({line_count} lines)");
    } else {
        log_info!(
            LOG_TAG,
            "Session history loaded ({} raw bytes, invalid UTF-8)",
            history_bytes.len()
        );
    }
    record_sandbox_op(
        "session_history_read",
        history_read_start.elapsed(),
        true,
        None,
    );

    // Compute SHA-256 hash of session history for presigned URL upload
    let history_hash = hex::encode(Sha256::digest(&history_bytes));
    let history_size = history_bytes.len() as u64;
    log_info!(
        LOG_TAG,
        "Session history hash={}, size={history_size}",
        &history_hash[..8]
    );

    // History upload and artifact snapshots are independent pre-requisites
    // of the final checkpoint API call, so run them concurrently. The history
    // path is web-API bound (prepare + S3 PUT); the artifact path is VAS-bound
    // (prepare + HEAD update). Serial, wall time was dominated by whichever
    // was longer plus the other; concurrent, it's just the longer one.
    let (session_history_encoding, artifact_snapshots) = tokio::try_join!(
        upload_session_history(
            http,
            inputs.run_id,
            &history_hash,
            build_session_history_upload(history_bytes)?
        ),
        snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries),
    )?;

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let cli_agent_type = inputs.framework.agent_type();
    let mut payload = json!({
        "runId": inputs.run_id,
        "cliAgentType": cli_agent_type,
        "cliAgentSessionId": cli_agent_session_id,
        "cliAgentSessionHistoryHash": history_hash,
    });

    if let Some(encoding) = session_history_encoding
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert(
            "cliAgentSessionHistoryEncoding".to_string(),
            json!(encoding),
        );
    }

    if let Some(snaps) = artifact_snapshots
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert("artifactSnapshots".to_string(), snaps);
    }

    log_info!(LOG_TAG, "Calling checkpoint API...");
    let api_start = std::time::Instant::now();
    let url = http.checkpoint_url()?;
    let result = match http
        .post_json(url, &payload, constants::HTTP_MAX_RETRIES)
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
        write_final_session_history_identity(
            mode,
            &cli_agent_session_id,
            &history_hash,
            history_size,
            &history_marker_payload,
            inputs.framework,
            inputs.final_session_history_identity_file.as_ref(),
        );
        log_info!(LOG_TAG, "{} created successfully: {id}", mode.log_label());
        record_sandbox_op("checkpoint_api_call", api_start.elapsed(), true, None);
        Ok(())
    } else {
        Err(fail(
            mode,
            "checkpoint_api_call",
            api_start,
            "Invalid checkpoint API response",
        ))
    }
}

fn write_final_session_history_identity(
    mode: CheckpointMode,
    cli_agent_session_id: &str,
    history_hash: &str,
    history_size: u64,
    history_marker_payload: &str,
    framework: env::Framework,
    final_session_history_identity_file: &str,
) {
    if !matches!(mode, CheckpointMode::Success) {
        return;
    }
    let identity = match build_final_session_history_identity(
        framework,
        cli_agent_session_id,
        history_hash,
        history_size,
        history_marker_payload,
    ) {
        Ok(identity) => identity,
        Err(error) => {
            match error {
                FinalSessionHistoryIdentityBuildError::InvalidSessionId => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_session_id",
                    Duration::ZERO,
                    true,
                    None,
                ),
                FinalSessionHistoryIdentityBuildError::InvalidMetadata(_) => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_metadata",
                    Duration::ZERO,
                    true,
                    None,
                ),
            }
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    let bytes = match identity.to_json_vec() {
        Ok(bytes) => bytes,
        Err(error) => {
            record_sandbox_op(
                "session_history_identity_write_skipped_invalid_metadata",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    match crate::paths::write_private(final_session_history_identity_file, bytes) {
        Ok(()) => {
            record_sandbox_op(
                "session_history_identity_written",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity written");
        }
        Err(_) => {
            record_sandbox_op(
                "session_history_identity_write_failed",
                Duration::ZERO,
                false,
                None,
            );
            log_warn!(LOG_TAG, "Failed to write final session history identity");
        }
    }
}

fn validate_recoverable_session_history(session_history: &str) -> Result<(), String> {
    let mut line_count = 0usize;
    for (index, line) in session_history.lines().enumerate() {
        if line.trim().is_empty() {
            return Err(format!(
                "Session history line {} is empty; recovery checkpoint skipped",
                index + 1
            ));
        }
        serde_json::from_str::<serde_json::Value>(line).map_err(|e| {
            format!(
                "Session history line {} is not valid JSON; recovery checkpoint skipped: {e}",
                index + 1
            )
        })?;
        line_count += 1;
    }

    if line_count == 0 {
        return Err("Session history has no JSONL entries; recovery checkpoint skipped".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
    use httpmock::prelude::*;
    use std::time::Duration;

    struct CheckpointFilesGuard {
        guest_paths: crate::paths::GuestPaths,
    }

    impl CheckpointFilesGuard {
        fn new(guest_paths: &crate::paths::GuestPaths) -> Self {
            cleanup_checkpoint_files(guest_paths);
            Self {
                guest_paths: guest_paths.clone(),
            }
        }
    }

    impl Drop for CheckpointFilesGuard {
        fn drop(&mut self) {
            cleanup_checkpoint_files(&self.guest_paths);
        }
    }

    fn cleanup_checkpoint_files(guest_paths: &crate::paths::GuestPaths) {
        let _ = std::fs::remove_file(guest_paths.session_id_file());
        let _ = std::fs::remove_file(guest_paths.session_history_path_file());
    }

    #[test]
    fn artifact_snapshot_entry_shape_matches_receiver_schema() {
        let entry = build_artifact_snapshot_entry("workspace", "v-abc-123", "/workspace", None);
        assert_eq!(
            entry,
            json!({
                "name": "workspace",
                "version": "v-abc-123",
                "mountPath": "/workspace",
            })
        );
    }

    #[test]
    fn artifact_snapshot_entry_uses_camel_case_keys() {
        let entry = build_artifact_snapshot_entry(
            "n",
            "v",
            "/m",
            Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        );
        let obj = entry.as_object().expect("entry must be a JSON object");
        // Contract-boundary invariant: the web Zod receiver requires camelCase
        // `mountPath` and `missingRootPolicy`; a snake_case slip would
        // silently cause a 400 on the webhook side.
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("version"));
        assert!(obj.contains_key("mountPath"));
        assert!(obj.contains_key("missingRootPolicy"));
        assert!(!obj.contains_key("mount_path"));
        assert!(!obj.contains_key("missing_root_policy"));
    }

    #[tokio::test]
    async fn artifact_snapshot_missing_mount_fails_before_storage_api_calls() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_explicit_fail_policy_missing_mount_fails() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::Fail),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_later_missing_mount_fails_before_any_storage_api_calls() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let valid_mount = dir.path().join("valid");
        std::fs::create_dir(&valid_mount).unwrap();
        std::fs::write(valid_mount.join("changed.txt"), "changed").unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![
            env::ArtifactEnv {
                name: "workspace".to_string(),
                mount_path: valid_mount.to_string_lossy().into_owned(),
                storage_id: "workspace-storage-id".to_string(),
                version_id: "old-workspace-version".to_string(),
                missing_root_policy: None,
            },
            env::ArtifactEnv {
                name: "memory".to_string(),
                mount_path: missing_mount.to_string_lossy().into_owned(),
                storage_id: "memory-storage-id".to_string(),
                version_id: "old-memory-version".to_string(),
                missing_root_policy: None,
            },
        ];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_preserve_policy_missing_mount_preserves_parent_version() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let missing_mount = dir.path().join("memory");
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let snapshots = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            snapshots,
            json!([
                {
                    "name": "memory",
                    "version": "old-memory-version",
                    "mountPath": missing_mount.to_string_lossy(),
                    "missingRootPolicy": "preserveParentVersion",
                }
            ])
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn artifact_snapshot_policy_still_fails_on_non_not_found_root_error() {
        let server = MockServer::start();
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file_mount = dir.path().join("memory");
        std::fs::write(&file_mount, "not a directory").unwrap();
        let entries = vec![env::ArtifactEnv {
            name: "memory".to_string(),
            mount_path: file_mount.to_string_lossy().into_owned(),
            storage_id: "memory-storage-id".to_string(),
            version_id: "old-memory-version".to_string(),
            missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        }];

        let err = snapshot_artifact_entries(&http, "test-run", &entries)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
    }

    #[tokio::test]
    async fn checkpoint_missing_mount_fails_before_final_checkpoint_api_call() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let history_path = dir.path().join("history.jsonl");
        let home_dir = dir.path().join("home").to_string_lossy().into_owned();
        std::fs::write(&history_path, r#"{"type":"system"}"#).unwrap();
        crate::paths::write_private(
            guest_paths.session_id_file(),
            "session-with-missing-artifact",
        )
        .unwrap();
        crate::paths::write_private(
            guest_paths.session_history_path_file(),
            history_path.to_string_lossy().as_ref(),
        )
        .unwrap();

        let _history_prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history");
            then.status(200).json_body(json!({"existing": true}));
        });
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let commit = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200).json_body(json!({"unreachable": true}));
        });
        let checkpoint = server.mock(|when, then| {
            when.method(POST).path("/api/webhooks/agent/checkpoints");
            then.status(200)
                .json_body(json!({"checkpointId": "unreachable"}));
        });
        let http = HttpClient::with_api_config(server.base_url(), "test-token", "", Duration::ZERO)
            .unwrap();
        let missing_mount = dir.path().join("missing");
        let entries = vec![env::ArtifactEnv {
            name: "workspace".to_string(),
            mount_path: missing_mount.to_string_lossy().into_owned(),
            storage_id: "storage-id".to_string(),
            version_id: "parent-version".to_string(),
            missing_root_policy: None,
        }];

        let inputs = CheckpointInputs {
            run_id: "checkpoint-missing-mount",
            framework: env::Framework::ClaudeCode,
            home_dir: &home_dir,
            artifact_entries: &entries,
            session_id_file: guest_paths.session_id_file().into(),
            session_history_path_file: guest_paths.session_history_path_file().into(),
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        let err = create_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("Failed to walk artifact files"),
            "got: {err}"
        );
        prepare.assert_calls(0);
        commit.assert_calls(0);
        checkpoint.assert_calls(0);
    }

    #[test]
    fn recoverable_session_history_accepts_valid_jsonl() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"#;

        assert!(validate_recoverable_session_history(&history).is_ok());
    }

    #[test]
    fn recoverable_session_history_rejects_partial_trailing_json() {
        let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#;

        let err = validate_recoverable_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }

    #[test]
    fn recoverable_session_history_rejects_blank_lines() {
        let history = r#"{"type":"system"}"#.to_string() + "\n\n" + r#"{"type":"assistant"}"#;

        let err = validate_recoverable_session_history(&history).unwrap_err();

        assert!(err.contains("line 2"));
    }
}
