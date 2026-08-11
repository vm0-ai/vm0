//! Durable active-input acceptance coverage for Claude stream-JSON stdin.
//!
//! This test lives in its own binary to isolate process environment and current
//! directory changes required by the mock Claude integration harness.

mod common;

use std::time::Duration;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};

const DELIVERY_ID: &str = "09065b04-cb85-4dd3-8cde-965e61ab8bfa";

#[tokio::test]
async fn claude_receipts_delivery_only_after_follow_up_reaches_stdin()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        common::setup_env(&mock, tmp.path(), "@active-input-smoke:1", 3, 1)?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let run_id = runtime.config.run_id.as_str();
    let receipt = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{run_id}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
            ))
            .header("Authorization", "Bearer test-token")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let receipt_http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", run_id, Duration::ZERO)?;
    let journal_path = guest_contracts::runtime_paths::active_input_receipt_journal_file(
        runtime.paths.runtime_dir(),
    );
    let active_input = ActiveInputRuntime::new_with_receipts(
        run_id,
        true,
        &runtime.config.prompt,
        &journal_path,
        receipt_http,
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
        "the same delivery must not create a second stdin frame"
    );

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("Claude active-input execution should quiesce")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        result.active_input_delivery_ids,
        vec![DELIVERY_ID.to_string()]
    );
    receipt.assert_calls(1);
    assert!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            run_id,
        )?
        .is_empty()
    );

    let history_path = std::fs::read_to_string(runtime.paths.session_history_path_file())?;
    let history = std::fs::read_to_string(history_path.trim())?;
    let delivered_user_frames = history
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("user"))
        .filter(|event| event.get("uuid").and_then(Value::as_str) == Some(DELIVERY_ID))
        .collect::<Vec<_>>();
    assert_eq!(delivered_user_frames.len(), 1);
    assert_eq!(
        delivered_user_frames[0]
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("follow-up prompt")
    );

    Ok(())
}
