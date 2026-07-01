//! Integration tests for codex session-resume metadata capture.
//!
//! # Why a dedicated test binary
//!
//! The pre-existing `tests/integration/mod.rs` binary defaults to Claude. This
//! binary keeps Codex metadata tests separate so their setup can stay focused
//! on Codex config and file layout.
//!
//! Each test serialises behind a `std::sync::Mutex` because they touch the same
//! on-disk session-id / history-path files.
//!
//! # Coverage
//!
//! - End-to-end `send_event` → session metadata capture → marker write for the
//!   codex `thread.started` event shape.
//! - Checkpoint metadata remains repairable after a partial metadata write.
//! - Invalid/non-Codex events do not persist Codex session metadata.

mod common;

use common::SystemLogOverrideGuard;
use httpmock::prelude::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use guest_agent::masker::SecretMasker;

static CODEX_RESUME_HOME: LazyLock<PathBuf> =
    LazyLock::new(|| common::unique_temp_path("codex-resume-home"));
static CODEX_RESUME_RUN_ID: LazyLock<String> =
    LazyLock::new(|| format!("codex-resume-{}", std::process::id()));

/// Serialise tests — they share the run-id-scoped runtime metadata files
/// written by session metadata capture.
static TEST_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn send_event_for_test(
    event: serde_json::Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), guest_agent::error::AgentError> {
    let config = codex_resume_config("http://127.0.0.1:1", "")
        .map_err(guest_agent::error::AgentError::Execution)?;
    let paths = codex_resume_paths();
    let http = guest_agent::http::HttpClient::for_config(&config)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(guest_agent::events::send_event_for_config(
        &http, event, seq, masker, &config, &paths,
    ))
}

fn codex_resume_paths() -> guest_agent::paths::GuestPaths {
    guest_agent::paths::GuestPaths::from_runtime_dir(codex_resume_runtime_dir())
}

fn codex_resume_runtime_dir() -> PathBuf {
    CODEX_RESUME_HOME
        .join(".vm0")
        .join("guest-agent")
        .join("runs")
        .join(CODEX_RESUME_RUN_ID.as_str())
}

fn codex_resume_config(
    api_url: &str,
    api_token: &str,
) -> Result<guest_agent::env::GuestConfig, String> {
    guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: CODEX_RESUME_RUN_ID.clone(),
        api_url: api_url.to_string(),
        api_token: api_token.to_string(),
        sandbox_id: "00000000-0000-4000-8000-000000000abc".to_string(),
        sandbox_reuse_result: "reused".to_string(),
        prompt: "test prompt".to_string(),
        cli_agent_type: "codex".to_string(),
        home: Some(CODEX_RESUME_HOME.to_string_lossy().into_owned()),
        guest_runtime_dir: Some(codex_resume_runtime_dir()),
        ..Default::default()
    })
}

fn session_file_paths() -> (String, String) {
    let paths = codex_resume_paths();
    (
        paths.session_id_file().to_string(),
        paths.session_history_path_file().to_string(),
    )
}

/// Wipe the per-run session-id / history-path files so each test starts
/// from a clean slate. Session metadata capture is idempotent (first id wins),
/// so leaving stale files would mask real failures.
fn reset_session_files() {
    let (session_id_file, session_history_path_file) = session_file_paths();
    let _ = std::fs::remove_file(session_id_file);
    let _ = std::fs::remove_file(session_history_path_file);
}

struct CodexResumeFilesGuard;

impl CodexResumeFilesGuard {
    fn new() -> Self {
        cleanup_codex_resume_files();
        Self
    }
}

impl Drop for CodexResumeFilesGuard {
    fn drop(&mut self) {
        cleanup_codex_resume_files();
    }
}

fn cleanup_codex_resume_files() {
    reset_session_files();
    let home = CODEX_RESUME_HOME.as_path();
    let is_test_home = home
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("codex-resume-home-"))
        .unwrap_or(false);
    if is_test_home && home.starts_with(std::env::temp_dir()) {
        let _ = std::fs::remove_dir_all(home);
    }
}

fn write_codex_session_file(thread_id: &str, history: &str) -> Result<(), String> {
    let id_no_dashes = thread_id.replace('-', "");
    let path = CODEX_RESUME_HOME
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("06")
        .join("18")
        .join(format!("rollout-2026-06-18T10-00-00-{id_no_dashes}.jsonl"));
    let parent = path
        .parent()
        .ok_or_else(|| format!("session path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create codex session dir {}: {e}", parent.display()))?;
    std::fs::write(&path, history)
        .map_err(|e| format!("write codex session history {}: {e}", path.display()))?;
    Ok(())
}

fn checkpoint_http_client(
    server: &MockServer,
) -> Result<guest_agent::http::HttpClient, guest_agent::error::AgentError> {
    guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        Duration::ZERO,
    )
}

#[test]
fn send_event_extracts_codex_thread_id_and_writes_marker() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": thread_id
    });

    // No API token -> send_event skips the HTTP POST but still captures
    // session metadata, which is the part we want to assert.
    let result = send_event_for_test(event, 1, &masker);
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let (session_id_file, session_history_path_file) = session_file_paths();
    let stored_id = std::fs::read_to_string(&session_id_file).expect("session id written");
    assert_eq!(stored_id, thread_id);

    let marker =
        std::fs::read_to_string(&session_history_path_file).expect("history-path file written");
    assert!(
        marker.starts_with("CODEX_SEARCH:"),
        "codex framework should write a marker, got: {marker}"
    );
    assert!(
        marker.contains("/.codex/sessions:"),
        "marker should embed the codex sessions dir, got: {marker}"
    );
    assert!(
        marker.ends_with(&format!(":{thread_id}")),
        "marker should end with the thread id, got: {marker}"
    );
    assert_eq!(masker.mask_string(thread_id), "***");

    let system_log = std::fs::read_to_string(&system_log_path).expect("system log written");
    assert!(
        system_log.contains("Session history marker written to"),
        "system log should confirm marker creation, got: {system_log}"
    );
    assert!(
        !system_log.contains(thread_id),
        "system log must not contain the raw thread id, got: {system_log}"
    );
    assert!(
        !system_log.contains("CODEX_SEARCH"),
        "system log must not contain the codex marker payload, got: {system_log}"
    );
    assert!(
        !system_log.contains(&marker),
        "system log must not contain the full marker payload, got: {system_log}"
    );
}

#[test]
fn send_event_canonicalizes_codex_thread_id_before_writing_marker() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": "0193ABCDEF01723489ABCDEF01234567"
    });
    let expected = "0193abcd-ef01-7234-89ab-cdef01234567";

    let result = send_event_for_test(event, 1, &masker);
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let (session_id_file, session_history_path_file) = session_file_paths();
    let stored_id = std::fs::read_to_string(&session_id_file).expect("session id written");
    assert_eq!(stored_id, expected);

    let marker =
        std::fs::read_to_string(&session_history_path_file).expect("history-path file written");
    assert!(
        marker.ends_with(&format!(":{expected}")),
        "marker should use canonical thread id, got: {marker}"
    );
}

#[test]
fn send_event_seeds_existing_codex_thread_id_without_repairing_history_marker() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    for seed_empty_marker in [false, true] {
        reset_session_files();
        let (session_id_file, session_history_path_file) = session_file_paths();
        guest_agent::paths::write_private(&session_id_file, thread_id)
            .expect("seed existing session id");
        if seed_empty_marker {
            guest_agent::paths::write_private(&session_history_path_file, "")
                .expect("seed empty history marker");
        } else {
            assert!(
                !Path::new(&session_history_path_file).exists(),
                "history marker should start missing"
            );
        }

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "turn.completed"});

        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        let stored_id = std::fs::read_to_string(&session_id_file).expect("session id kept");
        assert_eq!(stored_id, thread_id);
        if seed_empty_marker {
            assert_eq!(
                std::fs::read_to_string(&session_history_path_file).unwrap(),
                "",
                "ordinary events must not repair empty history markers"
            );
        } else {
            assert!(
                !Path::new(&session_history_path_file).exists(),
                "ordinary events must not create missing history markers"
            );
        }
        assert_eq!(masker.mask_string(thread_id), "***");
    }
}

#[test]
fn recovery_checkpoint_derives_missing_codex_history_marker() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let history = r#"{"type":"thread.started"}"#.to_string() + "\n";
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, thread_id)
        .expect("seed existing session id");
    write_codex_session_file(thread_id, &history).unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    let server = MockServer::start();
    let prepare_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints/prepare-history");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/codex-derived-history-upload"),
                "existing": false
            }));
    });
    let upload_mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/codex-derived-history-upload")
            .body(history.as_str());
        then.status(200);
    });
    let checkpoint_mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/checkpoints")
            .json_body_includes(format!(r#"{{"cliAgentSessionId":"{thread_id}"}}"#));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"checkpointId": "codex-derived-checkpoint"}));
    });

    let config =
        codex_resume_config(&server.base_url(), "test-token").expect("build codex resume config");
    let paths = codex_resume_paths();
    let http = checkpoint_http_client(&server).expect("build http client");
    let guest_runtime = guest_agent::run_context::GuestRuntime {
        config,
        paths,
        http,
    };
    let result = runtime
        .block_on(guest_agent::checkpoint::create_recovery_checkpoint_for_runtime(&guest_runtime));

    assert!(result.is_ok());
    prepare_mock.assert_calls(1);
    upload_mock.assert_calls(1);
    checkpoint_mock.assert_calls(1);
}

#[test]
fn send_event_codex_ignores_non_thread_started_event() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    let (session_id_file, _) = session_file_paths();
    assert!(
        !Path::new(&session_id_file).exists(),
        "session id file must not be written for non-thread.started events"
    );
}

#[test]
fn send_event_codex_ignores_empty_thread_id() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": ""});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    let (session_id_file, _) = session_file_paths();
    assert!(
        !Path::new(&session_id_file).exists(),
        "empty thread_id must not be persisted"
    );
}

#[test]
fn send_event_codex_ignores_malformed_thread_id() {
    let _guard = TEST_MUTEX.lock().unwrap();
    let _files_guard = CodexResumeFilesGuard::new();

    for thread_id in [
        "abc",
        "0193-abcd-ef01-7234-89abcdef01234567",
        "{0193abcd-ef01-7234-89ab-cdef01234567}",
        "urn:uuid:0193abcd-ef01-7234-89ab-cdef01234567",
    ] {
        reset_session_files();

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "thread.started", "thread_id": thread_id});
        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        let (session_id_file, _) = session_file_paths();
        assert!(
            !Path::new(&session_id_file).exists(),
            "malformed thread_id must not be persisted: {thread_id}"
        );
        if thread_id.len() >= 5 {
            assert_eq!(masker.mask_string(thread_id), "***");
        } else {
            assert_eq!(masker.mask_string(thread_id), thread_id);
        }
    }
}
