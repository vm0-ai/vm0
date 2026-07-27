use crate::support::*;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
};
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    io::{Read, Seek, SeekFrom, Write},
};
const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;

fn runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

fn set_claude_session_pruning(runtime: &mut guest_agent::run_context::GuestRuntime, enabled: bool) {
    runtime
        .config
        .feature_flags
        .insert("claudeSessionPruning".to_string(), enabled);
}

fn set_codex_session_pruning(runtime: &mut guest_agent::run_context::GuestRuntime, enabled: bool) {
    runtime.config.framework = guest_agent::env::Framework::Codex;
    runtime
        .config
        .feature_flags
        .insert("codexSessionPruning".to_string(), enabled);
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

fn write_prunable_claude_history(session_id: &str) -> Result<(tempfile::TempDir, Vec<u8>), String> {
    let boundary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let summary_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let records = [
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": session_id,
            "uuid": boundary_id,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }),
        json!({
            "type": "user",
            "sessionId": session_id,
            "uuid": summary_id,
            "parentUuid": boundary_id,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }),
    ];
    let mut candidate = Vec::new();
    for record in records {
        let mut line =
            serde_json::to_vec(&record).map_err(|error| format!("encode history: {error}"))?;
        line.push(b'\n');
        candidate.extend_from_slice(&line);
    }

    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create history dir: {error}"))?;
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let mut history_file =
        std::fs::File::create(&history_path).map_err(|error| format!("create history: {error}"))?;
    history_file
        .set_len(guest_session_prune::CLAUDE_COMPACT_GENERATION_MAX_BYTES + 1)
        .map_err(|error| format!("size history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("seek history: {error}"))?;
    history_file
        .write_all(b"\n")
        .and_then(|()| history_file.write_all(&candidate))
        .and_then(|()| history_file.flush())
        .map_err(|error| format!("write history: {error}"))?;

    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write session id: {error}"))?;
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .map_err(|error| format!("write history marker: {error}"))?;
    Ok((history_dir, candidate))
}

fn write_prunable_codex_history(
    session_id: &str,
) -> Result<(tempfile::TempDir, std::path::PathBuf, Vec<u8>), String> {
    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create Codex history dir: {error}"))?;
    let day_dir = history_dir
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("07")
        .join("26");
    std::fs::create_dir_all(&day_dir)
        .map_err(|error| format!("create Codex session directory: {error}"))?;
    let history_path = day_dir.join(format!("rollout-{session_id}.jsonl"));

    let line = |record_type: &str, payload: serde_json::Value| -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(&json!({
            "timestamp": "2026-07-26T00:00:00Z",
            "type": record_type,
            "payload": payload,
        }))
        .map_err(|error| format!("encode Codex history: {error}"))?;
        bytes.push(b'\n');
        Ok(bytes)
    };
    let canonical = line(
        "session_meta",
        json!({
            "id": session_id,
            "session_id": session_id,
            "timestamp": "2026-07-26T00:00:00Z",
            "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
            "originator": "codex",
            "cli_version": "0.144.6",
            "source": "cli",
            "history_mode": "legacy",
        }),
    )?;
    let turn_id = "compact-turn";
    let retained_records = [
        line(
            "event_msg",
            json!({
                "type": "task_started",
                "turn_id": turn_id,
                "model_context_window": 258400,
                "collaboration_mode_kind": "default",
            }),
        )?,
        line(
            "event_msg",
            json!({
                "type": "user_message",
                "message": "compact this thread",
                "images": [],
                "local_images": [],
                "audio": [],
                "local_audio": [],
                "text_elements": [],
            }),
        )?,
        line(
            "turn_context",
            json!({
                "turn_id": turn_id,
                "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
                "approval_policy": {"granular": {"sandbox_approval": true}},
                "sandbox_policy": {"type": "read_only"},
                "model": "gpt-test",
                "summary": "auto",
            }),
        )?,
        line(
            "compacted",
            json!({
                "message": "retained summary",
                "replacement_history": [{
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "retained summary",
                    }],
                }],
                "window_number": 1,
                "first_window_id": "019c0000-0000-7000-8000-000000000001",
                "window_id": "019c0000-0000-7000-8000-000000000002",
            }),
        )?,
        line(
            "world_state",
            json!({"full": true, "state": {"working_directory": "/workspace"}}),
        )?,
        line(
            "event_msg",
            json!({
                "type": "task_complete",
                "turn_id": turn_id,
                "last_agent_message": "retained summary",
            }),
        )?,
    ];
    let candidate = std::iter::once(canonical.clone())
        .chain(retained_records.iter().cloned())
        .flatten()
        .collect::<Vec<_>>();

    let mut history_file = std::fs::File::create(&history_path)
        .map_err(|error| format!("create Codex history: {error}"))?;
    history_file
        .write_all(&canonical)
        .map_err(|error| format!("write canonical Codex history: {error}"))?;
    history_file
        .set_len(api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES + 1)
        .map_err(|error| format!("size Codex history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .and_then(|_| history_file.write_all(b"\n"))
        .and_then(|()| {
            for record in retained_records {
                history_file.write_all(&record)?;
            }
            history_file.flush()
        })
        .map_err(|error| format!("write retained Codex history: {error}"))?;

    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write Codex session id: {error}"))?;
    Ok((history_dir, history_path, candidate))
}

fn zstd_session_history_for_test(history: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::stream::encode_all(history, 3)
}

fn gzip_session_history_for_test(history: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(history)?;
    encoder.finish()
}

fn high_entropy_history(size: usize) -> Vec<u8> {
    let mut state = 0x6a09e667f3bcc909_u64;
    let mut bytes = Vec::with_capacity(size);
    for _ in 0..size {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let value = state.wrapping_mul(0x2545f4914f6cdd1d);
        bytes.push((value >> 56) as u8);
    }
    bytes
}

fn long_distance_repeated_history() -> Vec<u8> {
    let chunk = high_entropy_history(64 * 1024);
    [chunk.as_slice(), chunk.as_slice()].concat()
}

fn upload_zstd_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
) -> HttpMockResponse {
    if request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() != expected_body
        && zstd::stream::decode_all(req.body_ref()).is_ok_and(|decoded| decoded == expected_body)
    {
        http_status(200)
    } else {
        http_status(400)
    }
}

fn upload_gzip_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
) -> HttpMockResponse {
    if request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() != expected_body
    {
        let mut decoded = Vec::new();
        let decode_result = GzDecoder::new(req.body_ref()).read_to_end(&mut decoded);
        if decode_result.is_ok() && decoded == expected_body {
            return http_status(200);
        }
    }
    http_status(400)
}

// =========================================================================
// Success checkpoint
// =========================================================================

#[tokio::test]
async fn success_checkpoint_preserves_oversized_claude_history_when_pruning_disabled() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, false);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, _) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"rawSize":{source_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true, "encoding": "zstd"}));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-unpruned-claude"}));
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = FinalSessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.history_size_bytes, source_size);
}

#[tokio::test]
async fn success_checkpoint_preserves_oversized_codex_history_when_pruning_disabled() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_codex_session_pruning(&mut runtime, false);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, _) = write_prunable_codex_history(session_id).unwrap();
    runtime.config.home_dir = history_dir.path().to_string_lossy().into_owned();
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let error = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Session history exceeds maximum size"),
        "disabled Codex pruning must retain the original hard-limit behavior: {error}"
    );
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn success_checkpoint_preserves_small_codex_history_when_pruning_enabled() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_codex_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, history) = write_prunable_codex_history(session_id).unwrap();
    std::fs::write(&history_path, &history).unwrap();
    runtime.config.home_dir = history_dir.path().to_string_lossy().into_owned();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-unpruned-codex"}));
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), history);
}

#[tokio::test]
async fn success_checkpoint_reconciles_claude_compact_generation_after_commit() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let upload_url = server.url("/test/pruned-claude-history-upload");
    let prepare_history_path = history_path.clone();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.respond_with(move |_| {
            if std::fs::metadata(&prepare_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(
                    200,
                    json!({
                        "presignedUrl": upload_url.clone(),
                        "existing": false
                    }),
                )
            } else {
                http_status(500)
            }
        });
    });
    let upload_len = history_size.to_string();
    let upload_body = candidate.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/pruned-claude-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_history_path = history_path.clone();
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#))
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.respond_with(move |_| {
            if std::fs::metadata(&checkpoint_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(200, json!({"checkpointId": "checkpoint-pruned-claude"}))
            } else {
                http_status(500)
            }
        });
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), candidate);

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = FinalSessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, FinalSessionHistoryFramework::ClaudeCode);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(identity.history_hash, history_hash);
    assert_eq!(
        std::path::Path::new(&identity.history_marker_payload),
        history_path
    );
}

#[tokio::test]
async fn success_checkpoint_reconciles_codex_compact_generation_after_commit() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_codex_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, candidate) = write_prunable_codex_history(session_id).unwrap();
    runtime.config.home_dir = history_dir.path().to_string_lossy().into_owned();
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let upload_url = server.url("/test/pruned-codex-history-upload");
    let prepare_history_path = history_path.clone();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.respond_with(move |_| {
            if std::fs::metadata(&prepare_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(
                    200,
                    json!({
                        "presignedUrl": upload_url.clone(),
                        "existing": false,
                    }),
                )
            } else {
                http_status(500)
            }
        });
    });
    let upload_len = history_size.to_string();
    let upload_body = candidate.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/pruned-codex-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |request| {
            upload_validation_response(request, &upload_body, &upload_len)
        });
    });
    let checkpoint_history_path = history_path.clone();
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#))
            .json_body_includes(r#"{"cliAgentType":"codex"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.respond_with(move |_| {
            if std::fs::metadata(&checkpoint_history_path)
                .is_ok_and(|metadata| metadata.len() == source_size)
            {
                json_http_response(200, json!({"checkpointId": "checkpoint-pruned-codex"}))
            } else {
                http_status(500)
            }
        });
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::read(&history_path).unwrap(), candidate);

    let identity_bytes =
        std::fs::read(runtime.paths.final_session_history_identity_file()).unwrap();
    let identity = FinalSessionHistoryIdentity::from_json_slice(&identity_bytes).unwrap();
    assert_eq!(identity.framework, FinalSessionHistoryFramework::Codex);
    assert_eq!(identity.history_size_bytes, history_size as u64);
    assert_eq!(identity.history_hash, history_hash);
    assert!(
        identity.history_marker_payload.contains(session_id),
        "Codex identity must retain the marker for the original thread"
    );
}

#[tokio::test]
async fn success_checkpoint_omits_identity_when_live_history_replacement_fails() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();
    let moved_history_dir = history_dir.path().with_extension("replacement-source");

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let history_size = candidate.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let replacement_history_path = history_path.clone();
    let replacement_moved_dir = moved_history_dir.clone();
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.respond_with(move |_| {
            let history_parent = replacement_history_path.parent().unwrap();
            std::fs::rename(history_parent, &replacement_moved_dir).unwrap();
            std::fs::create_dir(history_parent).unwrap();
            std::fs::rename(
                replacement_moved_dir.join(replacement_history_path.file_name().unwrap()),
                &replacement_history_path,
            )
            .unwrap();
            json_http_response(
                200,
                json!({"checkpointId": "checkpoint-pruned-unreconciled"}),
            )
        });
    });

    guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap();

    prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    std::fs::remove_dir_all(moved_history_dir).unwrap();
}

#[tokio::test]
async fn success_checkpoint_keeps_live_history_when_compact_commit_fails() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, candidate) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let history_hash = hex::encode(Sha256::digest(&candidate));
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });

    let error = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Invalid checkpoint API response")
    );
    prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
}

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
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
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
async fn success_checkpoint_writes_large_final_identity_metadata()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("success-large-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_history = zstd_session_history_for_test(&history)?;
    let zstd_size = zstd_history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/success-large-history-upload"),
                "existing": false,
                "encoding": "zstd"
            }));
    });
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/success-large-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_zstd_validation_response(req, &upload_body));
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
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_downgrades_to_gzip_when_zstd_prepare_is_rejected()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("fallback-gzip-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(400)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "Invalid enum value. Expected identity | gzip"
                }
            }));
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
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
        then.respond_with(move |req| upload_gzip_validation_response(req, &upload_body));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"fallback-gzip-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-success-gzip"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    zstd_prepare_mock.assert_calls_async(1).await;
    gzip_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_downgrades_when_zstd_prepare_is_not_acknowledged()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("zstd-unack-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/zstd-unack-history-upload"),
                "existing": false
            }));
    });
    let zstd_upload_mock = server.mock(|when, then| {
        when.method(PUT).path("/test/zstd-unack-history-upload");
        then.status(200);
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/zstd-unack-gzip-history-upload"),
                "existing": false,
                "encoding": "gzip"
            }));
    });
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/zstd-unack-gzip-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_gzip_validation_response(req, &upload_body));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"zstd-unack-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-zstd-unack"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    zstd_prepare_mock.assert_calls_async(1).await;
    zstd_upload_mock.assert_calls_async(0).await;
    gzip_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_gzip_prepare_without_encoding_acknowledgement()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("gzip-unack-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(400)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "Invalid enum value. Expected identity | gzip"
                }
            }));
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/gzip-unack-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT).path("/test/gzip-unack-history-upload");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "unexpected"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Prepare-history response did not acknowledge gzip"),
        "expected gzip acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    gzip_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_existing_gzip_without_encoding_acknowledgement()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir =
        write_literal_session_history("gzip-existing-unack-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(400)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "Invalid enum value. Expected identity | gzip"
                }
            }));
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "existing": true
            }));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "unexpected"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("Prepare-history response did not acknowledge gzip"),
        "expected gzip acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    gzip_prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_legacy_gzip_when_not_smaller_than_identity()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = long_distance_repeated_history();
    let _history_dir =
        write_literal_session_history("gzip-not-beneficial-session", &history).unwrap();

    let zstd_history = zstd_session_history_for_test(&history)?;
    let gzip_history = gzip_session_history_for_test(&history)?;
    assert!(
        zstd_history.len() < history.len(),
        "test fixture must be zstd-beneficial"
    );
    assert!(
        gzip_history.len() >= history.len(),
        "test fixture must not be gzip-beneficial"
    );

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_history.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(400)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "Invalid enum value. Expected identity | gzip"
                }
            }));
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/unexpected-gzip-history-upload"),
                "existing": false,
                "encoding": "gzip"
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/unexpected-gzip-history-upload");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "unexpected"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("legacy gzip session history was not smaller than identity"),
        "expected gzip fallback compression failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    gzip_prepare_mock.assert_calls_async(0).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_does_not_downgrade_zstd_auth_failure()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir =
        write_literal_session_history("zstd-auth-failure-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let zstd_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(401)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "unauthorized checkpoint history prepare"
                }
            }));
    });
    let gzip_prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"encoding":"gzip"}"#);
        then.status(200).json_body(json!({
            "presignedUrl": server.url("/test/unexpected-gzip-history-upload"),
            "existing": false,
            "encoding": "gzip"
        }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/unexpected-gzip-history-upload");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "unexpected"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("unauthorized checkpoint history prepare"),
        "expected auth failure to propagate, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    gzip_prepare_mock.assert_calls_async(0).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_uploads_large_non_utf8_session_history_as_zstd_when_acknowledged()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let mut history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    history.extend_from_slice(&[0xc3, 0x28, b'\n']);
    let _history_dir = write_literal_session_history("large-non-utf8-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let zstd_size = zstd_session_history_for_test(&history)?.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{zstd_size}}}"#))
            .json_body_includes(r#"{"encoding":"zstd"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/large-non-utf8-history-upload"),
                "existing": false,
                "encoding": "zstd"
            }));
    });
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/large-non-utf8-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_zstd_validation_response(req, &upload_body));
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
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_uploads_large_uncompressible_session_history_as_identity()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = high_entropy_history(LARGE_SESSION_HISTORY_SIZE_BYTES);
    let zstd_history = zstd_session_history_for_test(&history)?;
    assert!(
        zstd_history.len() >= history.len(),
        "test fixture must not be zstd-compressible"
    );
    let _history_dir = write_literal_session_history("large-identity-session", &history).unwrap();

    let history_hash = hex::encode(Sha256::digest(&history));
    let history_size = history.len();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"runId":"test-run-001"}"#)
            .json_body_includes(format!(r#"{{"hash":"{history_hash}"}}"#))
            .json_body_includes(format!(r#"{{"rawSize":{history_size}}}"#))
            .json_body_includes(format!(r#"{{"encodedSize":{history_size}}}"#))
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/large-identity-history-upload"),
                "existing": false
            }));
    });
    let upload_len = history_size.to_string();
    let upload_body = history.clone();
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/large-identity-history-upload")
            .header("Content-Type", "application/octet-stream");
        then.respond_with(move |req| upload_validation_response(req, &upload_body, &upload_len));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"large-identity-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-large-identity"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
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
    let run_payload_file = crate::common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload::default(),
    )
    .unwrap();
    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "captured-run".to_string(),
        api_url: server.base_url(),
        api_token: "test-token-abc123".to_string(),
        cli_agent_type: "claude-code".to_string(),
        home: Some(home_dir.to_string_lossy().into_owned()),
        run_payload_file: run_payload_file.to_string_lossy().into_owned(),
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
            .json_body_includes(format!(r#"{{"rawSize":{}}}"#, history.len()))
            .json_body_includes(format!(r#"{{"encodedSize":{}}}"#, history.len()))
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

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_claude_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_claude_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, _) = write_prunable_claude_history(session_id).unwrap();
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let error = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Session history line 1 is not valid JSON"),
        "recovery checkpoint should validate the original history: {error}"
    );
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn recovery_checkpoint_does_not_prune_eligible_codex_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    set_codex_session_pruning(&mut runtime, true);
    let _files_guard = SessionCheckpointFilesGuard::new();
    let session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (history_dir, history_path, _) = write_prunable_codex_history(session_id).unwrap();
    runtime.config.home_dir = history_dir.path().to_string_lossy().into_owned();
    let source_size = std::fs::metadata(&history_path).unwrap().len();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/checkpoints");
        then.status(200);
    });

    let error = guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&runtime)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Session history exceeds maximum size"),
        "recovery checkpoint must retain the original Codex hard-limit behavior: {error}"
    );
    assert_eq!(std::fs::metadata(&history_path).unwrap().len(), source_size);
    assert!(!std::path::Path::new(runtime.paths.final_session_history_identity_file()).exists());
    prepare_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
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
