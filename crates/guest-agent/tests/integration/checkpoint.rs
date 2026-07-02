use crate::support::*;
use flate2::read::GzDecoder;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
};
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{ffi::OsString, io::Read};

const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;

fn runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

fn session_file_paths() -> (String, String) {
    let paths = shared_guest_paths();
    (
        paths.session_id_file().to_string(),
        paths.session_history_path_file().to_string(),
    )
}

struct EnvVarRestore {
    key: &'static str,
    value: Option<OsString>,
}

impl EnvVarRestore {
    fn capture(key: &'static str) -> Self {
        Self {
            key,
            value: std::env::var_os(key),
        }
    }
}

impl Drop for EnvVarRestore {
    fn drop(&mut self) {
        unsafe {
            match &self.value {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

fn write_derived_claude_history(
    home_dir: &str,
    session_id: &str,
    history: &str,
) -> Result<(), String> {
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    let project_name = guest_agent::paths::CANONICAL_WORKING_DIR
        .strip_prefix('/')
        .unwrap_or(guest_agent::paths::CANONICAL_WORKING_DIR)
        .replace('/', "-");
    let history_path = std::path::Path::new(home_dir)
        .join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"));
    let parent = history_path
        .parent()
        .ok_or_else(|| format!("history path has no parent: {}", history_path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create history dir {}: {e}", parent.display()))?;
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    Ok(())
}

fn write_literal_session_history(
    session_id: &str,
    history: &[u8],
) -> Result<tempfile::TempDir, String> {
    let (session_id_file, session_history_path_file) = session_file_paths();
    let dir = tempfile::tempdir().map_err(|e| format!("create temp history dir: {e}"))?;
    let history_path = dir.path().join(format!("{session_id}.jsonl"));
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .map_err(|e| format!("write session history marker: {e}"))?;
    Ok(dir)
}

// =========================================================================
// Success checkpoint
// =========================================================================

#[tokio::test]
async fn success_checkpoint_uploads_non_utf8_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = b"{\"type\":\"system\"}\nnon-utf8:\xC3(\n".to_vec();
    let _history_dir = write_literal_session_history("success-non-utf8-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"size":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/success-non-utf8-history-upload"),
                "existing": false
            }));
    });
    let upload_len = history_size.to_string();
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/success-non-utf8-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"success-non-utf8-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-success-non-utf8"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = FinalSessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, FinalSessionHistoryFramework::ClaudeCode);
    assert_eq!(identity.history_ref_kind, FinalSessionHistoryRefKind::Blob);
    assert_eq!(
        identity.session_id_hash,
        hex::encode(Sha256::digest(b"success-non-utf8-session"))
    );
    assert_eq!(identity.history_hash, history_hash);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(
        std::fs::read(&identity.history_marker_payload).unwrap(),
        history
    );
}

#[tokio::test]
async fn success_checkpoint_writes_large_final_identity_metadata() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("success-large-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"size":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/success-large-history-upload"),
                "existing": false
            }));
    });
    let upload_len = history_size.to_string();
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/success-large-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"success-large-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-success-large"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = FinalSessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, FinalSessionHistoryFramework::ClaudeCode);
    assert_eq!(identity.history_ref_kind, FinalSessionHistoryRefKind::Blob);
    assert_eq!(
        identity.session_id_hash,
        hex::encode(Sha256::digest(b"success-large-session"))
    );
    assert_eq!(identity.history_hash, history_hash);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(
        std::fs::read(&identity.history_marker_payload).unwrap(),
        history
    );
}

#[tokio::test]
async fn success_checkpoint_uploads_gzip_session_history_when_acknowledged() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("success-gzip-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"size":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/success-gzip-history-upload"),
                "existing": false,
                "encoding": "gzip"
            }));
    });
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/success-gzip-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| {
            if request_header_absent(req, "authorization")
                && request_header_absent(req, "x-vercel-protection-bypass")
                && req.body_ref() != upload_body.as_slice()
            {
                let mut decoded = Vec::new();
                let decode_result = GzDecoder::new(req.body_ref()).read_to_end(&mut decoded);
                if decode_result.is_ok() && decoded == upload_body {
                    return http_status(200);
                }
            }
            http_status(400)
        });
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"success-gzip-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-success-gzip"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn success_checkpoint_keeps_large_non_utf8_session_history_identity_encoded() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let mut history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    history.extend_from_slice(&[0xc3, 0x28, b'\n']);
    let _history_dir = write_literal_session_history("large-non-utf8-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"size":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/large-non-utf8-history-upload"),
                "existing": false
            }));
    });
    let upload_len = history_size.to_string();
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/large-non-utf8-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"large-non-utf8-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-large-non-utf8"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn success_checkpoint_uses_explicit_runtime_after_process_env_changes() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _run_id_guard = EnvVarRestore::capture("VM0_RUN_ID");
    let _runtime_dir_guard =
        EnvVarRestore::capture(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV);

    let tmp = tempfile::tempdir().unwrap();
    let runtime_dir = tmp.path().join("captured-runtime");
    let stale_runtime_dir = tmp.path().join("stale-runtime");
    let home_dir = tmp.path().join("home");
    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(&runtime_dir);
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "captured-run".to_string(),
        api_url: server.base_url(),
        api_token: "test-token-abc123".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(home_dir.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(runtime_dir.clone()),
        ..guest_agent::env::GuestConfigRaw::default()
    })
    .unwrap();
    let final_identity_file = paths.final_session_history_identity_file().to_string();
    let stale_paths = guest_agent::paths::GuestPaths::from_runtime_dir(&stale_runtime_dir);

    let history = r#"{"type":"system"}"#.to_string() + "\n";
    let history_path = tmp.path().join("history.jsonl");
    std::fs::write(&history_path, &history).unwrap();
    guest_agent::paths::write_private(paths.session_id_file(), "captured-session").unwrap();
    guest_agent::paths::write_private(
        paths.session_history_path_file(),
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let runtime = guest_agent::run_context::GuestRuntime {
        config,
        paths,
        http: http_client!(),
    };

    unsafe {
        std::env::set_var("VM0_RUN_ID", "stale-run-after-runtime");
        std::env::set_var(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &stale_runtime_dir,
        );
    }

    let history_hash = hex::encode(Sha256::digest(history.as_bytes()));
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"captured-run"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"size":{}}}"#, history.len()))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/explicit-runtime-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/explicit-runtime-history-upload")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"runId":"captured-run"}"#)
            .json_body_includes(r#"{"cliAgentType":"claude-code"}"#)
            .json_body_includes(r#"{"cliAgentSessionId":"captured-session"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-explicit-runtime"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert!(
        std::path::Path::new(&final_identity_file).exists(),
        "final identity should be written under explicit runtime paths"
    );
    assert!(
        !std::path::Path::new(stale_paths.final_session_history_identity_file()).exists(),
        "stale process env runtime path must not receive final identity"
    );
}

// =========================================================================
// Recovery checkpoint
// =========================================================================

#[tokio::test]
async fn recovery_checkpoint_uploads_valid_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("history.jsonl");
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    std::fs::write(&history_path, &history).unwrap();
    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "recovery-session").unwrap();
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/recovery-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/recovery-history-upload")
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"recovery-session"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-recovery"}));
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert!(
        !std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists(),
        "recovery checkpoint must not write final session history identity metadata"
    );
}

async fn assert_recovery_checkpoint_derives_claude_history_marker(
    seed_empty_marker: bool,
    upload_path: &str,
) -> Result<(), String> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env()?;
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = if seed_empty_marker {
        "derived-empty-marker-session"
    } else {
        "derived-missing-marker-session"
    };
    let history = r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant"}"# + "\n";
    if seed_empty_marker {
        let (_, session_history_path_file) = session_file_paths();
        guest_agent::paths::write_private(&session_history_path_file, "")
            .map_err(|e| format!("write empty history marker: {e}"))?;
    }
    write_derived_claude_history(&runtime.config.home_dir, session_id, &history)?;

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url(upload_path),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path(upload_path)
            .header("Content-Type", "application/octet-stream")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-derived-history"}));
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn recovery_checkpoint_derives_missing_claude_history_marker() {
    assert_recovery_checkpoint_derives_claude_history_marker(
        false,
        "/test/derived-missing-history-upload",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_checkpoint_derives_empty_claude_history_marker() {
    assert_recovery_checkpoint_derives_claude_history_marker(
        true,
        "/test/derived-empty-history-upload",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn recovery_checkpoint_rejects_partial_jsonl_without_error_file() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let dir = tempfile::tempdir().unwrap();
    let history_path = dir.path().join("partial.jsonl");
    std::fs::write(
        &history_path,
        r#"{"type":"system"}"#.to_string() + "\n" + r#"{"type":"assistant""#,
    )
    .unwrap();
    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "partial-session").unwrap();
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Session history line 2 is not valid JSON"),
        "expected recovery checkpoint to fail on partial JSONL history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_non_utf8_session_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let _history_dir = write_literal_session_history(
        "recovery-non-utf8-session",
        b"{\"type\":\"system\"}\nnon-utf8:\xC3(\n",
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Session history is not valid UTF-8"),
        "expected recovery checkpoint to fail on invalid UTF-8 history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_session_id_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("No session ID found"),
        "expected recovery checkpoint to fail on missing session ID, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_skips_when_derived_history_is_missing() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "missing-history").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("Failed to read session history"),
        "expected recovery checkpoint to fail on missing derived history, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_rejects_invalid_session_id_without_marker() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, "../unsafe-session").unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let result = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Failed to derive session history marker from session ID"),
        "expected recovery checkpoint to fail on invalid session ID, got: {err}"
    );
    assert!(
        !std::path::Path::new(runtime.paths.checkpoint_error_file()).exists(),
        "recovery checkpoint must not write the success-path checkpoint error file"
    );
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}
