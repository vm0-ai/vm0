use super::super::signals::{
    LifecycleController, handle_drain_signal, handle_resume_signal, handle_stopping_signal,
};
use super::super::*;
use std::{collections::BTreeMap, future::Future};

use crate::executor;
use crate::idle_pool::{ParkCandidate, ParkCandidateParts, ParkResult, ParkingState};
use crate::provider::mock::{MockJobProvider, MockProviderHandle};
use crate::resource_budget::BudgetLease;
use sandbox::{SandboxFactory, SandboxId};
use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxRuntime};

pub(super) fn test_profiles() -> BTreeMap<String, config::ProfileConfig> {
    let mut m = BTreeMap::new();
    m.insert(
        "vm0/default".to_string(),
        config::ProfileConfig {
            rootfs_hash: "hash".into(),
            snapshot_hash: "snap".into(),
            vcpu: 2,
            memory_mb: 4096,
            disk_mb: 10240,
        },
    );
    m
}

/// Everything a test needs to drive the main loop.
pub(super) struct MockRunEnv {
    pub(super) handle: MockProviderHandle,
    pub(super) provider: Arc<MockJobProvider>,
    pub(super) idle_pool: SharedIdlePool,
    pub(super) lifecycle: LifecycleController,
    pub(super) parking_gate: ParkingGate,
    pub(super) mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    pub(super) cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    pub(super) cancel: CancellationToken,
    pub(super) _temp_dir: tempfile::TempDir,
}

impl MockRunEnv {
    /// Simulate SIGUSR1 by driving the real `handle_drain_signal` so
    /// tests exercise the same state-guard path production does
    /// (ignored unless current mode is Running).
    pub(super) fn drain(&self) {
        handle_drain_signal(&self.lifecycle);
    }

    /// Simulate SIGUSR2 via the real `handle_resume_signal` — only
    /// transitions when current mode is Draining.
    pub(super) fn resume(&self) {
        handle_resume_signal(&self.lifecycle);
    }

    /// Simulate SIGTERM by driving the real `handle_stopping_signal`.
    /// Keeps the test path in sync with production.
    pub(super) async fn trigger_stopping(&self) {
        handle_stopping_signal("TEST", &self.cancel, &self.cancel_tokens, &self.lifecycle).await;
    }
}

/// Assemble a complete `RunConfig` with all mock/noop dependencies.
pub(super) fn mock_run_config(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
) -> (RunConfig, MockRunEnv) {
    build_mock_run_config(
        profiles,
        budget_vcpu,
        budget_memory_mb,
        max_concurrent,
        MockJobProvider::new,
    )
}

/// Variant with an explicit poll delay for regression testing.
pub(super) fn mock_run_config_with_delay(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
    poll_delay: Duration,
) -> (RunConfig, MockRunEnv) {
    build_mock_run_config(
        profiles,
        budget_vcpu,
        budget_memory_mb,
        max_concurrent,
        |cancel| MockJobProvider::with_poll_delay(cancel, Some(poll_delay)),
    )
}

pub(super) fn build_mock_run_config(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
    make_provider: impl FnOnce(CancellationToken) -> (Arc<MockJobProvider>, MockProviderHandle),
) -> (RunConfig, MockRunEnv) {
    build_mock_run_config_with_runtime(
        profiles,
        budget_vcpu,
        budget_memory_mb,
        max_concurrent,
        make_provider,
        Box::new(MockSandboxRuntime::new()),
        "http://localhost:0",
    )
}

/// Variant that points the runner's HTTP client at an explicit URL. Used by
/// tests that spin up an `httpmock::MockServer` to observe webhook traffic.
pub(super) fn mock_run_config_with_api_url(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
    api_url: &str,
) -> (RunConfig, MockRunEnv) {
    build_mock_run_config_with_runtime(
        profiles,
        budget_vcpu,
        budget_memory_mb,
        max_concurrent,
        MockJobProvider::new,
        Box::new(MockSandboxRuntime::new()),
        api_url,
    )
}

pub(super) fn build_mock_run_config_with_runtime(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
    make_provider: impl FnOnce(CancellationToken) -> (Arc<MockJobProvider>, MockProviderHandle),
    runtime: Box<dyn sandbox::SandboxRuntime>,
    api_url: &str,
) -> (RunConfig, MockRunEnv) {
    let temp_dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let (provider, handle) = make_provider(cancel.clone());
    let provider_ref = Arc::clone(&provider);

    let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
    let parking_gate = ParkingGate::new_open();
    let lifecycle = LifecycleController::new(mode_tx, parking_gate.clone());
    let cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let home = HomePaths::with_root(temp_dir.path().to_path_buf());
    let registry_path = temp_dir.path().join("registry.json");
    let lock_path = temp_dir.path().join("registry.lock");
    // Write empty registry file so ProxyRegistryHandle can read it.
    std::fs::write(&registry_path, r#"{"vms":{},"updatedAt":0}"#).unwrap();
    let registry = proxy::ProxyRegistryHandle::new(registry_path, lock_path);

    let log_dir = temp_dir.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();

    let (mitm, mitm_crash_rx) = proxy::MitmProxy::noop();
    let min_vcpu = profiles_min_vcpu(&profiles);
    let min_memory_mb = profiles_min_memory(&profiles);
    let idle_pool: SharedIdlePool =
        Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
            IdlePoolConfig {
                default_timeout: Duration::from_secs(300),
                max_idle: 10,
            },
            parking_gate.clone(),
        )));

    let config = RunConfig {
        id: "test-runner".into(),
        name: "test".into(),
        group: "test-group".into(),
        profiles,
        runtime,
        home: home.clone(),
        budget: Arc::new(ResourceBudget::new(
            budget_vcpu,
            budget_memory_mb,
            1.0,
            max_concurrent,
        )),
        idle_pool: Arc::clone(&idle_pool),
        parking_gate: parking_gate.clone(),
        status: Arc::new(StatusTracker::new(
            temp_dir.path().join("status.json"),
            max_concurrent,
            None,
            None,
        )),
        mitm,
        mitm_crash_rx,
        provider,
        cancel_tokens: Arc::clone(&cancel_tokens),
        cancel: cancel.clone(),
        exec_config: Arc::new(executor::ExecutorConfig {
            api_url: api_url.to_string(),
            registry,
            http: crate::http::HttpClient::new(api_url.to_string()).unwrap(),
            log_paths: crate::paths::LogPaths::new(log_dir),
            network_log_manager: NetworkLogManager::new(),
            network_log_drain: NetworkLogDrainCoordinator::noop(),
            home,
        }),
        firecracker: config::FirecrackerConfig {
            binary: PathBuf::new(),
            kernel: PathBuf::new(),
        },
        base_dir: temp_dir.path().to_path_buf(),
        min_vcpu,
        min_memory_mb,
        kmsg_handle: kmsg_log::KmsgHandle::noop(),
        dns_handle: crate::dns::DnsProxy::noop(),
        orphan_reap_process_discovery: None,
        signal_source: SignalSource::Override(SignalController {
            mode_rx,
            lifecycle: lifecycle.clone(),
            handler_abort: None,
        }),
        outer_job_panic: None,
    };

    let env = MockRunEnv {
        handle,
        provider: provider_ref,
        idle_pool,
        lifecycle: lifecycle.clone(),
        parking_gate,
        mode_tx: lifecycle.mode_tx().clone(),
        cancel_tokens,
        cancel,
        _temp_dir: temp_dir,
    };
    (config, env)
}

pub(super) fn profiles_min_vcpu(profiles: &BTreeMap<String, config::ProfileConfig>) -> u32 {
    profiles.values().map(|p| p.vcpu).min().unwrap_or(1)
}

pub(super) fn profiles_min_memory(profiles: &BTreeMap<String, config::ProfileConfig>) -> u32 {
    profiles.values().map(|p| p.memory_mb).min().unwrap_or(1)
}

pub(super) fn minimal_context(run_id: RunId) -> crate::types::ExecutionContext {
    crate::types::ExecutionContext {
        run_id,
        prompt: "test".into(),
        append_system_prompt: None,
        _agent_compose_version_id: None,
        vars: None,
        checkpoint_id: None,
        sandbox_token: "tok".into(),
        working_dir: "/workspace".into(),
        storage_manifest: None,
        environment: None,
        resume_session: None,
        secret_values: None,
        encrypted_secrets: None,
        secret_connector_map: None,
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

/// Push a job to the mock provider and pre-configure its claim result.
pub(super) fn push_job(
    env: &MockRunEnv,
    run_id: RunId,
    profile: &str,
    ctx: Option<crate::types::ExecutionContext>,
) {
    env.provider.set_claim_result(run_id, ctx);
    env.handle
        .discover_tx
        .send((run_id, profile.into()))
        .unwrap();
}

/// Trigger graceful shutdown and wait for run() to exit.
pub(super) async fn shutdown(
    env: &MockRunEnv,
    run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
) {
    env.drain();
    env.cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(10), run_handle)
        .await
        .expect("run should finish within 10s")
        .expect("task should not panic");
    assert!(result.is_ok());
}

/// ExecutionContext with a resume_session for idle pool testing.
pub(super) fn context_with_session(
    run_id: RunId,
    session_id: &str,
) -> crate::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    ctx.resume_session = Some(crate::types::ResumeSession {
        session_id: session_id.into(),
        session_history: String::new(),
    });
    ctx
}

/// Two profiles with different resource requirements for mismatch tests.
pub(super) fn two_profiles() -> BTreeMap<String, config::ProfileConfig> {
    let mut m = BTreeMap::new();
    m.insert(
        "vm0/default".to_string(),
        config::ProfileConfig {
            rootfs_hash: "hash".into(),
            snapshot_hash: "snap".into(),
            vcpu: 2,
            memory_mb: 4096,
            disk_mb: 10240,
        },
    );
    m.insert(
        "vm0/large".to_string(),
        config::ProfileConfig {
            rootfs_hash: "hash2".into(),
            snapshot_hash: "snap2".into(),
            vcpu: 4,
            memory_mb: 8192,
            disk_mb: 20480,
        },
    );
    m
}

/// Build an active-owned park candidate with all seed fields configurable.
pub(super) fn make_test_park_candidate(
    session_id: &str,
    profile_name: &str,
    budget_lease: BudgetLease,
) -> ParkCandidate {
    ParkCandidate::from_parked_parts(ParkCandidateParts {
        sandbox: Box::new(MockSandbox::new("idle-test")),
        factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
        session_id: session_id.into(),
        sandbox_id: SandboxId::new_v4(),
        profile_name: profile_name.into(),
        budget_lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    })
}

/// Pre-populate idle pool with an entry and reserve its budget. Returns
/// the entry's sandbox id so reuse tests can assert it propagates through
/// to the completion payload.
pub(super) async fn seed_idle_pool(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    let budget_lease = ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).unwrap();
    let candidate = make_test_park_candidate(session_id, profile_name, budget_lease);
    let sandbox_id = candidate.sandbox_id();
    let mut guard = pool.lock().await;
    let result = guard.park(candidate);
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

pub(super) async fn seed_idle_pool_with_overrides(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    overrides: &Arc<sandbox_mock::MockSandboxOverrides>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) -> SandboxId {
    let runtime = sandbox_mock::MockSandboxRuntime::with_overrides(Arc::clone(overrides));
    let mut factory = runtime
        .create_factory(sandbox::FactoryConfig {
            profile: profile_name.into(),
            binary_path: PathBuf::new(),
            kernel_path: PathBuf::new(),
            rootfs_path: PathBuf::new(),
            base_dir: PathBuf::new(),
            snapshot: None,
        })
        .await
        .expect("create factory");
    factory.startup().await.expect("startup");
    let factory_arc: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(factory);
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory_arc
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: vcpu,
                memory_mb,
            },
        })
        .await
        .expect("create sandbox");
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).expect("reserve budget");

    let mut guard = pool.lock().await;
    let result = guard.park(ParkCandidate::from_parked_parts(ParkCandidateParts {
        sandbox,
        factory: factory_arc,
        session_id: session_id.to_string(),
        sandbox_id,
        profile_name: profile_name.into(),
        budget_lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
    }));
    assert!(matches!(result, ParkResult::Parked));
    sandbox_id
}

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

enum WaitProbe<T> {
    Ready(T),
    Pending(String),
}

async fn wait_for_probe<T, F, Fut>(timeout: Duration, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = WaitProbe<T>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match probe().await {
            WaitProbe::Ready(value) => return value,
            WaitProbe::Pending(message) => {
                assert!(tokio::time::Instant::now() < deadline, "{message}");
                tokio::time::sleep(WAIT_POLL_INTERVAL).await;
            }
        }
    }
}

/// Poll until `budget.allocated().2` (running_count) reaches `expected`.
///
/// The active budget lease is dropped after `provider.complete()` in the
/// spawned job task, so `wait_completion()` returning does NOT guarantee
/// the budget has been released yet. This helper avoids fixed sleeps as
/// synchronization.
pub(super) async fn wait_budget_count(budget: &ResourceBudget, expected: usize, timeout: Duration) {
    wait_for_probe(timeout, || async {
        let actual = budget.allocated().2;
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "budget count did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

pub(super) async fn wait_idle_pool_len(pool: &SharedIdlePool, expected: usize, timeout: Duration) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.len();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool length did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

/// Poll until the idle pool parking state reaches `expected`.
pub(super) async fn wait_parking_state(
    pool: &SharedIdlePool,
    expected: ParkingState,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.parking_state();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool parking state did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

/// Pre-populate idle pool with an expired entry (parked 400s ago, timeout 300s).
pub(super) async fn seed_idle_pool_expired(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    session_id: &str,
    profile_name: &str,
    vcpu: u32,
    memory_mb: u32,
) {
    let budget_lease = ResourceBudget::try_reserve_lease(budget, vcpu, memory_mb).unwrap();
    let candidate = make_test_park_candidate(session_id, profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(
        candidate,
        std::time::Instant::now() - Duration::from_secs(400),
        Duration::from_secs(300),
    );
    assert!(matches!(result, ParkResult::Parked));
}

pub(super) struct TestParkCandidateSpec<'a> {
    pub(super) session_id: &'a str,
    pub(super) profile_name: &'a str,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) parked_at: std::time::Instant,
    pub(super) idle_timeout: Duration,
}

pub(super) async fn seed_idle_pool_with_timing(
    pool: &SharedIdlePool,
    budget: &Arc<ResourceBudget>,
    spec: TestParkCandidateSpec<'_>,
) {
    let budget_lease =
        ResourceBudget::try_reserve_lease(budget, spec.vcpu, spec.memory_mb).unwrap();
    let candidate = make_test_park_candidate(spec.session_id, spec.profile_name, budget_lease);
    let mut guard = pool.lock().await;
    let result = guard.park_at_for_test(candidate, spec.parked_at, spec.idle_timeout);
    assert!(matches!(result, ParkResult::Parked));
}

pub(super) async fn status_idle_sessions_and_active_runs(
    status_path: &std::path::Path,
) -> (Vec<String>, Vec<String>) {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut sessions: Vec<String> = status
        .get("idle_vms")
        .and_then(|v| v.as_array())
        .map(|idle_vms| {
            idle_vms
                .iter()
                .filter_map(|vm| {
                    vm.get("session_id")
                        .and_then(|session| session.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    sessions.sort_unstable();
    let mut run_ids: Vec<String> = status["active_runs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|run| {
            run.get("run_id")
                .and_then(|run_id| run_id.as_str())
                .map(str::to_string)
        })
        .collect();
    run_ids.sort_unstable();
    (sessions, run_ids)
}

pub(super) async fn status_idle_sessions(status_path: &std::path::Path) -> Vec<String> {
    status_idle_sessions_and_active_runs(status_path).await.0
}

pub(super) async fn wait_status_idle_sessions_and_active_runs(
    status_path: &std::path::Path,
    expected_idle_sessions: &[&str],
    expected_active_runs: &[String],
    timeout: Duration,
) {
    let mut expected_idle_sessions: Vec<String> = expected_idle_sessions
        .iter()
        .map(|session| (*session).to_string())
        .collect();
    expected_idle_sessions.sort_unstable();
    let mut expected_active_runs = expected_active_runs.to_vec();
    expected_active_runs.sort_unstable();

    wait_for_probe(timeout, || async {
        match status_idle_sessions_and_active_runs_if_exists(status_path).await {
            Some((idle_sessions, active_runs))
                if idle_sessions == expected_idle_sessions
                    && active_runs == expected_active_runs =>
            {
                WaitProbe::Ready(())
            }
            Some((idle_sessions, active_runs)) => WaitProbe::Pending(format!(
                "status did not reach expected idle={expected_idle_sessions:?} active={expected_active_runs:?} within {timeout:?} (actual idle={idle_sessions:?} active={active_runs:?})",
            )),
            None => WaitProbe::Pending(format!(
                "status file {} was not written within {timeout:?}",
                status_path.display(),
            )),
        }
    })
    .await;
}

pub(super) async fn status_idle_sessions_and_active_runs_if_exists(
    status_path: &std::path::Path,
) -> Option<(Vec<String>, Vec<String>)> {
    match tokio::fs::try_exists(status_path).await {
        Ok(true) => Some(status_idle_sessions_and_active_runs(status_path).await),
        Ok(false) => None,
        Err(err) => panic!(
            "failed to check status file {}: {err}",
            status_path.display()
        ),
    }
}

pub(super) async fn publish_idle_status(pool: &SharedIdlePool, status: &StatusTracker) {
    let snapshot = pool.lock().await.status_snapshot();
    assert!(
        status
            .set_idle_info_at_revision(snapshot.revision, snapshot.idle_vms)
            .await
    );
}

pub(super) async fn wait_status_idle_empty_with_active_run(
    status_path: &std::path::Path,
    run_id: RunId,
    timeout: Duration,
) {
    let expected = run_id.to_string();
    wait_for_probe(timeout, || async {
        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(status_path).await;
        if idle_sessions.is_empty() && active_runs.iter().any(|id| id == &expected) {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "status did not atomically clear idle_vms and add active run {expected} within {timeout:?} (idle: {idle_sessions:?}, active: {active_runs:?})",
            ))
        }
    })
    .await;
}

pub(super) fn mock_run_config_with_overrides(
    profiles: BTreeMap<String, config::ProfileConfig>,
    budget_vcpu: u32,
    budget_memory_mb: u32,
    max_concurrent: usize,
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> (RunConfig, MockRunEnv) {
    build_mock_run_config_with_runtime(
        profiles,
        budget_vcpu,
        budget_memory_mb,
        max_concurrent,
        MockJobProvider::new,
        Box::new(MockSandboxRuntime::with_overrides(overrides)),
        "http://localhost:0",
    )
}

pub(super) async fn wait_cancel_token(
    tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    run_id: RunId,
    timeout: Duration,
) -> CancellationToken {
    wait_for_probe(timeout, || async {
        let token = tokens.lock().await.get(&run_id).cloned();
        if let Some(token) = token {
            WaitProbe::Ready(token)
        } else {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} not found within {timeout:?}",
            ))
        }
    })
    .await
}

pub(super) async fn wait_cancel_token_removed(
    tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    run_id: RunId,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let present = tokens.lock().await.contains_key(&run_id);
        if present {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} still present after {timeout:?}",
            ))
        } else {
            WaitProbe::Ready(())
        }
    })
    .await;
}
