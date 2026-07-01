//! Integration coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_runs_initial_turn_and_synthesizes_thread_started()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-test",
                prompt: "drive the app-server backend",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());
    assert!(cli_result.last_event_sequence.is_none());

    let events = read_agent_log_events()?;
    assert_event_type_sequence(
        &events,
        &[
            "thread.started",
            "turn.started",
            "item.completed",
            "turn.completed",
        ],
    );

    let thread_id = events[0]
        .get("thread_id")
        .and_then(Value::as_str)
        .ok_or("thread.started missing thread_id")?;
    let stored_id = std::fs::read_to_string(guest_agent::paths::session_id_file())?;
    assert_eq!(stored_id, thread_id);
    let marker = std::fs::read_to_string(guest_agent::paths::session_history_path_file())?;
    assert!(marker.starts_with("CODEX_SEARCH:"));
    assert!(marker.ends_with(&format!(":{thread_id}")));
    assert_eq!(masker.mask_string(thread_id), "***");

    let session_events = read_codex_session_history_events()?;
    let input_event = session_events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .ok_or("missing mock app-server input event")?;
    assert_eq!(
        input_event
            .get("thread_request_has_runtime_workspace_roots")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        input_event
            .get("turn_request_has_runtime_workspace_roots")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        input_event.get("turn_request_cwd").and_then(Value::as_str),
        Some(guest_agent::paths::CANONICAL_WORKING_DIR)
    );
    assert_eq!(
        input_event
            .get("turn_request_approval_policy")
            .and_then(Value::as_str),
        Some("never")
    );
    assert_eq!(
        input_event
            .get("turn_request_approvals_reviewer")
            .and_then(Value::as_str),
        Some("user")
    );
    assert_eq!(
        input_event
            .pointer("/turn_request_sandbox_policy/type")
            .and_then(Value::as_str),
        Some("dangerFullAccess")
    );

    Ok(())
}

fn read_agent_log_events() -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(guest_agent::paths::agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn read_codex_session_history_events() -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let history = guest_agent::session_history::read_session_history(
        guest_agent::paths::session_history_path_file(),
    )?;
    let history = String::from_utf8(history)?;
    history
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn assert_event_type_sequence(events: &[Value], expected: &[&str]) {
    let actual = events
        .iter()
        .map(|event| event.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let expected = expected
        .iter()
        .map(|value| Some(*value))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}
