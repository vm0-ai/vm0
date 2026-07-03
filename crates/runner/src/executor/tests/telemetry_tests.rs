use std::time::Duration;

use sandbox::SandboxId;
use sandbox::{ProcessOutputChunk, ProcessOutputMode};
use sandbox_mock::MockSandboxFactory;

use super::super::telemetry::{
    RunnerPreSpawnPhase, elapsed_since_api_start_ms, record_reuse_result,
};
use super::super::{
    ExecutionHooks, NewSandboxDispatch, RunnerPreSpawnTiming, SessionHistoryRestorePlan,
    execute_job, execute_job_reuse, execute_job_reuse_with_hooks,
    execute_job_with_prepared_notifier,
};
use super::support::{
    default_params, make_reusable_idle_sandbox, minimal_context, test_executor_config,
};
use crate::http::{HttpClient, HttpClientConfig};
use crate::ids::RunId;
use crate::telemetry::JobTelemetry;
use crate::types::SandboxReuseResult;

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

fn assert_has_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|op| op.0 == action),
        "expected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_lacks_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().all(|op| op.0 != action),
        "unexpected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_action_success(telemetry: &JobTelemetry, action: &str, success: bool) {
    let ops = telemetry.pending_ops_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, success, "{action} success flag");
}

const RUNNER_PRE_SPAWN_PHASE_ACTIONS: &[&str] = &[
    "runner_claim_resume_session_validation",
    "runner_claim_session_history_materializer_start",
    "runner_claim_device_rate_limits",
    "runner_claim_idle_reuse_lookup",
    "runner_claim_held_session_state_refresh",
    "runner_claim_workspace_promotion_validation",
    "runner_claim_idle_unpark",
    "runner_claim_active_status_publish",
    "runner_claim_spawn_job_setup",
    "runner_claim_task_schedule_wait",
];

fn assert_pre_spawn_phase_actions_succeeded(telemetry: &JobTelemetry) {
    for action in RUNNER_PRE_SPAWN_PHASE_ACTIONS {
        assert_action_success(telemetry, action, true);
    }
}

fn pre_spawn_timing_with_phases() -> RunnerPreSpawnTiming {
    let mut timing = RunnerPreSpawnTiming::start_after_claim();
    for (phase, duration_ms) in [
        (RunnerPreSpawnPhase::ResumeSessionValidation, 1),
        (RunnerPreSpawnPhase::SessionHistoryMaterializerStart, 2),
        (RunnerPreSpawnPhase::DeviceRateLimits, 3),
        (RunnerPreSpawnPhase::IdleReuseLookup, 4),
        (RunnerPreSpawnPhase::HeldSessionStateRefresh, 5),
        (RunnerPreSpawnPhase::WorkspacePromotionValidation, 6),
        (RunnerPreSpawnPhase::IdleUnpark, 7),
        (RunnerPreSpawnPhase::ActiveStatusPublish, 8),
        (RunnerPreSpawnPhase::SpawnJobSetup, 9),
    ] {
        timing.record_phase(phase, Duration::from_millis(duration_ms));
    }
    timing.mark_task_enqueued();
    timing
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
    assert_lacks_action(&telemetry, "runner_claim_to_executor_start");
    assert_lacks_action(&telemetry, "runner_claim_resume_session_validation");
    assert_lacks_action(&telemetry, "runner_claim_task_schedule_wait");
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

#[tokio::test]
async fn execute_job_records_runner_pre_spawn_and_fresh_path_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    for action in [
        "runner_claim_to_executor_start",
        "runner_executor_start_to_spawn",
        "runner_claim_to_spawn",
        "runner_fresh_sandbox_prepare",
        "runner_fresh_sandbox_factory_create",
        "runner_fresh_sandbox_proxy_register",
        "runner_fresh_sandbox_start",
        "runner_guest_timezone_sync",
        "runner_user_env_write",
        "runner_agent_env_build",
        "runner_agent_start_process",
        "sandbox_reuse_miss",
        "vm_create",
        "workspace_drive_mount",
        "agent_execute",
    ] {
        assert_has_action(&telemetry, action);
    }
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_reused_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_workspace_image_prepare");
    assert_lacks_action(&telemetry, "runner_guest_state_restore");
}

#[tokio::test]
async fn execute_job_reuse_records_runner_pre_spawn_and_reuse_path_timing() {
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
    let (_outcome, telemetry) = execute_job_reuse_with_hooks(
        idle_sandbox,
        minimal_context(),
        &config,
        &default_params(),
        cancel,
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    for action in [
        "runner_claim_to_executor_start",
        "runner_executor_start_to_spawn",
        "runner_claim_to_spawn",
        "runner_reused_sandbox_prepare",
        "runner_guest_state_restore",
        "runner_user_env_write",
        "runner_agent_env_build",
        "runner_agent_start_process",
        "sandbox_reuse_hit",
        "workspace_drive_mount",
        "agent_execute",
    ] {
        assert_has_action(&telemetry, action);
    }
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_factory_create");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_proxy_register");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
    assert_lacks_action(&telemetry, "runner_guest_timezone_sync");
}

#[tokio::test]
async fn start_process_failure_records_phase_failure_without_spawn_completion() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = std::sync::Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_stdout_chunks(vec![
        ProcessOutputChunk {
            bytes: Vec::new(),
            truncated: false,
        };
        ProcessOutputMode::DEFAULT_QUEUE_CAPACITY + 1
    ]);
    let factory = MockSandboxFactory::with_overrides(overrides);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(RunnerPreSpawnTiming::start_after_claim()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    assert_action_success(&telemetry, "runner_agent_start_process", false);
    assert_action_success(&telemetry, "agent_execute", false);
    assert_lacks_action(&telemetry, "runner_executor_start_to_spawn");
    assert_lacks_action(&telemetry, "runner_claim_to_spawn");
}
