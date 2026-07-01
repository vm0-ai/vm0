//! Scope validation coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_unexpected_thread_event_scope()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-scope-test",
                prompt: "drive the app-server backend scope failure path",
                scenario: Some("unexpected-thread-turn-completed"),
                resume_session_id: None,
            },
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
        ),
    )
    .await
    .expect("execute_cli should return promptly");

    let error = result.expect_err("unexpected thread event should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("unexpected thread id"),
        "unexpected error: {message}"
    );

    let events = read_agent_log_events()?;
    assert!(
        events.iter().all(|event| {
            event.get("thread_id").and_then(Value::as_str) != Some("unexpected-thread-id")
        }),
        "unexpected-thread-id event should not be written to the agent log: {events:?}"
    );

    Ok(())
}

fn read_agent_log_events() -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(guest_agent::paths::agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
