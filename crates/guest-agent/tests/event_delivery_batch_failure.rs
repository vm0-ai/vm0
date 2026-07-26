//! A failed multi-event request freezes the contiguous watermark at its first
//! sequence while later batches continue.

mod common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::io;
use std::time::Duration;

const TOTAL_EVENTS: usize = 81;

#[tokio::test]
async fn failed_batch_retries_three_times_and_later_batches_continue()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines.extend(
        (0..TOTAL_EVENTS - 1)
            .map(|index| json!({ "type": "assistant", "index": index }).to_string()),
    );
    prompt_lines.push(json!({ "type": "result", "marker": "failed-batch-sentinel" }).to_string());
    let prompt = prompt_lines.join("\n");

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
    let agent_log_file = runtime.paths.agent_log_file().to_string();
    let event_error_flag = runtime.paths.event_error_flag().to_string();
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });

    let first_request = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        std::path::Path::new(&agent_log_file),
        "failed-batch-sentinel",
        Duration::from_secs(5),
    )
    .await?;
    let first_sequences = common::event_request_sequences(&first_request.request)?;
    let expected_watermark = first_sequences
        .last()
        .copied()
        .ok_or_else(|| io::Error::other("first request contained no events"))?;
    first_request.respond(200)?;

    let failed_request = server.next_request(Duration::from_secs(5)).await?;
    let failed_sequences = common::event_request_sequences(&failed_request.request)?;
    let failed_body = failed_request.request.body.clone();
    assert_eq!(failed_sequences.len(), 32);
    failed_request.respond(500)?;
    for _ in 1..3 {
        let retry = server.next_request(Duration::from_secs(5)).await?;
        assert_eq!(retry.request.body, failed_body);
        assert_eq!(
            common::event_request_sequences(&retry.request)?,
            failed_sequences
        );
        retry.respond(500)?;
    }

    let mut logical_sequences = first_sequences;
    logical_sequences.extend(failed_sequences);
    while logical_sequences.len() < TOTAL_EVENTS {
        let request = server.next_request(Duration::from_secs(5)).await?;
        logical_sequences.extend(common::event_request_sequences(&request.request)?);
        request.respond(200)?;
    }

    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("CLI should finish after later batches are acknowledged")??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some(expected_watermark));
    assert_eq!(
        logical_sequences,
        (0..TOTAL_EVENTS as u32).collect::<Vec<_>>(),
        "logical batches should remain FIFO even though one batch was retried"
    );
    assert_eq!(std::fs::read_to_string(event_error_flag)?, "1");

    Ok(())
}
