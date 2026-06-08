use super::*;

#[test]
fn elapsed_since_api_start_ms_returns_elapsed_duration() {
    let duration = elapsed_since_api_start_ms(1_700_000_000_000, 1_700_000_001_250);

    assert_eq!(duration, Some(Duration::from_millis(1_250)));
}

#[test]
fn elapsed_since_api_start_ms_clamps_future_start_to_zero() {
    let duration = elapsed_since_api_start_ms(1_700_000_001_250, 1_700_000_000_000);

    assert_eq!(duration, Some(Duration::ZERO));
}

#[test]
fn elapsed_since_api_start_ms_rejects_seconds_shaped_start() {
    let duration = elapsed_since_api_start_ms(1_700_000_000, 1_700_000_001_250);

    assert_eq!(duration, None);
}

// -----------------------------------------------------------------------
// Reuse-outcome telemetry (issue #10360: sandbox reuse success rate)
// -----------------------------------------------------------------------

fn new_telemetry() -> JobTelemetry {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".to_string(),
        vercel_bypass: None,
    })
    .unwrap();
    JobTelemetry::new(http, RunId::nil(), "tok".to_string())
}

#[test]
fn record_reuse_result_emits_hit_for_reuse() {
    let mut telemetry = new_telemetry();
    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].0, "sandbox_reuse_hit");
}

#[test]
fn record_reuse_result_emits_miss_for_every_miss_variant() {
    let variants = [
        SandboxReuseResult::NoSessionId,
        SandboxReuseResult::PoolMiss,
        SandboxReuseResult::ProfileMismatch,
        SandboxReuseResult::DeviceLimitMismatch,
        SandboxReuseResult::UnparkFailed,
    ];
    for variant in variants {
        let mut telemetry = new_telemetry();
        record_reuse_result(&mut telemetry, variant);
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), 1, "{variant:?}");
        assert_eq!(ops[0].0, "sandbox_reuse_miss", "{variant:?}");
    }
}

#[tokio::test]
async fn execute_job_records_sandbox_reuse_miss_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_miss");
}

#[tokio::test]
async fn execute_job_reuse_records_sandbox_reuse_hit_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoSessionId,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (_outcome, telemetry) = execute_job_reuse(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_hit");
}
