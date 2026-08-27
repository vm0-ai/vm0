//! Claude Code event delivery must fail without blocking stdout when the
//! bounded delivery queue fills behind a stalled event endpoint.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn claude_code_event_delivery_count_overload_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    let mut prompt_lines = vec!["@ECHO-HANG@".to_string()];
    prompt_lines
        .extend((0..640).map(|index| json!({ "type": "assistant", "index": index }).to_string()));
    let prompt = prompt_lines.join("\n");

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        );
        std::env::set_var("VM0_API_TOKEN", "test-token");
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let stalled_events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200).delay(Duration::from_secs(30));
    });

    let masker = SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("delivery overload should not wait for the stalled event request");

    let result = execution.expect("the live CLI should use controlled delivery termination");
    let error = result
        .control_error
        .expect("count overload should be exposed as a control error")
        .to_string();
    assert!(
        error.contains("event delivery queue exceeded 512 pending events"),
        "unexpected overload error: {error}"
    );
    assert_eq!(result.last_event_sequence, None);
    assert_eq!(
        result
            .cli_termination
            .expect("delivery overload should record process-group termination")
            .reason,
        guest_contracts::diagnostics::CliTerminationReason::EventDelivery
    );
    assert!(
        stalled_events.calls() <= 1,
        "the serial sender should have at most one stalled request in flight"
    );

    Ok(())
}
