use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, ExecRequest, ExecResult, ProcessExit, ProcessOutputChunk, ProcessOutputMode,
    Sandbox, SandboxConfig, SandboxCreateObserver, SandboxCreateStage, SandboxError,
    SandboxFactory, SandboxId, SandboxInitializationPhase, SandboxNbdCowCreateOutcome,
    SandboxNbdCowCreateStage, SandboxNbdNetlinkConnectStage, SandboxStartObserver,
    SandboxStartStage, StartProcessRequest,
};
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
use crate::run_cancellation::RunCancellationSignals;
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
        client_session_id: "runner-session-test".to_string(),
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

fn assert_action_outcome(
    telemetry: &JobTelemetry,
    action: &str,
    success: bool,
    error: Option<&str>,
) {
    let ops = telemetry.pending_ops_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, success, "{action} success flag");
    assert_eq!(op.2.as_deref(), error, "{action} error");
}

fn assert_action_duration(telemetry: &JobTelemetry, action: &str, duration_ms: u64) {
    let ops = telemetry.pending_ops_with_duration_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, duration_ms, "{action} duration");
}

struct ObservedStartSandbox {
    inner: Box<dyn Sandbox>,
    failed_stage: Option<SandboxStartStage>,
    omit_optional_stages: bool,
}

#[async_trait]
impl Sandbox for ObservedStartSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn host_process_pid(&self) -> Option<u32> {
        self.inner.host_process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn start_with_observer(
        &mut self,
        observer: &mut dyn SandboxStartObserver,
    ) -> sandbox::Result<()> {
        for (index, stage) in SandboxStartStage::ALL.iter().copied().enumerate() {
            if self.omit_optional_stages
                && matches!(
                    stage,
                    SandboxStartStage::SnapshotLoadResume | SandboxStartStage::GuestDnsReadiness
                )
            {
                continue;
            }
            let success = self.failed_stage != Some(stage);
            observer.record_stage(stage, Duration::from_millis(index as u64 + 30), success);
            if !success {
                return Err(SandboxError::Start {
                    message: "observed mock start failure".to_string(),
                });
            }
        }
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn exec_with_diagnostic_label(
        &self,
        request: &ExecRequest<'_>,
        label: &'static str,
    ) -> sandbox::Result<ExecResult> {
        self.inner.exec_with_diagnostic_label(request, label).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

struct ObservedMockSandboxFactory {
    inner: MockSandboxFactory,
    failed_stage: Option<SandboxCreateStage>,
    failed_nbd_cow_stage: Option<SandboxNbdCowCreateStage>,
    failed_nbd_netlink_connect_stage: Option<SandboxNbdNetlinkConnectStage>,
    failed_start_stage: Option<SandboxStartStage>,
    omit_optional_start_stages: bool,
}

impl ObservedMockSandboxFactory {
    fn new() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_stage(stage: SandboxCreateStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: Some(stage),
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_nbd_cow_stage(stage: SandboxNbdCowCreateStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: Some(stage),
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_nbd_netlink_connect_stage(stage: SandboxNbdNetlinkConnectStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: Some(stage),
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_start_stage(stage: SandboxStartStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: Some(stage),
            omit_optional_start_stages: false,
        }
    }

    fn without_optional_start_stages() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: true,
        }
    }
}

#[async_trait]
impl SandboxFactory for ObservedMockSandboxFactory {
    fn name(&self) -> &str {
        "observed-mock"
    }

    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let inner = self.inner.create(config).await?;
        Ok(Box::new(ObservedStartSandbox {
            inner,
            failed_stage: self.failed_start_stage,
            omit_optional_stages: self.omit_optional_start_stages,
        }))
    }

    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        if let Some(stage) = self.failed_stage {
            observer.record_stage(stage, Duration::from_millis(1), false);
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock create failure".to_string(),
            });
        }

        if let Some(stage) = self.failed_nbd_cow_stage {
            observer.record_nbd_cow_stage(stage, Duration::from_millis(1), false);
            observer.record_stage(
                SandboxCreateStage::NbdCowCreate,
                Duration::from_millis(2),
                false,
            );
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock NBD COW detail failure".to_string(),
            });
        }

        if let Some(stage) = self.failed_nbd_netlink_connect_stage {
            observer.record_nbd_netlink_connect_stage(stage, Duration::from_millis(1), false);
            observer.record_nbd_cow_stage(
                SandboxNbdCowCreateStage::NetlinkConnect,
                Duration::from_millis(2),
                false,
            );
            observer.record_stage(
                SandboxCreateStage::NbdCowCreate,
                Duration::from_millis(3),
                false,
            );
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock NBD netlink detail failure".to_string(),
            });
        }

        for (index, stage) in SandboxCreateStage::ALL.iter().copied().enumerate() {
            observer.record_stage(stage, Duration::from_millis(index as u64 + 1), true);
        }
        for (index, stage) in SandboxNbdCowCreateStage::ALL.iter().copied().enumerate() {
            observer.record_nbd_cow_stage(stage, Duration::from_millis(index as u64 + 10), true);
        }
        for (index, stage) in SandboxNbdNetlinkConnectStage::ALL
            .iter()
            .copied()
            .enumerate()
        {
            observer.record_nbd_netlink_connect_stage(
                stage,
                Duration::from_millis(index as u64 + 20),
                true,
            );
        }
        for outcome in [
            SandboxNbdCowCreateOutcome::AcquireSourceDemandScan,
            SandboxNbdCowCreateOutcome::EbusyRetriesNone,
            SandboxNbdCowCreateOutcome::SizeZeroRetriesNone,
        ] {
            observer.record_nbd_cow_outcome(outcome);
        }
        self.create(config).await
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

const FRESH_SANDBOX_FACTORY_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_cow_pool_acquire",
    "runner_fresh_sandbox_factory_workspace_dir_rename",
    "runner_fresh_sandbox_factory_workspace_drive_prepare",
    "runner_fresh_sandbox_factory_workspace_seed_sparse_copy",
    "runner_fresh_sandbox_factory_workspace_fresh_format",
    "runner_fresh_sandbox_factory_sock_dir_prepare",
    "runner_fresh_sandbox_factory_netns_acquire",
    "runner_fresh_sandbox_factory_nbd_cow_create",
];

const FRESH_SANDBOX_FACTORY_NBD_COW_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_cow_layer_create",
    "runner_fresh_sandbox_factory_nbd_device_acquire",
    "runner_fresh_sandbox_factory_nbd_device_scan",
    "runner_fresh_sandbox_factory_nbd_dispatch_setup",
    "runner_fresh_sandbox_factory_nbd_netlink_connect",
    "runner_fresh_sandbox_factory_nbd_size_verify",
    "runner_fresh_sandbox_factory_nbd_retry_cleanup",
    "runner_fresh_sandbox_factory_nbd_retry_delay",
];

const FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_netlink_blocking_task_queue",
    "runner_fresh_sandbox_factory_nbd_netlink_socket_setup",
    "runner_fresh_sandbox_factory_nbd_netlink_family_resolve",
    "runner_fresh_sandbox_factory_nbd_netlink_connect_command",
];

const FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_acquire_source_demand_scan",
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_none",
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_none",
];

const FRESH_SANDBOX_START_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_start_backend_launch",
    "runner_fresh_sandbox_start_snapshot_load_resume",
    "runner_fresh_sandbox_start_guest_connection_wait",
    "runner_fresh_sandbox_start_guest_dns_readiness",
    "runner_fresh_sandbox_start_runtime_finalize",
];

const RUNNER_PRE_SPAWN_PHASE_ACTIONS: &[&str] = &[
    "runner_claim_resume_session_validation",
    "runner_claim_session_history_materializer_start",
    "runner_claim_device_rate_limits",
    "runner_claim_idle_reuse_lookup",
    "runner_claim_workspace_cache_state_lookup",
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
        (RunnerPreSpawnPhase::WorkspaceCacheStateLookup, 5),
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
        SandboxReuseResult::NoReuseKey,
        SandboxReuseResult::InvalidResumeSessionId,
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
    assert_action_success(&telemetry, "runner_fresh_sandbox_start", true);
    for action in FRESH_SANDBOX_START_STAGE_ACTIONS {
        assert_lacks_action(&telemetry, action);
    }
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
            reuse_result: SandboxReuseResult::NoReuseKey,
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
    let factory = ObservedMockSandboxFactory::new();

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
        RunCancellationSignals::hard_only(cancel),
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
    for action in FRESH_SANDBOX_FACTORY_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for (index, action) in FRESH_SANDBOX_START_STAGE_ACTIONS.iter().enumerate() {
        assert_action_success(&telemetry, action, true);
        assert_action_duration(&telemetry, action, index as u64 + 30);
    }
    let operations = telemetry.pending_ops_with_duration_snapshot();
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS {
        let matching: Vec<_> = operations
            .iter()
            .filter(|operation| operation.0 == *action)
            .collect();
        assert_eq!(matching.len(), 1, "outcome {action}: {operations:?}");
        assert_eq!(matching[0].1, 0, "outcome {action} duration");
    }
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_reused_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_workspace_image_prepare");
    assert_lacks_action(&telemetry, "runner_guest_state_restore");
}

#[tokio::test]
async fn execute_job_omits_inapplicable_sandbox_start_stages() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::without_optional_start_stages();

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

    for action in [
        "runner_fresh_sandbox_start_backend_launch",
        "runner_fresh_sandbox_start_guest_connection_wait",
        "runner_fresh_sandbox_start_runtime_finalize",
    ] {
        assert_action_success(&telemetry, action, true);
    }
    assert_lacks_action(
        &telemetry,
        "runner_fresh_sandbox_start_snapshot_load_resume",
    );
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_guest_dns_readiness");
    assert_action_success(&telemetry, "runner_fresh_sandbox_start", true);
}

#[tokio::test]
async fn execute_job_records_failed_sandbox_start_stage_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory =
        ObservedMockSandboxFactory::with_failed_start_stage(SandboxStartStage::GuestConnectionWait);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, telemetry) = execute_job(
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

    assert!(
        outcome
            .error()
            .is_some_and(|error| error.contains("observed mock start failure"))
    );

    for action in [
        "runner_fresh_sandbox_start_backend_launch",
        "runner_fresh_sandbox_start_snapshot_load_resume",
    ] {
        assert_action_success(&telemetry, action, true);
    }
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_start_guest_connection_wait",
        false,
        Some("sandbox_start_stage_failed"),
    );
    assert_action_duration(
        &telemetry,
        "runner_fresh_sandbox_start_guest_connection_wait",
        32,
    );
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_guest_dns_readiness");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_runtime_finalize");
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_start",
        false,
        Some("sandbox_start_failed"),
    );
}

#[tokio::test]
async fn execute_job_records_failed_fresh_sandbox_factory_stage_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_stage(SandboxCreateStage::NbdCowCreate);

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

    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_cow_create",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
    assert_action_success(&telemetry, "vm_create", false);
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
}

#[tokio::test]
async fn execute_job_records_failed_nbd_cow_detail_and_parent_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_nbd_cow_stage(
        SandboxNbdCowCreateStage::NetlinkConnect,
    );

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

    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_netlink_connect",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_cow_create",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
}

#[tokio::test]
async fn execute_job_records_failed_nbd_netlink_detail_and_parent_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_nbd_netlink_connect_stage(
        SandboxNbdNetlinkConnectStage::ConnectCommand,
    );

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

    for action in [
        "runner_fresh_sandbox_factory_nbd_netlink_connect_command",
        "runner_fresh_sandbox_factory_nbd_netlink_connect",
        "runner_fresh_sandbox_factory_nbd_cow_create",
    ] {
        assert_action_outcome(
            &telemetry,
            action,
            false,
            Some("sandbox_factory_create_stage_failed"),
        );
    }
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
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
            reuse_result: SandboxReuseResult::NoReuseKey,
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
        RunCancellationSignals::hard_only(cancel),
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
        "agent_execute",
    ] {
        assert_has_action(&telemetry, action);
    }
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_factory_create");
    for action in FRESH_SANDBOX_FACTORY_STAGE_ACTIONS {
        assert_lacks_action(&telemetry, action);
    }
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_proxy_register");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
    assert_lacks_action(&telemetry, "runner_guest_timezone_sync");
    assert_lacks_action(&telemetry, "workspace_drive_mount");
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
        RunCancellationSignals::hard_only(cancel),
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
