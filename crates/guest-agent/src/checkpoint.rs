//! Checkpoint creation — reads session history and calls checkpoint API.

use crate::artifact;
use crate::constants;
use crate::content_hash;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::paths;
use crate::session_history;
use bytes::Bytes;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Clone, Copy)]
enum CheckpointMode {
    Success,
    Recovery,
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
fn build_artifact_snapshot_entry(name: &str, version: &str, mount_path: &str) -> serde_json::Value {
    json!({
        "name": name,
        "version": version,
        "mountPath": mount_path,
    })
}

struct ArtifactSnapshotPlan<'a> {
    entry: &'a env::ArtifactEnv,
    files: Vec<artifact::FileEntry>,
}

enum ArtifactSnapshotWork<'a> {
    Preserve(serde_json::Value),
    Snapshot(ArtifactSnapshotPlan<'a>),
}

/// Prepare + upload the session history to S3 via a presigned URL. If the
/// prepare endpoint reports `existing=true`, skip the upload (content-addressed
/// dedup). Telemetry is recorded under `session_history_prepare` and
/// `session_history_s3_upload` to match the pre-parallelization op names.
async fn upload_session_history(
    http: &HttpClient,
    history_hash: &str,
    history_size: u64,
    history_bytes: Vec<u8>,
) -> Result<(), AgentError> {
    let prep_start = std::time::Instant::now();
    let url = http.checkpoint_prepare_history_url()?;
    let prep_resp = match http
        .post_json(
            url,
            &json!({
                "runId": env::run_id(),
                "hash": history_hash,
                "size": history_size,
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
    if existing {
        log_info!(
            LOG_TAG,
            "Session history already exists in S3 (deduplicated)"
        );
        return Ok(());
    }

    let presigned_url = prep_resp
        .get("presignedUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            AgentError::Checkpoint("No presignedUrl in prepare-history response".into())
        })?;

    log_info!(LOG_TAG, "Uploading session history to S3...");
    let upload_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned(
            presigned_url,
            Bytes::from(history_bytes),
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
    Ok(())
}

/// Snapshot artifact entries. Memory rides in `VM0_ARTIFACTS` post-#10602, so
/// there is no longer a separate memory arm. Payload shape is
/// `Array<{name, version, mountPath}>`, matching the webhook
/// receiver's canonical artifact snapshot schema.
async fn snapshot_artifact_entries(
    http: &HttpClient,
    entries: &[env::ArtifactEnv],
) -> Result<Option<serde_json::Value>, AgentError> {
    if entries.is_empty() {
        log_info!(
            LOG_TAG,
            "No artifact configured, creating checkpoint without artifact snapshot"
        );
        return Ok(None);
    }

    let mut work = Vec::with_capacity(entries.len());
    for entry in entries {
        log_info!(
            LOG_TAG,
            "Processing artifact '{}' at {}",
            entry.name,
            entry.mount_path
        );
        let files = match artifact::walk_files_for_checkpoint(&entry.mount_path).await {
            Ok(files) => files,
            Err(error)
                if entry.missing_root_policy
                    == Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion)
                    && error.is_root_not_found() =>
            {
                let preserve_start = std::time::Instant::now();
                let message = format!(
                    "Preserving artifact '{}' parent version {} because mount root is missing at {}",
                    entry.name, entry.version_id, entry.mount_path
                );
                log_warn!(LOG_TAG, "{message}");
                record_sandbox_op(
                    "artifact_snapshot_preserved_missing_root",
                    preserve_start.elapsed(),
                    true,
                    Some(&message),
                );
                work.push(ArtifactSnapshotWork::Preserve(
                    build_artifact_snapshot_entry(
                        &entry.name,
                        &entry.version_id,
                        &entry.mount_path,
                    ),
                ));
                continue;
            }
            Err(error) => return Err(error.into_agent_error()),
        };
        work.push(ArtifactSnapshotWork::Snapshot(ArtifactSnapshotPlan {
            entry,
            files,
        }));
    }

    let mut results = Vec::with_capacity(work.len());
    for item in work {
        let (entry, files) = match item {
            ArtifactSnapshotWork::Preserve(entry) => {
                results.push(entry);
                continue;
            }
            ArtifactSnapshotWork::Snapshot(ArtifactSnapshotPlan { entry, files }) => (entry, files),
        };
        // Skip the VAS round-trips when the mount is byte-identical to what
        // was originally mounted. `version_id` in VAS *is* the content hash
        // (same SHA-256 the web producer emits), so an equality check on the
        // locally-recomputed hash is sufficient — no extra metadata needed.
        // See #10967 for the ~3.9s-per-checkpoint motivation.
        let skip_check_start = std::time::Instant::now();
        let local_hash = content_hash::compute_content_hash(
            &entry.storage_id,
            files.iter().map(|f| (f.path.as_str(), f.hash.as_str())),
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
            ));
            continue;
        }

        log_info!(
            LOG_TAG,
            "Creating VAS snapshot for artifact '{}'",
            entry.name
        );
        let message = format!("Checkpoint from run {}", env::run_id());
        let snapshot = artifact::create_snapshot(
            http,
            artifact::CreateSnapshotRequest {
                mount_path: &entry.mount_path,
                files,
                storage_name: &entry.name,
                storage_type: "artifact",
                run_id: env::run_id(),
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
        ));
    }
    Ok(Some(serde_json::Value::Array(results)))
}

/// Create a checkpoint after a successful run.
pub async fn create_checkpoint(http: &HttpClient) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Success).await;
    record_sandbox_op(
        CheckpointMode::Success.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

/// Create a best-effort recovery checkpoint after an abnormal CLI exit.
pub async fn create_recovery_checkpoint(http: &HttpClient) -> Result<(), AgentError> {
    let start = std::time::Instant::now();
    let result = create_checkpoint_impl(http, CheckpointMode::Recovery).await;
    record_sandbox_op(
        CheckpointMode::Recovery.total_op(),
        start.elapsed(),
        result.is_ok(),
        None,
    );
    result
}

async fn create_checkpoint_impl(http: &HttpClient, mode: CheckpointMode) -> Result<(), AgentError> {
    create_checkpoint_impl_with_artifacts(http, mode, env::artifacts()).await
}

async fn create_checkpoint_impl_with_artifacts(
    http: &HttpClient,
    mode: CheckpointMode,
    artifact_entries: &[env::ArtifactEnv],
) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Creating {}...", mode.log_label());

    // Read session ID. Let `read_to_string` surface `NotFound` directly — an
    // explicit `exists()` check would be a redundant stat plus a TOCTOU race
    // between check and read.
    let session_id_start = std::time::Instant::now();
    let session_id = match std::fs::read_to_string(paths::session_id_file()) {
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
    if session_id.is_empty() {
        return Err(fail(
            mode,
            "session_id_read",
            session_id_start,
            "Session ID is empty",
        ));
    }
    record_sandbox_op("session_id_read", session_id_start.elapsed(), true, None);

    // Read session history. The history-path file's content is either a
    // literal jsonl path (Claude) or a `CODEX_SEARCH:{dir}:{id}` marker
    // (codex) — `session_history::read_session_history` abstracts the
    // difference and decompresses zstd-compressed codex sessions.
    let history_read_start = std::time::Instant::now();
    let history_bytes =
        match session_history::read_session_history(paths::session_history_path_file()) {
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

    let session_history = match String::from_utf8(history_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Err(fail(
                mode,
                "session_history_read",
                history_read_start,
                format!("Session history is not valid UTF-8: {e}"),
            ));
        }
    };

    if session_history.trim().is_empty() {
        return Err(fail(
            mode,
            "session_history_read",
            history_read_start,
            "Session history is empty",
        ));
    }

    if mode.validate_history() {
        validate_recoverable_session_history(&session_history)
            .map_err(|msg| fail(mode, "session_history_validate", history_read_start, msg))?;
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
    let history_hash = hex::encode(Sha256::digest(session_history.as_bytes()));
    let history_size = session_history.len() as u64;
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
    let (_, artifact_snapshots) = tokio::try_join!(
        upload_session_history(
            http,
            &history_hash,
            history_size,
            session_history.into_bytes()
        ),
        snapshot_artifact_entries(http, artifact_entries),
    )?;

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let cli_agent_type = env::Framework::from_env().agent_type();
    let mut payload = json!({
        "runId": env::run_id(),
        "cliAgentType": cli_agent_type,
        "cliAgentSessionId": session_id,
        "cliAgentSessionHistoryHash": history_hash,
    });

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
    use httpmock::prelude::*;
    use std::time::Duration;

    struct CheckpointFilesGuard;

    impl CheckpointFilesGuard {
        fn new() -> Self {
            cleanup_checkpoint_files();
            Self
        }
    }

    impl Drop for CheckpointFilesGuard {
        fn drop(&mut self) {
            cleanup_checkpoint_files();
        }
    }

    fn cleanup_checkpoint_files() {
        let _ = std::fs::remove_file(paths::session_id_file());
        let _ = std::fs::remove_file(paths::session_history_path_file());
    }

    #[test]
    fn artifact_snapshot_entry_shape_matches_receiver_schema() {
        let entry = build_artifact_snapshot_entry("workspace", "v-abc-123", "/workspace");
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
        let entry = build_artifact_snapshot_entry("n", "v", "/m");
        let obj = entry.as_object().expect("entry must be a JSON object");
        // Contract-boundary invariant: the web Zod receiver requires camelCase
        // `mountPath`; a snake_case slip would silently cause a 400 on the
        // webhook side.
        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("version"));
        assert!(obj.contains_key("mountPath"));
        assert!(!obj.contains_key("mount_path"));
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

        let err = snapshot_artifact_entries(&http, &entries)
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

        let err = snapshot_artifact_entries(&http, &entries)
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

        let err = snapshot_artifact_entries(&http, &entries)
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
    async fn artifact_snapshot_preserves_parent_version_for_policy_missing_root() {
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

        let snapshots = snapshot_artifact_entries(&http, &entries).await.unwrap();

        assert_eq!(
            snapshots,
            Some(json!([{
                "name": "memory",
                "version": "old-memory-version",
                "mountPath": missing_mount.to_string_lossy(),
            }]))
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

        let err = snapshot_artifact_entries(&http, &entries)
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
        let _files_guard = CheckpointFilesGuard::new();
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let history_path = dir.path().join("history.jsonl");
        std::fs::write(&history_path, r#"{"type":"system"}"#).unwrap();
        std::fs::write(paths::session_id_file(), "session-with-missing-artifact").unwrap();
        std::fs::write(
            paths::session_history_path_file(),
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

        let err = create_checkpoint_impl_with_artifacts(&http, CheckpointMode::Success, &entries)
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
