//! Active-input success coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_steers_active_input_into_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-active-input-test",
                prompt: "drive the app-server backend with active input",
                scenario: Some("runtime-turn-started-before-steer"),
                resume_session_id: None,
            },
        )?;
    }
    let _run_files = common::RunFilesGuard::new();
    let runtime = common::guest_runtime_from_process_env()?;

    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        &runtime.config.run_id,
        true,
        &runtime.config.prompt,
    );
    let controller = active_input.controller();
    let payload = common::active_input_payload("follow-up prompt")?;
    assert_eq!(
        controller.handle_control_payload("active-msg-1", &payload),
        ActiveInputControlOutcome::Accepted
    );
    assert!(matches!(
        controller.handle_control_payload("active-msg-1", &payload),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input message id is duplicate"
    ));

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());

    let input_events = common::read_codex_session_history_events_for_paths(&runtime.paths)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 2);
    assert_eq!(input_events[0]["kind"], "initial");
    assert_eq!(
        input_events[0]["text"],
        "drive the app-server backend with active input"
    );
    assert_eq!(input_events[1]["kind"], "steered");
    assert_eq!(input_events[1]["text"], "follow-up prompt");
    assert_eq!(
        input_events[1]["turn_request_client_user_message_id"],
        "active-msg-1"
    );

    Ok(())
}
