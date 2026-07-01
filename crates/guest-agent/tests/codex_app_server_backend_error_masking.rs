//! Error masking coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_masks_resume_id_in_rpc_errors()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193ABCDEF01723489ABCDEF01234567";
    let canonical_resume_thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-error-masking-test",
                prompt: "drive the app-server backend error masking path",
                scenario: Some("resume-rpc-error-with-thread-id"),
                resume_session_id: Some(resume_thread_id),
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

    let error = result.expect_err("resume RPC error should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("resume failed for ***"),
        "unexpected masked error: {message}"
    );
    assert!(
        !message.contains(resume_thread_id),
        "raw resume id leaked in app-server RPC error: {message}"
    );
    assert!(
        !message.contains(canonical_resume_thread_id),
        "canonical resume id leaked in app-server RPC error: {message}"
    );

    Ok(())
}
