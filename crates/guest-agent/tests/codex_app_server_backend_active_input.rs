//! Active-input success coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-backend-active-input-test";
const DELIVERY_ID: &str = "6bd71939-58df-48f2-81d4-468da3c788a5";

#[tokio::test]
async fn codex_app_server_backend_steers_active_input_into_active_turn()
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
                prompt: "drive the app-server backend with active input",
                scenario: Some("runtime-turn-started-before-steer"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let receipt = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
            ))
            .header("Authorization", "Bearer test-token")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let journal_path = guest_contracts::runtime_paths::active_input_receipt_journal_file(
        runtime.paths.runtime_dir(),
    );
    let active_input = ActiveInputRuntime::new_with_receipts(
        &runtime.config.run_id,
        &runtime.config.prompt,
        &journal_path,
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?,
    )?;
    let controller = active_input.controller();
    let payload = serde_json::to_vec(&json!({
        "type": "active-input",
        "deliveryId": DELIVERY_ID,
        "text": "follow-up prompt",
    }))?;
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted,
        "the same delivery must not create a second steer"
    );

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
    assert_eq!(
        cli_result.active_input_delivery_ids,
        vec![DELIVERY_ID.to_string()]
    );
    receipt.assert_calls(1);
    assert!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?
        .is_empty()
    );

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
    let client_user_message_id = input_events[1]["turn_request_client_user_message_id"]
        .as_str()
        .expect("steered input should carry an internal UUID");
    assert_eq!(client_user_message_id, DELIVERY_ID);

    Ok(())
}
