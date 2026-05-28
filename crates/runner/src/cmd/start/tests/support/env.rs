use super::super::super::signals::{
    LifecycleController, handle_drain_signal, handle_resume_signal, handle_stopping_signal,
};
use super::super::super::*;
use std::collections::BTreeMap;

use crate::executor;
use crate::provider::mock::{MockJobProvider, MockProviderHandle};
use sandbox_mock::MockSandboxRuntime;

pub(in super::super) fn test_profiles() -> BTreeMap<String, config::ProfileConfig> {
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
pub(in super::super) struct MockRunEnv {
    pub(in super::super) handle: MockProviderHandle,
    pub(in super::super) provider: Arc<MockJobProvider>,
    pub(in super::super) idle_pool: SharedIdlePool,
    pub(in super::super) lifecycle: LifecycleController,
    pub(in super::super) parking_gate: ParkingGate,
    pub(in super::super) start_observer: StartLoopTestObserver,
    pub(in super::super) mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    pub(in super::super) cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    pub(in super::super) cancel: CancellationToken,
    pub(in super::super) _temp_dir: tempfile::TempDir,
}

impl MockRunEnv {
    /// Simulate SIGUSR1 by driving the real `handle_drain_signal` so
    /// tests exercise the same state-guard path production does
    /// (ignored unless current mode is Running).
    pub(in super::super) fn drain(&self) {
        handle_drain_signal(&self.lifecycle);
    }

    /// Simulate SIGUSR2 via the real `handle_resume_signal` — only
    /// transitions when current mode is Draining.
    pub(in super::super) fn resume(&self) {
        handle_resume_signal(&self.lifecycle);
    }

    /// Simulate SIGTERM by driving the real `handle_stopping_signal`.
    /// Keeps the test path in sync with production.
    pub(in super::super) async fn trigger_stopping(&self) {
        handle_stopping_signal("TEST", &self.cancel, &self.cancel_tokens, &self.lifecycle).await;
    }
}

/// Assemble a complete `RunConfig` with all mock/noop dependencies.
pub(in super::super) fn mock_run_config(
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
pub(in super::super) fn mock_run_config_with_delay(
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

fn build_mock_run_config(
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
pub(in super::super) fn mock_run_config_with_api_url(
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

fn build_mock_run_config_with_runtime(
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
    let start_observer = StartLoopTestObserver::default();
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
        device_rate_limits: None,
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
            http: crate::http::HttpClient::new(crate::http::HttpClientConfig {
                api_url: api_url.to_string(),
                vercel_bypass: None,
            })
            .unwrap(),
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
        memory_prefetch: prefetch::MemoryPrefetchTasks::empty(),
        orphan_reap_process_discovery: None,
        signal_source: SignalSource::Override(SignalController {
            mode_rx,
            lifecycle: lifecycle.clone(),
            handler_task: None,
        }),
        outer_job_panic: None,
        test_observer: start_observer.clone(),
    };

    let env = MockRunEnv {
        handle,
        provider: provider_ref,
        idle_pool,
        lifecycle: lifecycle.clone(),
        parking_gate,
        start_observer,
        mode_tx: lifecycle.mode_tx().clone(),
        cancel_tokens,
        cancel,
        _temp_dir: temp_dir,
    };
    (config, env)
}

fn profiles_min_vcpu(profiles: &BTreeMap<String, config::ProfileConfig>) -> u32 {
    profiles.values().map(|p| p.vcpu).min().unwrap_or(1)
}

fn profiles_min_memory(profiles: &BTreeMap<String, config::ProfileConfig>) -> u32 {
    profiles.values().map(|p| p.memory_mb).min().unwrap_or(1)
}

pub(in super::super) fn two_profiles() -> BTreeMap<String, config::ProfileConfig> {
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

pub(in super::super) fn mock_run_config_with_overrides(
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
