//! Chat streaming publish failures must not fail the run or block final
//! webhook delivery.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! process-wide `VM0_*` values in `LazyLock`s.

mod common;

use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

const RUN_ID: &str = "33333333-3333-4333-8333-333333333333";

fn prompt() -> String {
    format!(
        r#"@ECHO@
{{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"{session_id}","tools":[],"model":"mock-claude"}}
{{"type":"stream_event","event":{{"type":"message_start","message":{{"id":"msg_01"}}}}}}
{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"hello world"}}}}}}
{{"type":"stream_event","event":{{"type":"message_stop"}}}}
{{"type":"assistant","session_id":"{session_id}","message":{{"role":"assistant","content":[{{"type":"text","text":"hello world"}}]}}}}
{{"type":"result","subtype":"success","session_id":"{session_id}","is_error":false,"duration_ms":100,"num_turns":1,"result":"hello world","total_cost_usd":0,"usage":{{"input_tokens":0,"output_tokens":0}}}}"#,
        session_id = common::CHAT_STREAM_SESSION_ID,
    )
}

#[tokio::test]
async fn execute_cli_continues_when_ably_publish_returns_500()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(500, Duration::ZERO).await?;

    unsafe {
        common::setup_chat_stream_env(
            &mock_cli,
            tmp.path(),
            RUN_ID,
            &prompt(),
            &server.base_url,
            true,
            None,
        )?;
    }
    let _run_files = common::RunFilesGuard::new();

    let masker = SecretMasker::from_env();
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli(
            &masker,
            common::spawn_dummy_heartbeat(),
            HttpClient::with_api_config(server.base_url.clone(), "test-token", "", Duration::ZERO)?,
        ),
    )
    .await
    .map_err(|_| "execute_cli timed out")??;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(cli_result.last_event_sequence, Some(2));

    let _events = server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(2))
        .await?;
    let requests = server.requests()?;
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.path == "/api/webhooks/agent/events")
            .count(),
        3
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.path == "/channels/user%3Auser_123/messages")
            .count(),
        1
    );

    Ok(())
}
