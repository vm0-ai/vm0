//! `runner start` — run the long-lived worker loop.
//!
//! `run_start` registers lifecycle signals early, loads config, claims the
//! canonical runner `base_dir` lock, initializes shared resources, then enters
//! `run()`, the main reactor for discovery, heartbeats, job execution,
//! idle-pool maintenance, mitmproxy restart, and teardown.
//!
//! The sibling modules keep focused responsibilities out of this orchestration
//! file:
//! - `factory_lifecycle`: sandbox factory creation and shutdown.
//! - `idle_lifecycle`: idle-pool lifecycle, status updates, and destroy helpers.
//! - `identity`: persistent runner id storage.
//! - `job_discovery`: discovery branch handling and idle-reuse admission.
//! - `job_lifecycle`: cleanup, budget, and completion ownership state.
//! - `job_spawn`: claimed job task spawning, completion, and panic cleanup.
//! - `mitm_restart`: mitmproxy crash restart and backoff.
//! - `orphan_reap`: orphan active-run reconciliation.
//! - `ownership`: active/idle/orphan ownership transition ordering.
//! - `sandbox_finalization`: post-executor sandbox park/destroy finalization.
//! - `signals`: lifecycle signal registration and mode transitions.
//!
//! Important invariants:
//! - one process owns the canonical `base_dir` lock;
//! - lifecycle signals are registered before slow startup work;
//! - discovery is pinned across `select!` ticks so heartbeat and cleanup
//!   branches do not restart polling;
//! - the first heartbeat and idle-cleanup ticks are deferred;
//! - teardown drops discovery before provider shutdown.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{RuntimeProvider, SandboxRuntime};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ids::RunId;

use crate::config::{self, ProfileConfig};
use crate::deps;
use crate::dns;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::ExecutorConfig;
use crate::host;
use crate::http::{HttpClient, HttpClientConfig};
use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};
use crate::kmsg_log;
use crate::lock;
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::paths::{HomePaths, LogPaths, RunnerPaths, touch_mtime};
use crate::prefetch;
use crate::provider::{ApiProvider, JobProvider, LocalProvider};
use crate::proxy;
use crate::resource_budget::ResourceBudget;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::run_cancellation::SharedRunCancellationMap;
use crate::status::{RunnerMode, StatusTracker};
use crate::workspace_image_cache::SessionWorkspaceCache;

mod active_sessions;
mod factory_lifecycle;
mod heartbeat;
mod identity;
mod idle_lifecycle;
mod job_discovery;
mod job_lifecycle;
mod job_spawn;
mod mitm_restart;
mod orphan_reap;
mod ownership;
mod sandbox_finalization;
mod signals;

use active_sessions::new_active_sessions;
use factory_lifecycle::{shutdown_factories, start_factories};
use heartbeat::{
    HEARTBEAT_PERIOD, HeartbeatContext, HeartbeatContextInit, collect_heartbeat_state,
    send_heartbeat,
};
use identity::load_or_generate_runner_id;
use idle_lifecycle::{
    SharedIdlePool, cleanup_expired_idle_entries, destroy_idle_jobs_and_wait, drain_idle_pool,
    evict_expired_idle_entries, evict_oldest_idle_entry, spawn_idle_destroy_job,
};
use job_discovery::{DiscoveredJob, DiscoveredJobContext, handle_discovered_job};
use job_spawn::{SpawnContext, handle_job_result};
use mitm_restart::{
    MITM_BACKOFF_INITIAL, MITM_BACKOFF_MAX, MITM_MAX_CONSECUTIVE_FAILURES, MitmRestartHandle,
    finish_mitm_restart_before_shutdown, handle_mitm_restart_result, maybe_spawn_mitm_restart,
};
use orphan_reap::{
    OrphanReapMode, OrphanReapProcessDiscovery, OrphanedActiveRuns, reap_orphaned_active_runs,
};
use signals::{EarlySignals, SignalController, handle_stopping_signal, recv_handler_task};

struct TeardownTimer {
    start: Instant,
}

impl TeardownTimer {
    fn start() -> Self {
        let timer = Self {
            start: Instant::now(),
        };
        info!("teardown started");
        timer
    }

    fn duration_ms(duration: Duration) -> u64 {
        duration.as_millis().min(u128::from(u64::MAX)) as u64
    }

    fn elapsed_ms(&self) -> u64 {
        Self::duration_ms(self.start.elapsed())
    }

    fn phase_start(&self, phase: &'static str) -> Instant {
        let phase_start = Instant::now();
        info!(
            phase,
            elapsed_ms = self.elapsed_ms(),
            "teardown phase started"
        );
        phase_start
    }

    fn phase_complete(&self, phase: &'static str, phase_start: Instant) {
        info!(
            phase,
            phase_ms = Self::duration_ms(phase_start.elapsed()),
            elapsed_ms = self.elapsed_ms(),
            "teardown phase complete"
        );
    }

    fn event(&self, phase: &'static str) {
        info!(
            phase,
            elapsed_ms = self.elapsed_ms(),
            "teardown phase event"
        );
    }
}

#[derive(Args)]
pub struct StartArgs {
    /// Path to runner.yaml config file
    #[arg(long, short)]
    pub(crate) config: PathBuf,
    /// vm0 API URL (overrides config)
    #[arg(long, env = "VM0_API_URL")]
    api_url: Option<String>,
    /// Runner authentication token (overrides config)
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: Option<String>,
    /// Use local file queue provider instead of API (for testing)
    #[arg(long)]
    local: bool,
}

/// Load config and run the main poll loop.
pub async fn run_start(
    args: StartArgs,
    runtime_provider: &dyn RuntimeProvider,
) -> RunnerResult<()> {
    // Register lifecycle signals (SIGTERM/SIGINT/SIGUSR1/SIGUSR2) before
    // any slow startup work. Tokio's `signal()` installs the process-wide
    // `sigaction` handler on first call; until then the default disposition
    // (Term) applies, so a drain SIGUSR1 racing with `service install`
    // would kill the process and leave a restart that no one drains. See
    // issue #10416.
    let signals = EarlySignals::register()
        .map_err(|e| RunnerError::Internal(format!("register signal handlers: {e}")))?;

    let mut runner_config = config::load(&args.config).await?;

    // CLI / env overrides — take server out so we can mutate independently
    let mut server = runner_config.server.take().unwrap_or(config::ServerConfig {
        url: String::new(),
        token: String::new(),
    });
    if let Some(url) = args.api_url {
        server.url = url;
    }
    if let Some(token) = args.token {
        server.token = token;
    }

    // Validate required server fields
    if server.url.is_empty() {
        return Err(RunnerError::Config(
            "server.url is required (set in config or via --api-url / VM0_API_URL)".into(),
        ));
    }
    if server.token.is_empty() {
        return Err(RunnerError::Config(
            "server.token is required (set in config or via --token / VM0_RUNNER_TOKEN)".into(),
        ));
    }

    let runner_host_env = crate::host_env::read_runner_host_env()?;
    let config::SandboxConfig {
        max_concurrent,
        concurrency_factor: yaml_concurrency_factor,
        idle_timeout_secs,
        max_idle,
    } = runner_config.sandbox;
    let (concurrency_factor, concurrency_factor_source) =
        crate::runtime_overrides::resolve_concurrency_factor(
            yaml_concurrency_factor,
            &runner_host_env,
        )?;
    if concurrency_factor_source.is_override() {
        info!(
            env_var = crate::host_env::RUNNER_CONCURRENCY_FACTOR_ENV,
            override_source = concurrency_factor_source.label(),
            concurrency_factor,
            yaml_concurrency_factor,
            "using host environment override for concurrency_factor"
        );
    }

    crate::private_fs::ensure_private_dir(&runner_config.base_dir).await?;

    // Exclusive lock — prevents two runner processes from sharing the same base_dir.
    // Canonicalize so that equivalent paths (e.g. with `..`) produce the same lock.
    let base_dir_canonical = runner_config.base_dir.canonicalize().map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize base_dir {}: {e}",
            runner_config.base_dir.display()
        ))
    })?;
    let home = HomePaths::new()?;
    let mut base_dir_lock = lock::try_acquire(home.base_dir_lock(&base_dir_canonical))
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "cannot lock base_dir {}: {e}",
                runner_config.base_dir.display()
            ))
        })?;
    // Write base_dir path into lock file so `runner gc` can discover workspace
    // directories even after all processes for this runner have died.
    {
        use std::io::{Seek, Write};
        if let Err(e) = base_dir_lock
            .seek(std::io::SeekFrom::Start(0))
            .and_then(|_| base_dir_lock.set_len(0))
            .and_then(|_| {
                base_dir_lock.write_all(base_dir_canonical.as_os_str().as_encoded_bytes())
            })
        {
            tracing::warn!(
                error = %e,
                "failed to write base_dir into lock file — runner gc may not discover orphaned workspaces"
            );
        }
    }

    // Load or generate a persistent runner identity (UUID).
    let runner_id = load_or_generate_runner_id(&runner_config.base_dir).await?;
    info!(runner_id = %runner_id, runner_name = %runner_config.name, "runner identity");

    // Shared locks on rootfs + snapshot per profile — allows `runner gc` to detect in-use resources.
    let mut _resource_locks = Vec::new();
    for (profile_name, profile) in &runner_config.profiles {
        let rootfs_lock = lock::acquire_shared(home.rootfs_lock(&profile.rootfs_hash)).await?;
        let rootfs_paths = crate::paths::RootfsPaths::new(&home, &profile.rootfs_hash);
        _resource_locks.push(rootfs_lock);
        let snapshot_lock =
            lock::acquire_shared(home.snapshot_lock(&profile.snapshot_hash)).await?;
        let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
        _resource_locks.push(snapshot_lock);

        // Validate image artifacts only after both shared locks are held.
        // Reading them before lock acquisition can race with builders or GC.
        config::validate_profile_image_artifacts(profile_name, profile, &home).await?;
        touch_mtime(rootfs_paths.dir());
        touch_mtime(snapshot_paths.dir());
    }

    let log_paths = LogPaths::new(home.logs_dir());
    tokio::fs::create_dir_all(log_paths.dir())
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "create logs_dir {}: {e}",
                log_paths.dir().display()
            ))
        })?;

    // Start background prefetch of snapshot memory for all profiles.
    let memory_prefetch =
        prefetch::MemoryPrefetchTasks::spawn(runner_config.profiles.values().map(|profile| {
            crate::paths::RootfsPaths::new(&home, &profile.rootfs_hash)
                .snapshot(&profile.snapshot_hash)
                .memory_bin()
        }));

    // Compute the smallest profile resources for budget pre-check.
    // When budget is exhausted for all profiles, we wait instead of polling.
    let min_vcpu = runner_config
        .profiles
        .values()
        .map(|p| p.vcpu)
        .min()
        .unwrap_or(1);
    let min_memory_mb = runner_config
        .profiles
        .values()
        .map(|p| p.memory_mb)
        .min()
        .unwrap_or(1);

    // Start proxy before factory so proxy_port is available for netns pool.
    let paths = RunnerPaths::new(runner_config.base_dir.clone());
    let (mut mitm, mitm_crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(deps::MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        addon_dir: paths.mitm_addon_dir(),
        registry_path: paths.proxy_registry(),
        registry_lock_path: paths.proxy_registry_lock(),
        api_url: Some(server.url.clone()),
    })
    .await?;
    mitm.start().await?;
    info!(port = mitm.port(), "proxy ready");

    let registry_handle = mitm.registry_handle();

    // Start background DNS/kmsg monitors for Rust-side network logging.
    let network_log_manager = NetworkLogManager::new();
    let kmsg_handle = kmsg_log::spawn(network_log_manager.clone())
        .map_err(|e| RunnerError::Internal(format!("kmsg monitor: {e}")))?;

    // Start DNS proxy (dnsmasq) for domain-level DNS interception and logging.
    // Shares NetworkLogManager with kmsg — both use source IP (peer veth) as key.
    let dns_handle = dns::start(network_log_manager.clone())
        .await
        .map_err(|e| RunnerError::Internal(format!("dns proxy: {e}")))?;
    let network_log_drain = NetworkLogDrainCoordinator::new(vec![
        kmsg_handle.drain_producer(),
        dns_handle.drain_producer(),
    ]);

    // Resource budget from host resources + config.
    let host_cpus = host::cpu_count()?;
    let host_memory_mb = host::memory_mb()?;
    let budget = Arc::new(ResourceBudget::new(
        host_cpus as u32,
        host_memory_mb as u32,
        concurrency_factor,
        max_concurrent,
    ));
    info!(
        host_cpus,
        host_memory_mb,
        concurrency_factor,
        concurrency_factor_source = concurrency_factor_source.label(),
        yaml_concurrency_factor,
        max_concurrent,
        effective_vcpu = budget.effective_vcpu(),
        effective_memory_mb = budget.effective_memory_mb(),
        profiles = runner_config.profiles.len(),
        "resource budget initialized"
    );
    let io_limit_resolution =
        crate::io_limits::resolve_io_limits(&runner_config.profiles, &budget, &runner_host_env);
    let device_rate_limits = io_limit_resolution.device_rate_limits();
    match &io_limit_resolution {
        crate::io_limits::IoLimitResolution::Disabled => {
            info!("I/O limiters disabled");
        }
        crate::io_limits::IoLimitResolution::Misconfigured { reason } => {
            warn!(%reason, "I/O limiter host env config invalid; disabling I/O limiter capacity");
        }
        crate::io_limits::IoLimitResolution::Configured {
            limits,
            denominator,
        } => {
            info!(
                denominator,
                disk_bandwidth_bytes_per_sec = limits.block.bandwidth_bytes_per_sec,
                disk_ops_per_sec = limits.block.ops_per_sec,
                net_rx_bytes_per_sec = limits.network.rx_bytes_per_sec,
                net_tx_bytes_per_sec = limits.network.tx_bytes_per_sec,
                feature_flag = crate::io_limits::SANDBOX_IO_LIMITERS_FEATURE_FLAG,
                "I/O limiter capacity configured; applying limiters only for flagged jobs"
            );
        }
    }

    // Idle sandbox pool for VM reuse across conversation turns.
    let parking_gate = ParkingGate::new_open();
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
        IdlePoolConfig {
            default_timeout: Duration::from_secs(idle_timeout_secs),
            max_idle,
        },
        parking_gate.clone(),
    )));

    // Estimated capacity for status reporting.
    // Derived from the smallest profile to cover the worst case.
    let estimated_capacity = {
        let resource_limit = std::cmp::min(
            budget.effective_vcpu() as usize / min_vcpu as usize,
            budget.effective_memory_mb() as usize / min_memory_mb as usize,
        )
        .max(1);
        if max_concurrent > 0 {
            std::cmp::min(resource_limit, max_concurrent)
        } else {
            resource_limit
        }
    };

    // Build sandbox runtime with shared resources (netns and NBD device pools).
    let runtime = runtime_provider
        .create_runtime(sandbox::RuntimeConfig {
            proxy_port: Some(mitm.port()),
            dns_port: Some(dns_handle.port()),
        })
        .await
        .map_err(|e| RunnerError::Internal(format!("sandbox runtime: {e}")))?;

    let status = Arc::new(StatusTracker::new(
        paths.status(),
        estimated_capacity,
        Some(mitm.port()),
        Some(dns_handle.port()),
    ));
    status.write_initial().await;

    // Create provider — handles discovery + claim + complete
    let cancel = CancellationToken::new();
    let http = HttpClient::new(HttpClientConfig {
        api_url: server.url.clone(),
        vercel_bypass: std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET").ok(),
    })?;
    let name = runner_config.name;
    let group = runner_config.group;
    let cancel_tokens: SharedRunCancellationMap = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let (usage_flush_tx, usage_flush_rx) = mpsc::channel(1);

    let (provider, group_name): (Arc<dyn JobProvider>, String) = if args.local {
        let group_dir = home.groups_dir().join(&group);
        std::fs::create_dir_all(&group_dir).map_err(|e| {
            RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
        })?;
        let profiles: Vec<String> = runner_config.profiles.keys().cloned().collect();
        let provider = LocalProvider::new(
            group_dir,
            profiles,
            cancel.clone(),
            Arc::clone(&cancel_tokens),
        );
        (provider, group)
    } else {
        let group_name = group.clone();
        let profiles: Vec<String> = runner_config.profiles.keys().cloned().collect();
        let provider = ApiProvider::new(
            http.clone(),
            server.token,
            group,
            profiles,
            runner_id.clone(),
            cancel.clone(),
            Arc::clone(&cancel_tokens),
        )
        .await;
        (provider, group_name)
    };

    let exec_config = Arc::new(ExecutorConfig {
        api_url: server.url,
        registry: registry_handle,
        http,
        log_paths,
        network_log_manager,
        network_log_drain,
        mitm_jsonl_flush: Some(mitm.jsonl_flush_handle(usage_flush_tx.clone())),
        home: home.clone(),
        workspace_cache: Some(SessionWorkspaceCache::shared(
            paths.clone(),
            &home,
            &group_name,
        )),
    });

    let config = RunConfig {
        runner: RunnerInfo {
            id: runner_id,
            name,
            group: group_name,
            profiles: runner_config.profiles,
        },
        paths: RunPaths {
            home,
            base_dir: runner_config.base_dir,
        },
        sandbox_runtime: SandboxRuntimeConfig {
            runtime,
            firecracker: runner_config.firecracker,
        },
        capacity: CapacityPolicy {
            budget,
            min_vcpu,
            min_memory_mb,
            device_rate_limits,
        },
        shared: RunnerSharedState {
            idle_pool,
            parking_gate,
            status,
        },
        provider: ProviderState {
            provider,
            cancel_tokens,
            cancel,
        },
        proxy: ProxyState {
            mitm,
            mitm_crash_rx,
        },
        exec_config,
        shutdown: ShutdownHandles {
            kmsg_handle,
            dns_handle,
            memory_prefetch,
        },
        usage_flush_tx,
        usage_flush_rx,
        signals: SignalState {
            signal_source: SignalSource::Real(signals),
        },
        orphan_reap: OrphanReapState {
            process_discovery: None,
        },
        #[cfg(test)]
        test_hooks: RunTestHooks {
            outer_job_panic: None,
            test_observer: StartLoopTestObserver::default(),
        },
    };

    run(config).await
}

struct RunConfig {
    runner: RunnerInfo,
    paths: RunPaths,
    sandbox_runtime: SandboxRuntimeConfig,
    capacity: CapacityPolicy,
    shared: RunnerSharedState,
    provider: ProviderState,
    proxy: ProxyState,
    exec_config: Arc<ExecutorConfig>,
    shutdown: ShutdownHandles,
    usage_flush_tx: mpsc::Sender<()>,
    usage_flush_rx: mpsc::Receiver<()>,
    signals: SignalState,
    orphan_reap: OrphanReapState,
    #[cfg(test)]
    test_hooks: RunTestHooks,
}

struct RunnerInfo {
    id: String,
    name: String,
    group: String,
    profiles: BTreeMap<String, ProfileConfig>,
}

struct RunPaths {
    home: HomePaths,
    base_dir: PathBuf,
}

struct SandboxRuntimeConfig {
    runtime: Box<dyn SandboxRuntime>,
    firecracker: config::FirecrackerConfig,
}

struct CapacityPolicy {
    budget: Arc<ResourceBudget>,
    min_vcpu: u32,
    min_memory_mb: u32,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

struct RunnerSharedState {
    idle_pool: SharedIdlePool,
    parking_gate: ParkingGate,
    status: Arc<StatusTracker>,
}

struct ProviderState {
    provider: Arc<dyn JobProvider>,
    /// Per-job cancel tokens shared with the provider for cancel events
    /// (Ably for ApiProvider, `.cancel` files for LocalProvider).
    cancel_tokens: SharedRunCancellationMap,
    cancel: CancellationToken,
}

struct ProxyState {
    mitm: proxy::MitmProxy,
    mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
}

struct ShutdownHandles {
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
    memory_prefetch: prefetch::MemoryPrefetchTasks,
}

struct SignalState {
    /// How the run's mode channel is driven. Production supplies the signal
    /// streams registered at the top of `run_start`; tests supply a
    /// pre-built `SignalController` so they can drive mode transitions
    /// through the lifecycle controller.
    signal_source: SignalSource,
}

struct OrphanReapState {
    /// Deterministic process snapshot for orphan-reaper tests. Production leaves
    /// this unset and scans `/proc`.
    process_discovery: Option<OrphanReapProcessDiscovery>,
}

#[cfg(test)]
struct RunTestHooks {
    outer_job_panic: Option<OuterJobPanicPoint>,
    test_observer: StartLoopTestObserver,
}

enum SignalSource {
    /// Real signals pre-registered at the top of `run_start`. `run()`
    /// spawns the `SignalController` task that consumes them.
    Real(EarlySignals),
    /// Test-supplied controller. `run()` does not spawn a handler task and
    /// the caller drives `mode_tx` itself. Constructed only by `mod tests`
    /// below; non-test code matches on it but never builds it.
    #[cfg_attr(not(test), allow(dead_code))]
    Override(SignalController),
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum StartLoopEvent {
    BudgetExhaustedReactorEntered,
    IdleCleanupProcessed { expired_count: usize },
    BeforeIdlePoolOwnershipTransfer { run_id: RunId },
    UsageFlushRequested,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StartLoopCursor(usize);

#[cfg(test)]
#[derive(Clone, Default)]
struct StartLoopTestObserver {
    inner: Arc<StartLoopTestObserverInner>,
}

#[cfg(test)]
#[derive(Default)]
struct StartLoopTestObserverInner {
    events: std::sync::Mutex<Vec<StartLoopEvent>>,
    notify: tokio::sync::Notify,
}

#[cfg(test)]
impl StartLoopTestObserver {
    fn record(&self, event: StartLoopEvent) {
        self.inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
        self.inner.notify.notify_waiters();
    }

    fn cursor(&self) -> StartLoopCursor {
        let events = self
            .inner
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        StartLoopCursor(events.len())
    }

    async fn wait_for<T>(
        &self,
        timeout: Duration,
        context: &'static str,
        predicate: impl FnMut(&StartLoopEvent) -> Option<T>,
    ) -> T {
        let (value, _) = self
            .wait_after(StartLoopCursor(0), timeout, context, predicate)
            .await;
        value
    }

    async fn wait_after<T>(
        &self,
        cursor: StartLoopCursor,
        timeout: Duration,
        context: &'static str,
        mut predicate: impl FnMut(&StartLoopEvent) -> Option<T>,
    ) -> (T, StartLoopCursor) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let events = self
                    .inner
                    .events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                assert!(
                    cursor.0 <= events.len(),
                    "start-loop observer cursor {} is past event history length {}",
                    cursor.0,
                    events.len()
                );
                for (offset, event) in events[cursor.0..].iter().enumerate() {
                    if let Some(value) = predicate(event) {
                        return (value, StartLoopCursor(cursor.0 + offset + 1));
                    }
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "runner did not observe {context} within {timeout:?}"
            );
            let observed = tokio::time::timeout(remaining, notified).await;
            assert!(
                observed.is_ok(),
                "runner did not observe {context} within {timeout:?}"
            );
        }
    }

    fn notify_budget_exhausted_reactor(&self) {
        self.record(StartLoopEvent::BudgetExhaustedReactorEntered);
    }

    fn notify_before_idle_pool_ownership_transfer(&self, run_id: RunId) {
        self.record(StartLoopEvent::BeforeIdlePoolOwnershipTransfer { run_id });
    }

    fn notify_usage_flush_requested(&self) {
        self.record(StartLoopEvent::UsageFlushRequested);
    }

    async fn wait_budget_exhausted_reactor(&self, timeout: Duration) {
        self.wait_for(timeout, "budget-exhausted reactor entry", |event| {
            matches!(event, StartLoopEvent::BudgetExhaustedReactorEntered).then_some(())
        })
        .await;
    }

    async fn wait_idle_cleanup_processed_with_expired_entries(&self, timeout: Duration) -> usize {
        self.wait_for(
            timeout,
            "idle cleanup processing expired entries",
            |event| match event {
                StartLoopEvent::IdleCleanupProcessed { expired_count } if *expired_count > 0 => {
                    Some(*expired_count)
                }
                _ => None,
            },
        )
        .await
    }

    async fn wait_before_idle_pool_ownership_transfer(&self, run_id: RunId, timeout: Duration) {
        self.wait_for(
            timeout,
            "idle-pool ownership transfer attempt",
            |event| match event {
                StartLoopEvent::BeforeIdlePoolOwnershipTransfer {
                    run_id: observed_run_id,
                } if *observed_run_id == run_id => Some(()),
                _ => None,
            },
        )
        .await
    }

    async fn wait_usage_flush_requested(&self, timeout: Duration) {
        self.wait_for(timeout, "usage flush request", |event| {
            matches!(event, StartLoopEvent::UsageFlushRequested).then_some(())
        })
        .await
    }
}

#[cfg(test)]
mod start_loop_observer_tests {
    use super::*;

    fn idle_cleanup_expired_count(event: &StartLoopEvent) -> Option<usize> {
        match event {
            StartLoopEvent::IdleCleanupProcessed { expired_count } => Some(*expired_count),
            _ => None,
        }
    }

    #[tokio::test]
    async fn start_loop_observer_wait_after_ignores_events_before_cursor() {
        let observer = StartLoopTestObserver::default();

        observer.record(StartLoopEvent::IdleCleanupProcessed { expired_count: 1 });
        let cursor = observer.cursor();
        observer.record(StartLoopEvent::IdleCleanupProcessed { expired_count: 2 });

        let (expired_count, cursor) = observer
            .wait_after(
                cursor,
                Duration::from_secs(1),
                "second idle cleanup",
                idle_cleanup_expired_count,
            )
            .await;
        assert_eq!(
            expired_count, 2,
            "wait_after should ignore stale events before the cursor"
        );

        observer.record(StartLoopEvent::IdleCleanupProcessed { expired_count: 3 });
        let (expired_count, _) = observer
            .wait_after(
                cursor,
                Duration::from_secs(1),
                "third idle cleanup",
                idle_cleanup_expired_count,
            )
            .await;
        assert_eq!(
            expired_count, 3,
            "next cursor should advance past the matched event"
        );
    }

    #[tokio::test]
    #[should_panic(expected = "start-loop observer cursor")]
    async fn start_loop_observer_wait_after_rejects_cursor_past_history() {
        let observer = StartLoopTestObserver::default();

        observer
            .wait_after(
                StartLoopCursor(1),
                Duration::from_secs(1),
                "invalid cursor",
                |_| Some(()),
            )
            .await;
    }

    #[tokio::test]
    async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_observes_existing_event()
    {
        let observer = StartLoopTestObserver::default();
        let run_id = RunId::new_v4();

        observer.notify_before_idle_pool_ownership_transfer(run_id);
        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    #[should_panic(expected = "runner did not observe idle-pool ownership transfer attempt")]
    async fn start_loop_observer_wait_before_idle_pool_ownership_transfer_ignores_other_runs() {
        let observer = StartLoopTestObserver::default();
        let run_id = RunId::new_v4();
        let other_run_id = RunId::new_v4();

        observer.notify_before_idle_pool_ownership_transfer(other_run_id);
        observer
            .wait_before_idle_pool_ownership_transfer(run_id, Duration::ZERO)
            .await;
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OuterJobPanicPoint {
    ActiveOrUnknown,
    IdlePoolOwned,
    DestroyCompleted,
}

#[cfg(test)]
fn maybe_panic_outer_job(
    configured: Option<OuterJobPanicPoint>,
    point: OuterJobPanicPoint,
    run_id: RunId,
) {
    if configured == Some(point) {
        panic!("simulated outer job panic at {point:?} for {run_id}");
    }
}

async fn run(config: RunConfig) -> RunnerResult<()> {
    let RunConfig {
        runner,
        paths,
        sandbox_runtime,
        capacity,
        shared,
        provider: provider_state,
        proxy,
        exec_config,
        shutdown,
        usage_flush_tx,
        mut usage_flush_rx,
        signals,
        orphan_reap,
        #[cfg(test)]
        test_hooks,
    } = config;
    let SandboxRuntimeConfig {
        mut runtime,
        firecracker,
    } = sandbox_runtime;
    let ProxyState {
        mut mitm,
        mut mitm_crash_rx,
    } = proxy;

    let mut factories = start_factories(
        &runner.profiles,
        &firecracker,
        &paths.base_dir,
        &paths.home,
        runtime.as_mut(),
    )
    .await?;

    let mut jobs: JoinSet<Option<RunId>> = JoinSet::new();
    // Tracked destroy tasks — JoinSet ensures we can await all in-flight
    // destroys at shutdown, preventing factory Arc leaks that cause
    // "factory still referenced" warnings from Arc::try_unwrap.
    let mut destroy_tasks: JoinSet<bool> = JoinSet::new();

    shared.status.write_initial().await;
    info!(
        name = %runner.name,
        group = %runner.group,
        effective_vcpu = capacity.budget.effective_vcpu(),
        effective_memory_mb = capacity.budget.effective_memory_mb(),
        max_concurrent = capacity.budget.max_concurrent(),
        "runner started"
    );

    // -----------------------------------------------------------------------
    // Mitmproxy crash-restart state
    // -----------------------------------------------------------------------
    let mut mitm_retry: RetryState<MitmRestartHandle> = RetryState::new(
        MITM_BACKOFF_INITIAL,
        MITM_BACKOFF_MAX,
        Some(MITM_MAX_CONSECUTIVE_FAILURES),
    );

    // -----------------------------------------------------------------------
    // Signal handling / mode channel
    // -----------------------------------------------------------------------
    let signal = match signals.signal_source {
        SignalSource::Real(signals) => SignalController::spawn(
            provider_state.cancel.clone(),
            Arc::clone(&provider_state.cancel_tokens),
            signals,
            shared.parking_gate.clone(),
        ),
        SignalSource::Override(controller) => controller,
    };
    let mut mode_rx = signal.mode_rx;
    let lifecycle = signal.lifecycle;
    let mut signal_handler_task = signal.handler_task;

    // -----------------------------------------------------------------------
    // Idle pool cleanup interval (every 10 seconds)
    // -----------------------------------------------------------------------
    // `interval` fires its first tick immediately. In the main-loop
    // `tokio::select!` this can pre-empt `discover_fut` on its very first
    // poll — the discover future parks on `rx.recv()` (Pending) while the
    // interval tick is Ready, so select deterministically picks the tick.
    // Inside the tick arm any silent watch flip (`send_if_modified(.., false)`)
    // lands before the loop returns to the discover arm, and the top-of-loop
    // `borrow_and_update()` then breaks out before the pending job is ever
    // claimed. Delaying the first tick by one period keeps both arms Pending
    // on entry, so `discover_fut` wins the first wake. No observable prod
    // effect: idle cleanup on an empty pool and the first heartbeat were
    // both fine to happen ~10s later.
    let mut idle_cleanup = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    idle_cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // -----------------------------------------------------------------------
    // Heartbeat interval — same first-tick delay as above.
    // -----------------------------------------------------------------------
    let mut heartbeat_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_PERIOD,
        HEARTBEAT_PERIOD,
    );
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------
    // Notification channel: spawned jobs signal the main loop to send an
    // immediate heartbeat after session affinity state changes, so the server
    // learns about a held session VM or workspace image cache without waiting
    // for the next 10-second tick.
    let park_notify = Arc::new(tokio::sync::Notify::new());
    let orphaned_active_runs = OrphanedActiveRuns::new();
    let active_sessions = new_active_sessions();
    let mut orphan_reap_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    orphan_reap_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let hb_ctx = HeartbeatContext::new(HeartbeatContextInit {
        idle_pool: &shared.idle_pool,
        runner_id: &runner.id,
        name: &runner.name,
        group: &runner.group,
        profiles: &runner.profiles,
        budget: &capacity.budget,
        provider: &*provider_state.provider,
        workspace_cache: exec_config.workspace_cache.clone(),
        active_sessions: &active_sessions,
    });

    // Pin the discover future so it survives cancellation by other select!
    // branches (heartbeat, idle cleanup, etc.). Without pinning, heartbeat
    // (10s) cancels discover() on every tick, restarting its internal poll
    // sleep (30s) from scratch — so poll never fires. See #8747.
    let mut discover_fut = Box::pin(provider_state.provider.discover());

    let mut current_mode = RunnerMode::Running;
    let spawn_ctx = SpawnContext {
        provider: Arc::clone(&provider_state.provider),
        exec_config: Arc::clone(&exec_config),
        idle_pool: Arc::clone(&shared.idle_pool),
        status: Arc::clone(&shared.status),
        cancel_tokens: Arc::clone(&provider_state.cancel_tokens),
        orphaned_active_runs: orphaned_active_runs.clone(),
        parking_gate: shared.parking_gate.clone(),
        park_notify: Arc::clone(&park_notify),
        usage_flush_tx,
        active_sessions: active_sessions.clone(),
        device_rate_limits: capacity.device_rate_limits.clone(),
        #[cfg(test)]
        outer_job_panic: test_hooks.outer_job_panic,
        #[cfg(test)]
        test_observer: test_hooks.test_observer.clone(),
    };
    let mut draining_idle_pool_drained = false;
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            shared.status.set_mode(mode).await;
        }
        match mode {
            // Stopped should not normally reach here — teardown sets it and
            // exits. Treat as a safety break.
            RunnerMode::Stopped => break,
            // Stopping entry — skip the Draining soft-drain and go straight
            // to teardown.
            RunnerMode::Stopping => break,
            RunnerMode::Draining => {
                if !draining_idle_pool_drained {
                    // Soft drain entry. Destroy the idle pool once (releases
                    // budget — matches pre-split teardown behavior), then keep
                    // servicing the shared reactor while jobs finish.
                    drain_idle_pool(&shared.idle_pool, &shared.status, "draining").await;
                    draining_idle_pool_drained = true;
                }
                if jobs.is_empty() {
                    // Natural drain complete — commit to Stopping so teardown
                    // is observable to heartbeat and status.json. Guard the
                    // transition on `mode == Draining` so a concurrent SIGUSR2
                    // resume wins instead of being overwritten.
                    info!("draining: jobs drained, transitioning to Stopping");
                    let transitioned = lifecycle.stop_after_natural_drain();
                    if transitioned {
                        // Live observability: fire an immediate "stopping"
                        // heartbeat before teardown removes the runner.
                        send_heartbeat(&hb_ctx, RunnerMode::Stopping).await;
                    }
                    continue;
                }
            }
            RunnerMode::Running => {
                draining_idle_pool_drained = false;
            }
        }

        // Spawn background restart task when timer fires
        maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

        let can_discover = if matches!(mode, RunnerMode::Running) {
            if !capacity
                .budget
                .can_afford(capacity.min_vcpu, capacity.min_memory_mb)
            {
                let expired = evict_expired_idle_entries(&shared.idle_pool, &shared.status).await;
                if !expired.is_empty() {
                    info!(
                        count = expired.len(),
                        "reclaiming expired idle VMs for resource pressure"
                    );
                    if destroy_idle_jobs_and_wait(expired, "budget_pressure_expired").await {
                        park_notify.notify_one();
                    }
                    continue;
                }

                // If budget is still exhausted, try evicting an idle VM before
                // parking discovery. NOTE: evict_oldest is session-blind — it
                // may destroy the VM the next job wants to reuse. A proper fix
                // requires knowing session_id before claim, tracked separately.
                if let Some(evicted) =
                    evict_oldest_idle_entry(&shared.idle_pool, &shared.status).await
                {
                    info!(
                        session_id = %evicted.session_id(),
                        profile = %evicted.profile_name(),
                        vcpu = evicted.budget_vcpu(),
                        memory_mb = evicted.budget_memory_mb(),
                        "evicting idle VM for resource pressure"
                    );
                    // Wait for the destroy task so the idle VM's lease is
                    // dropped before the loop re-checks can_afford().
                    if destroy_idle_jobs_and_wait(vec![evicted], "budget_pressure_oldest").await {
                        park_notify.notify_one();
                    }
                    continue;
                }
            }
            capacity
                .budget
                .can_afford(capacity.min_vcpu, capacity.min_memory_mb)
        } else {
            false
        };
        #[cfg(test)]
        if matches!(mode, RunnerMode::Running) && !can_discover {
            test_hooks.test_observer.notify_budget_exhausted_reactor();
        }
        tokio::select! {
            // Job discovery via provider (Ably wakeups + HTTP poll).
            // The future is pinned outside the loop so heartbeat/cleanup
            // ticks don't cancel and restart its internal poll timer. See #8747.
            discovered = &mut discover_fut, if can_discover => {
                let Some(candidate) = discovered else { break };
                // Future completed — create a new one for the next discovery.
                discover_fut = Box::pin(provider_state.provider.discover());
                handle_discovered_job(
                    DiscoveredJob { candidate },
                    DiscoveredJobContext {
                        profiles: &runner.profiles,
                        factories: &factories,
                        budget: &capacity.budget,
                        idle_pool: &shared.idle_pool,
                        status: &shared.status,
                        mode_rx: &mode_rx,
                        cancel_tokens: &provider_state.cancel_tokens,
                        spawn_ctx: &spawn_ctx,
                        destroy_tasks: &mut destroy_tasks,
                        jobs: &mut jobs,
                    },
                ).await;
            }
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
            // Signal handler task should run until teardown aborts it. If it
            // exits early, stop the runner because OS signals are no longer
            // being consumed.
            result = recv_handler_task(&mut signal_handler_task) => {
                match result {
                    Ok(()) => warn!("signal handler task exited unexpectedly"),
                    Err(error) => warn!(error = %error, "signal handler task failed"),
                }
                handle_stopping_signal(
                    "signal-handler-task",
                    &provider_state.cancel,
                    &provider_state.cancel_tokens,
                    &lifecycle,
                ).await;
            }
            // Reap completed jobs promptly in all live modes. Without this,
            // normal Running mode can retain completed JoinSet entries and
            // stale cancel tokens until drain, budget exhaustion, or shutdown.
            result = jobs.join_next(), if !jobs.is_empty() => {
                handle_job_result(result, &provider_state.cancel_tokens).await;
                if !orphaned_active_runs.is_empty() {
                    reap_orphaned_active_runs(
                        &orphaned_active_runs,
                        &shared.idle_pool,
                        &shared.status,
                        OrphanReapMode::Immediate,
                        orphan_reap.process_discovery.as_ref(),
                    ).await;
                }
            }
            Some(()) = usage_flush_rx.recv() => {
                #[cfg(test)]
                test_hooks.test_observer.notify_usage_flush_requested();
                mitm.request_usage_flush();
            }
            // Reconcile active runs left visible after an outer job-task panic.
            _ = orphan_reap_tick.tick(), if !orphaned_active_runs.is_empty() => {
                reap_orphaned_active_runs(
                    &orphaned_active_runs,
                    &shared.idle_pool,
                    &shared.status,
                    OrphanReapMode::ConfirmAbsent,
                    orphan_reap.process_discovery.as_ref(),
                ).await;
            }
            // Reap completed destroy tasks
            Some(result) = destroy_tasks.join_next(), if !destroy_tasks.is_empty() => {
                match result {
                    Ok(true) => park_notify.notify_one(),
                    Ok(false) => {}
                    Err(e) => warn!(error = %e, "destroy task panicked"),
                }
            }
            // Mitmproxy crash detection
            _ = mitm_crash_rx.recv() => {
                warn!("mitmproxy exited unexpectedly, scheduling restart");
                mitm_retry.schedule();
            }
            // Mitmproxy restart result (background task)
            result = recv_retry(&mut mitm_retry.handle) => {
                handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry);
            }
            // Mitmproxy restart timer
            () = sleep_until_retry(&mitm_retry.restart_at) => {}
            // Idle pool cleanup: evict expired VMs and update status
            _ = idle_cleanup.tick(), if can_discover => {
                let expired = cleanup_expired_idle_entries(&shared.idle_pool, &shared.status).await;
                #[cfg(test)]
                let expired_count = expired.len();
                for entry in expired {
                    spawn_idle_destroy_job(&mut destroy_tasks, entry, "idle_expired");
                }
                #[cfg(test)]
                test_hooks
                    .test_observer
                    .record(StartLoopEvent::IdleCleanupProcessed { expired_count });
            }
            // Heartbeat: report runner state to the server
            _ = heartbeat_tick.tick() => {
                send_heartbeat(&hb_ctx, current_mode).await;
            }
            // Immediate heartbeat after session affinity state changes —
            // eliminates the up-to-10s blind spot for affinity routing.
            _ = park_notify.notified(), if matches!(mode, RunnerMode::Running) => {
                let source = if can_discover { "main" } else { "budget_exhausted" };
                info!(source, "session affinity state triggered immediate heartbeat");
                send_heartbeat(&hb_ctx, current_mode).await;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown — drain idle pool, release discovery resources, then drain running jobs
    // -----------------------------------------------------------------------
    let ShutdownHandles {
        kmsg_handle,
        dns_handle,
        mut memory_prefetch,
    } = shutdown;
    let teardown = TeardownTimer::start();
    memory_prefetch.cancel();
    teardown.event("memory_prefetch_cancelled");

    // Drop the pinned discover future before provider shutdown so any
    // provider-local discovery resources are released first. This also keeps
    // the historical shutdown-deadlock regression covered by mock providers.
    drop(discover_fut);
    teardown.event("drop_discover_fut");

    // Drain idle pool first — these VMs hold budget reservations. This
    // also clears `idle_vms` in status.json so the final snapshot is
    // consistent with the empty pool.
    lifecycle.close_parking();
    let phase = teardown.phase_start("drain_idle_pool");
    drain_idle_pool(&shared.idle_pool, &shared.status, "shutdown").await;
    teardown.phase_complete("drain_idle_pool", phase);

    let phase = teardown.phase_start("provider_shutdown");
    provider_state.provider.shutdown().await;
    teardown.phase_complete("provider_shutdown", phase);

    // Send final heartbeat with Stopping so the server stops routing jobs
    // to this runner immediately, without waiting for TTL expiry.
    let phase = teardown.phase_start("final_heartbeat");
    {
        let pool = shared.idle_pool.lock().await;
        let state = collect_heartbeat_state(
            &runner.id,
            &runner.name,
            &runner.group,
            &runner.profiles,
            &capacity.budget,
            &pool,
            RunnerMode::Stopping,
        );
        drop(pool);
        provider_state.provider.heartbeat(&state).await;
    }
    teardown.phase_complete("final_heartbeat", phase);

    let remaining = jobs.len();
    let phase = teardown.phase_start("running_jobs_drain");
    if remaining > 0 {
        info!(remaining, "waiting for running jobs to finish");
        while !jobs.is_empty() {
            maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

            tokio::select! {
                result = jobs.join_next() => {
                    handle_job_result(result, &provider_state.cancel_tokens).await;
                    if !orphaned_active_runs.is_empty() {
                        reap_orphaned_active_runs(
                            &orphaned_active_runs,
                            &shared.idle_pool,
                            &shared.status,
                            OrphanReapMode::Immediate,
                            orphan_reap.process_discovery.as_ref(),
                        ).await;
                    }
                }
                Some(()) = usage_flush_rx.recv() => {
                    #[cfg(test)]
                    test_hooks.test_observer.notify_usage_flush_requested();
                    mitm.request_usage_flush();
                }
                Some(result) = destroy_tasks.join_next() => {
                    match result {
                        Ok(_) => {}
                        Err(e) => warn!(error = %e, "destroy task panicked"),
                    }
                }
                _ = mitm_crash_rx.recv() => {
                    warn!("mitmproxy exited unexpectedly, scheduling restart");
                    mitm_retry.schedule();
                }
                result = recv_retry(&mut mitm_retry.handle) => {
                    handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry);
                }
                () = sleep_until_retry(&mitm_retry.restart_at) => {}
            }
        }
    }
    teardown.phase_complete("running_jobs_drain", phase);
    if !orphaned_active_runs.is_empty() {
        let phase = teardown.phase_start("orphan_reap_shutdown_final");
        reap_orphaned_active_runs(
            &orphaned_active_runs,
            &shared.idle_pool,
            &shared.status,
            OrphanReapMode::ShutdownFinal,
            orphan_reap.process_discovery.as_ref(),
        )
        .await;
        teardown.phase_complete("orphan_reap_shutdown_final", phase);
    }
    // Wait for any in-flight destroy tasks (from cleanup tick, profile
    // mismatch eviction, etc.) so their factory Arcs are dropped before
    // shutdown_factories calls Arc::try_unwrap.
    let phase = teardown.phase_start("destroy_tasks_drain");
    while let Some(result) = destroy_tasks.join_next().await {
        match result {
            Ok(_) => {}
            Err(e) => {
                warn!(error = %e, "destroy task panicked during shutdown");
            }
        }
    }
    teardown.phase_complete("destroy_tasks_drain", phase);
    let phase = teardown.phase_start("finish_mitm_restart");
    finish_mitm_restart_before_shutdown(&mut mitm, &mut mitm_retry).await;
    teardown.phase_complete("finish_mitm_restart", phase);
    if let Some(handler_task) = signal_handler_task.take() {
        match handler_task.abort_and_wait().await {
            Err(error) if error.is_cancelled() => {
                teardown.event("signal_handler_aborted");
            }
            Err(error) => {
                warn!(error = %error, "signal handler task failed during shutdown");
            }
            Ok(()) => {
                warn!("signal handler task exited before shutdown abort completed");
            }
        }
    }

    info!("shutting down factories");
    let phase = teardown.phase_start("shutdown_factories");
    shutdown_factories(&mut factories, runtime.as_mut(), Some(&teardown)).await;
    teardown.phase_complete("shutdown_factories", phase);

    // Wait for buffered and pending usage reports before stopping the proxy.
    // The runner writes a shutdown request marker, then the addon replies with
    // fresh pending snapshots after SIGUSR1-triggered flush requests. This
    // remains bounded best-effort, and timeout is the abnormal data-loss path.
    let phase = teardown.phase_start("wait_usage_flush");
    if let Some(usage_flush_target) = mitm.usage_flush_target() {
        let addon_dir = paths.base_dir.join("mitm-addon");
        match proxy::write_usage_flush_request(&addon_dir, &usage_flush_target).await {
            Ok(usage_flush_request) => {
                info!("requesting proxy usage flush");
                if mitm.request_usage_flush() {
                    info!("waiting for proxy usage reports to flush");
                    let flushed = proxy::wait_usage_flush_requesting(
                        &addon_dir,
                        proxy::USAGE_FLUSH_TIMEOUT,
                        &usage_flush_request,
                        || mitm.request_usage_flush(),
                    )
                    .await;
                    if flushed {
                        info!("all usage reports flushed");
                    } else {
                        warn!("usage flush did not complete, some reports may be lost");
                    }
                } else {
                    warn!("failed to request proxy usage flush, skipping usage wait");
                }
            }
            Err(e) => {
                warn!(error = %e, "failed to create proxy usage flush request, skipping usage wait");
            }
        }
    } else {
        info!("proxy is not running; skipping usage flush wait");
    }
    teardown.phase_complete("wait_usage_flush", phase);

    // Stop proxy after all jobs have drained and factory is shut down.
    let phase = teardown.phase_start("mitm_stop");
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }
    teardown.phase_complete("mitm_stop", phase);

    // Stop the kmsg monitor and wait for the `dmesg -w` child process
    // to be killed and reaped.
    let phase = teardown.phase_start("kmsg_stop");
    kmsg_handle.stop().await;
    teardown.phase_complete("kmsg_stop", phase);
    let phase = teardown.phase_start("dns_stop");
    dns_handle.stop().await;
    teardown.phase_complete("dns_stop", phase);

    let phase = teardown.phase_start("memory_prefetch_drain");
    memory_prefetch.drain().await;
    teardown.phase_complete("memory_prefetch_drain", phase);

    let phase = teardown.phase_start("status_stopped");
    shared.status.set_mode(RunnerMode::Stopped).await;
    teardown.phase_complete("status_stopped", phase);
    info!(total_teardown_ms = teardown.elapsed_ms(), "runner stopped");

    Ok(())
}

#[cfg(test)]
mod tests;
