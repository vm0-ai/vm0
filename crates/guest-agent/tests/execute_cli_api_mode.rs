//! API-enabled `execute_cli` should capture session metadata from stdout events
//! while still delivering webhook events.
//!
//! This test lives in its own binary because `guest_agent::env` and
//! `guest_agent::paths` cache process-wide `VM0_*` values in `LazyLock`s.

mod common;

use base64::Engine;
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::path::Path;
use std::time::Duration;

struct RunFilesGuard {
    ops_file: String,
}

impl RunFilesGuard {
    fn new() -> Self {
        let ops_file = guest_common::telemetry::sandbox_ops_log().to_string();
        cleanup_run_files(&ops_file);
        Self { ops_file }
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files(&self.ops_file);
    }
}

fn cleanup_run_files(ops_file: &str) {
    let _ = std::fs::remove_file(guest_agent::paths::agent_log_file());
    let _ = std::fs::remove_file(guest_agent::paths::event_error_flag());
    let _ = std::fs::remove_file(guest_agent::paths::session_id_file());
    let _ = std::fs::remove_file(guest_agent::paths::session_history_path_file());
    let _ = std::fs::remove_file(ops_file);
}

unsafe fn setup_api_env(mock_path: &Path, workdir: &Path, api_url: &str) -> Result<(), String> {
    unsafe {
        std::env::set_var("VM0_MOCK_CLAUDE_PATH", mock_path);
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var("VM0_POST_RESULT_SIGTERM_GRACE_SECS", "3");
        std::env::set_var("VM0_POST_RESULT_SIGKILL_GRACE_SECS", "1");
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "execute-cli-api-mode-test".to_string());
        std::env::set_var("VM0_RUN_ID", run_id);
        std::env::set_var("VM0_PROMPT", "@exit-after-result");
        std::env::set_var("VM0_WORKING_DIR", workdir);
        std::env::set_var("VM0_API_URL", api_url);
        std::env::set_var("VM0_API_TOKEN", "test-token");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", workdir);
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

#[tokio::test]
async fn api_mode_execute_cli_captures_session_metadata_and_sends_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        setup_api_env(&mock_cli, tmp.path(), &server.base_url())?;
    }
    let _run_files = RunFilesGuard::new();

    let init_event = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""subtype":"init""#)
            .body_includes(r#""session_id":"***"#);
        then.status(200);
    });
    let result_event = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""type":"result""#);
        then.status(200);
    });

    let encoded_mock_session_prefix = base64::engine::general_purpose::STANDARD.encode("mock-");
    let masker = SecretMasker::from_raw(&encoded_mock_session_prefix);
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::with_retry_delay(Duration::ZERO)?,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence,
        Some(1),
        "API mode should acknowledge the init and result events"
    );
    init_event.assert_calls_async(1).await;
    result_event.assert_calls_async(1).await;

    let session_id = std::fs::read_to_string(guest_agent::paths::session_id_file())?;
    assert!(
        session_id.starts_with("mock-"),
        "execute_cli should capture the mock CLI session id, got {session_id}"
    );
    let history_path = std::fs::read_to_string(guest_agent::paths::session_history_path_file())?;
    assert!(
        history_path.contains(session_id.trim()),
        "history path should contain the captured session id, got {history_path}"
    );

    Ok(())
}
