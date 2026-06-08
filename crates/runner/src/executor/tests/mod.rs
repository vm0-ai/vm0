use super::agent_run::*;
use super::diagnostics::*;
use super::env::*;
use super::guest_state::*;
use super::sandbox_run::*;
use super::session_restore::*;
use super::storage::*;
use super::telemetry::*;
use super::*;
use crate::host_env::{
    RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV, RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV,
};
use crate::http::HttpClientConfig;
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::proxy;
use crate::types::{
    GuestDownloadArtifactEntry, GuestDownloadManifest, GuestDownloadStorageEntry, ResumeSession,
    SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG,
};
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
};
use agent_diagnostics::FAILURE_DIAGNOSTIC_SCHEMA_VERSION;
use api_contracts::generated::constants::model_provider_env::placeholders as model_provider_placeholders;
use api_contracts::generated::types::runners::storage::{
    ArtifactEntry, ArtifactEntryMissingRootPolicy, StorageEntry, StorageManifest,
};
use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ProcessControlMode, ProcessOutputMode,
    SandboxConfig, StartProcessRequest,
};
use sandbox_mock::MockSandboxFactory;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

const RUN_IN_SANDBOX_TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
struct CapturedEvent {
    level: Level,
    fields: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
struct CapturedEvents {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl CapturedEvents {
    fn entries(&self) -> Vec<CapturedEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl<S> Layer<S> for CapturedEvents
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapturedFields::default();
        event.record(&mut visitor);
        self.events.lock().unwrap().push(CapturedEvent {
            level: *event.metadata().level(),
            fields: visitor.fields,
        });
    }
}

#[derive(Default)]
struct CapturedFields {
    fields: BTreeMap<String, String>,
}

impl Visit for CapturedFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.fields
            .insert(field.name().to_string(), format!("{value:?}"));
    }
}

fn api_storage(name: &str, mount_path: &str, version: &str, archive_url: &str) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        instructions_target_filename: None,
    }
}

fn api_artifact(
    name: &str,
    mount_path: &str,
    storage_id: &str,
    version: &str,
    archive_url: &str,
) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        archive_url: archive_url.into(),
        vas_storage_name: name.into(),
        vas_storage_id: storage_id.into(),
        vas_version_id: version.into(),
        manifest_url: None,
        missing_root_policy: None,
    }
}

struct DestroyPanicFactory {
    inner: MockSandboxFactory,
}

#[async_trait]
impl SandboxFactory for DestroyPanicFactory {
    fn name(&self) -> &str {
        "destroy-panic"
    }

    fn config_hash(&self) -> String {
        "destroy-panic".into()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }

    #[allow(clippy::panic)]
    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        panic!("simulated destroy panic");
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

fn build_env_for_test(ctx: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
    build_env_for_test_result(ctx, api_url).expect("test env should build")
}

fn build_env_for_test_result(
    ctx: &ExecutionContext,
    api_url: &str,
) -> RunnerResult<HashMap<String, String>> {
    build_env_for_test_with_host_env_result(ctx, api_url, &HostEnv::default())
}

fn build_env_for_test_with_host_env(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> HashMap<String, String> {
    build_env_for_test_with_host_env_result(ctx, api_url, host_env).expect("test env should build")
}

fn build_env_for_test_with_host_env_result(
    ctx: &ExecutionContext,
    api_url: &str,
    host_env: &HostEnv,
) -> RunnerResult<HashMap<String, String>> {
    let sid = SandboxId::new_v4().to_string();
    build_env_json_with_host_env(ctx, api_url, &sid, SandboxReuseResult::Reused, host_env)
}

fn minimal_context() -> ExecutionContext {
    ExecutionContext {
        run_id: RunId::nil(),
        prompt: "test prompt".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
        storage_manifest: None,
        environment: None,
        resume_session: None,
        secret_values: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        cli_agent_type: String::new(),
        debug_no_mock_claude: None,
        debug_no_mock_codex: None,
        api_start_time: None,
        user_timezone: None,
        capture_network_bodies: None,
        firewalls: None,
        network_policies: None,
        disallowed_tools: None,
        tools: None,
        settings: None,
        experimental_profile: None,
        feature_flags: None,
        billable_firewalls: vec![],
        model_usage_provider: None,
    }
}

fn context_with_env(environment: HashMap<String, String>) -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.environment = Some(environment);
    ctx
}

fn set_session_workspace_image_cache_flag(ctx: &mut ExecutionContext, enabled: bool) {
    ctx.feature_flags
        .get_or_insert_with(HashMap::new)
        .insert(SESSION_WORKSPACE_IMAGE_CACHE_FEATURE_FLAG.into(), enabled);
}

mod agent_run_tests;
mod diagnostics_tests;
mod env_tests;
mod guest_state_tests;
mod sandbox_run_tests;
mod session_restore_tests;
mod storage_tests;
mod telemetry_tests;

// -----------------------------------------------------------------------
// Sandbox-interacting function tests (using sandbox-mock)
// -----------------------------------------------------------------------

use sandbox::{
    ExecResult, ProcessExit, ProcessOutputChunk, SandboxError, SandboxInitializationPhase,
    SandboxOperation, SandboxOperationReason,
};
use sandbox_mock::MockSandbox;

fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: message.into(),
    }
}

// -----------------------------------------------------------------------
// execute_new_sandbox integration tests (MockSandboxFactory + real filesystem)
// -----------------------------------------------------------------------

/// Build a real `ExecutorConfig` backed by tempdir files.
async fn test_executor_config(dir: &std::path::Path) -> ExecutorConfig {
    let registry_path = dir.join("proxy-registry.json");
    let lock_path = dir.join("proxy-registry.json.lock");
    tokio::fs::write(&registry_path, r#"{"vms":{},"updatedAt":0}"#)
        .await
        .unwrap();
    let log_dir = dir.join("logs");
    tokio::fs::create_dir_all(&log_dir).await.unwrap();

    ExecutorConfig {
        api_url: "http://localhost:9999".into(),
        registry: proxy::ProxyRegistryHandle::new(registry_path, lock_path),
        http: crate::http::HttpClient::new(HttpClientConfig {
            api_url: "http://localhost:9999".into(),
            vercel_bypass: None,
        })
        .unwrap(),
        log_paths: LogPaths::new(log_dir),
        network_log_manager: NetworkLogManager::new(),
        network_log_drain: NetworkLogDrainCoordinator::noop(),
        home: HomePaths::with_root(dir.to_path_buf()),
        workspace_cache: None,
    }
}

fn default_params() -> JobParams {
    JobParams {
        profile_name: "vm0/default".into(),
        vcpu: 2,
        memory_mb: 2048,
        workspace_disk_mb: 16_384,
        restore_guest_state: false,
        device_rate_limits: None,
    }
}

fn test_device_rate_limits() -> sandbox::DeviceRateLimits {
    sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    }
}

fn test_budget_lease() -> crate::resource_budget::BudgetLease {
    let budget = Arc::new(crate::resource_budget::ResourceBudget::new(1, 1, 1.0, 0));
    crate::resource_budget::ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap()
}

async fn make_reusable_idle_sandbox(
    sandbox: Box<dyn Sandbox>,
    source_ip: String,
    session_id: &str,
) -> (ReusableIdleSandbox, crate::resource_budget::BudgetLease) {
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult, ParkedIdleCandidate,
        SyntheticParkedIdleCandidateParts,
    };

    let mut pool = IdlePool::new(IdlePoolConfig {
        default_timeout: std::time::Duration::from_secs(300),
        max_idle: 0,
    });
    let candidate = ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
        sandbox,
        factory: std::sync::Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: session_id.into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: test_budget_lease(),
        source_ip,
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let entry = pool.take(session_id).expect("idle entry should exist");
    match entry.try_unpark().await {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        IdleUnparkResult::Failed { error, .. } => {
            panic!("test idle entry should unpark: {error}");
        }
    }
}

fn test_telemetry(config: &ExecutorConfig, ctx: &ExecutionContext) -> JobTelemetry {
    crate::telemetry::JobTelemetry::new(config.http.clone(), ctx.run_id, ctx.sandbox_token.clone())
}

async fn assert_proxy_registry_empty(dir: &std::path::Path) {
    let raw = tokio::fs::read_to_string(dir.join("proxy-registry.json"))
        .await
        .unwrap();
    let registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        registry["vms"].as_object().map(|vms| vms.len()),
        Some(0),
        "proxy registry should not retain a VM after executor cleanup: {registry}",
    );
    assert!(
        registry["updatedAt"]
            .as_i64()
            .is_some_and(|updated_at| updated_at > 0),
        "proxy registry should record a cleanup mutation: {registry}",
    );
}

struct CancelAfterWaitSandbox {
    inner: Box<dyn Sandbox>,
    cancel: tokio_util::sync::CancellationToken,
}

#[async_trait]
impl Sandbox for CancelAfterWaitSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
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
        let result = self.inner.wait_process(handle, timeout).await;
        self.cancel.cancel();
        result
    }
}

struct QueuedCopyFileSandbox {
    inner: Box<dyn Sandbox>,
    copy_file_results: Mutex<VecDeque<Vec<u8>>>,
    remove_path_before_copy: Option<std::path::PathBuf>,
}

impl QueuedCopyFileSandbox {
    fn new(inner: Box<dyn Sandbox>, copy_file_results: Vec<Vec<u8>>) -> Self {
        Self {
            inner,
            copy_file_results: Mutex::new(VecDeque::from(copy_file_results)),
            remove_path_before_copy: None,
        }
    }

    fn with_remove_path_before_copy(mut self, path: std::path::PathBuf) -> Self {
        self.remove_path_before_copy = Some(path);
        self
    }
}

#[async_trait]
impl Sandbox for QueuedCopyFileSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        if let Some(path) = &self.remove_path_before_copy {
            let _ = std::fs::remove_file(path);
        }
        let bytes = self
            .copy_file_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front();
        let Some(bytes) = bytes else {
            return self.inner.copy_file(path, host_path, options).await;
        };

        if bytes.len() as u64 > options.max_bytes {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!("test copy_file exceeded {} bytes", options.max_bytes),
            });
        }
        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(host_path, &bytes)?;
        Ok(sandbox::CopyFileResult {
            bytes_copied: bytes.len() as u64,
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
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

async fn run_execute_inner(
    factory: &MockSandboxFactory,
    ctx: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
) -> RunnerResult<(i32, Option<String>)> {
    let mut telemetry = test_telemetry(config, ctx);
    let cancel = tokio_util::sync::CancellationToken::new();
    let outcome = execute_new_sandbox(
        factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        config,
        params,
        &mut telemetry,
        cancel,
    )
    .await?;
    Ok((outcome.exit_code(), outcome.error().map(ToOwned::to_owned)))
}

async fn create_overridden_sandbox(
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    sandbox_mock::MockSandboxFactory::with_overrides(overrides)
        .create(SandboxConfig {
            id: SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .unwrap()
}

async fn seed_workspace_image_cache(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    workspace_disk_mb: u32,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(workspace_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &crate::idle_pool::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    drop(lease);

    let hit = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(hit.result(), WorkspaceCacheCheckoutResult::Hit);
    let seed = hit
        .workspace_drive_config()
        .and_then(|config| config.seed_image)
        .expect("seeded workspace cache should produce a seed image");
    drop(hit);
    seed
}

fn spawn_run_in_sandbox_test(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    spawn_run_in_sandbox_test_with_timeouts(sandbox, ctx, config, cancel, PROCESS_CANCEL_TIMEOUTS)
}

fn spawn_run_in_sandbox_test_with_timeouts(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: tokio_util::sync::CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        run_in_sandbox_with_process_cancel_timeouts(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            cancel,
            process_cancel_timeouts,
        )
        .await
    })
}
