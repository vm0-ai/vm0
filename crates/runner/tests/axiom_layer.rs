//! Integration tests for the Axiom tracing layer.
//!
//! The layer + its dispatcher run for real; only the network boundary is
//! mocked (`httpmock` stands in for `https://api.axiom.co`). Tests verify
//! that events flow through the layer → channel → dispatcher → POST
//! endpoint with the TS-compatible payload shape.
//!
//! Env vars are process-global, so tests serialize on `ENV_LOCK`.

#[path = "../src/axiom_layer.rs"]
mod axiom_layer;

use std::sync::{Arc, Mutex};

use httpmock::Method::POST;
use httpmock::MockServer;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
const INTERNAL_TARGET: &str = "runner::axiom_layer::internal";

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

fn clear_axiom_env() {
    // SAFETY: setenv is not thread-safe, but we hold ENV_LOCK for the
    // duration of every test that touches these vars.
    unsafe {
        std::env::remove_var("AXIOM_TOKEN_TELEMETRY");
        std::env::remove_var("AXIOM_DATASET_SUFFIX");
    }
}

/// Acquire `ENV_LOCK`, run `f` with env state captured, then drop the lock.
/// `f` does the env setup and returns anything cheap (e.g. a layer + guard).
/// The lock never spans an `.await` — `axiom_layer::init` owns its env reads
/// synchronously, and the returned dispatcher holds owned strings.
fn with_env<T>(f: impl FnOnce() -> T) -> T {
    // `unwrap_or_else` handles poison by reusing the inner guard — poisoning
    // only means a previous test panicked while holding it, which doesn't
    // corrupt the `()` payload.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_axiom_env();
    f()
}

#[tokio::test]
async fn warn_and_error_events_are_ingested_with_ts_shape() {
    let server = MockServer::start_async().await;

    // `body_includes` checks substrings in the batched JSON array. If any
    // substring is missing, the mock doesn't match and `assert_calls_async(1)`
    // below will name the expected-but-not-hit mock in the failure message.
    let content_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                // Rust-only discriminator.
                .body_includes(r#""service":"runner""#)
                // Lowercase levels (matches TS @axiomhq/logging).
                .body_includes(r#""level":"warn""#)
                .body_includes(r#""level":"error""#)
                // `message` flattened to top level.
                .body_includes(r#""message":"a warning""#)
                .body_includes(r#""message":"a failure""#)
                // User fields flattened.
                .body_includes(r#""foo":"bar""#)
                .body_includes(r#""code":42"#)
                // `context` present (value is the tracing target — the test
                // module path, whatever it turns out to be).
                .body_includes(r#""context":"#);
            then.status(200).body("{}");
        })
        .await;

    // Negative: INFO is below the layer's WARN threshold, so no payload
    // should contain `"level":"info"`.
    let info_mock = server
        .mock_async(|when, then| {
            when.method(POST).body_includes(r#""level":"info""#);
            then.status(200).body("{}");
        })
        .await;

    // Use the test-only `init_with_base_url` to redirect at the mock server.
    // `init()` always targets api.axiom.co and can't be pointed elsewhere.
    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "test-token", "test")
        .expect("init_with_base_url must succeed");

    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::warn!(foo = "bar", "a warning");
        tracing::error!(code = 42, "a failure");
        tracing::info!("info is below threshold, should not be ingested");
    }

    guard.shutdown().await;

    content_mock.assert_calls_async(1).await;
    info_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn axiom_filter_does_not_suppress_sibling_local_layers() {
    let server = MockServer::start_async().await;

    let warn_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                .body_includes(r#""level":"warn""#)
                .body_includes(r#""message":"local warn""#);
            then.status(200).body("{}");
        })
        .await;
    let info_mock = server
        .mock_async(|when, then| {
            when.method(POST).body_includes(r#""message":"local info""#);
            then.status(200).body("{}");
        })
        .await;
    let debug_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .body_includes(r#""message":"local debug""#);
            then.status(200).body("{}");
        })
        .await;
    let trace_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .body_includes(r#""message":"local trace""#);
            then.status(200).body("{}");
        })
        .await;
    let internal_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .body_includes(r#""message":"local internal""#);
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(axiom_layer::with_ingest_filter(layer));

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

    warn_mock.assert_calls_async(1).await;
    info_mock.assert_calls_async(0).await;
    debug_mock.assert_calls_async(0).await;
    trace_mock.assert_calls_async(0).await;
    internal_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn init_returns_none_when_env_missing() {
    let result = with_env(axiom_layer::init);
    assert!(result.is_none());
}

#[tokio::test]
async fn init_returns_none_when_token_empty() {
    let result = with_env(|| {
        unsafe {
            std::env::set_var("AXIOM_TOKEN_TELEMETRY", "");
            std::env::set_var("AXIOM_DATASET_SUFFIX", "dev");
        }
        axiom_layer::init()
    });
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

    // Match on the exact nested shape the `record_error` visitor emits.
    // `serde_json::Map` preserves insertion order, and we insert `message`
    // before `chain` — so the substring literal is stable.
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                .body_includes(r#""error":{"message":"top","chain":["middle","root"]}"#)
                .body_includes(r#""message":"explosion""#);
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));
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

    mock.assert_calls_async(1).await;
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

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));

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

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let recording = RecordingLayer::default();
    let subscriber = tracing_subscriber::registry()
        .with(recording.clone())
        .with(axiom_layer::with_ingest_filter(layer));
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
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                .body_includes(r#""message":"truncate-me""#)
                .body_includes("…[truncated]");
            then.status(200).body("{}");
        })
        .await;
    // Negative: content past the 4 KiB cap MUST be dropped. If the
    // `s.truncate(cut)` line is ever removed while the marker append stays,
    // the marker assertion alone still passes — this mock catches that
    // mutation by asserting the far-past-cap sentinel never reaches ingest.
    let sentinel_mock = server
        .mock_async(|when, then| {
            when.method(POST).body_includes("SENTINEL_PAST_CAP");
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));
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

    mock.assert_calls_async(1).await;
    sentinel_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn debug_field_truncation_walks_to_utf8_char_boundary() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                .body_includes(r#""message":"utf8-boundary""#)
                .body_includes("…[truncated]");
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));
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

    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn debug_field_at_exact_limit_passes_through_unmodified() {
    let server = MockServer::start_async().await;

    // Positive: event arrives with its message AND the full payload —
    // `SENTINEL_AT_END` is the last 15 bytes of the 4094-byte payload, so
    // it survives only if the value is passed through untouched. This
    // catches mutations that erroneously empty the value at exact-limit
    // without appending the marker.
    let clean_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest")
                .body_includes(r#""message":"at-limit""#)
                .body_includes("SENTINEL_AT_END");
            then.status(200).body("{}");
        })
        .await;
    // Negative: no truncation marker should appear in any ingested body.
    let truncation_mock = server
        .mock_async(|when, then| {
            when.method(POST).body_includes("…[truncated]");
            then.status(200).body("{}");
        })
        .await;

    let (layer, guard) = axiom_layer::init_with_base_url(&server.base_url(), "t", "test")
        .expect("init must succeed");
    let subscriber = tracing_subscriber::registry().with(axiom_layer::with_ingest_filter(layer));
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

    clean_mock.assert_calls_async(1).await;
    truncation_mock.assert_calls_async(0).await;
}
