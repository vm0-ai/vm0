//! Resume id validation for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_invalid_resume_id_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let missing_mock = tmp.path().join("missing-mock-codex");

    unsafe {
        common::setup_codex_app_server_env(
            &missing_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-invalid-resume-id-test",
                prompt: "drive the app-server backend invalid resume id path",
                scenario: None,
                resume_session_id: Some("not-a-valid-codex-thread-id"),
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

    let error = result.expect_err("invalid resume id should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("VM0_RESUME_SESSION_ID is not a valid Codex thread id"),
        "unexpected error: {message}"
    );
    assert!(
        !message.contains("failed to spawn codex app-server"),
        "invalid resume id should fail before app-server spawn: {message}"
    );
    let session_id_path = guest_agent::paths::session_id_file();
    assert!(
        !std::path::Path::new(session_id_path).exists(),
        "invalid resume id should not write a session id"
    );

    Ok(())
}
