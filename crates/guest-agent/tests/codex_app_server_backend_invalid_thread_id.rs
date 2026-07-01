//! Thread identity validation for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_invalid_thread_start_id()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-invalid-thread-id-test",
                prompt: "drive the app-server backend invalid thread id path",
                scenario: Some("thread-start-invalid-thread-id"),
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

    let error = result.expect_err("invalid thread id should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("thread response returned an invalid Codex thread id"),
        "unexpected error: {message}"
    );
    let session_id_path = guest_agent::paths::session_id_file();
    assert!(
        !std::path::Path::new(session_id_path).exists(),
        "invalid thread response should not write a session id"
    );

    Ok(())
}
