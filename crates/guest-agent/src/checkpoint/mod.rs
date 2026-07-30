//! Checkpoint creation — reads session history and calls checkpoint API.

mod artifact;
mod session_history;

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use api_contracts::generated::types::webhooks::agent::checkpoints;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use std::borrow::Cow;

const LOG_TAG: &str = "sandbox:guest-agent";
const CLAUDE_SESSION_PRUNING_FEATURE_FLAG: &str = "claudeSessionPruning";

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

    fn can_prune_history(self) -> bool {
        matches!(self, Self::Success)
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
    record_failure(mode, op, start, &msg);
    AgentError::Checkpoint(msg)
}

fn record_failure(mode: CheckpointMode, op: &str, start: std::time::Instant, msg: &str) {
    match mode {
        CheckpointMode::Success => log_error!(LOG_TAG, "{msg}"),
        CheckpointMode::Recovery => log_warn!(LOG_TAG, "{msg}"),
    }
    record_sandbox_op(op, start.elapsed(), false, Some(msg));
}

struct CheckpointInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    claude_session_pruning_enabled: bool,
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
            claude_session_pruning_enabled: runtime
                .config
                .feature_flags
                .get(CLAUDE_SESSION_PRUNING_FEATURE_FLAG)
                .copied()
                .unwrap_or(false),
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

    // History upload and artifact snapshots are independent pre-requisites
    // of the final checkpoint API call, so run them concurrently. The history
    // path performs blocking local preparation before web API work; the
    // artifact path performs blocking file preparation before VAS work. Wait
    // for both results even after one fails so a started blocking operation is
    // not detached from the checkpoint future.
    let history_inputs =
        session_history::CheckpointSessionHistoryInputs::from_checkpoint(mode, inputs);
    let (artifact_snapshots, checkpoint_history) = tokio::join!(
        artifact::snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries),
        session_history::prepare_and_upload_session_history(http, inputs.run_id, history_inputs),
    );
    let session_history::CheckpointSessionHistory {
        cli_agent_session_id,
        history_marker_payload,
        history_hash,
        history_size,
        live_history,
    } = checkpoint_history?;
    let artifact_snapshots = artifact_snapshots?;

    // Build and send checkpoint payload (session history hash only, content uploaded to S3)
    let cli_agent_type = inputs.framework.agent_type();
    let payload = checkpoints::Request {
        run_id: inputs.run_id.to_string(),
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_hash: history_hash,
        artifact_snapshots,
        volume_versions_snapshot: None,
    };

    log_info!(LOG_TAG, "Calling checkpoint API...");
    let api_start = std::time::Instant::now();
    let url = http.checkpoint_url()?;
    let result = match http
        .post_json(url, &payload, constants::HTTP_MAX_ATTEMPTS)
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
        if session_history::reconcile_live_history_after_checkpoint(live_history) {
            session_history::write_final_session_history_identity(
                mode,
                &payload.cli_agent_session_id,
                &payload.cli_agent_session_history_hash,
                history_size,
                &history_marker_payload,
                inputs.framework,
                inputs.final_session_history_identity_file.as_ref(),
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use api_contracts::generated::constants::runners::SESSION_HISTORY_ENCODING_ZSTD;
    use httpmock::prelude::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
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

    fn http_status(status: u16) -> HttpMockResponse {
        HttpMockResponse::builder().status(status).build()
    }

    fn request_header_eq(req: &HttpMockRequest, name: &str, expected: &str) -> bool {
        req.headers_vec()
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case(name) && value == expected)
    }

    fn session_history_upload_response(
        req: &HttpMockRequest,
        expected_body: &[u8],
    ) -> HttpMockResponse {
        if request_header_eq(req, "content-type", "application/octet-stream")
            && req.body_ref() == expected_body
        {
            http_status(200)
        } else {
            http_status(400)
        }
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
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
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
            claude_session_pruning_enabled: false,
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

    #[tokio::test]
    async fn checkpoint_reuses_codex_zstd_session_history() {
        let server = MockServer::start();
        let dir = tempfile::tempdir().unwrap();
        let guest_paths = crate::paths::GuestPaths::from_runtime_dir(dir.path().join("runtime"));
        let _files_guard = CheckpointFilesGuard::new(&guest_paths);
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let history_hash = hex::encode(Sha256::digest(history));
        let home_dir = dir.path().join("home");
        let codex_day_dir = home_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("02");
        std::fs::create_dir_all(&codex_day_dir).unwrap();
        std::fs::write(
            codex_day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst"),
            &compressed,
        )
        .unwrap();
        crate::paths::write_private(guest_paths.session_id_file(), thread_id).unwrap();

        let upload_url = server.url("/test/session-history-upload");
        let prepare = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints/prepare-history")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-reuse",
                    "hash": history_hash,
                    "rawSize": history.len() as u64,
                    "encodedSize": compressed.len() as u64,
                    "encoding": SESSION_HISTORY_ENCODING_ZSTD,
                }));
            then.status(200).json_body(json!({
                "presignedUrl": upload_url,
                "encoding": SESSION_HISTORY_ENCODING_ZSTD,
            }));
        });
        let expected_upload = compressed.clone();
        let upload = server.mock(|when, then| {
            when.method(PUT).path("/test/session-history-upload");
            then.respond_with(move |req| session_history_upload_response(req, &expected_upload));
        });
        let checkpoint = server.mock(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/checkpoints")
                .json_body(json!({
                    "runId": "checkpoint-codex-zstd-reuse",
                    "cliAgentType": "codex",
                    "cliAgentSessionId": thread_id,
                    "cliAgentSessionHistoryHash": history_hash,
                }));
            then.status(200)
                .json_body(json!({"checkpointId": "checkpoint-codex-zstd"}));
        });
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-run-001",
            Duration::ZERO,
        )
        .unwrap();
        let home_dir = home_dir.to_string_lossy().into_owned();
        let inputs = CheckpointInputs {
            run_id: "checkpoint-codex-zstd-reuse",
            framework: env::Framework::Codex,
            claude_session_pruning_enabled: false,
            home_dir: &home_dir,
            artifact_entries: &[],
            session_id_file: guest_paths.session_id_file().into(),
            session_history_path_file: guest_paths.session_history_path_file().into(),
            final_session_history_identity_file: guest_paths
                .final_session_history_identity_file()
                .into(),
        };

        create_checkpoint_impl(&http, CheckpointMode::Success, &inputs)
            .await
            .unwrap();

        prepare.assert_calls(1);
        upload.assert_calls(1);
        checkpoint.assert_calls(1);
    }
}
