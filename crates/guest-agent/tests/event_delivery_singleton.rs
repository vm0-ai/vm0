//! A CLI event with no backlog must be sent immediately as a singleton batch.

mod common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn ordinary_cli_sends_a_no_backlog_event_without_collection_delay()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let prompt = [
        "@ECHO@".to_string(),
        json!({ "type": "assistant", "message": "singleton" }).to_string(),
    ]
    .join("\n");

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
        &run_id,
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
    let request = server.next_request(Duration::from_secs(5)).await?;
    let body: serde_json::Value = serde_json::from_str(&request.request.body)?;
    assert_eq!(
        body.get("runId").and_then(serde_json::Value::as_str),
        Some(run_id.as_str())
    );
    let events = body
        .get("events")
        .and_then(serde_json::Value::as_array)
        .expect("event request should contain an events array");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]
            .get("sequenceNumber")
            .and_then(serde_json::Value::as_u64),
        Some(0)
    );
    request.respond(200)?;

    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("CLI should finish after the singleton response")??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some(0));
    assert_eq!(server.request_count(), 1);

    Ok(())
}
