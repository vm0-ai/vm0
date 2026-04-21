use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use sandbox::{RuntimeProvider, Sandbox, SandboxFactory, SandboxId, SandboxRuntime};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use uuid::Uuid;

use crate::ids::RunId;

use crate::config::{self, ProfileConfig};
use crate::deps;
use crate::dns;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{self, ExecutorConfig};
use crate::host;
use crate::http::HttpClient;
use crate::idle_pool::{IdleEntry, IdlePool, IdlePoolConfig, ParkResult};
use crate::kmsg_log;
use crate::lock;
use crate::network_logs;
use crate::paths::{HomePaths, LogPaths, RunnerPaths, touch_mtime};
use crate::prefetch;
use crate::provider::{ApiProvider, JobProvider, LocalProvider};
use crate::proxy;
use crate::resource_budget::ResourceBudget;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::status::{RunnerMode, StatusTracker};
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};

/// Initial backoff before retrying mitmproxy after a crash.
const MITM_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// Maximum backoff between mitmproxy restart attempts.
const MITM_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Stop retrying mitmproxy after this many consecutive failures.
const MITM_MAX_CONSECUTIVE_FAILURES: u32 = 20;

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
    for profile in runner_config.profiles.values() {
        let rootfs_lock = lock::acquire_shared(home.rootfs_lock(&profile.rootfs_hash)).await?;
        let rootfs_paths = crate::paths::RootfsPaths::new(&home, &profile.rootfs_hash);
        touch_mtime(rootfs_paths.dir());
        _resource_locks.push(rootfs_lock);
        let snapshot_lock =
            lock::acquire_shared(home.snapshot_lock(&profile.snapshot_hash)).await?;
        let snapshot_paths = rootfs_paths.snapshot(&profile.snapshot_hash);
        touch_mtime(snapshot_paths.dir());
        _resource_locks.push(snapshot_lock);
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

    // Start background kmsg monitor for non-TCP traffic logging.
    let ip_log_map = kmsg_log::new_ip_log_map();
    let kmsg_handle = kmsg_log::spawn(ip_log_map.clone())
        .map_err(|e| RunnerError::Internal(format!("kmsg monitor: {e}")))?;

    // Start DNS proxy (dnsmasq) for domain-level DNS interception and logging.
    // Shares ip_log_map with kmsg — both use source IP (peer veth) as key.
    let dns_handle = dns::start(ip_log_map.clone())
        .await
        .map_err(|e| RunnerError::Internal(format!("dns proxy: {e}")))?;

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
    // Whether individual jobs use the pool is controlled by the per-job
    // `sandboxReuse` feature flag; the pool itself is always available.
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        default_timeout: Duration::from_secs(idle_timeout_secs),
        max_idle,
    })));

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

    let mut status = StatusTracker::new(paths.status(), estimated_capacity);
    status.set_proxy_port(mitm.port()).await;
    status.set_dns_port(dns_handle.port()).await;
    let status = Arc::new(status);

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
        ip_log_map,
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
    /// How the run's mode channel is driven. Production supplies the signal
    /// streams registered at the top of `run_start`; tests supply a
    /// pre-built `SignalController` so they can drive mode transitions
    /// directly.
    signal_source: SignalSource,
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

type MitmRestartHandle = tokio::task::JoinHandle<RunnerResult<tokio::process::Child>>;

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
        signal_source,
    } = config;

    // Build per-profile factories via the sandbox runtime.
    let mut factories: BTreeMap<String, (SharedFactory, bool)> = BTreeMap::new();
    for (profile_name, profile_config) in &profiles {
        let factory_config = config::RunnerConfig::build_factory_config(
            &firecracker,
            &base_dir,
            profile_name,
            profile_config,
            &home,
        );
        let restore_guest_state = factory_config.snapshot.is_some();
        let factory_result = runtime.create_factory(factory_config).await;
        let factory = match factory_result {
            Ok(f) => f,
            Err(e) => {
                shutdown_factories(&mut factories, runtime.as_mut()).await;
                return Err(e.into());
            }
        };
        factories.insert(
            profile_name.clone(),
            (Arc::new(factory), restore_guest_state),
        );
        info!(profile = %profile_name, "factory started");
    }

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
        SignalSource::Real(signals) => {
            SignalController::spawn(cancel.clone(), Arc::clone(&cancel_tokens), signals)
        }
        SignalSource::Override(controller) => controller,
    };
    let mut mode_rx = signal.mode_rx;
    let mode_tx = signal.mode_tx;
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
    // Heartbeat interval (every 10 seconds) — same first-tick delay as above.
    // -----------------------------------------------------------------------
    let mut heartbeat_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------
    // Notification channel: spawned jobs signal the main loop to send an
    // immediate heartbeat after parking a VM, so the server learns about the
    // new heldSession without waiting for the next 10-second tick.
    let park_notify = Arc::new(tokio::sync::Notify::new());

    let hb_ctx = HeartbeatContext {
        idle_pool: &idle_pool,
        runner_id: &runner_id,
        name: &name,
        group: &group,
        profiles: &profiles,
        budget: &budget,
        provider: &*provider,
    };

    // Pin the discover future so it survives cancellation by other select!
    // branches (heartbeat, idle cleanup, etc.). Without pinning, heartbeat
    // (10s) cancels discover() on every tick, restarting its internal poll
    // sleep (30s) from scratch — so poll never fires. See #8747.
    let mut discover_fut = Box::pin(provider.discover());

    let mut current_mode = RunnerMode::Running;
    let mut spawn_ctx = SpawnContext {
        provider: Arc::clone(&provider),
        exec_config: Arc::clone(&exec_config),
        budget: Arc::clone(&budget),
        idle_pool: Arc::clone(&idle_pool),
        status: Arc::clone(&status),
        mode: current_mode,
        park_notify: Arc::clone(&park_notify),
    };
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            spawn_ctx.mode = mode;
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
                // Soft drain. Destroy the idle pool on entry (releases
                // budget — matches pre-split teardown behavior). Heartbeats
                // and mitm keep running. Exit the arm when any of: jobs
                // drain naturally / mode flips externally (Running on
                // SIGUSR2, Stopping on SIGTERM/SIGINT).
                drain_idle_pool(&idle_pool, &budget, &status, "draining").await;

                'draining: loop {
                    if jobs.is_empty() {
                        // Natural drain complete — commit to Stopping so
                        // teardown is observable to heartbeat and status.json.
                        // Broadcasting via mode_tx keeps mode_rx consistent
                        // with current_mode for the next outer-loop iteration.
                        //
                        // Guard the transition on `mode == Draining`: an
                        // unconditional `send(Stopping)` would silently
                        // overwrite a concurrent SIGUSR2 that flipped us back
                        // to Running. `send_if_modified` with the Draining
                        // check lets SIGUSR2 win the race — resume should
                        // never lose to an auto-transition.
                        info!("draining: jobs drained, transitioning to Stopping");
                        let transitioned = mode_tx.send_if_modified(|v| {
                            if *v == RunnerMode::Draining {
                                *v = RunnerMode::Stopping;
                                true
                            } else {
                                // SIGUSR2 raced us to Running — keep that.
                                false
                            }
                        });
                        if transitioned {
                            // Live observability: fire an immediate "stopping"
                            // heartbeat so operator dashboards see the
                            // transition before teardown completes and the
                            // runner disappears. Otherwise the last live tick
                            // is the previous "draining" heartbeat (up to 10s
                            // stale) and the only "stopping" signal would be
                            // the terminal heartbeat during teardown.
                            send_heartbeat(&hb_ctx, RunnerMode::Stopping).await;
                        }
                        break 'draining;
                    }

                    maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

                    tokio::select! {
                        _ = mode_rx.changed() => {
                            // External transition (SIGUSR2 → Running or
                            // SIGTERM → Stopping). Re-evaluate at outer loop top.
                            break 'draining;
                        }
                        result = jobs.join_next() => {
                            handle_job_result(result, &cancel_tokens).await;
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
                        _ = heartbeat_tick.tick() => {
                            send_heartbeat(&hb_ctx, current_mode).await;
                        }
                    }
                }

                // Re-read mode at outer loop top: Running → resume normal
                // discovery; Stopping → break to teardown; Draining shouldn't
                // happen (the arm only exits on a mode change or commit).
                continue;
            }
            RunnerMode::Running => {}
        }

        // Spawn background restart task when timer fires
        maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

        // If budget is exhausted for all profiles, try evicting an idle VM
        // before waiting for a running job to finish.
        //
        // NOTE: evict_oldest is session-blind — it may destroy the very VM
        // that the next job wants to reuse. A proper fix requires knowing
        // session_id before claim, which is tracked for Phase 2.
        if !budget.can_afford(min_vcpu, min_memory_mb) {
            if let Some(evicted) = idle_pool.lock().await.evict_oldest() {
                info!(
                    session_id = %evicted.session_id,
                    profile = %evicted.profile_name,
                    "evicting idle VM for resource pressure"
                );
                // Inline destroy so budget.release() happens synchronously
                // before the `continue` re-checks can_afford(). Using
                // tokio::spawn here would cause a cascade: the async release
                // hasn't fired yet → can_afford still false → evict another →
                // repeat until the entire pool is drained unnecessarily.
                let vcpu = evicted.vcpu;
                let memory_mb = evicted.memory_mb;
                evicted.stop_and_destroy().await;
                budget.release(vcpu, memory_mb);
                continue; // retry budget check — budget is now actually freed
            }
            tokio::select! {
                _ = mode_rx.changed() => {}
                result = jobs.join_next() => {
                    handle_job_result(result, &cancel_tokens).await;
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
                // Heartbeat must also run when budget is exhausted, otherwise
                // the server thinks the runner is dead.
                _ = heartbeat_tick.tick() => {
                    send_heartbeat(&hb_ctx, current_mode).await;
                }
                _ = park_notify.notified() => {
                    info!(source = "budget_exhausted", "park triggered immediate heartbeat");
                    send_heartbeat(&hb_ctx, current_mode).await;
                }
            }
            continue;
        }

        tokio::select! {
            // Job discovery via provider (Ably push + poll).
            // The future is pinned outside the loop so heartbeat/cleanup ticks
            // don't cancel and restart its internal poll timer. See #8747.
            discovered = &mut discover_fut => {
                let Some((run_id, profile_name)) = discovered else { break };
                // Future completed — create a new one for the next discovery.
                discover_fut = Box::pin(provider.discover());
                // Look up profile config for resource requirements.
                let Some(profile_config) = profiles.get(&profile_name) else {
                    warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
                    continue;
                };
                let job_vcpu = profile_config.vcpu;
                let job_memory = profile_config.memory_mb;
                // Look up factory for this profile.
                let Some((factory, restore_guest_state)) = factories.get(&profile_name) else {
                    warn!(run_id = %run_id, profile = %profile_name, "no factory for profile, skipping");
                    continue;
                };
                // Reserve resources before claiming so we don't waste a job
                // that another runner could handle.
                if !budget.try_reserve(job_vcpu, job_memory) {
                    continue;
                }
                // Insert cancel token before claiming so it is available when
                // discover() next processes a buffered Ably cancel event.
                // Skip if already present (duplicate discovery via poll +
                // buffered Ably notification) — overwriting would break
                // cancel delivery for the running executor.
                let job_cancel = CancellationToken::new();
                {
                    let mut tokens = cancel_tokens.lock().await;
                    if tokens.contains_key(&run_id) {
                        budget.release(job_vcpu, job_memory);
                        continue;
                    }
                    tokens.insert(run_id, job_cancel.clone());
                }
                // Close a TOCTOU race against hard shutdown: the signal
                // handler sends Stopping *before* locking cancel_tokens. If
                // the handler's iteration ran over an empty map between our
                // discover and insert, we catch it here by re-reading mode.
                // The watch channel's write/read fence makes this check
                // happens-after the send(Stopping).
                if matches!(*mode_rx.borrow(), RunnerMode::Stopping) {
                    job_cancel.cancel();
                }
                // claim() runs in the branch handler — non-interruptible,
                // so a successful claim is always paired with complete().
                let Some(context) = provider.claim(run_id).await else {
                    // None means the job won't run here — either lost the race
                    // to another runner, or the provider rejected the job
                    // (e.g. poisoned .job handled inside the provider). Either
                    // way, release the reservation and move on.
                    cancel_tokens.lock().await.remove(&run_id);
                    budget.release(job_vcpu, job_memory);
                    continue;
                };
                info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");

                // Check idle pool for a reusable VM (same session + same profile).
                // Only attempt reuse when the per-job sandboxReuse flag is on.
                // The `reuse_result` tag is paired with `reuse_entry` so every
                // fresh-create path names the branch it came from — the server
                // persists it on the agent_runs row for observability.
                let reuse_enabled = context.feature_enabled(crate::types::feature_flags::SANDBOX_REUSE);
                let (reuse_entry, reuse_result): (Option<IdleEntry>, SandboxReuseResult) =
                    if !reuse_enabled {
                        (None, SandboxReuseResult::FeatureDisabled)
                    } else if let Some(session_id) = context.session_id() {
                        // Take the entry under the pool lock, then drop the
                        // lock before any awaits — the unpark HTTP call below
                        // must not block other take/park operations.
                        let taken = {
                            let mut pool = idle_pool.lock().await;
                            pool.take(session_id)
                        };
                        match taken {
                            Some(mut entry) if entry.profile_name == profile_name => {
                                // Deflate the balloon and respawn the reactive
                                // controller before handing the sandbox to the
                                // job. On failure, destroy the idle entry and
                                // fall through to a fresh create — the run
                                // budget reservation we made above stays in
                                // place to cover the new sandbox.
                                match entry.sandbox.unpark().await {
                                    Ok(()) => {
                                        info!(
                                            run_id = %run_id,
                                            session_id,
                                            "reusing idle VM for session"
                                        );
                                        // Idle entry already holds budget — release the new reservation.
                                        budget.release(job_vcpu, job_memory);
                                        (Some(entry), SandboxReuseResult::Reused)
                                    }
                                    Err(e) => {
                                        warn!(
                                            run_id = %run_id,
                                            session_id,
                                            error = %e,
                                            "unpark failed, destroying idle VM and falling through to fresh create"
                                        );
                                        let b = Arc::clone(&budget);
                                        destroy_tasks.spawn(destroy_idle_entry(entry, b));
                                        (None, SandboxReuseResult::UnparkFailed)
                                    }
                                }
                            }
                            Some(stale) => {
                                // Profile mismatch — destroy the stale VM.
                                info!(
                                    run_id = %run_id,
                                    session_id,
                                    old_profile = %stale.profile_name,
                                    new_profile = %profile_name,
                                    "idle VM profile mismatch, destroying"
                                );
                                let b = Arc::clone(&budget);
                                destroy_tasks.spawn(destroy_idle_entry(stale, b));
                                (None, SandboxReuseResult::ProfileMismatch)
                            }
                            None => {
                                info!(
                                    run_id = %run_id,
                                    session_id,
                                    "no idle VM found for session"
                                );
                                (None, SandboxReuseResult::PoolMiss)
                            }
                        }
                    } else {
                        (None, SandboxReuseResult::NoSessionId)
                    };

                // Determine sandbox_id after the reuse decision. On reuse,
                // the sandbox keeps its original identity; on a fresh create,
                // we allocate a new UUID that the executor will use when
                // constructing the SandboxConfig. This is the join key for
                // doctor (FC CWD basename) and kill (workspace dir).
                let sandbox_id = match &reuse_entry {
                    Some(entry) => entry.sandbox_id,
                    None => SandboxId::new_v4(),
                };
                status.add_run(run_id, sandbox_id).await;

                let job_profile = JobProfile {
                    profile_name: profile_name.clone(),
                    vcpu: job_vcpu,
                    memory_mb: job_memory,
                    restore_guest_state: *restore_guest_state,
                    factory: Arc::clone(factory),
                    cancel: job_cancel,
                };
                spawn_job(
                    context,
                    sandbox_id,
                    job_profile,
                    reuse_entry,
                    reuse_result,
                    &spawn_ctx,
                    &mut jobs,
                );
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
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
            // Reap completed destroy tasks
            Some(result) = destroy_tasks.join_next() => {
                if let Err(e) = result {
                    warn!(error = %e, "destroy task panicked");
                }
            }
            // Idle pool cleanup: evict expired VMs and update status
            _ = idle_cleanup.tick() => {
                let mut pool = idle_pool.lock().await;
                let expired = pool.evict_expired();
                for entry in &expired {
                    info!(
                        profile = %entry.profile_name,
                        "idle VM expired, destroying"
                    );
                }
                // Update status with current idle pool state
                let idle_vms = pool.held_snapshot();
                drop(pool);
                status.set_idle_info(idle_vms).await;
                for entry in expired {
                    let b = Arc::clone(&budget);
                    destroy_tasks.spawn(destroy_idle_entry(entry, b));
                }
            }
            // Heartbeat: report runner state to the server
            _ = heartbeat_tick.tick() => {
                send_heartbeat(&hb_ctx, current_mode).await;
            }
            // Immediate heartbeat after a VM is parked — eliminates the
            // up-to-10s blind spot for session affinity routing.
            _ = park_notify.notified() => {
                info!(source = "main", "park triggered immediate heartbeat");
                send_heartbeat(&hb_ctx, current_mode).await;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown — drain idle pool, release discovery resources, then drain running jobs
    // -----------------------------------------------------------------------

    // Drop the pinned discover future so it releases the discovery Mutex.
    // Without this, provider.shutdown() deadlocks trying to acquire the
    // same Mutex that the still-alive discover_fut holds.
    drop(discover_fut);

    // Drain idle pool first — these VMs hold budget reservations. This
    // also clears `idle_vms` in status.json so the final snapshot is
    // consistent with the empty pool.
    drain_idle_pool(&idle_pool, &budget, &status, "shutdown").await;

    provider.shutdown().await;

    // Send final heartbeat with Stopping so the server stops routing jobs
    // to this runner immediately, without waiting for TTL expiry.
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

    let remaining = jobs.len();
    if remaining > 0 {
        info!(remaining, "waiting for running jobs to finish");
        while !jobs.is_empty() {
            maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

            tokio::select! {
                result = jobs.join_next() => {
                    handle_job_result(result, &cancel_tokens).await;
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
    // Wait for any in-flight destroy tasks (from cleanup tick, profile
    // mismatch eviction, etc.) so their factory Arcs are dropped before
    // shutdown_factories calls Arc::try_unwrap.
    while let Some(result) = destroy_tasks.join_next().await {
        if let Err(e) = result {
            warn!(error = %e, "destroy task panicked during shutdown");
        }
    }
    if let Some(h) = mitm_retry.handle {
        h.abort();
    }
    if let Some(abort) = signal_handler_abort {
        abort.abort();
    }

    info!("shutting down factories");
    shutdown_factories(&mut factories, runtime.as_mut()).await;

    // Wait for pending usage reports to flush before stopping the proxy.
    // The addon writes in-flight flow and pending report counts to a file;
    // we poll until both reach zero so no usage data is lost on shutdown.
    info!("waiting for proxy usage reports to flush");
    let flushed =
        proxy::wait_usage_flush(&base_dir.join("mitm-addon"), proxy::USAGE_FLUSH_TIMEOUT).await;
    if flushed {
        info!("all usage reports flushed");
    } else {
        warn!("usage flush timed out, some reports may be lost");
    }

    // Stop proxy after all jobs have drained and factory is shut down.
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }

    // Stop the kmsg monitor and wait for the `dmesg -w` child process
    // to be killed and reaped.
    kmsg_handle.stop().await;
    dns_handle.stop().await;

    status.set_mode(RunnerMode::Stopped).await;
    info!("runner stopped");

    Ok(())
}

/// A sandbox factory shared across concurrent job executors.
///
/// Uses `Arc<Box<...>>` instead of `Arc<dyn ...>` because `Arc::try_unwrap`
/// requires a sized type — `dyn SandboxFactory` is unsized, but `Box<dyn
/// SandboxFactory>` is sized, allowing `try_unwrap` at shutdown.
type SharedFactory = Arc<Box<dyn SandboxFactory>>;

/// Per-job profile parameters resolved from the profile config.
struct JobProfile {
    profile_name: String,
    vcpu: u32,
    memory_mb: u32,
    restore_guest_state: bool,
    factory: SharedFactory,
    cancel: CancellationToken,
}

/// Shut down all factories, then release shared runtime resources.
async fn shutdown_factories(
    factories: &mut BTreeMap<String, (SharedFactory, bool)>,
    runtime: &mut dyn SandboxRuntime,
) {
    for (name, (factory, _)) in std::mem::take(factories) {
        match Arc::try_unwrap(factory) {
            Ok(mut f) => f.shutdown().await,
            Err(_) => warn!(profile = %name, "factory still referenced at shutdown"),
        }
    }
    // Clean up shared resources (netns pool, base loop cache).
    runtime.shutdown().await;
}

type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

/// Shared state passed to each spawned job task.
struct SpawnContext {
    provider: Arc<dyn JobProvider>,
    exec_config: Arc<ExecutorConfig>,
    budget: Arc<ResourceBudget>,
    idle_pool: SharedIdlePool,
    status: Arc<StatusTracker>,
    /// Snapshot of [`RunnerMode`] at spawn time. Each `jobs.spawn` captures
    /// this value, so the post-exec park decision uses the mode that was
    /// current **when the job was claimed**, not when it finished. Only
    /// jobs spawned in `Running` are eligible for parking.
    ///
    /// Consequence: a job spawned in `Running` that completes during
    /// `Draining` may park — the entry is cleaned up by the teardown
    /// drain, so this wastes work rather than leaking. On `Stopping` the
    /// per-job cancel token fires, taking the cancelled branch and skipping
    /// park entirely.
    mode: RunnerMode,
    /// Notifies the main loop to send an immediate heartbeat after parking a VM.
    /// This eliminates the up-to-10s blind spot where the server doesn't know
    /// which runner holds a newly-parked session.
    park_notify: Arc<tokio::sync::Notify>,
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has reserved
/// resources in the budget — this function spawns the executor, reports
/// completion via the provider, and releases the budget when done.
///
/// If `reuse_entry` is `Some`, the job reuses an existing idle sandbox.
/// Otherwise it creates a new one via the factory.
///
/// After execution, if the per-job `sandboxReuse` feature flag is enabled
/// and the job succeeded, the sandbox is parked in the idle pool instead
/// of being destroyed.
fn spawn_job(
    context: ExecutionContext,
    sandbox_id: SandboxId,
    job_profile: JobProfile,
    reuse_entry: Option<IdleEntry>,
    reuse_result: SandboxReuseResult,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<Option<RunId>>,
) {
    let run_id = context.run_id;
    let session_id = context.session_id().map(String::from);
    let reuse_enabled = context.feature_enabled(crate::types::feature_flags::SANDBOX_REUSE);
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let job_cancel = job_profile.cancel;
    let params = executor::JobParams {
        vcpu,
        memory_mb,
        restore_guest_state: job_profile.restore_guest_state,
    };

    let storage_fingerprints = context
        .storage_manifest
        .as_ref()
        .map(crate::idle_pool::StorageFingerprints::from_manifest)
        .unwrap_or_default();

    let provider = Arc::clone(&ctx.provider);
    let exec_config = Arc::clone(&ctx.exec_config);
    let budget = Arc::clone(&ctx.budget);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let park_notify = Arc::clone(&ctx.park_notify);
    let mode = ctx.mode;
    let factory_for_cleanup = Arc::clone(&factory);

    // Captured for the post-complete deferred work below: the panic-arm
    // empty `JobTelemetry` construction, the final `telemetry.flush()`, and
    // the mitm `upload_network_logs()` POST. `context` gets moved into the
    // inner executor task and `exec_config` with it, so we snapshot the
    // token and bump the Arc before spawning.
    let sandbox_token = context.sandbox_token.clone();
    let exec_config_for_deferred = Arc::clone(&exec_config);

    jobs.spawn(async move {
        // Inner spawn isolates panics: if execute_job panics, the outer task
        // still reports completion and releases budget.
        let cancel = job_cancel.clone();

        let inner = tokio::spawn(async move {
            if let Some(idle_entry) = reuse_entry {
                executor::execute_job_reuse(idle_entry, context, &exec_config, cancel).await
            } else {
                executor::execute_job(
                    &**factory,
                    context,
                    sandbox_id,
                    &exec_config,
                    &params,
                    cancel,
                )
                .await
            }
        });

        let (exit_code, err, sandbox, source_ip, guest_session_id, telemetry) = match inner.await {
            Ok((outcome, telemetry)) => {
                let err = if job_cancel.is_cancelled() {
                    Some("cancelled by user".to_string())
                } else {
                    outcome.error
                };
                (
                    outcome.exit_code,
                    err,
                    outcome.sandbox,
                    outcome.source_ip,
                    outcome.guest_session_id,
                    telemetry,
                )
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "executor task panicked");
                // Panic lost the in-flight telemetry buffer; substitute an
                // empty collector so the post-complete flush path stays
                // unconditional. `flush` early-returns on empty pending_ops.
                let empty_telemetry = JobTelemetry::new(
                    exec_config_for_deferred.http.clone(),
                    run_id,
                    sandbox_token.clone(),
                );
                (
                    1,
                    Some(format!("internal error: {e}")),
                    None,
                    String::new(),
                    None,
                    empty_telemetry,
                )
            }
        };

        // Decide: park sandbox for reuse, or stop + destroy.
        let parked = if let Some(mut sandbox) = sandbox {
            let parkable_session = if reuse_enabled
                && exit_code == 0
                && !job_cancel.is_cancelled()
                && mode == RunnerMode::Running
            {
                // Prefer context session_id (from resume_session), fall back to
                // guest-reported session ID (first run — CLI generated it).
                session_id.as_deref().or(guest_session_id.as_deref())
            } else {
                None
            };

            if let Some(session_id) = parkable_session {
                // Inflate the guest balloon BEFORE acquiring the pool lock —
                // the HTTP call to Firecracker can take milliseconds, and we
                // must not block other take/park operations on it.
                if let Err(e) = sandbox.park().await {
                    warn!(
                        run_id = %run_id,
                        session_id,
                        error = %e,
                        "sandbox park failed, destroying instead of parking"
                    );
                    stop_and_destroy_sandbox(sandbox, &**factory_for_cleanup).await;
                    false
                } else {
                    let mut pool = idle_pool.lock().await;
                    let idle_timeout = pool.default_timeout();
                    let entry = IdleEntry {
                        sandbox,
                        factory: factory_for_cleanup,
                        session_id: session_id.to_string(),
                        sandbox_id,
                        profile_name,
                        vcpu,
                        memory_mb,
                        source_ip,
                        parked_at: std::time::Instant::now(),
                        idle_timeout,
                        storage_fingerprints,
                    };
                    match pool.park(session_id.to_string(), entry) {
                        ParkResult::Parked => {
                            info!(run_id = %run_id, session_id, "VM parked for reuse");
                            // Push fresh idle state to status.json BEFORE
                            // `status.remove_run` (below) clears the run_id
                            // from active_runs. Without this, doctor would
                            // briefly see the FC as unknown (neither active
                            // nor idle) until the next idle_cleanup tick
                            // (~10s), producing transient false-positive
                            // FirecrackerNotInStatus warnings.
                            let idle_vms = pool.held_snapshot();
                            drop(pool);
                            status.set_idle_info(idle_vms).await;
                            park_notify.notify_one();
                            true
                        }
                        ParkResult::Evicted(evicted) => {
                            info!(run_id = %run_id, session_id, "VM parked, evicting previous");
                            let idle_vms = pool.held_snapshot();
                            drop(pool);
                            status.set_idle_info(idle_vms).await;
                            // Notify immediately — session is already in pool.
                            // Don't wait for stop_and_destroy which can be slow.
                            park_notify.notify_one();
                            let evict_vcpu = evicted.vcpu;
                            let evict_mem = evicted.memory_mb;
                            // The evicted entry was park()ed when it entered the
                            // pool; destroying a parked sandbox is safe — Drop
                            // aborts any leftover handles and the FC process is
                            // killed regardless of balloon state.
                            evicted.stop_and_destroy().await;
                            budget.release(evict_vcpu, evict_mem);
                            true
                        }
                        ParkResult::PoolFull(rejected) => {
                            info!(run_id = %run_id, session_id, "idle pool full, destroying VM");
                            drop(pool);
                            // Pool unchanged (park rejected) — no status
                            // update needed. The rejected sandbox was just
                            // park()ed above; destroying a parked sandbox is
                            // safe — see Evicted arm for rationale.
                            rejected.stop_and_destroy().await;
                            false
                        }
                    }
                }
            } else {
                // No parkable session — stop + destroy
                stop_and_destroy_sandbox(sandbox, &**factory_for_cleanup).await;
                false
            }
        } else {
            false
        };

        // Structural guarantee: claim (in provider) is always paired with complete.
        provider
            .complete(
                run_id,
                exit_code,
                err.as_deref(),
                Some(sandbox_id),
                Some(reuse_result),
            )
            .await;
        status.remove_run(run_id).await;

        // Release budget only if sandbox was NOT parked (parked VMs hold their budget).
        if !parked {
            budget.release(vcpu, memory_mb);
        }

        // Best-effort telemetry, deferred past `provider.complete` so the
        // user-visible run-complete signal isn't blocked on these uploads.
        // They're still awaited (not spawned) so the surrounding `jobs`
        // JoinSet drains them on graceful shutdown — no data loss on SIGTERM.
        // Flush and upload run concurrently — they share no state and both
        // target the telemetry endpoint, so parallelism shortens the drain
        // window (~383 ms + ~1.6 s → ~1.6 s).
        let network_log_path = exec_config_for_deferred.log_paths.network_log(run_id);
        tokio::join!(
            telemetry.flush(),
            network_logs::upload_network_logs(
                &exec_config_for_deferred.http,
                run_id,
                &sandbox_token,
                &network_log_path,
            ),
        );

        Some(run_id)
    });
}

/// Drain the idle pool synchronously: destroy every entry and release each
/// one's budget. Called from both the Draining arm (soft-drain entry) and
/// teardown — both need the same sequence, and teardown also wants the
/// `status.json` `idle_vms` list cleared so the final snapshot is
/// consistent with the empty pool.
///
/// `context` is logged alongside the destroyed count for operator clarity
/// (e.g. "draining" vs "shutdown").
async fn drain_idle_pool(
    idle_pool: &SharedIdlePool,
    budget: &ResourceBudget,
    status: &StatusTracker,
    context: &'static str,
) {
    let entries = idle_pool.lock().await.drain();
    if entries.is_empty() {
        return;
    }
    info!(count = entries.len(), context, "destroying idle VMs");
    for entry in entries {
        let vcpu = entry.vcpu;
        let memory_mb = entry.memory_mb;
        entry.stop_and_destroy().await;
        budget.release(vcpu, memory_mb);
    }
    status.set_idle_info(Vec::new()).await;
}

/// Destroy an idle sandbox entry and release its budget.
async fn destroy_idle_entry(entry: IdleEntry, budget: Arc<ResourceBudget>) {
    let vcpu = entry.vcpu;
    let memory_mb = entry.memory_mb;
    entry.stop_and_destroy().await;
    budget.release(vcpu, memory_mb);
}

/// Stop a sandbox and destroy it via its factory.
async fn stop_and_destroy_sandbox(mut sandbox: Box<dyn Sandbox>, factory: &dyn SandboxFactory) {
    if let Err(e) = sandbox.stop().await {
        warn!(error = %e, "sandbox stop failed");
    }
    factory.destroy(sandbox).await;
}

/// Handle a completed job from the JoinSet, cleaning up cancel tokens.
async fn handle_job_result(
    result: Option<Result<Option<RunId>, tokio::task::JoinError>>,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
) {
    match result {
        Some(Ok(Some(run_id))) => {
            cancel_tokens.lock().await.remove(&run_id);
        }
        Some(Err(e)) => {
            error!(error = %e, "job task panicked");
        }
        _ => {}
    }
}

/// Pre-registered signal streams.
///
/// Tokio's `signal()` installs the process-wide `sigaction` handler on its
/// first call per signal kind; before that call, the default disposition
/// (Term for all four of these) applies. If a drain SIGUSR1 arrives during
/// startup (e.g. `service install` immediately followed by `service drain`
/// while the runner is still warming factories), the default action kills
/// the process and systemd restarts the unit with no one to drain it —
/// the new PID stays `Running` forever. See issue #10416.
///
/// Registering all four streams at the top of [`run_start`] before any
/// slow work (config load, runtime/factory boot) closes the race: the
/// sigaction handler is in place and the listener exists, so signals
/// arriving at any point after registration are queued in the listener's
/// watch channel and observed by [`SignalController`] as soon as its task
/// is spawned.
struct EarlySignals {
    sigterm: tokio::signal::unix::Signal,
    sigint: tokio::signal::unix::Signal,
    sigusr1: tokio::signal::unix::Signal,
    sigusr2: tokio::signal::unix::Signal,
}

impl EarlySignals {
    /// Register the four lifecycle signals (SIGTERM/SIGINT/SIGUSR1/SIGUSR2)
    /// so they don't fall to their default Term disposition during startup.
    ///
    /// Each `signal()` both installs the process-wide `sigaction` handler
    /// (idempotent via `OnceCell`) and subscribes a fresh watch receiver.
    /// Bind them via `let` rather than a struct literal so that if a later
    /// call fails with `?`, the already-subscribed earlier receivers are
    /// dropped (and unsubscribed) on the error path — obvious at a glance.
    fn register() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        let sigterm = signal(SignalKind::terminate())?;
        let sigint = signal(SignalKind::interrupt())?;
        let sigusr1 = signal(SignalKind::user_defined1())?;
        let sigusr2 = signal(SignalKind::user_defined2())?;
        Ok(Self {
            sigterm,
            sigint,
            sigusr1,
            sigusr2,
        })
    }
}

/// Signal-driven mode channel shared between the signal handler task and
/// the main run loop.
///
/// The `RunnerMode` enum is the single source of truth for runner lifecycle
/// state — `mode_tx` has two writers (the handler for external signals,
/// and the main loop for the internal Draining → Stopping transition when
/// `jobs.is_empty()`).
pub(crate) struct SignalController {
    pub mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    /// Abort handle for the spawned signal-handler task. `None` for test
    /// overrides where no task was spawned. Teardown calls `.abort()` to
    /// reap the task symmetrically with `mitm_retry.handle.abort()` — the
    /// handler otherwise would run until runtime drop, which is safe for
    /// the runner binary but leaks the task when `run()` is embedded in a
    /// longer-lived host runtime.
    pub handler_abort: Option<tokio::task::AbortHandle>,
}

impl SignalController {
    /// Spawn the signal-handler task and return a controller handle.
    ///
    /// Signal semantics:
    /// - **SIGUSR1** (drain): from `Running`, send `Draining` (soft,
    ///   resumable). Ignored from any other state.
    /// - **SIGUSR2** (resume): from `Draining`, send `Running` (resume normal
    ///   discovery). Ignored from `Running` / `Stopping` / `Stopped`.
    /// - **SIGTERM / SIGINT** (hard): send `Stopping`, cancel every in-flight
    ///   job's token, cancel the discovery token. Bypasses the soft drain
    ///   so `systemctl stop` exits promptly rather than waiting up to
    ///   `JOB_TIMEOUT = 2h` for jobs to finish naturally.
    ///
    /// ## Race handling
    ///
    /// `handle_stopping_signal` sends Stopping **before** locking
    /// `cancel_tokens`. This ordering lets the main loop close the TOCTOU
    /// window where a new job is claimed between the handler's iteration
    /// and its own token insert: the main loop re-reads `mode_rx` after
    /// insert and sees Stopping via watch's write/read fence.
    ///
    /// ## Lifetime
    ///
    /// The spawned task loops forever and is implicitly cancelled when the
    /// tokio runtime is dropped. Its `JoinHandle` is discarded — panics in
    /// the handler will be logged by tokio but not surfaced.
    fn spawn(
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        signals: EarlySignals,
    ) -> Self {
        let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let tx_for_task = mode_tx.clone();
        let EarlySignals {
            mut sigterm,
            mut sigint,
            mut sigusr1,
            mut sigusr2,
        } = signals;
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sigterm.recv() => {
                        handle_stopping_signal("SIGTERM", &cancel, &cancel_tokens, &tx_for_task).await;
                    }
                    _ = sigint.recv() => {
                        handle_stopping_signal("SIGINT", &cancel, &cancel_tokens, &tx_for_task).await;
                    }
                    _ = sigusr1.recv() => {
                        handle_drain_signal(&tx_for_task);
                    }
                    _ = sigusr2.recv() => {
                        handle_resume_signal(&tx_for_task);
                    }
                }
            }
        });
        Self {
            mode_rx,
            mode_tx,
            handler_abort: Some(handle.abort_handle()),
        }
    }
}

fn handle_drain_signal(mode_tx: &tokio::sync::watch::Sender<RunnerMode>) {
    let current = *mode_tx.borrow();
    if current != RunnerMode::Running {
        warn!(mode = ?current, "SIGUSR1 ignored — only valid from Running");
        return;
    }
    info!("received SIGUSR1, entering Draining (soft drain)");
    let _ = mode_tx.send(RunnerMode::Draining);
}

fn handle_resume_signal(mode_tx: &tokio::sync::watch::Sender<RunnerMode>) {
    let current = *mode_tx.borrow();
    if current != RunnerMode::Draining {
        warn!(mode = ?current, "SIGUSR2 ignored — only valid from Draining");
        return;
    }
    info!("received SIGUSR2, resuming to Running");
    let _ = mode_tx.send(RunnerMode::Running);
}

async fn handle_stopping_signal(
    name: &str,
    cancel: &CancellationToken,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    mode_tx: &tokio::sync::watch::Sender<RunnerMode>,
) {
    if *mode_tx.borrow() == RunnerMode::Stopping {
        warn!(signal = name, "already Stopping, ignoring repeat");
        return;
    }
    info!(signal = name, "initiating hard shutdown");
    // Send Stopping *before* locking cancel_tokens so that the main loop's
    // post-insert `mode_rx.borrow()` check catches any job claimed after
    // our iteration but before send would otherwise publish the state.
    let _ = mode_tx.send(RunnerMode::Stopping);
    let tokens = cancel_tokens.lock().await;
    let count = tokens.len();
    for (run_id, token) in tokens.iter() {
        info!(run_id = %run_id, "cancelling active job for hard shutdown");
        token.cancel();
    }
    drop(tokens);
    info!(active_jobs = count, "dispatched per-job cancellations");
    cancel.cancel();
}

/// Spawn a background mitm restart task when the backoff timer fires
/// and no restart is already in flight.
async fn maybe_spawn_mitm_restart(
    mitm: &mut proxy::MitmProxy,
    crash_rx: &mut tokio::sync::mpsc::Receiver<()>,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    if !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    // Drain any stale crash notifications from the previous process to prevent
    // a spurious restart cycle after this one completes.
    while crash_rx.try_recv().is_ok() {}
    let params = mitm.begin_restart().await;
    retry.handle = Some(tokio::spawn(params.spawn()));
}

/// Handle the result of a background mitm restart task.
fn handle_mitm_restart_result(
    result: Result<tokio::process::Child, String>,
    mitm: &mut proxy::MitmProxy,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    match result {
        Ok(child) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "mitmproxy restarted after failures"
                );
            } else {
                info!("mitmproxy restarted");
            }
            mitm.complete_restart(child);
            retry.on_success();
        }
        Err(e) => {
            // Capture before on_failure() — matches the delay actually scheduled.
            let next_secs = retry.backoff().as_secs();
            if !retry.on_failure() {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    "mitmproxy restart abandoned after too many failures"
                );
                return;
            }
            if retry.consecutive_failures() >= 5 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failing persistently"
                );
            } else {
                warn!(
                    error = %e,
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failed"
                );
            }
        }
    }
}

/// References needed to collect and send a heartbeat.
/// Avoids passing 8+ arguments through `send_heartbeat`.
struct HeartbeatContext<'a> {
    idle_pool: &'a SharedIdlePool,
    runner_id: &'a str,
    name: &'a str,
    group: &'a str,
    profiles: &'a BTreeMap<String, ProfileConfig>,
    budget: &'a ResourceBudget,
    provider: &'a dyn JobProvider,
}

/// Collect current runner state, update the provider's held-sessions cache,
/// and send a heartbeat to the server.
async fn send_heartbeat(hb: &HeartbeatContext<'_>, mode: RunnerMode) {
    let pool = hb.idle_pool.lock().await;
    let state = collect_heartbeat_state(
        hb.runner_id,
        hb.name,
        hb.group,
        hb.profiles,
        hb.budget,
        &pool,
        mode,
    );
    drop(pool);
    info!(
        mode = ?mode,
        running = state.running_count,
        sessions = state.held_sessions.len(),
        "heartbeat"
    );
    debug!(held_sessions = ?state.held_sessions);
    hb.provider
        .set_held_sessions(state.held_sessions.clone())
        .await;
    hb.provider.heartbeat(&state).await;
}

/// Collect current runner state for heartbeat reporting.
fn collect_heartbeat_state(
    runner_id: &str,
    name: &str,
    group: &str,
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
    idle_pool: &crate::idle_pool::IdlePool,
    mode: RunnerMode,
) -> HeartbeatState {
    // Stopped is set only by `status.set_mode(Stopped)` immediately before
    // `run()` returns, after the last heartbeat has been sent. If a caller
    // reaches here with Stopped it means a new code path was added that
    // heartbeats post-teardown, which breaks the contract that the server
    // never sees mode=stopped on the wire. Debug-only: release still falls
    // through to the defensive "stopping" mapping below.
    debug_assert_ne!(
        mode,
        RunnerMode::Stopped,
        "Stopped is never live-heartbeated",
    );
    let (allocated_vcpu, allocated_memory_mb, budget_running) = budget.allocated();
    // budget.allocated() includes parked (idle) VMs that hold their budget.
    // Report only actively running jobs so the scheduler sees real capacity.
    let idle_count = idle_pool.len();
    let running_count = budget_running.saturating_sub(idle_count);
    HeartbeatState {
        runner_id: runner_id.to_string(),
        runner_name: name.to_string(),
        group: group.to_string(),
        profiles: profiles.keys().cloned().collect(),
        total_vcpu: budget.effective_vcpu(),
        total_memory_mb: budget.effective_memory_mb(),
        max_concurrent: budget.max_concurrent(),
        allocated_vcpu,
        allocated_memory_mb,
        running_count,
        held_sessions: idle_pool.held_sessions(),
        mode: match mode {
            RunnerMode::Running => "running".to_string(),
            RunnerMode::Draining => "draining".to_string(),
            // Stopped caught by the debug_assert above; release falls here.
            RunnerMode::Stopping | RunnerMode::Stopped => "stopping".to_string(),
        },
    }
}

/// Load runner ID from `{base_dir}/runner_id`, or generate a new UUID and persist it.
async fn load_or_generate_runner_id(base_dir: &std::path::Path) -> RunnerResult<String> {
    let path = base_dir.join("runner_id");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let id = contents.trim().to_string();
            Uuid::parse_str(&id).map_err(|e| {
                RunnerError::Config(format!("invalid runner_id in {}: {e}", path.display()))
            })?;
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = Uuid::new_v4().to_string();
            tokio::fs::write(&path, &id).await.map_err(|e| {
                RunnerError::Config(format!("write runner_id to {}: {e}", path.display()))
            })?;
            info!(runner_id = %id, "generated new runner ID");
            Ok(id)
        }
        Err(e) => Err(RunnerError::Config(format!(
            "read runner_id from {}: {e}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a MitmProxy for testing (does not start mitmdump).
    async fn test_mitm() -> (
        proxy::MitmProxy,
        tokio::sync::mpsc::Receiver<()>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let (mitm, rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
            mitmdump_bin: PathBuf::from("true"),
            ca_dir: dir.path().to_path_buf(),
            addon_dir: dir.path().join("addon"),
            registry_path: dir.path().join("registry.json"),
            registry_lock_path: dir.path().join("registry.lock"),
            api_url: None,
        })
        .await
        .unwrap();
        (mitm, rx, dir)
    }

    #[tokio::test]
    async fn mitm_restart_success_resets_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = Duration::from_secs(16);
        retry.consecutive_failures = 5;

        let child = tokio::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        handle_mitm_restart_result(Ok(child), &mut mitm, &mut retry);

        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL);
        assert_eq!(retry.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn mitm_restart_failure_schedules_retry_with_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 1);
        assert!(retry.restart_at.is_some());
        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn mitm_restart_backoff_caps_at_max() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 10;

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.backoff, MITM_BACKOFF_MAX);
        assert!(retry.restart_at.is_some());
    }

    #[tokio::test]
    async fn mitm_restart_circuit_breaker_stops_retrying() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 19;

        handle_mitm_restart_result(Err("binary missing".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 20);
        assert!(
            retry.restart_at.is_none(),
            "circuit breaker should prevent further retries"
        );
    }

    #[tokio::test]
    async fn runner_id_generate_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert!(Uuid::parse_str(&id1).is_ok());

        // Second call reads the same ID
        let id2 = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id1, id2);
    }

    #[tokio::test]
    async fn runner_id_reads_existing() {
        let dir = tempfile::tempdir().unwrap();
        let expected = Uuid::new_v4().to_string();
        tokio::fs::write(dir.path().join("runner_id"), &expected)
            .await
            .unwrap();
        let id = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id, expected);
    }

    #[tokio::test]
    async fn runner_id_rejects_invalid() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("runner_id"), "not-a-uuid")
            .await
            .unwrap();
        let result = load_or_generate_runner_id(dir.path()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runner_id_trims_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let expected = Uuid::new_v4().to_string();
        // Write with trailing newline (common with echo/editors)
        tokio::fs::write(dir.path().join("runner_id"), format!("  {expected}\n"))
            .await
            .unwrap();
        let id = load_or_generate_runner_id(dir.path()).await.unwrap();
        assert_eq!(id, expected);
    }

    #[tokio::test]
    async fn runner_id_rejects_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("runner_id"), "")
            .await
            .unwrap();
        let result = load_or_generate_runner_id(dir.path()).await;
        assert!(result.is_err());
    }

    /// Regression test for issue #10416: SIGUSR1 arriving between
    /// `EarlySignals::register()` and `SignalController::spawn` must still
    /// drive the mode transition. Previously the handler was registered
    /// inside the spawned task, so signals delivered during the startup
    /// window hit the default Term disposition and killed the process.
    ///
    /// Timing: raising SIGUSR1 before `spawn()` is deterministic in program
    /// order, and the outer `timeout(2s)` absorbs the
    /// `kernel → sigaction → pipe → driver → watch → recv` propagation
    /// regardless of scheduling — no artificial sleep is needed.
    ///
    /// This test raises SIGUSR1 process-wide. It is safe only because no
    /// other test subscribes to SIGUSR1 — all other tests use
    /// `SignalSource::Override` and never call `signal()`. If another
    /// signal-raising test is added, serialize them (e.g. with a
    /// `Mutex` shared via `OnceLock`) to avoid cross-talk.
    #[tokio::test]
    async fn signal_buffered_before_spawn_is_delivered() {
        let signals = EarlySignals::register().expect("register");

        nix::sys::signal::raise(nix::sys::signal::Signal::SIGUSR1).expect("raise");

        let controller = SignalController::spawn(
            CancellationToken::new(),
            Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            signals,
        );
        let mut mode_rx = controller.mode_rx;

        tokio::time::timeout(Duration::from_secs(2), mode_rx.changed())
            .await
            .expect("buffered SIGUSR1 should drive mode within 2s")
            .expect("mode channel closed");
        assert_eq!(*mode_rx.borrow(), RunnerMode::Draining);

        // Abort so the task releases its Signal stream subscriptions
        // and does not linger to consume signals raised by later tests.
        if let Some(abort) = controller.handler_abort {
            abort.abort();
        }
    }

    // -----------------------------------------------------------------------
    // collect_heartbeat_state: running_count excludes idle VMs
    // -----------------------------------------------------------------------

    use crate::idle_pool::{IdleEntry, IdlePool, IdlePoolConfig, ParkResult};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};

    fn test_profiles() -> BTreeMap<String, config::ProfileConfig> {
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

    fn make_idle_entry(session_id: &str) -> IdleEntry {
        IdleEntry {
            sandbox: Box::new(MockSandbox::new("test")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 4096,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        }
    }

    #[test]
    fn heartbeat_running_count_no_idle() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        budget.try_reserve(2, 4096);
        budget.try_reserve(2, 4096);
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        // 2 running jobs, 0 idle → running_count = 2
        assert_eq!(state.running_count, 2);
    }

    #[test]
    fn heartbeat_running_count_excludes_idle() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        // 3 budget reservations: 2 running + 1 will be parked
        budget.try_reserve(2, 4096);
        budget.try_reserve(2, 4096);
        budget.try_reserve(2, 4096);
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        // Park 1 VM — budget still held, but pool.len() = 1
        assert!(matches!(
            pool.park("sess-1".into(), make_idle_entry("sess-1")),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        // budget says 3, idle pool has 1 → running_count = 2
        assert_eq!(state.running_count, 2);
        assert_eq!(state.held_sessions, vec!["sess-1"]);
    }

    #[test]
    fn heartbeat_running_count_all_idle() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        budget.try_reserve(2, 4096);
        budget.try_reserve(2, 4096);
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let _ = pool.park("sess-1".into(), make_idle_entry("sess-1"));
        let _ = pool.park("sess-2".into(), make_idle_entry("sess-2"));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        // budget says 2, idle pool has 2 → running_count = 0
        assert_eq!(state.running_count, 0);
    }

    #[test]
    fn heartbeat_running_count_saturates_on_transient_inconsistency() {
        // Simulate transient state: budget released before idle pool updated
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        // budget_running = 0 but pool has 1 entry (inconsistent)
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let _ = pool.park("sess-1".into(), make_idle_entry("sess-1"));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        // saturating_sub prevents underflow: 0 - 1 → 0
        assert_eq!(state.running_count, 0);
    }

    // =======================================================================
    // Main loop integration tests
    // =======================================================================

    use crate::provider::mock::{MockJobProvider, MockProviderHandle};
    use sandbox_mock::MockSandboxRuntime;

    /// Everything a test needs to drive the main loop.
    struct MockRunEnv {
        handle: MockProviderHandle,
        provider: Arc<MockJobProvider>,
        idle_pool: SharedIdlePool,
        mode_tx: tokio::sync::watch::Sender<RunnerMode>,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        cancel: CancellationToken,
        _temp_dir: tempfile::TempDir,
    }

    impl MockRunEnv {
        /// Simulate SIGUSR1 by driving the real `handle_drain_signal` so
        /// tests exercise the same state-guard path production does
        /// (ignored unless current mode is Running).
        fn drain(&self) {
            handle_drain_signal(&self.mode_tx);
        }

        /// Simulate SIGUSR2 via the real `handle_resume_signal` — only
        /// transitions when current mode is Draining.
        fn resume(&self) {
            handle_resume_signal(&self.mode_tx);
        }

        /// Simulate SIGTERM by driving the real `handle_stopping_signal`.
        /// Keeps the test path in sync with production.
        async fn trigger_stopping(&self) {
            handle_stopping_signal("TEST", &self.cancel, &self.cancel_tokens, &self.mode_tx).await;
        }
    }

    /// Assemble a complete `RunConfig` with all mock/noop dependencies.
    fn mock_run_config(
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
    fn mock_run_config_with_delay(
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
    fn mock_run_config_with_api_url(
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
            Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                default_timeout: Duration::from_secs(300),
                max_idle: 10,
            })));

        let config = RunConfig {
            id: "test-runner".into(),
            name: "test".into(),
            group: "test-group".into(),
            profiles,
            runtime,
            home,
            budget: Arc::new(ResourceBudget::new(
                budget_vcpu,
                budget_memory_mb,
                1.0,
                max_concurrent,
            )),
            idle_pool: Arc::clone(&idle_pool),
            status: Arc::new(StatusTracker::new(
                temp_dir.path().join("status.json"),
                max_concurrent,
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
                ip_log_map: kmsg_log::new_ip_log_map(),
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
            signal_source: SignalSource::Override(SignalController {
                mode_rx,
                mode_tx: mode_tx.clone(),
                handler_abort: None,
            }),
        };

        let env = MockRunEnv {
            handle,
            provider: provider_ref,
            idle_pool,
            mode_tx,
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

    fn minimal_context(run_id: RunId) -> crate::types::ExecutionContext {
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
            api_start_time: None,
            user_timezone: None,
            memory_name: None,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: None,
            feature_flags: None,
            billable_firewalls: vec![],
        }
    }

    /// Push a job to the mock provider and pre-configure its claim result.
    fn push_job(
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
    async fn shutdown(env: &MockRunEnv, run_handle: tokio::task::JoinHandle<RunnerResult<()>>) {
        let _ = env.mode_tx.send(RunnerMode::Draining);
        env.cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(10), run_handle)
            .await
            .expect("run should finish within 10s")
            .expect("task should not panic");
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // Test 1: Normal discover → claim → execute → complete
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn main_loop_discover_claim_execute_complete() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        let c = completion.unwrap();
        assert_eq!(c.exit_code, 0);
        assert!(c.error.is_none());

        shutdown(&env, run_handle).await;
    }

    /// Regression guard: the post-complete deferred network-log upload (moved
    /// out of `post_job_cleanup` by #9828) must still reach the telemetry
    /// endpoint, AND the drain shutdown must actually block on it — catching a
    /// `tokio::spawn` fire-and-forget refactor that would silently lose the
    /// upload on runtime drop.
    ///
    /// The mock responds with a 400 ms delay. Since the job completes almost
    /// immediately under `MockSandboxRuntime`, `shutdown()` is invoked while
    /// the deferred `tokio::join!(flush, upload)` is still in-flight, so a
    /// well-behaved drain returns AFTER the mock delay elapses. A detached
    /// upload would let shutdown return immediately — the elapsed-time
    /// assertion below is what catches that.
    #[tokio::test]
    async fn deferred_network_log_upload_drains_on_graceful_shutdown() {
        use httpmock::prelude::*;

        const MOCK_DELAY: Duration = Duration::from_millis(400);

        let server = MockServer::start_async().await;
        let telemetry_mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/api/webhooks/agent/telemetry");
                then.delay(MOCK_DELAY)
                    .status(200)
                    .header("content-type", "application/json")
                    .body(r#"{"success":true,"id":"ok"}"#);
            })
            .await;

        let (config, env) =
            mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());

        // Seed a network log file so `upload_network_logs` has a payload to POST
        // (otherwise it early-returns on NotFound and the assertion below would
        // measure nothing).
        let run_id = RunId::new_v4();
        let network_log_path = config.exec_config.log_paths.network_log(run_id);
        std::fs::create_dir_all(network_log_path.parent().unwrap()).unwrap();
        std::fs::write(
            &network_log_path,
            r#"{"timestamp":"2026-01-01T00:00:00","action":"ALLOW","host":"example.com","method":"GET","url":"https://example.com/","status":200}"#,
        )
        .unwrap();

        let run_handle = tokio::spawn(run(config));
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");

        // Drain shutdown — must block on each `spawn_job` closure's deferred
        // `tokio::join!(flush, upload)` via the outer `jobs` JoinSet.
        let shutdown_start = tokio::time::Instant::now();
        shutdown(&env, run_handle).await;
        let shutdown_elapsed = shutdown_start.elapsed();

        // At least one POST: the mitm network-log upload (and likely a second
        // for sandbox-op telemetry like `vm_create`). The endpoint must have
        // been hit — a fire-and-forget refactor that dropped the await on
        // runtime shutdown would fail this.
        assert!(
            telemetry_mock.calls_async().await >= 1,
            "telemetry endpoint should receive deferred post-complete upload"
        );

        // Stronger invariant: drain must actually WAIT for the deferred work.
        // With a 400 ms mock delay, a well-behaved drain takes ≥ the delay;
        // a detached (fire-and-forget) upload would let shutdown return in
        // tens of ms, dropping the in-flight request on runtime teardown.
        assert!(
            shutdown_elapsed >= MOCK_DELAY - Duration::from_millis(50),
            "drain must block on deferred upload (≥{MOCK_DELAY:?}); took only {shutdown_elapsed:?}",
        );
    }

    // -----------------------------------------------------------------------
    // Test 2: Discover survives heartbeat ticks (regression #8783)
    //
    // ApiProvider's discover() has an internal poll timer (30s) that must
    // survive heartbeat ticks (10s). Without pinning, `select!` cancels
    // and recreates discover() each tick, restarting the timer from scratch.
    //
    // We use poll_delay=20s to simulate this: if the future is pinned, the
    // delay completes at t=20s and the job is discovered. If not pinned,
    // heartbeat at t=10s restarts the delay → it won't complete until t=30s.
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn discover_survives_heartbeat_ticks() {
        let (config, env) = mock_run_config_with_delay(
            test_profiles(),
            8,
            32768,
            4,
            Duration::from_secs(20), // poll delay: 20s
        );
        let run_handle = tokio::spawn(run(config));

        // Push job immediately — it's in the channel, waiting for
        // discover to finish its poll delay and read it.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        // Advance past the 20s poll delay. Heartbeat fires at 10s but
        // must NOT restart the delay (because discover_fut is pinned).
        tokio::time::sleep(Duration::from_secs(25)).await;

        // Heartbeat should have fired during the wait.
        assert!(
            env.handle.heartbeat_count() > 0,
            "heartbeat should fire while discover poll delay is running"
        );

        // Job should have been discovered and completed.
        // If discover was cancelled and recreated at t=10s, the 20s delay
        // restarts → at t=25s only 15s of the second delay has elapsed →
        // job not discovered yet → this assertion fails.
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await;
        assert!(
            completion.is_some(),
            "job should complete — discover must survive heartbeat ticks (regression #8783)"
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 3: Shutdown completes without deadlock (regression #8898)
    //
    // Uses REAL time (not paused) because a Mutex deadlock blocks the
    // tokio runtime — paused time can't advance past a non-timer await.
    //
    // Only sends Draining (does NOT cancel the token). This forces the
    // worst-case race: mode_rx.changed() wins the select!, loop breaks
    // at the top-of-loop check, and discover_fut is never polled again.
    // The explicit `drop(discover_fut)` releases the Mutex so shutdown()
    // can proceed. Without that drop, shutdown() deadlocks on the Mutex.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn shutdown_completes_without_deadlock() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Let the main loop start and enter select!.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Only send Draining — do NOT cancel. The Draining arm sees
        // `jobs.is_empty()` immediately (no active jobs), breaks to
        // teardown, and `drop(discover_fut)` releases the Mutex before
        // `provider.shutdown()`. Without that drop → deadlock (regression #8898).
        env.drain();

        match tokio::time::timeout(Duration::from_secs(2), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => {
                panic!("deadlock detected: run() did not finish within 2s (regression #8898)")
            }
        }
    }

    // -----------------------------------------------------------------------
    // Draining / resume / hard-shutdown state machine
    // -----------------------------------------------------------------------

    /// SIGUSR1 → SIGUSR2 round-trip. While draining, the runner keeps the
    /// in-flight job alive and, on resume, returns to claiming new jobs.
    #[tokio::test]
    async fn drain_then_resume_keeps_jobs_running() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            Arc::clone(&gate),
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let run_handle = tokio::spawn(run(config));

        // Claim a job and let it reach the gated wait.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
        let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

        // Enter Draining. The job keeps running; no cancellation is fired.
        env.drain();
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Resume. Job is still alive in the executor.
        env.resume();
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Release the gated job so it completes normally.
        gate.notify_one();
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete after resume");
        let c = completion.unwrap();
        assert_eq!(c.exit_code, 0, "job ran to normal completion");
        assert!(c.error.is_none(), "no cancellation error");

        // Runner is back in Running — a second job is claimed (cancel_token
        // inserted). Don't wait for completion here; the shared wait_exit_gate
        // would also block this job's exit.
        let run_id_2 = RunId::new_v4();
        push_job(
            &env,
            run_id_2,
            "vm0/default",
            Some(minimal_context(run_id_2)),
        );
        let _token_2 =
            wait_cancel_token(&env.cancel_tokens, run_id_2, Duration::from_secs(5)).await;

        // Tear down hard — the shared gate would otherwise block the
        // second job's natural completion during Draining.
        env.trigger_stopping().await;
        let result = tokio::time::timeout(Duration::from_secs(5), run_handle)
            .await
            .expect("run should exit within 5s after hard shutdown")
            .expect("task should not panic");
        assert!(result.is_ok());
    }

    /// With no active jobs, SIGUSR1 transitions straight through Draining
    /// and exits within a few hundred ms.
    #[tokio::test]
    async fn drain_without_active_jobs_exits_promptly() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        tokio::time::sleep(Duration::from_millis(50)).await;
        env.drain();

        match tokio::time::timeout(Duration::from_secs(2), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("drain with no active jobs should exit within 2s"),
        }
    }

    /// SIGUSR2 on an already-Running runner is a no-op: it does not disturb
    /// normal discovery.
    #[tokio::test(start_paused = true)]
    async fn resume_on_running_is_noop() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // SIGUSR2 while already Running — state guard blocks the send,
        // leaving mode unchanged and discovery uninterrupted.
        env.resume();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Runner is still claiming jobs.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(
            completion.is_some(),
            "resume on Running should not break discovery"
        );

        shutdown(&env, run_handle).await;
    }

    /// SIGTERM while a job is in flight: per-job cancellation fires, the
    /// executor aborts, and run() exits within a couple of seconds rather
    /// than blocking on the 2h JOB_TIMEOUT.
    #[tokio::test]
    async fn hard_shutdown_cancels_active_jobs() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            gate,
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        // Wait for the job to enter the gated wait — cancel token is now in the map.
        let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

        // SIGTERM equivalent: latch hard-shutdown, cancel all in-flight jobs.
        env.trigger_stopping().await;

        match tokio::time::timeout(Duration::from_secs(3), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("hard shutdown should exit within 3s — got stuck"),
        }

        // The cancelled job reports the synthetic "cancelled by user" error.
        let comps = env.handle.completions.lock().unwrap();
        let c = comps
            .iter()
            .find(|c| c.run_id == run_id)
            .expect("cancelled job should still report completion");
        assert_eq!(c.error.as_deref(), Some("cancelled by user"));
    }

    /// SIGUSR1 → SIGTERM upgrade. Starts Draining, then hard-shutdown fires
    /// mid-drain and the run exits promptly with the active job cancelled.
    #[tokio::test]
    async fn drain_then_hard_shutdown_upgrades() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            gate,
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
        let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

        // Draining. Without hard shutdown, this would wait up to JOB_TIMEOUT = 2h.
        env.drain();
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Upgrade to hard shutdown.
        env.trigger_stopping().await;

        match tokio::time::timeout(Duration::from_secs(3), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("Draining → hard shutdown should exit within 3s"),
        }
    }

    /// TOCTOU regression: a SIGTERM that iterates `cancel_tokens` *before*
    /// the main loop inserts a newly-claimed job's token would leave that
    /// job running uncancelled. The fix is a post-insert `mode_rx.borrow()`
    /// check that catches Stopping and cancels the token in that window.
    ///
    /// To reproduce deterministically, we use `send_if_modified` to flip
    /// the watch value to `Stopping` **without** waking `mode_rx.changed()`
    /// — this is exactly what the racy window looks like to the main loop:
    /// its outer select! is still polling discover_fut, unaware that the
    /// value has changed. When discover yields a job, the main loop takes
    /// the claim path, inserts the token, then reads `mode_rx.borrow()`
    /// and catches the Stopping value that was silently written.
    #[tokio::test]
    async fn claim_after_stopping_sent_cancels_new_job() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Deterministic barrier: wait for run()'s main loop to have polled
        // `discover_fut` into its await state. Only then is the Running-arm
        // `select!` provably in place, which is the precondition for the
        // silent `send_if_modified` below to land without waking the loop.
        // A wall-clock sleep here flakes under coverage CI — see #10146.
        // The 2s timeout gives a clear diagnostic if the "loop parks on
        // discover" invariant ever regresses, rather than hanging until
        // the outer test harness kills us.
        tokio::time::timeout(
            Duration::from_secs(2),
            env.handle.discover_entered.notified(),
        )
        .await
        .expect("run() did not enter discover_fut select! within 2s");

        // Flip the watch value to Stopping without firing changed().
        env.mode_tx.send_if_modified(|v| {
            *v = RunnerMode::Stopping;
            false
        });

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        // `wait_completion` is event-driven (fires on `provider.complete`), so
        // this duration is a diagnostic cap for genuine hangs — not a budget
        // for the run. A large cap absorbs coverage-CI slowdown of the full
        // dispatch→executor→complete chain without flaking (see #10146).
        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(30))
            .await;
        assert!(
            c.is_some(),
            "job must report cancellation even when the handler missed the token"
        );
        assert_eq!(c.unwrap().error.as_deref(), Some("cancelled by user"));

        // Let run() exit — fire changed() now so the main loop observes
        // Stopping at loop top and breaks to teardown.
        env.mode_tx.send_modify(|v| {
            *v = RunnerMode::Stopping;
        });
        env.cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
    }

    /// SIGUSR2 received while Stopping is committed is ignored — the
    /// runner cannot resume out of Stopping.
    #[tokio::test]
    async fn resume_after_stopping_is_ignored() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Wait for the main loop to park on `discover_fut` so the subsequent
        // `trigger_stopping` lands on a steady-state loop rather than racing
        // against startup. This test does not depend on the silent-flip
        // semantics of `claim_after_stopping_sent_cancels_new_job` (it uses
        // `trigger_stopping`, which fires `changed()`), but the same barrier
        // is still the right "main loop is idle" signal — and deterministic
        // under coverage CI, unlike the 50 ms sleep this replaces.
        tokio::time::timeout(
            Duration::from_secs(2),
            env.handle.discover_entered.notified(),
        )
        .await
        .expect("run() did not enter discover_fut select! within 2s");

        // Enter Stopping first.
        env.trigger_stopping().await;

        // handle_resume_signal refuses any transition except from Draining.
        handle_resume_signal(&env.mode_tx);
        assert_eq!(
            *env.mode_tx.borrow(),
            RunnerMode::Stopping,
            "mode must remain Stopping after ignored SIGUSR2"
        );

        match tokio::time::timeout(Duration::from_secs(2), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("hard shutdown should exit within 2s"),
        }
    }

    /// Regression for #10146 / #10223: the main-loop `idle_cleanup` and
    /// `heartbeat_tick` intervals must defer their first tick past the
    /// configured period, so neither arm is Ready on the first `select!`
    /// poll. Otherwise they pre-empt `discover_fut` (which parks on
    /// `rx.recv()` → Pending) and any silent `mode_tx` flip during the
    /// tick body breaks the loop before the pending job is ever claimed.
    ///
    /// The behavioral test `claim_after_stopping_sent_cancels_new_job`
    /// only triggers the underlying race under `cargo llvm-cov`, so a
    /// silent revert of `interval_at` → `interval` would not fail it on
    /// the default CI path. This test pins the invariant directly: a
    /// job pushed immediately at startup is processed without any tick
    /// having fired, observable via `heartbeat_count == 0`.
    #[tokio::test(start_paused = true)]
    async fn heartbeat_tick_defers_past_first_select_poll() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        tokio::time::timeout(
            Duration::from_secs(2),
            env.handle.discover_entered.notified(),
        )
        .await
        .expect("run() did not enter discover_fut select! within 2s");

        // `minimal_context` → no session → completion path does not trigger
        // `park_notify`, so any heartbeat observed here came from the
        // interval tick (the path we want to prove did NOT fire).
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job must complete");

        assert_eq!(
            env.handle.heartbeat_count(),
            0,
            "heartbeat tick fired before the startup job was processed — \
             is the main-loop interval `interval_at(now + period, period)` \
             instead of `interval(period)`?"
        );

        shutdown(&env, run_handle).await;
    }

    /// `handle_drain_signal` state guard: SIGUSR1 is honored only from
    /// Running. Mirrors `handle_resume_signal`'s Draining-only guard.
    #[test]
    fn drain_signal_state_guards() {
        // Running → Draining (sanity: the one legal transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Draining);

        // Draining → ignored (no self-transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Draining);

        // Stopping → ignored (cannot reverse teardown).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);

        // Stopped → ignored (runner has exited its loop).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopped);
    }

    /// `handle_resume_signal` state guard: SIGUSR2 is honored only from
    /// Draining. The integration test `resume_after_stopping_is_ignored`
    /// covers the Stopping case; this pins the full matrix as a unit test.
    #[test]
    fn resume_signal_state_guards() {
        // Draining → Running (sanity: the one legal transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Running);

        // Running → ignored (nothing to resume from).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Running);

        // Stopping → ignored (too late).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);

        // Stopped → ignored.
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopped);
    }

    /// `handle_stopping_signal` idempotency: a repeat invocation takes the
    /// "already Stopping" guard and returns without re-iterating
    /// `cancel_tokens` or re-cancelling `cancel`.
    #[tokio::test]
    async fn stopping_signal_repeat_is_idempotent() {
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let cancel = CancellationToken::new();
        let tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        // First call: transitions, cancels main cancel.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &tx).await;
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);
        assert!(cancel.is_cancelled());

        // Insert a sentinel token *after* the first call so we can prove
        // the repeat did not re-iterate the map.
        let sentinel = CancellationToken::new();
        tokens
            .lock()
            .await
            .insert(RunId::new_v4(), sentinel.clone());

        // Repeat call: must early-return on the already-Stopping guard.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &tx).await;
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);
        assert!(
            !sentinel.is_cancelled(),
            "repeat must not re-iterate cancel_tokens and cancel late-inserted sentinel",
        );
    }

    /// Draining auto-transitions to Stopping when jobs drain naturally.
    /// Verifies the internal `mode_tx.send(Stopping)` in the Draining arm.
    #[tokio::test]
    async fn drain_with_jobs_transitions_to_stopping_when_empty() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Let a quick job complete, then drain.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
        let _ = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;

        // Give the main loop a moment to clean up the jobset, then drain.
        tokio::time::sleep(Duration::from_millis(50)).await;
        env.drain();

        // The Draining arm should observe jobs.is_empty() and self-send
        // Stopping, leading to teardown and run() exit.
        match tokio::time::timeout(Duration::from_secs(3), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("Draining natural drain should exit within 3s"),
        }

        assert_eq!(
            *env.mode_tx.borrow(),
            RunnerMode::Stopping,
            "mode_tx must reflect Stopping after natural drain transition"
        );

        // Observability pin: the Draining → Stopping auto-transition must
        // emit a one-shot heartbeat with mode="stopping" before teardown,
        // in addition to the terminal heartbeat during teardown. Two or
        // more "stopping" heartbeats prove both sites fire (the one-shot
        // at the transition and the terminal one). A single hit would mean
        // one of the two was removed.
        let stopping_count = env
            .handle
            .heartbeats
            .lock()
            .unwrap()
            .iter()
            .filter(|h| h.mode == "stopping")
            .count();
        assert!(
            stopping_count >= 2,
            "expected at least 2 stopping heartbeats (one-shot + terminal), got {stopping_count}",
        );
    }

    /// Race regression: the Draining → Stopping auto-transition must be
    /// guarded on `mode == Draining`, so a concurrent SIGUSR2 that flips
    /// mode back to Running is preserved rather than silently overwritten.
    ///
    /// We simulate the race deterministically:
    /// 1. Claim a gated job — mode is Draining, the Draining arm is waiting
    ///    in `select!`.
    /// 2. Silently flip mode to Running via `send_if_modified(false)`
    ///    (equivalent to SIGUSR2 arriving *after* the arm noticed jobs was
    ///    non-empty but *before* the next iteration's guard).
    /// 3. Release the gate — the job completes, the arm reaps it, loops to
    ///    top, sees `jobs.is_empty()`, and evaluates the guarded
    ///    `send_if_modified`. The guard rejects the overwrite because mode
    ///    is no longer Draining.
    /// 4. Outer loop re-reads mode → Running → resumes normal discovery.
    #[tokio::test]
    async fn draining_auto_stop_preserves_concurrent_resume() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            Arc::clone(&gate),
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let run_handle = tokio::spawn(run(config));

        // Claim a job and hold it at the gate so the Draining arm has
        // something to wait on — without a live job the auto-transition
        // fires before any concurrent signal could race.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
        let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

        env.drain();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);

        // Silently flip to Running — the `false` return suppresses
        // `changed()`, so the arm does not wake on a mode transition. The
        // guard will only observe the new value on its next iteration's
        // send_if_modified closure.
        env.mode_tx.send_if_modified(|v| {
            *v = RunnerMode::Running;
            false
        });

        // Release the gate: job completes, the arm reaps, then checks
        // jobs.is_empty() → true → calls the guarded send_if_modified.
        gate.notify_one();
        let _ = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            *env.mode_tx.borrow(),
            RunnerMode::Running,
            "SIGUSR2 must win the race against the Draining auto-Stop",
        );

        // Tear down cleanly.
        env.trigger_stopping().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 4: Claim failure (409) rolls back budget
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn claim_failure_rolls_back_budget() {
        // Budget for exactly 1 job (2 vcpu, 4096 MB matches the test profile).
        let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
        let run_handle = tokio::spawn(run(config));

        // First job: claim returns None (409 conflict)
        let run_id_1 = RunId::new_v4();
        push_job(&env, run_id_1, "vm0/default", None);

        // Give main loop time to process the failed claim and release budget.
        tokio::time::advance(Duration::from_millis(100)).await;
        tokio::task::yield_now().await;

        // Second job: claim succeeds — budget should have been freed.
        let run_id_2 = RunId::new_v4();
        push_job(
            &env,
            run_id_2,
            "vm0/default",
            Some(minimal_context(run_id_2)),
        );

        let completion = env
            .handle
            .wait_completion(run_id_2, Duration::from_secs(5))
            .await;
        assert!(
            completion.is_some(),
            "second job should complete (budget freed after first 409)"
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 5: Shutdown drains running jobs before exiting
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn shutdown_drains_running_jobs() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        // Wait for completion before draining.
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some());

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 6: Unknown profile is skipped without affecting subsequent jobs
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn unknown_profile_skipped() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Push a job with a profile that doesn't exist in the profiles map.
        // The main loop should log a warning and continue without claiming.
        let bad_id = RunId::new_v4();
        push_job(
            &env,
            bad_id,
            "vm0/nonexistent",
            Some(minimal_context(bad_id)),
        );

        // Give main loop time to skip the bad job.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Push a valid job — it should succeed despite the earlier bad one.
        let good_id = RunId::new_v4();
        push_job(&env, good_id, "vm0/default", Some(minimal_context(good_id)));

        let completion = env
            .handle
            .wait_completion(good_id, Duration::from_secs(5))
            .await;
        assert!(
            completion.is_some(),
            "valid job should complete after unknown profile is skipped"
        );

        // The bad job should never have been claimed (no completion recorded).
        {
            let comps = env.handle.completions.lock().unwrap();
            assert!(
                !comps.iter().any(|c| c.run_id == bad_id),
                "unknown-profile job should not produce a completion"
            );
        }

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 7: Duplicate discovery (same run_id) is deduplicated
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn duplicate_discovery_deduplicated() {
        // Budget for 2 jobs — enough for the duplicate to pass the budget
        // check and reach the cancel_tokens dedup logic.
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        // Wait for job to be claimed and executing (cancel_tokens now has run_id).
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Push the same run_id again (simulates Ably push + poll race).
        // Budget has room, but cancel_tokens already contains this run_id →
        // the duplicate is rejected and budget is released.
        env.handle
            .discover_tx
            .send((run_id, "vm0/default".into()))
            .unwrap();

        // Wait for the original job to complete.
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "original job should complete");

        // Only one completion should exist for this run_id.
        {
            let comps = env.handle.completions.lock().unwrap();
            let count = comps.iter().filter(|c| c.run_id == run_id).count();
            assert_eq!(
                count, 1,
                "duplicate discovery should not produce a second completion"
            );
        }

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 8: Two successful jobs in sequence
    //
    // After the first job completes, discover_fut is recreated
    // (Box::pin(provider.discover())). The second job must be discovered,
    // claimed, executed, and completed through the recreated future.
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn two_sequential_jobs_complete() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // First job
        let id1 = RunId::new_v4();
        push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
        let c1 = env
            .handle
            .wait_completion(id1, Duration::from_secs(5))
            .await;
        assert!(c1.is_some(), "first job should complete");
        assert_eq!(c1.unwrap().exit_code, 0);

        // Second job — exercises the recreated discover_fut path
        let id2 = RunId::new_v4();
        push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));
        let c2 = env
            .handle
            .wait_completion(id2, Duration::from_secs(5))
            .await;
        assert!(
            c2.is_some(),
            "second job should complete via recreated discover_fut"
        );
        assert_eq!(c2.unwrap().exit_code, 0);

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 9: sandboxReuse feature flag gates idle pool park/take
    //
    // With the flag ON and a session ID, the VM is parked after execution.
    // With the flag OFF (default), the VM is destroyed.
    // -----------------------------------------------------------------------

    fn context_with_reuse(
        run_id: RunId,
        reuse: bool,
        session_id: Option<&str>,
    ) -> crate::types::ExecutionContext {
        let mut ctx = minimal_context(run_id);
        if reuse {
            ctx.feature_flags = Some(HashMap::from([(
                crate::types::feature_flags::SANDBOX_REUSE.to_string(),
                true,
            )]));
        }
        if let Some(sid) = session_id {
            ctx.resume_session = Some(crate::types::ResumeSession {
                session_id: sid.to_string(),
                session_history: String::new(),
            });
        }
        ctx
    }

    #[tokio::test(start_paused = true)]
    async fn sandbox_reuse_flag_on_parks_vm() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        let ctx = context_with_reuse(run_id, true, Some("sess-1"));
        push_job(&env, run_id, "vm0/default", Some(ctx));

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 0);

        let pool = env.idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "VM should be parked when sandboxReuse is on");
        assert!(pool.held_sessions().contains(&"sess-1".to_string()));
        drop(pool);

        shutdown(&env, run_handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn sandbox_reuse_flag_off_destroys_vm() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        // Flag OFF (default) — even with a session ID, VM should not be parked.
        let ctx = context_with_reuse(run_id, false, Some("sess-1"));
        push_job(&env, run_id, "vm0/default", Some(ctx));

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 0);

        let pool = env.idle_pool.lock().await;
        assert_eq!(
            pool.len(),
            0,
            "VM should NOT be parked when sandboxReuse is off"
        );
        drop(pool);

        shutdown(&env, run_handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn sandbox_reuse_flag_on_without_session_does_not_park() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        // Flag ON but no session — parking requires a session ID.
        let ctx = context_with_reuse(run_id, true, None);
        push_job(&env, run_id, "vm0/default", Some(ctx));

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 0);

        let pool = env.idle_pool.lock().await;
        assert_eq!(
            pool.len(),
            0,
            "VM should NOT be parked without a session ID"
        );
        drop(pool);

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 11: Budget full → job skipped (not claimed) → budget freed → next job succeeds
    //
    // Different from test 4 (claim failure): here try_reserve returns false
    // so claim() is never called. The job stays in the channel but the main
    // loop moves on. After the running job completes and frees budget, the
    // next discover picks up the waiting job.
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn budget_full_skips_then_resumes() {
        // Budget for exactly 1 job (2 vcpu, 4096 MB).
        let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
        let run_handle = tokio::spawn(run(config));

        // First job: claims the entire budget.
        let id1 = RunId::new_v4();
        push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));

        // Wait for job 1 to be claimed (budget now full).
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Second job: pushed while budget is full. try_reserve fails →
        // the job is skipped without claim. But it remains in the channel.
        let id2 = RunId::new_v4();
        push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));

        // Job 1 completes (MockSandbox is instant) → budget freed.
        let c1 = env
            .handle
            .wait_completion(id1, Duration::from_secs(5))
            .await;
        assert!(c1.is_some(), "first job should complete");

        // After budget is freed, the main loop re-enters the normal select!
        // and discovers job 2 from the channel.
        let c2 = env
            .handle
            .wait_completion(id2, Duration::from_secs(5))
            .await;
        assert!(
            c2.is_some(),
            "second job should complete after budget is freed"
        );

        shutdown(&env, run_handle).await;
    }

    // =======================================================================
    // Subsystem integration tests — Phase 3
    //
    // Tests 10-19 cover job lifecycle (park/destroy), idle pool integration
    // (session affinity, profile mismatch, expiry), budget exhaustion
    // (eviction), shutdown drain, and edge cases (pool-full, reuse cycle).
    // =======================================================================

    /// ExecutionContext with a resume_session and sandboxReuse flag for idle pool testing.
    fn context_with_session(run_id: RunId, session_id: &str) -> crate::types::ExecutionContext {
        let mut ctx = minimal_context(run_id);
        ctx.feature_flags = Some(HashMap::from([(
            crate::types::feature_flags::SANDBOX_REUSE.to_string(),
            true,
        )]));
        ctx.resume_session = Some(crate::types::ResumeSession {
            session_id: session_id.into(),
            session_history: String::new(),
        });
        ctx
    }

    /// Two profiles with different resource requirements for mismatch tests.
    fn two_profiles() -> BTreeMap<String, config::ProfileConfig> {
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

    /// Build an idle entry with all fields configurable.
    fn make_test_idle_entry(
        session_id: &str,
        profile_name: &str,
        vcpu: u32,
        memory_mb: u32,
        parked_at: std::time::Instant,
        idle_timeout: Duration,
    ) -> IdleEntry {
        IdleEntry {
            sandbox: Box::new(MockSandbox::new("idle-test")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: profile_name.into(),
            vcpu,
            memory_mb,
            source_ip: "10.0.0.1".into(),
            parked_at,
            idle_timeout,
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        }
    }

    /// Pre-populate idle pool with an entry and reserve its budget. Returns
    /// the entry's sandbox id so reuse tests can assert it propagates through
    /// to the completion payload.
    async fn seed_idle_pool(
        pool: &SharedIdlePool,
        budget: &ResourceBudget,
        session_id: &str,
        profile_name: &str,
        vcpu: u32,
        memory_mb: u32,
    ) -> SandboxId {
        assert!(budget.try_reserve(vcpu, memory_mb));
        let entry = make_test_idle_entry(
            session_id,
            profile_name,
            vcpu,
            memory_mb,
            std::time::Instant::now(),
            Duration::from_secs(300),
        );
        let sandbox_id = entry.sandbox_id;
        let mut guard = pool.lock().await;
        let result = guard.park(session_id.into(), entry);
        assert!(matches!(result, ParkResult::Parked));
        sandbox_id
    }

    /// Poll until `budget.allocated().2` (running_count) reaches `expected`.
    ///
    /// `budget.release()` runs after `provider.complete()` in the spawned job
    /// task, so `wait_completion()` returning does NOT guarantee the budget has
    /// been released yet. This helper avoids fixed sleeps as synchronization.
    async fn wait_budget_count(budget: &ResourceBudget, expected: usize, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if budget.allocated().2 == expected {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "budget count did not reach {expected} within {timeout:?} (actual: {})",
                budget.allocated().2,
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Pre-populate idle pool with an expired entry (parked 400s ago, timeout 300s).
    async fn seed_idle_pool_expired(
        pool: &SharedIdlePool,
        budget: &ResourceBudget,
        session_id: &str,
        profile_name: &str,
        vcpu: u32,
        memory_mb: u32,
    ) {
        assert!(budget.try_reserve(vcpu, memory_mb));
        let entry = make_test_idle_entry(
            session_id,
            profile_name,
            vcpu,
            memory_mb,
            std::time::Instant::now() - Duration::from_secs(400),
            Duration::from_secs(300),
        );
        let mut guard = pool.lock().await;
        let result = guard.park(session_id.into(), entry);
        assert!(matches!(result, ParkResult::Parked));
    }

    // -----------------------------------------------------------------------
    // Test 10: Successful job parks VM in idle pool
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn successful_job_parks_in_idle_pool() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-park")),
        );

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        assert_eq!(completion.unwrap().exit_code, 0);

        // Give park notification time to propagate.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // VM should be parked in idle pool, holding budget.
        {
            let pool = idle_pool.lock().await;
            assert_eq!(pool.len(), 1, "VM should be parked");
            assert!(
                pool.held_sessions().contains(&"sess-park".to_string()),
                "parked session should be sess-park"
            );
        }
        let (_, _, count) = budget.allocated();
        assert_eq!(count, 1, "parked VM should hold budget");

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 11: Job without session destroys sandbox (no parking)
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn job_without_session_destroys_sandbox() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        // No resume_session → no session_id → no parking.
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        assert_eq!(completion.unwrap().exit_code, 0);

        // budget.release() runs after provider.complete() in the spawned task,
        // so wait_completion returning doesn't guarantee it has executed yet.
        // Poll until budget is fully released rather than using a fixed sleep.
        wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

        // No parking — pool empty, budget fully released.
        assert_eq!(idle_pool.lock().await.len(), 0, "pool should be empty");

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 12: Park notification triggers immediate heartbeat
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn park_triggers_immediate_heartbeat() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let run_handle = tokio::spawn(run(config));

        // Snapshot the heartbeat count before pushing a job. The first
        // interval tick is now deferred by one period (`interval_at`), so
        // `before` is typically 0; the 100 ms settle time just lets the
        // main loop reach its idle select state.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let before = env.handle.heartbeat_count();

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-hb")),
        );

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");

        // Give park notification time to trigger heartbeat.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let after = env.handle.heartbeat_count();
        assert!(
            after > before,
            "park should trigger at least one heartbeat (before={before}, after={after})"
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 13: Session affinity reuses idle VM
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn session_affinity_reuses_idle_vm() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);

        // Pre-seed: park a VM for session "sess-reuse" with matching profile.
        let seeded_sandbox_id =
            seed_idle_pool(&idle_pool, &budget, "sess-reuse", "vm0/default", 2, 4096).await;
        assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

        let run_handle = tokio::spawn(run(config));

        // Push job for same session — should reuse the idle VM.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-reuse")),
        );

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        let completion = completion.unwrap();
        assert_eq!(completion.exit_code, 0);
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::Reused),
            "reuse_result should be Reused"
        );
        assert_eq!(
            completion.sandbox_id,
            Some(seeded_sandbox_id),
            "reused completion should carry the seeded sandbox id"
        );

        tokio::time::sleep(Duration::from_millis(100)).await;

        // After reuse + re-park: pool should still have 1 entry, budget count=1.
        {
            let pool = idle_pool.lock().await;
            assert_eq!(pool.len(), 1, "VM should be re-parked after reuse");
        }
        assert_eq!(
            budget.allocated().2,
            1,
            "budget should remain at 1 (reused, not additive)"
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 13b: Reuse-enabled job with no session reports NoSessionId
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn reuse_enabled_without_session_reports_no_session_id() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);

        let run_handle = tokio::spawn(run(config));

        // Feature on but no resume_session → NoSessionId branch.
        let run_id = RunId::new_v4();
        let mut ctx = minimal_context(run_id);
        ctx.feature_flags = Some(HashMap::from([(
            crate::types::feature_flags::SANDBOX_REUSE.to_string(),
            true,
        )]));
        push_job(&env, run_id, "vm0/default", Some(ctx));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        let completion = completion.unwrap();
        assert_eq!(completion.exit_code, 0);
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::NoSessionId),
        );
        assert!(
            completion.sandbox_id.is_some(),
            "fresh create still allocates a sandbox id",
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 13c: Feature-disabled job reports FeatureDisabled
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn reuse_disabled_job_reports_feature_disabled() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);

        let run_handle = tokio::spawn(run(config));

        // minimal_context has feature_flags = None → SANDBOX_REUSE evaluates false.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        let completion = completion.expect("job should complete");
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::FeatureDisabled),
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 14: Profile mismatch destroys stale and creates new
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn profile_mismatch_destroys_stale_vm() {
        let (config, env) = mock_run_config(two_profiles(), 16, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);

        // Pre-seed: park a "vm0/default" (2vcpu) VM for session "sess-mm".
        seed_idle_pool(&idle_pool, &budget, "sess-mm", "vm0/default", 2, 4096).await;

        let run_handle = tokio::spawn(run(config));

        // Push job for "vm0/large" (4vcpu) with same session — profile mismatch.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/large",
            Some(context_with_session(run_id, "sess-mm")),
        );

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        let completion = completion.unwrap();
        assert_eq!(completion.exit_code, 0);
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::ProfileMismatch),
            "reuse_result should be ProfileMismatch when profile differs"
        );
        assert!(
            completion.sandbox_id.is_some(),
            "freshly created sandbox still reports its id"
        );

        // Stale VM destruction runs in a background destroy_task. Poll until
        // its budget is released rather than using a fixed sleep.
        // Expected: stale 2vcpu released, new 4vcpu held → count=1.
        wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

        {
            let pool = idle_pool.lock().await;
            assert_eq!(pool.len(), 1, "new VM should be parked");
        }
        let (alloc_vcpu, alloc_mem, alloc_count) = budget.allocated();
        assert_eq!(alloc_count, 1, "only new VM should hold budget");
        assert_eq!(alloc_vcpu, 4, "new VM is vm0/large (4 vcpu)");
        assert_eq!(alloc_mem, 8192, "new VM is vm0/large (8192 MB)");

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 15: Cleanup tick evicts expired idle entries
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn cleanup_tick_evicts_expired_entries() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);

        // Pre-seed: park an entry that is already expired (400s old, 300s timeout).
        seed_idle_pool_expired(&idle_pool, &budget, "sess-exp", "vm0/default", 2, 4096).await;
        assert_eq!(
            idle_pool.lock().await.len(),
            1,
            "should have 1 seeded entry"
        );
        assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

        let run_handle = tokio::spawn(run(config));

        // Advance past the first cleanup tick (every 10s).
        // The tick interval fires once immediately (at t=0), but the entry
        // was just inserted so it may not be expired yet from Instant::now()'s
        // perspective. Advance 11s to ensure at least one full tick fires.
        tokio::time::sleep(Duration::from_secs(11)).await;

        // Eviction spawns a destroy_task that calls budget.release() async.
        // Poll until it completes.
        wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

        let pool_len = idle_pool.lock().await.len();
        assert_eq!(pool_len, 0, "expired entry should be evicted");

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 16: Budget exhausted → evict idle VM → admit new job
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn budget_exhausted_evicts_idle_and_admits_job() {
        // Budget: exactly 1 default job (2 vcpu, 4096 MB).
        let (config, env) = mock_run_config(test_profiles(), 2, 4096, 2);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);

        // Pre-seed: idle VM fills the entire budget.
        seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
        assert!(
            !budget.can_afford(2, 4096),
            "budget should be exhausted after seeding"
        );

        let run_handle = tokio::spawn(run(config));

        // Push new job — budget is full, but idle pool has an entry to evict.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(
            completion.is_some(),
            "job should complete after idle VM eviction frees budget"
        );
        assert_eq!(completion.unwrap().exit_code, 0);

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 17: Shutdown drains idle pool and releases budget
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn shutdown_drains_idle_pool() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);

        // Pre-seed: two idle entries holding budget.
        seed_idle_pool(&idle_pool, &budget, "sess-drain-1", "vm0/default", 2, 4096).await;
        seed_idle_pool(&idle_pool, &budget, "sess-drain-2", "vm0/default", 2, 4096).await;
        assert_eq!(idle_pool.lock().await.len(), 2);
        assert_eq!(budget.allocated().2, 2);

        let run_handle = tokio::spawn(run(config));

        // Immediately shutdown — drain should destroy all idle entries.
        shutdown(&env, run_handle).await;

        // After shutdown: pool empty, budget fully released.
        assert_eq!(idle_pool.lock().await.len(), 0, "pool should be drained");
        let (_, _, count) = budget.allocated();
        assert_eq!(count, 0, "all budget should be released after drain");
    }

    /// Regression (G1): a job spawned in Running but completing during
    /// Draining captures `mode = Running` in its spawn snapshot, so the
    /// post-exec path still calls `park()`. The resulting pool entry
    /// lands *after* the Draining arm's initial drain — teardown's final
    /// `drain_idle_pool` is the only safety net that prevents a VM leak.
    /// Without it, the late-parked VM would remain in the pool and its
    /// budget would never be released.
    #[tokio::test]
    async fn late_park_during_draining_cleaned_by_teardown() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            Arc::clone(&gate),
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);
        let run_handle = tokio::spawn(run(config));

        // Claim a gated job with session + reuse — the spawn-time snapshot
        // captures `mode = Running`.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-late-park")),
        );
        let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

        // Enter Draining. The arm drains an empty pool and waits for the
        // gated job.
        env.drain();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            idle_pool.lock().await.len(),
            0,
            "Draining arm should have drained an empty pool",
        );

        // Release the gate: the job completes, post-exec parks the sandbox
        // (snapshot says Running), and the entry lands in the already-
        // drained pool.
        gate.notify_one();
        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 0);

        // Arm observes jobs.is_empty → auto-Stop → teardown → the second
        // `drain_idle_pool` call cleans the late-parked VM.
        match tokio::time::timeout(Duration::from_secs(5), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("natural drain + late park should exit within 5s"),
        }

        // Leak proof: pool empty, budget fully released.
        assert_eq!(
            idle_pool.lock().await.len(),
            0,
            "teardown must clean the late-parked VM",
        );
        assert_eq!(
            budget.allocated().2,
            0,
            "budget must be fully released (no held entries, no stray reservations)",
        );
    }

    /// Regression (G2): on SIGTERM from Running, teardown's
    /// `drain_idle_pool` is the *only* site that clears `idle_vms` in
    /// `status.json` — the Draining arm is skipped entirely. Pre-fix, the
    /// stale list leaked into the final `"stopped"` snapshot.
    #[tokio::test(start_paused = true)]
    async fn shutdown_clears_idle_vms_in_status_json() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let status_path = env._temp_dir.path().join("status.json");
        let idle_pool = Arc::clone(&config.idle_pool);
        let run_handle = tokio::spawn(run(config));

        // Park a VM via a normal job → status.json records the idle VM.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-status-clean")),
        );
        let _ = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(idle_pool.lock().await.len(), 1, "VM parked");

        // Pre-shutdown sanity: status.json lists the idle VM.
        let pre: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
        let pre_len = pre
            .get("idle_vms")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        assert_eq!(pre_len, 1, "pre-shutdown status.json should list the VM");

        // SIGTERM path: Draining arm is bypassed, so teardown's
        // drain_idle_pool is the only site that can clear idle_vms.
        env.trigger_stopping().await;
        match tokio::time::timeout(Duration::from_secs(5), run_handle).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
            Ok(Err(e)) => panic!("task panicked: {e}"),
            Err(_) => panic!("hard shutdown should exit within 5s"),
        }

        // Post-shutdown: mode=stopped, idle_vms empty/absent.
        let post: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
        assert_eq!(post["mode"], "stopped");
        let post_len = post
            .get("idle_vms")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        assert_eq!(
            post_len, 0,
            "status.json idle_vms must be cleared after shutdown: {post}",
        );
    }

    // -----------------------------------------------------------------------
    // Test 18: sandboxReuse flag OFF → VM destroyed, budget released
    //
    // When the feature flag is off, park is skipped even with a session.
    // The sandbox must be destroyed and the budget released (not leaked).
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn reuse_flag_off_destroys_and_releases_budget() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let budget = Arc::clone(&config.budget);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        // Job has a session but flag is OFF — parking is skipped.
        let ctx = context_with_reuse(run_id, false, Some("sess-rejected"));
        push_job(&env, run_id, "vm0/default", Some(ctx));

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "job should complete");
        assert_eq!(completion.unwrap().exit_code, 0);

        // Flag OFF: sandbox destroyed, budget must be released.
        wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Test 19: Two sequential jobs for same session → take + reuse + re-park
    //
    // Exercises the full session affinity cycle: park → take → reuse → park.
    // After two jobs the pool should have exactly 1 entry (the second job's
    // VM) and the budget count should be 1.
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn sequential_same_session_reuse_cycle() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);
        let budget = Arc::clone(&config.budget);
        let run_handle = tokio::spawn(run(config));

        // Job 1: parks VM for session "sess-seq".
        let id1 = RunId::new_v4();
        push_job(
            &env,
            id1,
            "vm0/default",
            Some(context_with_session(id1, "sess-seq")),
        );
        let c1 = env
            .handle
            .wait_completion(id1, Duration::from_secs(5))
            .await;
        assert!(c1.is_some(), "job 1 should complete");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(idle_pool.lock().await.len(), 1, "job 1 VM should be parked");

        // Job 2: same session → take → reuse → re-park.
        let id2 = RunId::new_v4();
        push_job(
            &env,
            id2,
            "vm0/default",
            Some(context_with_session(id2, "sess-seq")),
        );
        let c2 = env
            .handle
            .wait_completion(id2, Duration::from_secs(5))
            .await;
        assert!(c2.is_some(), "job 2 should complete");
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            idle_pool.lock().await.len(),
            1,
            "pool should have 1 entry after two sequential jobs"
        );
        assert_eq!(budget.allocated().2, 1, "only one VM should hold budget");

        shutdown(&env, run_handle).await;
    }

    // =======================================================================
    // Tests 20-22: Edge cases requiring MockSandboxOverrides
    // =======================================================================

    fn mock_run_config_with_overrides(
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

    async fn wait_cancel_token(
        tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        run_id: RunId,
        timeout: Duration,
    ) -> CancellationToken {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(token) = tokens.lock().await.get(&run_id).cloned() {
                return token;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "cancel token for {run_id} not found within {timeout:?}",
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Test 20: Failed job with session context is not parked.
    ///
    /// When `wait_exit` returns a non-zero exit code, `spawn_job()` skips
    /// parking (because `exit_code == 0` is false) and destroys the sandbox.
    #[tokio::test(start_paused = true)]
    async fn failed_job_with_session_not_parked() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_code(1));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 4, overrides);
        let budget = Arc::clone(&config.budget);
        let idle_pool = Arc::clone(&config.idle_pool);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-fail")),
        );

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 1);

        wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
        assert_eq!(idle_pool.lock().await.len(), 0, "failed job must not park");

        shutdown(&env, run_handle).await;
    }

    /// Test 21: Cancelled job is not parked.
    ///
    /// `wait_exit_gate` blocks the agent execution. The test cancels the job
    /// via the cancel token, causing `select!` in the executor to take the
    /// cancellation branch. `job_cancel.is_cancelled()` is true, so
    /// `parkable_session` is `None` → sandbox destroyed.
    #[tokio::test(start_paused = true)]
    async fn cancelled_job_not_parked() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_gate(
            gate,
        ));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 4, overrides);
        let budget = Arc::clone(&config.budget);
        let idle_pool = Arc::clone(&config.idle_pool);
        let cancel_tokens = Arc::clone(&config.cancel_tokens);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-cancel")),
        );

        // Wait for the job to be claimed (cancel token inserted).
        let token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;
        // Cancel the job — executor's select! takes the cancelled branch.
        token.cancel();

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "cancelled job should still complete");
        let c = c.unwrap();
        assert_eq!(c.exit_code, 137, "cancellation yields synthetic SIGKILL");
        assert_eq!(c.error.as_deref(), Some("cancelled by user"));

        wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
        assert_eq!(
            idle_pool.lock().await.len(),
            0,
            "cancelled job must not park"
        );

        shutdown(&env, run_handle).await;
    }

    /// Test 22: `ParkResult::Evicted` via `guest_session_id`.
    ///
    /// A first-run job (no `resume_session`) reads a CLI-generated session ID
    /// from the guest filesystem. When that session already has an entry in
    /// the idle pool, `pool.park()` returns `Evicted(old)`, the old VM is
    /// destroyed, and the new VM takes its place.
    #[tokio::test(start_paused = true)]
    async fn park_evicts_via_guest_session_id() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: "cat /tmp/vm0-session-".into(),
            exit_code: 0,
            stdout: b"sess-evict".to_vec(),
            stderr: Vec::new(),
        });
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
        let budget = Arc::clone(&config.budget);
        let idle_pool = Arc::clone(&config.idle_pool);

        // Pre-seed idle pool with session "sess-evict".
        seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
        assert_eq!(budget.allocated().2, 1, "pre-seeded entry holds budget");

        let run_handle = tokio::spawn(run(config));

        // Push job WITHOUT resume_session — first run, no session context.
        // read_guest_session_id() will be called and return "sess-evict"
        // via the exec matcher.
        let run_id = RunId::new_v4();
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");
        assert_eq!(c.unwrap().exit_code, 0);

        // After eviction: old entry destroyed + old budget released,
        // new entry parked + new budget held → net count = 1.
        wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "pool should have the newly parked entry");
        assert_eq!(
            pool.held_sessions(),
            vec!["sess-evict"],
            "parked session should match guest_session_id"
        );
        drop(pool);

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Tests 23-25: park / unpark idle-transition orchestration (#9102)
    // -----------------------------------------------------------------------

    /// Two sequential jobs on the same session produce park=2 / unpark=1:
    /// the first job's post-exit park, plus the second job's take (unpark)
    /// and post-exit re-park. Verifies the full reuse cycle drives the
    /// new trait hooks symmetrically.
    #[tokio::test(start_paused = true)]
    async fn reuse_cycle_invokes_park_and_unpark_symmetrically() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let counter = Arc::clone(&overrides);
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
        let idle_pool = Arc::clone(&config.idle_pool);
        let run_handle = tokio::spawn(run(config));

        // Job 1: fresh create → run → park.
        let id1 = RunId::new_v4();
        push_job(
            &env,
            id1,
            "vm0/default",
            Some(context_with_session(id1, "sess-reuse-cycle")),
        );
        assert!(
            env.handle
                .wait_completion(id1, Duration::from_secs(5))
                .await
                .is_some()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(counter.park_call_count(), 1);
        assert_eq!(counter.unpark_call_count(), 0);

        // Job 2: same session → take (unpark) → run → re-park.
        let id2 = RunId::new_v4();
        push_job(
            &env,
            id2,
            "vm0/default",
            Some(context_with_session(id2, "sess-reuse-cycle")),
        );
        assert!(
            env.handle
                .wait_completion(id2, Duration::from_secs(5))
                .await
                .is_some()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            counter.park_call_count(),
            2,
            "park() should fire once per job"
        );
        assert_eq!(
            counter.unpark_call_count(),
            1,
            "unpark() should fire only for the reused job"
        );
        assert_eq!(idle_pool.lock().await.len(), 1);

        shutdown(&env, run_handle).await;
    }

    /// A successful job with a session triggers `Sandbox::park()` exactly once
    /// when the VM is handed off to the idle pool.
    #[tokio::test(start_paused = true)]
    async fn park_called_when_vm_enters_idle_pool() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let counter = Arc::clone(&overrides);
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
        let idle_pool = Arc::clone(&config.idle_pool);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-park-hook")),
        );

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete");

        // Park notification + park() are called from the post-job task; give
        // them a moment to run before asserting.
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            counter.park_call_count(),
            1,
            "park() should have been called exactly once"
        );
        assert_eq!(
            counter.unpark_call_count(),
            0,
            "unpark() must not be called for a fresh park"
        );
        assert_eq!(idle_pool.lock().await.len(), 1, "VM should be parked");

        shutdown(&env, run_handle).await;
    }

    /// When `Sandbox::park()` returns an error, the runner falls back to
    /// `stop_and_destroy_sandbox` and does NOT insert into the idle pool.
    #[tokio::test(start_paused = true)]
    async fn park_failure_destroys_sandbox_and_skips_pool() {
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition(
            "simulated balloon failure".into(),
        )));
        let counter = Arc::clone(&overrides);
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
        let budget = Arc::clone(&config.budget);
        let idle_pool = Arc::clone(&config.idle_pool);
        let run_handle = tokio::spawn(run(config));

        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-park-fail")),
        );

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(c.is_some(), "job should complete normally");
        assert_eq!(c.unwrap().exit_code, 0);

        // park failure → destroy → budget fully released, pool empty.
        wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
        assert_eq!(
            idle_pool.lock().await.len(),
            0,
            "park failure must NOT insert into pool"
        );
        assert_eq!(
            counter.park_call_count(),
            1,
            "park() should have been attempted exactly once"
        );

        shutdown(&env, run_handle).await;
    }

    /// When the runner takes a sandbox out of the idle pool for reuse and
    /// `Sandbox::unpark()` returns an error, the idle entry is destroyed
    /// and the runner falls through to a fresh sandbox create.
    #[tokio::test(start_paused = true)]
    async fn unpark_failure_destroys_idle_entry_and_falls_through() {
        // Both the pre-seeded sandbox and the fresh-create sandbox share
        // the same MockSandboxOverrides set, so the unpark error queued
        // here is consumed by the FIRST unpark call — which is the take
        // path's call against the pre-seeded sandbox.
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let counter = Arc::clone(&overrides);
        overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition(
            "simulated unpark failure".into(),
        )));
        let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
        let budget = Arc::clone(&config.budget);
        let idle_pool = Arc::clone(&config.idle_pool);

        // Pre-seed via the factory so the seeded MockSandbox shares the
        // override set (and consumes the queued unpark error).
        {
            let mut pool = idle_pool.lock().await;
            let runtime = sandbox_mock::MockSandboxRuntime::with_overrides(Arc::clone(&counter));
            let mut factory = runtime
                .create_factory(sandbox::FactoryConfig {
                    profile: "vm0/default".into(),
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
            let sandbox = factory_arc
                .create(sandbox::SandboxConfig {
                    id: SandboxId::new_v4(),
                    resources: sandbox::ResourceLimits {
                        cpu_count: 2,
                        memory_mb: 4096,
                    },
                })
                .await
                .expect("create sandbox");
            assert!(budget.try_reserve(2, 4096), "reserve seeded budget");
            let _ = pool.park(
                "sess-unpark-fail".to_string(),
                IdleEntry {
                    sandbox,
                    factory: factory_arc,
                    session_id: "sess-unpark-fail".to_string(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default".into(),
                    vcpu: 2,
                    memory_mb: 4096,
                    source_ip: "10.0.0.1".into(),
                    parked_at: std::time::Instant::now(),
                    idle_timeout: Duration::from_secs(300),
                    storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
                },
            );
        }
        assert_eq!(idle_pool.lock().await.len(), 1, "pool seeded");

        let run_handle = tokio::spawn(run(config));

        // Push a job for the same session — runner will try to reuse,
        // unpark() will fail, idle entry gets destroyed, fresh create runs.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-unpark-fail")),
        );

        let c = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        let c = c.expect("fresh-create job should still complete");
        assert_eq!(c.exit_code, 0);
        assert_eq!(
            c.reuse_result,
            Some(SandboxReuseResult::UnparkFailed),
            "completion must tag the unpark-failure branch",
        );

        // After the dust settles:
        //   - unpark called exactly once (the failed take-side call);
        //   - park called exactly once (the fresh-create's successful park).
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            counter.unpark_call_count(),
            1,
            "expected exactly one unpark attempt"
        );
        assert_eq!(
            counter.park_call_count(),
            1,
            "expected exactly one park (the fresh-create's)"
        );

        shutdown(&env, run_handle).await;
    }

    // -----------------------------------------------------------------------
    // Reuse-enabled job whose session has no idle entry reports PoolMiss
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn reuse_enabled_empty_pool_reports_pool_miss() {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let idle_pool = Arc::clone(&config.idle_pool);

        let run_handle = tokio::spawn(run(config));

        // Empty pool + resume_session set + feature on → PoolMiss branch.
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "sess-missing")),
        );

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .expect("job should complete");
        assert_eq!(completion.exit_code, 0);
        assert_eq!(
            completion.reuse_result,
            Some(SandboxReuseResult::PoolMiss),
            "empty-pool reuse attempt must tag PoolMiss",
        );
        assert!(
            completion.sandbox_id.is_some(),
            "fresh create still allocates a sandbox id",
        );
        // Sanity: no one was in the pool to begin with.
        assert_eq!(
            idle_pool.lock().await.len(),
            1,
            "fresh-create sandbox re-parks into the pool",
        );

        shutdown(&env, run_handle).await;
    }
}
