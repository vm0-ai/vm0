//! Exercise exact final requests and failure controls through the real sender.
use super::event_delivery::*;
use crate::env::Framework;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::time::Duration;

const LIMIT: usize = 4 * 1024 * 1024;
const RUN_ID: &str = "delivery-\"\\-你好";

fn body(event: &Value, transport: bool) -> Result<String, String> {
    let mut public = event.clone();
    let citation = public
        .as_object_mut()
        .ok_or("event is not an object")?
        .remove("memoryCitation");
    let suffix = if transport {
        let citations = citation
            .map(|citation| json!({"sequenceNumber":19,"citation":citation}))
            .into_iter()
            .collect::<Vec<_>>();
        format!(
            ",\"piMemoryCitationTransport\":{{\"schemaVersion\":1,\"citations\":{}}}",
            json!(citations)
        )
    } else {
        public = event.clone();
        String::new()
    };
    Ok(format!(
        "{{\"runId\":{},\"events\":[{}]{suffix}}}",
        json!(RUN_ID),
        public
    ))
}

fn text_event(framework: Framework, text: &str) -> Value {
    let mut event = match framework {
        Framework::Pi => {
            json!({"type":"assistant","message":{"id":"message","role":"assistant","model":"test","usage":{"input_tokens":2},"content":[{"type":"text","text":text}]}})
        }
        _ => {
            json!({"type":"item.completed","thread_id":"thread","turn_id":"turn","item":{"id":"item","type":"agent_message","text":text}})
        }
    };
    if let Some(event) = event.as_object_mut() {
        event.insert("memoryCitation".into(), json!({"entries":[{"path":"memory.md","lineStart":1,"lineEnd":2,"note":"citation-你好\"\\\n"}],"rolloutIds":[]}));
    }
    events::prepare_event_for_delivery(event, 19, &SecretMasker::from_raw(""))
}

#[tokio::test]
async fn sender_preserves_normal_bytes_and_accounts_for_exact_citation_envelopes() {
    for framework in [Framework::Pi, Framework::Codex] {
        for transport in [false, true] {
            for overflow in [None, Some(0), Some(1)] {
                let empty = text_event(framework, "");
                let retained = overflow.map_or(5, |extra| {
                    LIMIT - body(&empty, transport).unwrap().len() + extra
                });
                let event = text_event(framework, &"x".repeat(retained));
                let expected = body(&event, transport).unwrap();
                if let Some(extra) = overflow {
                    assert_eq!(expected.len(), LIMIT + extra);
                }
                let expected_json: Value = serde_json::from_str(&expected).unwrap();
                let server = MockServer::start_async().await;
                let request = server.mock(|when, then| {
                    when.method(POST)
                        .path("/api/webhooks/agent/events")
                        .is_true(move |request| {
                            if overflow != Some(1) {
                                return request.body_ref() == expected.as_bytes();
                            }
                            let payload: Value =
                                serde_json::from_slice(request.body_ref()).unwrap();
                            request.body_ref().len() <= LIMIT
                                && request
                                    .body_string()
                                    .contains("bytes truncated for delivery")
                                && payload["piMemoryCitationTransport"]
                                    == expected_json["piMemoryCitationTransport"]
                                && payload["events"][0]["memoryCitation"]
                                    == expected_json["events"][0]["memoryCitation"]
                                && payload["events"][0]["sequenceNumber"] == 19
                        });
                    then.status(200);
                });
                let http = HttpClient::with_api_config(
                    server.base_url(),
                    "test-token",
                    "",
                    "test-session",
                    Duration::ZERO,
                )
                .unwrap();
                let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, transport).unwrap();
                runtime
                    .sender()
                    .try_send_for_framework(19, event, framework)
                    .unwrap();
                let report = runtime.finish().await.unwrap();
                assert_eq!(report.last_acknowledged_sequence, Some(19));
                assert!(report.diagnostic.is_none());
                request.assert_calls_async(1).await;
            }
        }
    }
}

#[tokio::test]
async fn impossible_citation_and_protected_core_fail_before_http() {
    let server = MockServer::start_async().await;
    let request = server.mock(|when, then| {
        when.method(POST);
        then.status(200);
    });
    for (framework, mut event) in [
        (Framework::Pi, text_event(Framework::Pi, "text")),
        (Framework::Pi, text_event(Framework::Pi, "text")),
        (Framework::Codex, text_event(Framework::Codex, "text")),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (framework, mut event))| {
        match i {
            0 => event["memoryCitation"]["entries"][0]["note"] = json!("x".repeat(LIMIT)),
            1 => event["message"]["id"] = json!("x".repeat(LIMIT)),
            _ => event["item"]["id"] = json!("x".repeat(LIMIT)),
        }
        (framework, event)
    }) {
        let http = HttpClient::with_api_config(
            server.base_url(),
            "test-token",
            "",
            "test-session",
            Duration::ZERO,
        )
        .unwrap();
        let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, true).unwrap();
        let error = runtime
            .sender()
            .try_send_for_framework(19, event.take(), framework)
            .unwrap_err();
        assert!(error.to_string().contains("serialized event budget"));
        assert!(runtime.finish().await.unwrap().last_acknowledged_sequence == Some(18));
    }
    request.assert_calls_async(0).await;
}

#[tokio::test]
async fn reduced_http_failure_still_breaks_acknowledgement_and_retries_identical_bytes() {
    let server = MockServer::start_async().await;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
    let captured = seen.clone();
    let request = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .is_true(move |request| {
                captured.lock().unwrap().push(request.body_vec());
                request.body_ref().len() <= LIMIT
                    && request
                        .body_string()
                        .contains("bytes truncated for delivery")
            });
        then.status(500);
    });
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-session",
        Duration::ZERO,
    )
    .unwrap();
    let runtime = EventDeliveryRuntime::start(http, RUN_ID, 19, true).unwrap();
    runtime
        .sender()
        .try_send_for_framework(
            19,
            text_event(Framework::Pi, &"x".repeat(LIMIT)),
            Framework::Pi,
        )
        .unwrap();
    let report = runtime.finish().await.unwrap();
    assert_eq!(report.last_acknowledged_sequence, Some(18));
    assert!(report.diagnostic.is_some());
    assert!(request.calls_async().await > 1);
    let requests = seen.lock().unwrap();
    assert!(requests.len() > 1);
    assert!(requests.iter().all(|body| body == &requests[0]));
}
