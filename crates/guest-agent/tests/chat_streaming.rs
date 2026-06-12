//! Chat text streaming should publish Claude text deltas to Ably while keeping
//! raw `stream_event` lines out of the API webhook stream.
//!
//! This test lives in its own binary because `guest_agent::env` caches
//! process-wide `VM0_*` values in `LazyLock`s.

mod common;

use base64::Engine;
use common::{RecordedHttpEvent, RecordedRequest};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

const RUN_ID: &str = "11111111-1111-4111-8111-111111111111";
const EXPECTED_MESSAGE_ID: &str = "f819e443-a3fc-5990-920b-5eb8e51e038e";

fn prompt() -> String {
    format!(
        r#"@ECHO@
{{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"{session_id}","tools":[],"model":"mock-claude"}}
{{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{{"type":"message_start","message":{{"id":"msg_sub"}}}}}}
{{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"subagent leak"}}}}}}
{{"type":"stream_event","event":{{"type":"message_start","message":{{"id":"msg_01"}}}}}}
{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"prefix secret-token"}}}}}}
{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":" suffix"}}}}}}
{{"type":"stream_event","event":{{"type":"content_block_stop"}}}}
{{"type":"stream_event","event":{{"type":"message_stop"}}}}
{{"type":"assistant","session_id":"{session_id}","message":{{"role":"assistant","content":[{{"type":"text","text":"prefix secret-token suffix"}}]}}}}
{{"type":"result","subtype":"success","session_id":"{session_id}","is_error":false,"duration_ms":100,"num_turns":1,"result":"prefix secret-token suffix","total_cost_usd":0,"usage":{{"input_tokens":0,"output_tokens":0}}}}"#,
        session_id = common::CHAT_STREAM_SESSION_ID,
    )
}

#[tokio::test]
async fn execute_cli_publishes_masked_chat_stream_deltas_before_final_event()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::from_millis(100)).await?;
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode("secret-token");

    unsafe {
        common::setup_chat_stream_env(
            &mock_cli,
            tmp.path(),
            RUN_ID,
            &prompt(),
            &server.base_url,
            true,
            Some(&encoded_secret),
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
    assert_eq!(
        cli_result.last_event_sequence,
        Some(2),
        "API mode should acknowledge init, assistant, and result events"
    );

    let events = server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(2))
        .await?;
    let requests = server.requests()?;
    let webhook_requests = requests_for_path(&requests, "/api/webhooks/agent/events");
    assert_eq!(webhook_requests.len(), 3);
    for request in &webhook_requests {
        assert!(!request.body.contains("stream_event"));
        assert!(!request.body.contains("content_block_delta"));
        assert!(!request.body.contains("chatThreadMessageDelta"));
        assert!(!request.body.contains("secret-token"));
        assert!(!request.body.contains("subagent leak"));
    }

    let ably_requests = requests_for_path(&requests, "/channels/user%3Auser_123/messages");
    assert_eq!(ably_requests.len(), 2);
    let mut streamed_text = String::new();
    for request in &ably_requests {
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer stream-token")
        );
        assert!(!request.body.contains("secret-token"));
        assert!(!request.body.contains("secret"));
        assert!(!request.body.contains("-token"));
        assert!(!request.body.contains("subagent leak"));

        let body: serde_json::Value = serde_json::from_str(&request.body)?;
        assert_eq!(
            body.pointer("/name").and_then(serde_json::Value::as_str),
            Some("chatThreadMessageDelta:22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(
            body.pointer("/data/messageId")
                .and_then(serde_json::Value::as_str),
            Some(EXPECTED_MESSAGE_ID)
        );
        assert_eq!(
            body.pointer("/data/runId")
                .and_then(serde_json::Value::as_str),
            Some(RUN_ID)
        );
        assert_eq!(
            body.pointer("/data/runEventId")
                .and_then(serde_json::Value::as_str),
            Some("msg_01")
        );
        assert_eq!(
            body.pointer("/data/threadId")
                .and_then(serde_json::Value::as_str),
            Some(common::CHAT_STREAM_THREAD_ID)
        );
        let text = body
            .pointer("/data/text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Ably publish body is missing data.text".to_string())?;
        streamed_text.push_str(text);
    }
    assert_eq!(streamed_text, "prefix *** suffix");

    let last_ably_response_index = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            RecordedHttpEvent::Response { path, .. } if path.starts_with("/channels/") => {
                Some(index)
            }
            _ => None,
        })
        .max()
        .ok_or_else(|| "missing Ably response event".to_string())?;
    let assistant_webhook_request_index = events
        .iter()
        .enumerate()
        .find_map(|(index, event)| match event {
            RecordedHttpEvent::Request(request)
                if request.path == "/api/webhooks/agent/events"
                    && request.body.contains(r#""type":"assistant""#) =>
            {
                Some(index)
            }
            _ => None,
        })
        .ok_or_else(|| "missing final assistant webhook request".to_string())?;
    assert!(
        last_ably_response_index < assistant_webhook_request_index,
        "Ably publishes must complete before the assistant webhook starts: {events:#?}"
    );

    Ok(())
}

fn requests_for_path<'a>(requests: &'a [RecordedRequest], path: &str) -> Vec<&'a RecordedRequest> {
    requests
        .iter()
        .filter(|request| request.path == path)
        .collect()
}
