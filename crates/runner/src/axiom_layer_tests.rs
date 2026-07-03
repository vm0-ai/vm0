//! Tests for the Axiom tracing layer.
//!
//! The layer + its dispatcher run for real; only the network boundary is
//! mocked (`httpmock` stands in for `https://api.axiom.co`). Tests verify
//! that events flow through the layer → channel → dispatcher → POST
//! endpoint with the TS-compatible payload shape.
//!

use std::sync::{Arc, Mutex};

use super::{INTERNAL_TARGET, init_from_env_values, init_with_base_url, with_ingest_filter};
use httpmock::Method::POST;
use httpmock::MockServer;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use serde_json::{Value, json};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

#[derive(Clone, Debug)]
struct RecordedEvent {
    level: tracing::Level,
    target: String,
    message: Option<String>,
}

#[derive(Clone, Default)]
struct RecordingLayer {
    events: Arc<Mutex<Vec<RecordedEvent>>>,
}

impl RecordingLayer {
    fn events(&self) -> Vec<RecordedEvent> {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl<S> Layer<S> for RecordingLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        struct MessageVisitor {
            message: Option<String>,
        }

        impl Visit for MessageVisitor {
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = Some(value.to_string());
                }
            }

            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.message = Some(format!("{value:?}"));
                }
            }
        }

        let mut visitor = MessageVisitor { message: None };
        event.record(&mut visitor);

        let metadata = event.metadata();
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(RecordedEvent {
                level: *metadata.level(),
                target: metadata.target().to_string(),
                message: visitor.message,
            });
    }
}

#[derive(Clone, Default)]
struct CapturedAxiomIngest {
    bodies: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl CapturedAxiomIngest {
    fn push_body(&self, body: &[u8]) {
        self.bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(body.to_vec());
    }

    fn events(&self) -> Vec<Value> {
        let bodies = self
            .bodies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();

        bodies
            .into_iter()
            .flat_map(|body| {
                let value: Value = serde_json::from_slice(&body).unwrap_or_else(|err| {
                    panic!(
                        "captured Axiom ingest body should be valid JSON: {err}; body: {}",
                        String::from_utf8_lossy(&body),
                    );
                });
                let Value::Array(events) = value else {
                    panic!("captured Axiom ingest body should be a JSON array, got: {value}");
                };
                events
            })
            .collect()
    }
}

async fn capture_axiom_ingest<'a>(server: &'a MockServer) -> (Mock<'a>, CapturedAxiomIngest) {
    let captured = CapturedAxiomIngest::default();
    let responder_capture = captured.clone();
    let mock = server
        .mock_async(move |when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.respond_with(move |request: &HttpMockRequest| {
                responder_capture.push_body(request.body_ref());
                HttpMockResponse::builder().status(200).body("{}").build()
            });
        })
        .await;

    (mock, captured)
}

fn event_with_message<'a>(events: &'a [Value], message: &str) -> &'a Value {
    events
        .iter()
        .find(|event| event.get("message").and_then(Value::as_str) == Some(message))
        .unwrap_or_else(|| panic!("expected event with message {message:?}, got: {events:#?}"))
}

fn has_event_with_message(events: &[Value], message: &str) -> bool {
    events
        .iter()
        .any(|event| event.get("message").and_then(Value::as_str) == Some(message))
}

fn string_field<'a>(event: &'a Value, field: &str) -> &'a str {
    event
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected string field {field:?} in event: {event:#?}"))
}

fn json_contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value.contains(needle),
        Value::Array(values) => values
            .iter()
            .any(|value| json_contains_string(value, needle)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(needle) || json_contains_string(value, needle)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

#[tokio::test]
async fn warn_and_error_events_are_ingested_with_ts_shape() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    // Use the internal `init_with_base_url` to redirect at the mock server.
    // `init()` always targets api.axiom.co and can't be pointed elsewhere.
    let (layer, guard) = init_with_base_url(&server.base_url(), "test-token", "test")
        .expect("init_with_base_url must succeed");

    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::warn!(foo = "bar", "a warning");
        tracing::error!(code = 42, "a failure");
        tracing::info!("info is below threshold, should not be ingested");
    }

    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let warning = event_with_message(&events, "a warning");
    assert_eq!(warning["service"], json!("runner"));
    assert_eq!(warning["level"], json!("warn"));
    assert_eq!(warning["foo"], json!("bar"));
    assert!(
        !string_field(warning, "context").is_empty(),
        "warning event should include context: {warning:#?}",
    );

    let failure = event_with_message(&events, "a failure");
    assert_eq!(failure["service"], json!("runner"));
    assert_eq!(failure["level"], json!("error"));
    assert_eq!(failure["code"], json!(42));
    assert!(
        !events.iter().any(|event| event["level"] == json!("info")),
        "INFO event should not be ingested: {events:#?}",
    );
}

#[tokio::test]
async fn axiom_filter_does_not_suppress_sibling_local_layers() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(with_ingest_filter(layer));

    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::info!("local info");
        tracing::debug!("local debug");
        tracing::trace!("local trace");
        tracing::warn!("local warn");
        tracing::warn!(target: INTERNAL_TARGET, "local internal");
    }
    guard.shutdown().await;

    let events = recording.events();
    for (level, message) in [
        (tracing::Level::INFO, "local info"),
        (tracing::Level::DEBUG, "local debug"),
        (tracing::Level::TRACE, "local trace"),
        (tracing::Level::WARN, "local warn"),
    ] {
        assert!(
            events.iter().any(|event| {
                event.level == level
                    && event
                        .message
                        .as_deref()
                        .is_some_and(|seen| seen.contains(message))
            }),
            "sibling local layer did not record {level} event {message:?}: {events:?}",
        );
    }
    assert!(
        events.iter().any(|event| {
            event.target == INTERNAL_TARGET
                && event
                    .message
                    .as_deref()
                    .is_some_and(|seen| seen.contains("local internal"))
        }),
        "sibling local layer did not record internal-target event: {events:?}",
    );

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let warning = event_with_message(&events, "local warn");
    assert_eq!(warning["level"], json!("warn"));
    for message in ["local info", "local debug", "local trace", "local internal"] {
        assert!(
            !has_event_with_message(&events, message),
            "filtered event {message:?} should not be ingested: {events:#?}",
        );
    }
}

#[test]
fn init_returns_none_when_env_missing() {
    let result = init_from_env_values("https://example.invalid", None, None);
    assert!(result.is_none());
}

#[test]
fn init_returns_none_when_token_empty() {
    let result = init_from_env_values(
        "https://example.invalid",
        Some(String::new()),
        Some("dev".to_string()),
    );
    assert!(result.is_none());
}

/// Error type with a walkable `source()` chain. Lets us exercise the
/// `record_error` visitor without pulling in extra deps.
#[derive(Debug)]
struct ChainErr {
    msg: &'static str,
    src: Option<Box<ChainErr>>,
}

impl std::fmt::Display for ChainErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.msg)
    }
}

impl std::error::Error for ChainErr {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.src.as_deref().map(|e| e as &dyn std::error::Error)
    }
}

#[tokio::test]
async fn error_field_serializes_with_message_and_source_chain() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        let err = ChainErr {
            msg: "top",
            src: Some(Box::new(ChainErr {
                msg: "middle",
                src: Some(Box::new(ChainErr {
                    msg: "root",
                    src: None,
                })),
            })),
        };
        tracing::error!(
            error = &err as &(dyn std::error::Error + 'static),
            "explosion",
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "explosion");
    assert_eq!(event["error"]["message"], json!("top"));
    assert_eq!(event["error"]["chain"], json!(["middle", "root"]));
}

#[tokio::test]
async fn u128_fields_serialize_as_numbers_when_in_u64_range() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            timeout_ms = 7_200_000_u128,
            elapsed_ms = 7_200_100_u128,
            guest_duration_ms = Some(7_200_084_u32),
            "timeout fields"
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "timeout fields");
    assert_eq!(event["timeout_ms"].as_u64(), Some(7_200_000));
    assert_eq!(event["elapsed_ms"].as_u64(), Some(7_200_100));
    assert_eq!(event["guest_duration_ms"].as_u64(), Some(7_200_084));
}

#[tokio::test]
async fn none_option_fields_are_omitted_from_axiom_payload() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!(
            timeout_ms = 7_200_000_u128,
            guest_duration_ms = None::<u32>,
            "timeout without guest duration"
        );
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "timeout without guest duration");
    assert_eq!(event["timeout_ms"].as_u64(), Some(7_200_000));
    assert!(
        event.get("guest_duration_ms").is_none(),
        "None option field should be omitted: {event:#?}",
    );
    assert!(
        !events
            .iter()
            .any(|event| json_contains_string(event, "None")),
        "None debug text should not be serialized into ingest payloads: {events:#?}",
    );
}

#[tokio::test]
async fn burst_past_channel_cap_drops_without_blocking_or_feeding_back() {
    let server = MockServer::start_async().await;

    let ingest = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.status(200).body("{}");
        })
        .await;

    // Negative: the layer's own "axiom channel full" warning (emitted under
    // INTERNAL_TARGET every 1000 drops) must NOT reach ingest. The Axiom
    // per-layer filter excludes INTERNAL_TARGET to prevent the diagnostic
    // from re-entering the already-full channel and feedback-flooding.
    let feedback = server
        .mock_async(|when, then| {
            when.method(POST).body_includes("axiom channel full");
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));

    // 3000 > CHANNEL_CAP (1024) + 1000 so we both overflow the channel and
    // cross the drop counter's multiple-of-1000 branch at least twice
    // (drops #1 and #1001).
    const EMIT: usize = 3000;
    let emit_elapsed;
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // `#[tokio::test]` defaults to a current-thread runtime. The
        // synchronous for loop below monopolizes that thread — the
        // dispatcher task is spawned but cannot run, so the channel fills
        // deterministically without any mock-server delay trickery. Once
        // past CHANNEL_CAP every `try_send` returns `Full` and we exercise
        // the drop-counter path.
        let start = std::time::Instant::now();
        for i in 0..EMIT {
            tracing::warn!(i, "burst");
        }
        emit_elapsed = start.elapsed();
    }

    // `on_event` uses `try_send`, so even with a full channel the whole
    // burst must complete in low-ms. 500ms is ample slack over the expected
    // runtime and will hang (not silently pass) if someone ever swaps in a
    // blocking variant like `blocking_send` or a retry loop.
    assert!(
        emit_elapsed < std::time::Duration::from_millis(500),
        "caller blocked on full channel: {emit_elapsed:?}",
    );

    guard.shutdown().await;

    // Feedback invariant: INTERNAL_TARGET events never entered the channel.
    feedback.assert_calls_async(0).await;

    // Dispatcher drained normally after shutdown's `send(Close)` found a
    // slot — confirms the loop recovers rather than permanently wedging.
    let hits = ingest.calls_async().await;
    assert!(hits >= 1, "dispatcher never drained");
    // Drops actually happened: if buffering were unbounded, the dispatcher
    // would POST ceil(EMIT/BATCH_SIZE) = 60 batches; with a 1024-slot
    // channel it POSTs ~21. 40 is a comfortable ceiling under 60.
    assert!(
        hits < 40,
        "too many ingest POSTs ({hits}); drops may not have happened",
    );
}

#[tokio::test]
async fn non_success_ingest_response_does_not_hang_shutdown_or_panic() {
    let server = MockServer::start_async().await;

    // Return 500 for every ingest. The dispatcher should log via
    // INTERNAL_TARGET and drop the batch without panicking; shutdown must
    // still complete well within FLUSH_DEADLINE.
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.status(500).body("boom");
        })
        .await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!("trigger ingest failure");
        guard.shutdown().await;
    }

    // If the failure path panics or leaks the task, shutdown never returns
    // (the test harness enforces its own timeout, so we'd see a hang).
    mock.assert_calls_async(1).await;
    let events = recording.events();
    assert!(
        events.iter().any(|event| {
            event.target == INTERNAL_TARGET
                && event
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("axiom ingest returned non-success"))
        }),
        "sibling local layer did not record Axiom internal diagnostic: {events:?}",
    );
}

// -- Debug field truncation (DEBUG_FIELD_MAX_BYTES = 4 KiB) ------------------

#[tokio::test]
async fn debug_field_over_limit_is_truncated_with_marker() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // 5000 A's → sentinel → 3000 A's. Debug form: `"` + 5000 + sentinel
        // (17 bytes) + 3000 + `"` = 8019 bytes. The sentinel starts at
        // Debug-form byte 5001, well past the 4 KiB cap, so correct
        // truncation must drop it.
        let mut big = "A".repeat(5000);
        big.push_str("SENTINEL_PAST_CAP");
        big.push_str(&"A".repeat(3000));
        tracing::warn!(big = ?big, "truncate-me");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "truncate-me");
    let big = string_field(event, "big");
    assert!(
        big.contains("…[truncated]"),
        "oversized debug field should include truncation marker: {big:?}",
    );
    // Negative: content past the 4 KiB cap MUST be dropped. If the
    // `s.truncate(cut)` line is ever removed while the marker append stays,
    // the marker assertion alone still passes — this assertion catches that.
    assert!(
        !big.contains("SENTINEL_PAST_CAP"),
        "far-past-cap sentinel should not reach ingest: {big:?}",
    );
}

#[tokio::test]
async fn debug_field_truncation_walks_to_utf8_char_boundary() {
    let server = MockServer::start_async().await;
    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // 2500 × 2-byte `ñ` = 5000 bytes; Debug adds surrounding quotes →
        // 5002 bytes. Byte 4096 of the Debug form falls mid-`ñ`, so the
        // truncation code MUST walk backward to a char boundary — without
        // that walk, `s.truncate(4096)` panics and this test fails.
        let big: String = "ñ".repeat(2500);
        tracing::warn!(big = ?big, "utf8-boundary");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "utf8-boundary");
    assert!(
        string_field(event, "big").contains("…[truncated]"),
        "oversized UTF-8 debug field should include truncation marker: {event:#?}",
    );
}

#[tokio::test]
async fn debug_field_at_exact_limit_passes_through_unmodified() {
    let server = MockServer::start_async().await;

    let (ingest, captured) = capture_axiom_ingest(&server).await;

    let (layer, guard) =
        init_with_base_url(&server.base_url(), "t", "test").expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        // Debug form of a &str is `"<contents>"` — surrounding quotes cost
        // 2 bytes, so 4094 content bytes yields exactly DEBUG_FIELD_MAX_BYTES.
        // The truncation check is `s.len() > MAX`, which is FALSE at equality
        // → value must pass through unmodified. Ending with a sentinel lets
        // the positive mock verify the full body arrived, not just the
        // message field.
        let mut payload = "A".repeat(4094 - "SENTINEL_AT_END".len());
        payload.push_str("SENTINEL_AT_END");
        tracing::warn!(val = ?payload, "at-limit");
    }
    guard.shutdown().await;

    ingest.assert_calls_async(1).await;
    let events = captured.events();
    let event = event_with_message(&events, "at-limit");
    let val = string_field(event, "val");
    assert!(
        val.contains("SENTINEL_AT_END"),
        "exact-limit debug field should pass through unmodified: {val:?}",
    );
    assert!(
        !val.contains("…[truncated]"),
        "exact-limit debug field should not include truncation marker: {val:?}",
    );
}
