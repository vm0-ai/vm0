//! Failure diagnostics must mask a session ID carried by the same JSONL event.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;

struct SystemLogGuard;

impl SystemLogGuard {
    fn set(path: &std::path::Path) -> Self {
        guest_common::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

#[tokio::test]
async fn cli_failure_diagnostic_masks_session_id_from_same_event()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let session_id = "result-session-secret-123";
    let prompt = format!(
        "@ECHO@\n{}",
        json!({
            "type": "result",
            "subtype": "error",
            "session_id": session_id,
            "is_error": true,
            "duration_ms": 100,
            "num_turns": 1,
            "result": format!("failed for {session_id}"),
            "total_cost_usd": 0,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        })
    );

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
    }

    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogGuard::set(&system_log_path);
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

    let failure_diagnostic = cli_result
        .failure_diagnostic
        .as_ref()
        .expect("result event should produce a failure diagnostic");
    assert_eq!(failure_diagnostic.message, "failed for ***");
    assert!(
        !failure_diagnostic.message.contains(session_id),
        "failure diagnostic leaked session id: {}",
        failure_diagnostic.message
    );

    let system_log = std::fs::read_to_string(&system_log_path)?;
    assert!(
        system_log.contains("Claude JSONL failure result"),
        "system log should include the failure diagnostic log, got: {system_log}"
    );
    assert!(
        system_log.contains("failed for ***"),
        "system log should mask the same-event session id, got: {system_log}"
    );
    assert!(
        !system_log.contains(session_id),
        "system log leaked session id: {system_log}"
    );

    Ok(())
}
