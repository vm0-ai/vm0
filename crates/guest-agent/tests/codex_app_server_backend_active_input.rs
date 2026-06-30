//! Active-input success coverage for the experimental Codex app-server backend.
//!
//! This test lives in its own binary because `guest_agent::env` caches values
//! in process-wide `LazyLock`s.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
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
            "codex-app-server-backend-active-input-test",
            "drive the app-server backend with active input",
            "runtime-turn-started-before-steer",
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

    let active_input = ActiveInputRuntime::new_with_initial_prompt(
        guest_agent::env::run_id(),
        true,
        guest_agent::env::prompt(),
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
        guest_agent::cli::execute_cli_with_active_input(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::for_current_env()?,
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());

    let input_events = common::read_codex_session_history_events()?
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
