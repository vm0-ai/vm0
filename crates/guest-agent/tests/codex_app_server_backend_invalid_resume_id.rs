//! Resume id validation for the disabled Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::path::Path;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_invalid_resume_id_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let missing_mock = tmp.path().join("missing-mock-codex");

    unsafe {
        setup_codex_app_server_env(&missing_mock, tmp.path())?;
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

unsafe fn setup_codex_app_server_env(mock_path: &Path, home: &Path) -> Result<(), String> {
    unsafe {
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var("VM0_CODEX_APP_SERVER_BACKEND", "1");
        std::env::set_var("VM0_MOCK_CODEX_PATH", mock_path);
        std::env::set_var("USE_MOCK_CODEX", "true");
        std::env::remove_var("MOCK_CODEX_FIXTURE");
        std::env::remove_var("MOCK_CODEX_APP_SERVER_SCENARIO");
        std::env::set_var("VM0_RESUME_SESSION_ID", "not-a-valid-codex-thread-id");
        std::env::set_var(
            "VM0_RUN_ID",
            "codex-app-server-backend-invalid-resume-id-test",
        );
        std::env::set_var(
            "VM0_PROMPT",
            "drive the app-server backend invalid resume id path",
        );
        std::env::set_var("VM0_API_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "");
        std::env::set_var("VM0_SANDBOX_ID", "00000000-0000-4000-8000-000000000abc");
        std::env::set_var("VM0_SANDBOX_REUSE_RESULT", "reused");
        std::env::set_var("HOME", home);
    }
    std::fs::create_dir_all(home).map_err(|error| format!("create home: {error}"))?;
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(home).map_err(|error| format!("set_current_dir: {error}"))?;
    Ok(())
}
