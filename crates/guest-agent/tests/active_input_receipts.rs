//! Integration coverage for durable active-input acceptance state.

use std::time::Duration;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use httpmock::prelude::*;
use serde_json::json;

const RUN_ID: &str = "active-input-receipt-integration";
const DELIVERY_ID: &str = "60fca608-d174-4c1a-a1b2-57607b3adf46";
const PROMPT: &str = "continue with durable input";

fn receipt_http(base_url: &str) -> Result<HttpClient, guest_agent::error::AgentError> {
    HttpClient::with_api_config(base_url, "test-token", "", RUN_ID, Duration::ZERO)
}

fn payload(text: &str) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&json!({
        "type": "active-input",
        "deliveryId": DELIVERY_ID,
        "text": text,
    }))
}

#[tokio::test]
async fn explicit_null_delivery_id_is_rejected_instead_of_using_legacy_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        tmp.path().join("active-input-receipts.json"),
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let _writer = runtime.into_writer();

    assert!(matches!(
        controller.handle_control_payload(
            br#"{"type":"active-input","deliveryId":null,"text":"hello"}"#
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input payload is invalid"
    ));

    controller.close_terminal();
    assert!(controller.finalize_receipts().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn accepted_input_is_deduplicated_reported_and_compacted()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
            ))
            .header("Authorization", "Bearer test-token")
            .header("Content-Type", "application/json")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("active-input-receipts.json");
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let accepted_payload = payload(PROMPT)?;

    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted,
        "a duplicate must not enqueue a second sink operation"
    );
    assert!(matches!(
        controller.handle_control_payload(&payload("different text")?),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input delivery id was reused with different text"
    ));

    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    assert_eq!(frame.uuid, DELIVERY_ID);
    assert_eq!(frame.delivery_id(), Some(DELIVERY_ID));
    assert_eq!(frame.text, PROMPT);
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;

    controller.close_terminal();
    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted,
        "a known accepted delivery remains idempotent after close"
    );
    assert!(matches!(
        controller.handle_control_payload(
            &serde_json::to_vec(&json!({
                "type": "active-input",
                "deliveryId": "8736a7bd-8ddc-46b4-a159-af71d09f65e4",
                "text": "new after close",
            }))?
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input is closed"
    ));

    assert_eq!(
        controller.finalize_receipts().await?,
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

    Ok(())
}

#[tokio::test]
async fn failed_input_creates_no_receipt_or_completion_evidence()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
        ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("active-input-receipts.json");
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let accepted_payload = payload(PROMPT)?;

    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_failed(&frame);
    assert!(matches!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input delivery previously failed"
    ));

    controller.close_terminal();
    assert!(controller.finalize_receipts().await?.is_empty());
    receipt.assert_calls(0);
    assert!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?
        .is_empty()
    );

    Ok(())
}

#[tokio::test]
async fn rejected_receipt_is_retained_without_a_finalization_retry()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
        ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "rejected" }));
    });
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("active-input-receipts.json");
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();

    assert_eq!(
        controller.handle_control_payload(&payload(PROMPT)?),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;
    controller.close_terminal();

    assert_eq!(
        controller.finalize_receipts().await?,
        vec![DELIVERY_ID.to_string()]
    );
    receipt.assert_calls(1);
    assert_eq!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?,
        vec![DELIVERY_ID.to_string()]
    );
    let journal = std::fs::read_to_string(&journal_path)?;
    assert!(journal.contains(DELIVERY_ID));
    assert!(!journal.contains(PROMPT));

    Ok(())
}

#[tokio::test]
async fn transport_failure_gets_only_one_finalization_retry()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
        ));
        then.status(500);
    });
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("active-input-receipts.json");
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();

    assert_eq!(
        controller.handle_control_payload(&payload(PROMPT)?),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;
    tokio::time::timeout(Duration::from_secs(1), async {
        while receipt.calls_async().await == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the immediate receipt attempt should finish");

    controller.close_terminal();
    assert_eq!(
        controller.finalize_receipts().await?,
        vec![DELIVERY_ID.to_string()]
    );
    receipt.assert_calls(2);
    assert_eq!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?,
        vec![DELIVERY_ID.to_string()]
    );

    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn journal_publication_failure_is_terminal_after_backend_acceptance()
-> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
        ));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("run/active-input-receipts.json");
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let unrelated_target = tmp.path().join("unrelated");
    std::fs::write(&unrelated_target, b"unchanged")?;
    symlink(&unrelated_target, &journal_path)?;

    assert_eq!(
        controller.handle_control_payload(&payload(PROMPT)?),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    let error = writer
        .mark_backend_accepted_without_replay(&frame)
        .expect_err("unsafe journal state must prevent a receipt claim");
    assert!(error.to_string().contains("symlink"));
    assert_eq!(std::fs::read(&unrelated_target)?, b"unchanged");

    controller.close_terminal();
    assert!(controller.finalize_receipts().await?.is_empty());
    receipt.assert_calls(0);

    Ok(())
}

#[tokio::test]
async fn unacknowledged_journal_recovers_without_requeueing_the_backend()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let journal_path = tmp.path().join("active-input-receipts.json");
    let failed_server = MockServer::start();
    let failed_receipt = failed_server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
        ));
        then.status(500);
    });
    let runtime = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&failed_server.base_url())?,
    )?;
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let accepted_payload = payload(PROMPT)?;
    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;
    controller.close_terminal();
    assert_eq!(
        controller.finalize_receipts().await?,
        vec![DELIVERY_ID.to_string()]
    );
    assert!((1..=2).contains(&failed_receipt.calls()));
    assert_eq!(
        guest_contracts::active_input_receipts::read_active_input_receipt_journal(
            &journal_path,
            RUN_ID,
        )?,
        vec![DELIVERY_ID.to_string()]
    );

    let server = MockServer::start();
    let receipt = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{RUN_ID}/active-inputs/deliveries/{DELIVERY_ID}/receipt"
            ))
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "delivered" }));
    });
    let recovered = ActiveInputRuntime::new_with_receipts(
        RUN_ID,
        true,
        "initial",
        &journal_path,
        receipt_http(&server.base_url())?,
    )?;
    let recovered_controller = recovered.controller();
    let _writer = recovered.into_writer();

    assert_eq!(
        recovered_controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted,
        "a recovered delivery must not be queued for the backend again"
    );
    recovered_controller.close_terminal();
    assert_eq!(
        recovered_controller.finalize_receipts().await?,
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

    Ok(())
}
