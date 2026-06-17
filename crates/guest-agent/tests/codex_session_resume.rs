//! Integration tests for codex session-resume metadata capture.
//!
//! # Why a dedicated test binary
//!
//! `guest_agent::env::Framework` and the rest of the env accessors are
//! cached in process-wide `LazyLock`s on first read. The pre-existing
//! `tests/integration/mod.rs` binary defaults to Claude (no `CLI_AGENT_TYPE`
//! set), so it can't also exercise the codex branch — once `Framework`
//! is locked to `ClaudeCode`, the codex path becomes unreachable in that
//! process. Splitting codex coverage into a separate test binary gives
//! it a fresh `LazyLock` state with `CLI_AGENT_TYPE=codex`.
//!
//! Each test still serialises behind a `std::sync::Mutex` because they share
//! that single set of LazyLocks and because they touch the same on-disk
//! session-id / history-path files (run-id-scoped under `/tmp`).
//!
//! # Coverage
//!
//! - End-to-end `send_event` → `capture_session_metadata` → marker write for the
//!   codex `thread.started` event shape.
//! - Marker repair after a partial metadata write.
//! - Invalid/non-Codex events do not persist Codex session metadata.

mod common;

use common::SystemLogOverrideGuard;
use serde_json::json;
use std::path::Path;
use std::sync::{LazyLock, Mutex, Once};

use guest_agent::masker::SecretMasker;

/// Configure the process env BEFORE any `guest_agent::env` LazyLock
/// initialiser runs. Idempotent — only the first call wins.
fn setup_env_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // SAFETY: this `Once` runs on the first test, before any test
        // body has read `guest_agent::env::*`. No other thread is
        // touching the env at this point.
        unsafe {
            std::env::set_var("CLI_AGENT_TYPE", "codex");
            // Empty API token → `send_event` skips the HTTP POST after
            // running session-id extraction (which is the part we want
            // to assert against).
            std::env::set_var("VM0_API_TOKEN", "");
            std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
            std::env::set_var("VM0_RUN_ID", format!("codex-resume-{}", std::process::id()));
            std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
            std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
            std::env::set_var("VM0_PROMPT", "test prompt");
            // `home_dir` is loaded eagerly via `expect`. The marker
            // payload embeds it, so set a stable dummy.
            std::env::set_var("HOME", "/tmp/codex-resume-home");
        }
    });
}

/// Serialise tests — they share both LazyLock state and the run-id-scoped
/// runtime metadata files written by `capture_session_metadata`.
static TEST_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

macro_rules! http_client {
    () => {
        guest_agent::http::HttpClient::new().unwrap()
    };
}

fn send_event_for_test(
    event: serde_json::Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), guest_agent::error::AgentError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let http = http_client!();
    runtime.block_on(guest_agent::events::send_event(&http, event, seq, masker))
}

/// Wipe the per-run session-id / history-path files so each test starts
/// from a clean slate. `capture_session_metadata` is idempotent (first id wins),
/// so leaving stale files would mask real failures.
fn reset_session_files() {
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
}

#[test]
fn send_event_extracts_codex_thread_id_and_writes_marker() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "thread.started",
        "thread_id": thread_id
    });

    // No API token → send_event skips the HTTP POST but still captures
    // session metadata, which is the part we want to assert.
    let result = send_event_for_test(event, 1, &masker);
    assert!(
        result.is_ok(),
        "send_event should succeed when no API token"
    );

    let stored_id =
        std::fs::read_to_string(guest_agent::paths::session_id_file()).expect("session id written");
    assert_eq!(stored_id, thread_id);

    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
        .expect("history-path file written");
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
        !system_log.contains("CODEX_SEARCH:"),
        "system log must not contain the codex marker payload, got: {system_log}"
    );
    assert!(
        !system_log.contains(&marker),
        "system log must not contain the full marker payload, got: {system_log}"
    );
}

#[test]
fn send_event_canonicalizes_codex_thread_id_before_writing_marker() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

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

    let stored_id =
        std::fs::read_to_string(guest_agent::paths::session_id_file()).expect("session id written");
    assert_eq!(stored_id, expected);

    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
        .expect("history-path file written");
    assert!(
        marker.ends_with(&format!(":{expected}")),
        "marker should use canonical thread id, got: {marker}"
    );
}

#[test]
fn send_event_repairs_missing_codex_history_marker_after_later_event() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();

    let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
    for seed_empty_marker in [false, true] {
        reset_session_files();
        guest_agent::paths::write_private(guest_agent::paths::session_id_file(), thread_id)
            .expect("seed existing session id");
        if seed_empty_marker {
            guest_agent::paths::write_private(guest_agent::paths::session_history_path_file(), "")
                .expect("seed empty history marker");
        } else {
            assert!(
                !Path::new(guest_agent::paths::session_history_path_file()).exists(),
                "history marker should start missing"
            );
        }

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "turn.completed"});

        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        let stored_id = std::fs::read_to_string(guest_agent::paths::session_id_file())
            .expect("session id kept");
        assert_eq!(stored_id, thread_id);
        let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())
            .expect("history marker repaired");
        assert!(
            marker.ends_with(&format!(":{thread_id}")),
            "repaired marker should point at the existing thread id, got: {marker}"
        );
    }
}

#[test]
fn send_event_codex_ignores_non_thread_started_event() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "turn.completed"});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "session id file must not be written for non-thread.started events"
    );
}

#[test]
fn send_event_codex_ignores_empty_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();
    reset_session_files();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "thread.started", "thread_id": ""});
    let result = send_event_for_test(event, 1, &masker);
    assert!(result.is_ok());

    assert!(
        !Path::new(guest_agent::paths::session_id_file()).exists(),
        "empty thread_id must not be persisted"
    );
}

#[test]
fn send_event_codex_ignores_malformed_thread_id() {
    setup_env_once();
    let _guard = TEST_MUTEX.lock().unwrap();

    for thread_id in ["abc", "0193-abcd-ef01-7234-89abcdef01234567"] {
        reset_session_files();

        let masker = SecretMasker::from_raw("");
        let event = json!({"type": "thread.started", "thread_id": thread_id});
        let result = send_event_for_test(event, 1, &masker);
        assert!(result.is_ok());

        assert!(
            !Path::new(guest_agent::paths::session_id_file()).exists(),
            "malformed thread_id must not be persisted: {thread_id}"
        );
        if thread_id.len() >= 5 {
            assert_eq!(masker.mask_string(thread_id), "***");
        } else {
            assert_eq!(masker.mask_string(thread_id), thread_id);
        }
    }
}
