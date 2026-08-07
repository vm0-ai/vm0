//! Event delivery distinguishes connection establishment failures from other
//! response-less transport failures without retaining raw error text.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{
    EventDeliveryAcceptanceOutcome, EventDeliveryAttemptFailureKind, EventDeliveryDiagnostic,
};
use serde_json::json;
use std::io;
use std::time::Duration;

#[tokio::test]
async fn response_less_failures_have_stable_classifications()
-> Result<(), Box<dyn std::error::Error>> {
    let connect_delivery = run_connect_failure().await?;
    assert_failed_attempts(&connect_delivery, EventDeliveryAttemptFailureKind::Connect)?;

    let (transport_delivery, on_wire_request_ids) = run_transport_failure().await?;
    let transport_attempts = assert_failed_attempts(
        &transport_delivery,
        EventDeliveryAttemptFailureKind::Transport,
    )?;
    assert_eq!(
        transport_attempts
            .iter()
            .map(|attempt| attempt.client_request_id.as_str())
            .collect::<Vec<_>>(),
        on_wire_request_ids
    );

    Ok(())
}

async fn run_connect_failure() -> Result<EventDeliveryDiagnostic, Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let prompt = format!(
        "@ECHO@\n{}",
        json!({ "type": "result", "marker": "connect-failure" })
    );

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var("VM0_API_BACKEND_URL", "http://127.0.0.1:1");
        std::env::set_var("VM0_API_TOKEN", "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        "http://127.0.0.1:1",
        "test-token",
        "",
        run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .map_err(|_| io::Error::other("connect-failure delivery exceeded its retry budget"))??;

    result
        .event_delivery
        .ok_or_else(|| io::Error::other("connect failure omitted delivery diagnostic").into())
}

async fn run_transport_failure()
-> Result<(EventDeliveryDiagnostic, Vec<String>), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let prompt = format!(
        "@ECHO@\n{}",
        json!({ "type": "result", "marker": "transport-failure" })
    );

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var("VM0_API_BACKEND_URL", &server.base_url);
        std::env::set_var("VM0_API_TOKEN", "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });

    let mut request_ids = Vec::new();
    let mut request_body = None;
    for _ in 0..3 {
        let request = server.next_request(Duration::from_secs(5)).await?;
        if let Some(request_body) = &request_body {
            assert_eq!(&request.request.body, request_body);
        } else {
            request_body = Some(request.request.body.clone());
        }
        request_ids.push(
            request
                .request
                .client_request_id
                .clone()
                .ok_or_else(|| io::Error::other("transport request omitted request ID"))?,
        );
        drop(request);
    }

    let joined = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .map_err(|_| io::Error::other("transport-failure delivery exceeded its retry budget"))?;
    let result = joined??;
    let delivery = result
        .event_delivery
        .ok_or_else(|| io::Error::other("transport failure omitted delivery diagnostic"))?;
    Ok((delivery, request_ids))
}

fn assert_failed_attempts(
    delivery: &EventDeliveryDiagnostic,
    expected_kind: EventDeliveryAttemptFailureKind,
) -> Result<
    &[guest_contracts::diagnostics::EventDeliveryCompletedAttemptDiagnostic],
    Box<dyn std::error::Error>,
> {
    let failed_batch = delivery
        .first_failed_batch
        .as_ref()
        .ok_or_else(|| io::Error::other("delivery diagnostic omitted first failed batch"))?;
    assert_eq!(failed_batch.attempts.len(), 3);
    assert!(
        failed_batch.attempts.iter().all(|attempt| {
            attempt.failure_kind == expected_kind && attempt.http_status.is_none()
        })
    );
    assert_eq!(
        failed_batch.outcome,
        EventDeliveryAcceptanceOutcome::OutcomeUnknown
    );
    let mut unique_request_ids = failed_batch
        .attempts
        .iter()
        .map(|attempt| attempt.client_request_id.as_str())
        .collect::<Vec<_>>();
    unique_request_ids.sort_unstable();
    unique_request_ids.dedup();
    assert_eq!(unique_request_ids.len(), 3);
    Ok(&failed_batch.attempts)
}
