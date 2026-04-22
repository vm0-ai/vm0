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

use httpmock::Method::POST;
use httpmock::MockServer;
use tracing_subscriber::layer::SubscriberExt;

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

    let subscriber = tracing_subscriber::registry().with(layer);
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
    let subscriber = tracing_subscriber::registry().with(layer);
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
    let subscriber = tracing_subscriber::registry().with(layer);
    {
        let _sub = tracing::subscriber::set_default(subscriber);
        tracing::error!("trigger ingest failure");
    }

    // If the failure path panics or leaks the task, this await never returns
    // (the test harness enforces its own timeout, so we'd see a hang).
    guard.shutdown().await;
    mock.assert_calls_async(1).await;
}
