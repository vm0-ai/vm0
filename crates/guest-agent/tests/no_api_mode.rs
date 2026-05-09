//! No-API mode is used by local/reap tests and skips all webhook calls.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! environment values in process-wide `LazyLock`s.

mod common;

use guest_agent::error::AgentError;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    fn set(path: &std::path::Path) -> Self {
        guest_common::log::set_system_log_file(path.to_string_lossy().as_ref());
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        guest_common::log::clear_system_log_file();
    }
}

#[tokio::test]
async fn no_api_mode_drains_background_webhook_users_without_network_client()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@exit-after-result", 3, 1)?;
    }

    let http = HttpClient::for_current_env()?;
    let _ = std::fs::remove_file(guest_agent::paths::event_error_flag());
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    let ops_file = guest_common::telemetry::sandbox_ops_log();
    let _ = std::fs::remove_file(ops_file);

    let disabled = http
        .post_json("http://127.0.0.1:1/should-not-send", &json!({}), 1)
        .await;
    let Err(AgentError::Http(message)) = disabled else {
        return Err("direct HTTP use should fail when no API token is configured".into());
    };
    assert!(message.contains("HTTP client is disabled"));

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn(Arc::clone(&masker), http.clone());
    telemetry
        .flush(guest_agent::telemetry::UploadMode::Final)
        .await?;
    telemetry.shutdown().await;

    let shutdown = CancellationToken::new();
    let heartbeat = tokio::spawn(guest_agent::heartbeat::heartbeat_loop(
        http.clone(),
        shutdown.clone(),
    ));
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(1), heartbeat)
        .await
        .expect("heartbeat should exit promptly after shutdown in no-API mode")
        .expect("heartbeat task should not panic")?;

    let mut event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "session-no-api",
        "cwd": tmp.path().to_string_lossy(),
    });
    guest_agent::events::send_event(&http, &mut event, 1, &masker).await?;
    assert_eq!(
        std::fs::read_to_string(guest_agent::paths::session_id_file())?,
        "session-no-api"
    );

    let complete_log_path = tmp.path().join("complete-system.log");
    let complete_log_guard = SystemLogOverrideGuard::set(&complete_log_path);
    guest_agent::complete::report_success(&http, "sandbox-no-api", "reused", Some(1)).await;
    drop(complete_log_guard);
    let complete_log = std::fs::read_to_string(&complete_log_path).unwrap_or_default();
    assert!(
        !complete_log.contains("Complete webhook failed"),
        "no-API complete path must return before touching the disabled HTTP client: {complete_log}"
    );

    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(&masker, common::spawn_dummy_heartbeat(), http.clone()),
    )
    .await
    .expect("no-API execute_cli should return promptly with disabled HTTP client")?;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence, None,
        "no-API execute_cli must not enqueue webhook events"
    );
    assert!(
        !std::path::Path::new(guest_agent::paths::event_error_flag()).exists(),
        "no-API execute_cli must not write event error flag"
    );
    let ops = std::fs::read_to_string(ops_file)?;
    let cli_exit_metric_count = ops
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|entry| {
            entry["action_type"] == "last_read_event_to_cli_exit"
                && entry["success"] == true
                && entry["duration_ms"].as_u64().is_some()
        })
        .count();
    assert_eq!(
        cli_exit_metric_count, 1,
        "execute_cli should record exactly one last-read-event to CLI-exit sandbox op: {ops}"
    );

    let _ = std::fs::remove_file(guest_agent::paths::event_error_flag());
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    Ok(())
}
