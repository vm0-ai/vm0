//! Event-delivery integration coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-test";

#[tokio::test]
async fn codex_app_server_event_delivery_stops_watermark_at_failed_sequence()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive app-server event delivery",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var("VM0_API_BACKEND_URL", server.base_url());
        std::env::set_var("VM0_API_TOKEN", "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        RUN_ID,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    // Keep response matchers mutually exclusive: sequence 1 may share a batch
    // with later notifications, and the whole request is one failure unit.
    let failed_batch = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""sequenceNumber":1"#);
        then.status(500);
    });
    let successful_batches = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_excludes(r#""sequenceNumber":1"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(cli_result.last_event_sequence, Some(0));
    assert_eq!(
        std::fs::read_to_string(runtime.paths.event_error_flag())?,
        "1"
    );
    failed_batch.assert_calls_async(3).await;
    assert!(
        successful_batches.calls_async().await >= 1,
        "the sequence-zero prefix should be acknowledged before the failed batch"
    );

    Ok(())
}
