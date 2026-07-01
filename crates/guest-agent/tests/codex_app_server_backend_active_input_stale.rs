//! Stale-turn active-input coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_fails_visible_on_stale_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-active-input-stale-test",
                prompt: "drive the app-server backend stale path",
                scenario: Some("stale-turn"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        true,
        &runtime.config.prompt,
    );
    let payload = common::active_input_payload("stale follow-up prompt")?;
    assert_eq!(
        active_input
            .controller()
            .handle_control_payload("active-msg-stale", &payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly");

    let error = result.expect_err("stale turn should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("active input steer failed") && message.contains("stale expectedTurnId"),
        "unexpected error: {message}"
    );

    let input_events = common::read_codex_session_history_events_for_paths(&runtime.paths)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 1);
    assert_eq!(input_events[0]["kind"], "initial");

    Ok(())
}
