//! No-active-turn coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_fails_visible_when_no_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-active-input-no-turn-test",
                prompt: "drive the app-server backend no active turn path",
                scenario: Some("no-active-turn"),
                resume_session_id: None,
            },
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        guest_agent::env::run_id(),
        true,
        guest_agent::env::prompt(),
    );
    let payload = common::active_input_payload("no-active-turn follow-up prompt")?;
    assert_eq!(
        active_input
            .controller()
            .handle_control_payload("active-msg-no-turn", &payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly");

    let error = result.expect_err("no active turn should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("active input steer failed") && message.contains("no active turn"),
        "unexpected error: {message}"
    );

    Ok(())
}
