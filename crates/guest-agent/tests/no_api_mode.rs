//! No-API mode is used by local/reap tests and skips all webhook calls.
//!
//! This test captures an explicit runtime from process env, then exercises
//! disabled-HTTP users through explicit runtime/config/path entry points. The
//! `send_event` call intentionally remains legacy compatibility coverage for
//! no-API session metadata capture.

mod common;

use common::SystemLogOverrideGuard;
use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn cleanup_session_files(paths: &GuestPaths) {
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.session_history_path_file());
}

fn cleanup_run_files(paths: &GuestPaths) {
    let _ = std::fs::remove_file(paths.agent_log_file());
    let _ = std::fs::remove_file(paths.event_error_flag());
    cleanup_session_files(paths);
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
}

struct RunFilesGuard {
    paths: GuestPaths,
}

impl RunFilesGuard {
    fn new(paths: &GuestPaths) -> Self {
        cleanup_run_files(paths);
        Self {
            paths: paths.clone(),
        }
    }

    fn ops_file(&self) -> &str {
        self.paths.sandbox_ops_file()
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files(&self.paths);
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

    let runtime = GuestRuntime::from_process_env()?;
    let http = runtime.http.clone();
    let run_files = RunFilesGuard::new(&runtime.paths);
    let ops_file = run_files.ops_file();

    let disabled = http
        .post_json("http://127.0.0.1:1/should-not-send", &json!({}), 1)
        .await;
    let Err(AgentError::Http(message)) = disabled else {
        return Err("direct HTTP use should fail when no API token is configured".into());
    };
    assert!(message.contains("HTTP client is disabled"));

    let masker = Arc::new(SecretMasker::from_raw(""));
    let telemetry = guest_agent::telemetry::Telemetry::spawn_for_paths(
        runtime.config.run_id.clone(),
        &runtime.paths,
        Arc::clone(&masker),
        http.clone(),
    );
    telemetry.final_flush_and_shutdown().await?;

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

    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "session-no-api",
        "cwd": tmp.path().to_string_lossy(),
    });
    guest_agent::events::send_event(&http, event, 1, &masker).await?;
    assert_eq!(
        std::fs::read_to_string(runtime.paths.session_id_file())?,
        "session-no-api"
    );
    cleanup_session_files(&runtime.paths);

    let complete_log_path = tmp.path().join("complete-system.log");
    let complete_log_guard = SystemLogOverrideGuard::set(&complete_log_path);
    guest_agent::complete::report_success_for_run(
        &http,
        &runtime.config.run_id,
        "sandbox-no-api",
        "reused",
        Some(1),
    )
    .await;
    drop(complete_log_guard);
    let complete_log = std::fs::read_to_string(&complete_log_path).unwrap_or_default();
    assert!(
        !complete_log.contains("Complete webhook failed"),
        "no-API complete path must return before touching the disabled HTTP client: {complete_log}"
    );

    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        false,
        &runtime.config.prompt,
    );
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &masker,
            common::spawn_dummy_heartbeat(),
            http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("no-API execute_cli should return promptly with disabled HTTP client")?;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence, None,
        "no-API execute_cli must not enqueue webhook events"
    );
    assert!(
        !std::path::Path::new(runtime.paths.event_error_flag()).exists(),
        "no-API execute_cli must not write event error flag"
    );
    let cli_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert!(
        cli_session_id.starts_with("mock-"),
        "no-API execute_cli should capture session metadata from stdout events, got {cli_session_id}"
    );
    let cli_history_path = std::fs::read_to_string(runtime.paths.session_history_path_file())?;
    assert!(
        cli_history_path.contains(cli_session_id.trim()),
        "history path should contain the captured CLI session id, got {cli_history_path}"
    );
    assert!(
        cli_history_path.trim_end().ends_with(".jsonl"),
        "history path should be the Claude JSONL path captured from stdout events, got {cli_history_path}"
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

    Ok(())
}
