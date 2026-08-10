//! Cancellation must let an in-flight Codex steer settle before completion.
//!
//! This test lives in its own binary to isolate process environment and current
//! directory changes required by the mock Codex integration harness.

mod common;

use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use httpmock::prelude::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const RUN_ID: &str = "codex-app-server-backend-active-input-cancellation-test";
const DELIVERY_ID: &str = "2532261d-b0e1-471e-b93d-1acae383d001";

#[tokio::test]
async fn cancellation_preserves_a_steer_response_already_in_flight()
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
                prompt: "drive cancellation during an active-input steer",
                scenario: Some("wait-on-turn-steer-response"),
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
        RUN_ID,
        true,
        &runtime.config.prompt,
        &journal_path,
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?,
    )?;
    assert_eq!(
        active_input
            .controller()
            .handle_control_payload(&serde_json::to_vec(&json!({
                "type": "active-input",
                "deliveryId": DELIVERY_ID,
                "text": "settle this steer before stopping",
            }))?),
        ActiveInputControlOutcome::Accepted
    );

    let cancellation = CancellationToken::new();
    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), cancellation.clone(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    tokio::pin!(execution);
    let ready_file = tmp.path().join(common::MOCK_CODEX_TURN_STEER_READY_FILE);
    tokio::select! {
        result = &mut execution => {
            return Err(format!("Codex execution ended before steer cancellation: {result:?}").into());
        }
        ready = common::wait_for_file_contains(
            &ready_file,
            common::MOCK_CODEX_TURN_STEER_READY_EVENT,
            Duration::from_secs(5),
        ) => ready?,
    }

    cancellation.cancel();
    UnixStream::connect(
        tmp.path()
            .join(common::MOCK_CODEX_TURN_STEER_RELEASE_SOCKET),
    )?;
    let result = tokio::time::timeout(Duration::from_secs(10), execution)
        .await
        .expect("Codex cancellation should quiesce")?;

    assert_eq!(
        result.active_input_delivery_ids,
        vec![DELIVERY_ID.to_string()]
    );
    assert_eq!(
        result
            .cli_termination
            .expect("cancellation should retain termination attribution")
            .reason,
        CliTerminationReason::UserCancellation
    );
    receipt.assert_calls(1);
    assert!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?
        .is_empty()
    );

    Ok(())
}
