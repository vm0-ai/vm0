use super::support::*;
use crate::support::*;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
};
use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn success_checkpoint_history_preparation_yields_to_runtime_siblings() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history_dir = tempfile::tempdir().unwrap();
    let history_path = history_dir.path().join("blocking-history.jsonl");
    create_fifo(&history_path).unwrap();

    let session_id = "blocking-history-session";
    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id).unwrap();
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .unwrap();

    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history")
            .json_body_includes(r#"{"encoding":"identity"}"#);
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"existing": true}));
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{session_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-runtime-yield"}));
    });

    let history = b"{\"type\":\"system\"}\n".to_vec();
    let (release_writer_tx, release_writer_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let open_deadline = Instant::now() + Duration::from_secs(10);
        let mut fifo = loop {
            match OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&history_path)
            {
                Ok(fifo) => break fifo,
                Err(error)
                    if error.raw_os_error() == Some(libc::ENXIO)
                        && Instant::now() < open_deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("open history FIFO for writing: {error}"),
            }
        };
        release_writer_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        fifo.write_all(&history).unwrap();
    });

    let (runtime_progress_tx, runtime_progress_rx) = mpsc::channel();
    let watchdog_release_tx = release_writer_tx.clone();
    let watchdog = thread::spawn(move || {
        if runtime_progress_rx
            .recv_timeout(Duration::from_secs(5))
            .is_ok()
        {
            false
        } else {
            watchdog_release_tx.send(()).unwrap();
            true
        }
    });

    let (checkpoint_result, ()) = tokio::join!(
        biased;
        guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime),
        async {
            runtime_progress_tx.send(()).unwrap();
            release_writer_tx.send(()).unwrap();
        },
    );

    writer.join().unwrap();
    let watchdog_released_writer = watchdog.join().unwrap();
    checkpoint_result.unwrap();
    assert!(
        !watchdog_released_writer,
        "checkpoint history preparation blocked the runtime thread"
    );
    prepare_mock.assert_calls_async(1).await;
    checkpoint_mock.assert_calls_async(1).await;
}

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
async fn success_checkpoint_preserves_small_codex_history() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mut runtime = runtime_from_process_env().unwrap();
    runtime.config.framework = guest_agent::env::Framework::Codex;
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
    runtime.config.framework = guest_agent::env::Framework::Codex;
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
async fn success_checkpoint_propagates_zstd_prepare_bad_request()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir = write_literal_session_history("zstd-bad-request-session", &history).unwrap();

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
                    "message": "Session history encoded size does not match the existing blob"
                }
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
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
            .contains("Session history encoded size does not match the existing blob"),
        "expected prepare-history error to propagate, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_missing_zstd_encoding_acknowledgement()
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
            .contains("Prepare-history response did not acknowledge zstd"),
        "expected zstd acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    zstd_upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_rejects_new_zstd_with_mismatched_encoding_acknowledgement()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir =
        write_literal_session_history("zstd-new-mismatched-ack-session", &history).unwrap();

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
                "presignedUrl": server.url("/test/zstd-new-mismatched-ack-upload"),
                "existing": false,
                "encoding": "identity"
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/zstd-new-mismatched-ack-upload");
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
            .contains("Prepare-history response did not acknowledge zstd"),
        "expected zstd acknowledgement failure, got: {err}"
    );
    zstd_prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(0).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_accepts_existing_gzip_for_zstd_history()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let runtime = runtime_from_process_env().unwrap();
    let _files_guard = SessionCheckpointFilesGuard::new();
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    let _history_dir =
        write_literal_session_history("zstd-existing-gzip-session", &history).unwrap();

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
                "existing": true,
                "encoding": "gzip"
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(r#"{"cliAgentSessionId":"zstd-existing-gzip-session"}"#)
            .json_body_includes(format!(
                r#"{{"cliAgentSessionHistoryHash":"{history_hash}"}}"#
            ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "checkpoint-existing-gzip"}));
    });

    let result = guest_agent::checkpoint::create_checkpoint_for_runtime(&runtime).await;

    assert!(result.is_ok());
    prepare_mock.assert_calls_async(1).await;
    upload_mock.assert_calls_async(0).await;
    checkpoint_mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn success_checkpoint_propagates_zstd_auth_failure() -> Result<(), Box<dyn std::error::Error>>
{
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
    let upload_mock = server.mock(|when, then| {
        when.method(PUT);
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
