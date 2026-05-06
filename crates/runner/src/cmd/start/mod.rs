//! `runner start` — run the long-lived worker loop.
//!
//! `run_start` registers lifecycle signals early, loads config, claims the
//! canonical runner `base_dir` lock, initializes shared resources, then enters
//! `run()`, the main reactor for discovery, heartbeats, job execution,
//! idle-pool maintenance, mitmproxy restart, and teardown.
//!
//! The sibling modules keep focused responsibilities out of this orchestration
//! file:
//! - `factory_lifecycle`: sandbox factory startup and shutdown.
//! - `idle_lifecycle`: idle-pool lifecycle, status updates, and destroy helpers.
//! - `identity`: persistent runner id storage.
//! - `job_discovery`: discovery branch handling and idle-reuse admission.
//! - `job_lifecycle`: cleanup, budget, and completion ownership state.
//! - `job_spawn`: claimed job task spawning, completion, and panic cleanup.
//! - `mitm_restart`: mitmproxy crash restart and backoff.
//! - `orphan_reap`: orphan active-run reconciliation.
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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{RuntimeProvider, SandboxRuntime};
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
use crate::http::HttpClient;
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
use crate::status::{RunnerMode, StatusTracker};

mod factory_lifecycle;
mod heartbeat;
mod identity;
mod idle_lifecycle;
mod job_discovery;
mod job_lifecycle;
mod job_spawn;
mod mitm_restart;
mod orphan_reap;
mod sandbox_finalization;
mod signals;

use factory_lifecycle::{shutdown_factories, start_factories};
use heartbeat::{HEARTBEAT_PERIOD, HeartbeatContext, collect_heartbeat_state, send_heartbeat};
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
use signals::{EarlySignals, SignalController};

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

    tokio::fs::create_dir_all(&runner_config.base_dir)
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "create base_dir {}: {e}",
                runner_config.base_dir.display()
            ))
        })?;

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
    for profile in runner_config.profiles.values() {
        let path = crate::paths::RootfsPaths::new(&home, &profile.rootfs_hash)
            .snapshot(&profile.snapshot_hash)
            .memory_bin();
        tokio::task::spawn_blocking(move || prefetch::prefetch_memory(&path));
    }

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
    let config::SandboxConfig {
        max_concurrent,
        concurrency_factor,
        idle_timeout_secs,
        max_idle,
    } = runner_config.sandbox;
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
        max_concurrent,
        effective_vcpu = budget.effective_vcpu(),
        effective_memory_mb = budget.effective_memory_mb(),
        profiles = runner_config.profiles.len(),
        "resource budget initialized"
    );

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

    // Build sandbox runtime with shared resources (netns pool, base loop cache).
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
    let http = HttpClient::new(server.url.clone())?;
    let name = runner_config.name;
    let group = runner_config.group;
    let cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let (provider, group_name): (Arc<dyn JobProvider>, String) = if args.local {
        let group_dir = home.groups_dir().join(&group);
        std::fs::create_dir_all(&group_dir).map_err(|e| {
            RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
        })?;
        let provider = LocalProvider::new(group_dir, cancel.clone(), Arc::clone(&cancel_tokens));
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
        home: home.clone(),
    });

    let config = RunConfig {
        id: runner_id,
        name,
        group: group_name,
        profiles: runner_config.profiles,
        runtime,
        home,
        budget,
        idle_pool,
        parking_gate,
        status,
        mitm,
        mitm_crash_rx,
        provider,
        cancel_tokens,
        cancel,
        exec_config,
        firecracker: runner_config.firecracker,
        base_dir: runner_config.base_dir,
        min_vcpu,
        min_memory_mb,
        kmsg_handle,
        dns_handle,
        signal_source: SignalSource::Real(signals),
        orphan_reap_process_discovery: None,
        #[cfg(test)]
        outer_job_panic: None,
    };

    run(config).await
}

struct RunConfig {
    id: String,
    name: String,
    group: String,
    profiles: std::collections::BTreeMap<String, ProfileConfig>,
    runtime: Box<dyn SandboxRuntime>,
    home: HomePaths,
    budget: Arc<ResourceBudget>,
    idle_pool: SharedIdlePool,
    parking_gate: ParkingGate,
    status: Arc<StatusTracker>,
    mitm: proxy::MitmProxy,
    mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
    provider: Arc<dyn JobProvider>,
    /// Per-job cancel tokens shared with the provider for cancel events
    /// (Ably for ApiProvider, `.cancel` files for LocalProvider).
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    cancel: CancellationToken,
    exec_config: Arc<ExecutorConfig>,
    firecracker: config::FirecrackerConfig,
    base_dir: std::path::PathBuf,
    min_vcpu: u32,
    min_memory_mb: u32,
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
    /// Deterministic process snapshot for orphan-reaper tests. Production leaves
    /// this unset and scans `/proc`.
    orphan_reap_process_discovery: Option<OrphanReapProcessDiscovery>,
    /// How the run's mode channel is driven. Production supplies the signal
    /// streams registered at the top of `run_start`; tests supply a
    /// pre-built `SignalController` so they can drive mode transitions
    /// through the lifecycle controller.
    signal_source: SignalSource,
    #[cfg(test)]
    outer_job_panic: Option<OuterJobPanicPoint>,
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
        id: runner_id,
        name,
        group,
        profiles,
        mut runtime,
        home,
        budget,
        idle_pool,
        parking_gate,
        status,
        mut mitm,
        mut mitm_crash_rx,
        provider,
        cancel_tokens,
        cancel,
        exec_config,
        firecracker,
        base_dir,
        min_vcpu,
        min_memory_mb,
        kmsg_handle,
        dns_handle,
        orphan_reap_process_discovery,
        signal_source,
        #[cfg(test)]
        outer_job_panic,
    } = config;

    let mut factories =
        start_factories(&profiles, &firecracker, &base_dir, &home, runtime.as_mut()).await?;

    let mut jobs: JoinSet<Option<RunId>> = JoinSet::new();
    // Tracked destroy tasks — JoinSet ensures we can await all in-flight
    // destroys at shutdown, preventing factory Arc leaks that cause
    // "factory still referenced" warnings from Arc::try_unwrap.
    let mut destroy_tasks: JoinSet<()> = JoinSet::new();

    status.write_initial().await;
    info!(
        name = %name,
        group = %group,
        effective_vcpu = budget.effective_vcpu(),
        effective_memory_mb = budget.effective_memory_mb(),
        max_concurrent = budget.max_concurrent(),
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
    let signal = match signal_source {
        SignalSource::Real(signals) => SignalController::spawn(
            cancel.clone(),
            Arc::clone(&cancel_tokens),
            signals,
            parking_gate.clone(),
        ),
        SignalSource::Override(controller) => controller,
    };
    let mut mode_rx = signal.mode_rx;
    let lifecycle = signal.lifecycle;
    let signal_handler_abort = signal.handler_abort;

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
    // immediate heartbeat after parking a VM, so the server learns about the
    // new heldSession without waiting for the next 10-second tick.
    let park_notify = Arc::new(tokio::sync::Notify::new());
    let orphaned_active_runs = OrphanedActiveRuns::new();
    let mut orphan_reap_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    orphan_reap_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let hb_ctx = HeartbeatContext::new(
        &idle_pool, &runner_id, &name, &group, &profiles, &budget, &*provider,
    );

    // Pin the discover future so it survives cancellation by other select!
    // branches (heartbeat, idle cleanup, etc.). Without pinning, heartbeat
    // (10s) cancels discover() on every tick, restarting its internal poll
    // sleep (30s) from scratch — so poll never fires. See #8747.
    let mut discover_fut = Box::pin(provider.discover());

    let mut current_mode = RunnerMode::Running;
    let spawn_ctx = SpawnContext {
        provider: Arc::clone(&provider),
        exec_config: Arc::clone(&exec_config),
        idle_pool: Arc::clone(&idle_pool),
        status: Arc::clone(&status),
        cancel_tokens: Arc::clone(&cancel_tokens),
        orphaned_active_runs: orphaned_active_runs.clone(),
        parking_gate: parking_gate.clone(),
        park_notify: Arc::clone(&park_notify),
        #[cfg(test)]
        outer_job_panic,
    };
    let mut draining_idle_pool_drained = false;
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            status.set_mode(mode).await;
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
                    drain_idle_pool(&idle_pool, &status, "draining").await;
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
            if !budget.can_afford(min_vcpu, min_memory_mb) {
                let expired = evict_expired_idle_entries(&idle_pool, &status).await;
                if !expired.is_empty() {
                    info!(
                        count = expired.len(),
                        "reclaiming expired idle VMs for resource pressure"
                    );
                    destroy_idle_jobs_and_wait(expired, "budget_pressure_expired").await;
                    continue;
                }

                // If budget is still exhausted, try evicting an idle VM before
                // parking discovery. NOTE: evict_oldest is session-blind — it
                // may destroy the VM the next job wants to reuse. A proper fix
                // requires knowing session_id before claim, tracked separately.
                if let Some(evicted) = evict_oldest_idle_entry(&idle_pool, &status).await {
                    info!(
                        session_id = %evicted.session_id(),
                        profile = %evicted.profile_name(),
                        vcpu = evicted.budget_vcpu(),
                        memory_mb = evicted.budget_memory_mb(),
                        "evicting idle VM for resource pressure"
                    );
                    // Wait for the destroy task so the idle VM's lease is
                    // dropped before the loop re-checks can_afford().
                    destroy_idle_jobs_and_wait(vec![evicted], "budget_pressure_oldest").await;
                    continue;
                }
            }
            budget.can_afford(min_vcpu, min_memory_mb)
        } else {
            false
        };
        tokio::select! {
            // Job discovery via provider (Ably wakeups + HTTP poll).
            // The future is pinned outside the loop so heartbeat/cleanup
            // ticks don't cancel and restart its internal poll timer. See #8747.
            discovered = &mut discover_fut, if can_discover => {
                let Some((run_id, profile_name)) = discovered else { break };
                // Future completed — create a new one for the next discovery.
                discover_fut = Box::pin(provider.discover());
                handle_discovered_job(
                    DiscoveredJob { run_id, profile_name },
                    DiscoveredJobContext {
                        profiles: &profiles,
                        factories: &factories,
                        budget: &budget,
                        idle_pool: &idle_pool,
                        status: &status,
                        mode_rx: &mode_rx,
                        cancel_tokens: &cancel_tokens,
                        spawn_ctx: &spawn_ctx,
                        destroy_tasks: &mut destroy_tasks,
                        jobs: &mut jobs,
                    },
                ).await;
            }
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
            // Reap completed jobs promptly in all live modes. Without this,
            // normal Running mode can retain completed JoinSet entries and
            // stale cancel tokens until drain, budget exhaustion, or shutdown.
            result = jobs.join_next(), if !jobs.is_empty() => {
                handle_job_result(result, &cancel_tokens).await;
                if !orphaned_active_runs.is_empty() {
                    reap_orphaned_active_runs(
                        &orphaned_active_runs,
                        &idle_pool,
                        &status,
                        OrphanReapMode::Immediate,
                        orphan_reap_process_discovery.as_ref(),
                    ).await;
                }
            }
            // Reconcile active runs left visible after an outer job-task panic.
            _ = orphan_reap_tick.tick(), if !orphaned_active_runs.is_empty() => {
                reap_orphaned_active_runs(
                    &orphaned_active_runs,
                    &idle_pool,
                    &status,
                    OrphanReapMode::ConfirmAbsent,
                    orphan_reap_process_discovery.as_ref(),
                ).await;
            }
            // Reap completed destroy tasks
            Some(result) = destroy_tasks.join_next(), if !destroy_tasks.is_empty() => {
                if let Err(e) = result {
                    warn!(error = %e, "destroy task panicked");
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
                let expired = cleanup_expired_idle_entries(&idle_pool, &status).await;
                for entry in expired {
                    spawn_idle_destroy_job(&mut destroy_tasks, entry, "idle_expired");
                }
            }
            // Heartbeat: report runner state to the server
            _ = heartbeat_tick.tick() => {
                send_heartbeat(&hb_ctx, current_mode).await;
            }
            // Immediate heartbeat after a VM is parked — eliminates the
            // up-to-10s blind spot for session affinity routing.
            _ = park_notify.notified(), if matches!(mode, RunnerMode::Running) => {
                let source = if can_discover { "main" } else { "budget_exhausted" };
                info!(source, "park triggered immediate heartbeat");
                send_heartbeat(&hb_ctx, current_mode).await;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown — drain idle pool, release discovery resources, then drain running jobs
    // -----------------------------------------------------------------------
    let teardown = TeardownTimer::start();

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
    drain_idle_pool(&idle_pool, &status, "shutdown").await;
    teardown.phase_complete("drain_idle_pool", phase);

    let phase = teardown.phase_start("provider_shutdown");
    provider.shutdown().await;
    teardown.phase_complete("provider_shutdown", phase);

    // Send final heartbeat with Stopping so the server stops routing jobs
    // to this runner immediately, without waiting for TTL expiry.
    let phase = teardown.phase_start("final_heartbeat");
    {
        let pool = idle_pool.lock().await;
        let state = collect_heartbeat_state(
            &runner_id,
            &name,
            &group,
            &profiles,
            &budget,
            &pool,
            RunnerMode::Stopping,
        );
        drop(pool);
        provider.heartbeat(&state).await;
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
                    handle_job_result(result, &cancel_tokens).await;
                    if !orphaned_active_runs.is_empty() {
                        reap_orphaned_active_runs(
                            &orphaned_active_runs,
                            &idle_pool,
                            &status,
                            OrphanReapMode::Immediate,
                            orphan_reap_process_discovery.as_ref(),
                        ).await;
                    }
                }
                Some(result) = destroy_tasks.join_next() => {
                    if let Err(e) = result {
                        warn!(error = %e, "destroy task panicked");
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
            &idle_pool,
            &status,
            OrphanReapMode::ShutdownFinal,
            orphan_reap_process_discovery.as_ref(),
        )
        .await;
        teardown.phase_complete("orphan_reap_shutdown_final", phase);
    }
    // Wait for any in-flight destroy tasks (from cleanup tick, profile
    // mismatch eviction, etc.) so their factory Arcs are dropped before
    // shutdown_factories calls Arc::try_unwrap.
    let phase = teardown.phase_start("destroy_tasks_drain");
    while let Some(result) = destroy_tasks.join_next().await {
        if let Err(e) = result {
            warn!(error = %e, "destroy task panicked during shutdown");
        }
    }
    teardown.phase_complete("destroy_tasks_drain", phase);
    let phase = teardown.phase_start("finish_mitm_restart");
    finish_mitm_restart_before_shutdown(&mut mitm, &mut mitm_retry).await;
    teardown.phase_complete("finish_mitm_restart", phase);
    if let Some(abort) = signal_handler_abort {
        abort.abort();
        teardown.event("signal_handler_aborted");
    }

    info!("shutting down factories");
    let phase = teardown.phase_start("shutdown_factories");
    shutdown_factories(&mut factories, runtime.as_mut(), Some(&teardown)).await;
    teardown.phase_complete("shutdown_factories", phase);

    // Wait for pending usage reports to flush before stopping the proxy.
    // The addon writes the current mitmdump identity plus in-flight flow
    // and pending report counts; this remains bounded best-effort and
    // falls back to stopping the proxy on timeout.
    let phase = teardown.phase_start("wait_usage_flush");
    if let Some(usage_flush_target) = mitm.usage_flush_target() {
        info!("waiting for proxy usage reports to flush");
        let flushed = proxy::wait_usage_flush(
            &base_dir.join("mitm-addon"),
            proxy::USAGE_FLUSH_TIMEOUT,
            &usage_flush_target,
        )
        .await;
        if flushed {
            info!("all usage reports flushed");
        } else {
            warn!("usage flush timed out, some reports may be lost");
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

    let phase = teardown.phase_start("status_stopped");
    status.set_mode(RunnerMode::Stopped).await;
    teardown.phase_complete("status_stopped", phase);
    info!(total_teardown_ms = teardown.elapsed_ms(), "runner stopped");

    Ok(())
}

#[cfg(test)]
mod tests;
