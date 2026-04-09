use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use sandbox::{RuntimeProvider, Sandbox, SandboxFactory, SandboxRuntime};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

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
use crate::paths::{HomePaths, LogPaths, RunnerPaths, touch_mtime};
use crate::prefetch;
use crate::provider::{ApiProvider, JobProvider, LocalProvider};
use crate::proxy;
use crate::resource_budget::ResourceBudget;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::status::{RunnerMode, StatusTracker};
use crate::types::{ExecutionContext, HeartbeatState};

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

    // Shared locks on rootfs/snapshot per profile — allows `runner gc` to detect in-use resources.
    let mut _resource_locks = Vec::new();
    for profile in runner_config.profiles.values() {
        let lock = lock::acquire_shared(home.rootfs_lock(&profile.rootfs_hash)).await?;
        touch_mtime(&home.rootfs_dir().join(&profile.rootfs_hash));
        _resource_locks.push(lock);
        if let Some(hash) = &profile.snapshot_hash {
            let lock = lock::acquire_shared(home.snapshot_lock(hash)).await?;
            touch_mtime(&home.snapshots_dir().join(hash));
            _resource_locks.push(lock);
        }
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
        if let Some(hash) = &profile.snapshot_hash {
            let path = home.snapshots_dir().join(hash).join("memory.bin");
            tokio::task::spawn_blocking(move || prefetch::prefetch_memory(&path));
        }
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
    let kmsg_handle = kmsg_log::spawn(ip_log_map.clone());

    // Start DNS proxy (dnsmasq) for domain-level DNS interception and logging.
    // Shares ip_log_map with kmsg — both use source IP (peer veth) as key.
    let dns_handle = dns::start(ip_log_map.clone())
        .await
        .map_err(|e| RunnerError::Internal(format!("dns proxy: {e}")))?;

    // Resource budget from host resources + config.
    let config::SandboxConfig {
        max_concurrent,
        concurrency_factor,
        keep_alive,
        keep_alive_timeout_secs,
        keep_alive_max_idle,
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

    // Idle sandbox pool for VM keep-alive across conversation turns.
    let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        enabled: keep_alive,
        default_timeout: Duration::from_secs(keep_alive_timeout_secs),
        max_idle: keep_alive_max_idle,
    })));
    if keep_alive {
        info!(
            keep_alive_timeout_secs,
            keep_alive_max_idle, "VM keep-alive enabled"
        );
    }

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
    let cancel_tokens: Arc<tokio::sync::Mutex<HashMap<Uuid, CancellationToken>>> =
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
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<Uuid, CancellationToken>>>,
    cancel: CancellationToken,
    exec_config: Arc<ExecutorConfig>,
    firecracker: config::FirecrackerConfig,
    base_dir: std::path::PathBuf,
    min_vcpu: u32,
    min_memory_mb: u32,
    kmsg_handle: kmsg_log::KmsgHandle,
    dns_handle: dns::DnsProxy,
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
        let use_snapshot = factory_config.snapshot.is_some();
        let factory_result = runtime.create_factory(factory_config).await;
        let factory = match factory_result {
            Ok(f) => f,
            Err(e) => {
                shutdown_factories(&mut factories, runtime.as_mut()).await;
                return Err(e.into());
            }
        };
        factories.insert(profile_name.clone(), (Arc::new(factory), use_snapshot));
        info!(profile = %profile_name, "factory started");
    }

    let mut jobs: JoinSet<Option<Uuid>> = JoinSet::new();
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
    // Signal handling
    // -----------------------------------------------------------------------
    let (mode_tx, mut mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
    let signal_cancel = cancel.clone();

    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};

        let mut sigterm = signal(SignalKind::terminate()).ok();
        let mut sigint = signal(SignalKind::interrupt()).ok();
        let mut sigusr1 = signal(SignalKind::user_defined1()).ok();

        tokio::select! {
            _ = recv_signal(&mut sigterm) => {
                info!("received SIGTERM, draining");
            }
            _ = recv_signal(&mut sigint) => {
                info!("received SIGINT, draining");
            }
            _ = recv_signal(&mut sigusr1) => {
                info!("received SIGUSR1, draining");
            }
        }
        let _ = mode_tx.send(RunnerMode::Draining);
        signal_cancel.cancel();
    });

    // -----------------------------------------------------------------------
    // Idle pool cleanup interval (every 10 seconds)
    // -----------------------------------------------------------------------
    let mut idle_cleanup = tokio::time::interval(Duration::from_secs(10));
    idle_cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // -----------------------------------------------------------------------
    // Heartbeat interval (every 10 seconds)
    // -----------------------------------------------------------------------
    let mut heartbeat_tick = tokio::time::interval(Duration::from_secs(10));
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
            RunnerMode::Draining | RunnerMode::Stopped => break,
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
            // discover() has no server-side side effects — safe to cancel.
            discovered = provider.discover() => {
                let Some((run_id, profile_name)) = discovered else { break };
                // Look up profile config for resource requirements.
                let Some(profile_config) = profiles.get(&profile_name) else {
                    warn!(run_id = %run_id, profile = %profile_name, "unknown profile, skipping");
                    continue;
                };
                let job_vcpu = profile_config.vcpu;
                let job_memory = profile_config.memory_mb;
                // Look up factory for this profile.
                let Some((factory, use_snapshot)) = factories.get(&profile_name) else {
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
                // claim() runs in the branch handler — non-interruptible,
                // so a successful claim is always paired with complete().
                let Some(context) = provider.claim(run_id).await else {
                    cancel_tokens.lock().await.remove(&run_id);
                    budget.release(job_vcpu, job_memory); // rollback on 409
                    continue;
                };
                info!(run_id = %run_id, profile = %profile_name, "job claimed, spawning executor");
                status.add_run(run_id).await;

                // Check idle pool for a reusable VM (same session + same profile).
                let reuse_entry = if let Some(session_id) = context.session_id() {
                    let mut pool = idle_pool.lock().await;
                    match pool.take(session_id) {
                        Some(entry) if entry.profile_name == profile_name => {
                            info!(
                                run_id = %run_id,
                                session_id,
                                "reusing idle VM for session"
                            );
                            // Idle entry already holds budget — release the new reservation.
                            budget.release(job_vcpu, job_memory);
                            Some(entry)
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
                            None
                        }
                        None => {
                            info!(
                                run_id = %run_id,
                                session_id,
                                "no idle VM found for session"
                            );
                            None
                        }
                    }
                } else {
                    None
                };

                let job_profile = JobProfile {
                    profile_name: profile_name.clone(),
                    vcpu: job_vcpu,
                    memory_mb: job_memory,
                    use_snapshot: *use_snapshot,
                    factory: Arc::clone(factory),
                    cancel: job_cancel,
                };
                spawn_job(
                    context, job_profile, reuse_entry, &spawn_ctx, &mut jobs,
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
                let idle_count = pool.len();
                let idle_sessions = pool.held_sessions();
                drop(pool);
                status.set_idle_info(idle_count, idle_sessions).await;
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

    // Drain idle pool first — these VMs hold budget reservations.
    let idle_entries = idle_pool.lock().await.drain();
    if !idle_entries.is_empty() {
        info!(count = idle_entries.len(), "draining idle VMs");
        for entry in idle_entries {
            let vcpu = entry.vcpu;
            let memory_mb = entry.memory_mb;
            entry.stop_and_destroy().await;
            budget.release(vcpu, memory_mb);
        }
    }

    provider.shutdown().await;

    // Send final heartbeat with draining state so the server stops routing
    // jobs to this runner immediately, without waiting for TTL expiry.
    {
        let pool = idle_pool.lock().await;
        let state = collect_heartbeat_state(
            &runner_id,
            &name,
            &group,
            &profiles,
            &budget,
            &pool,
            RunnerMode::Draining,
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

    info!("shutting down factories");
    shutdown_factories(&mut factories, runtime.as_mut()).await;

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
    use_snapshot: bool,
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
/// After execution, if keep-alive is enabled and the job succeeded,
/// the sandbox is parked in the idle pool instead of being destroyed.
fn spawn_job(
    context: ExecutionContext,
    job_profile: JobProfile,
    reuse_entry: Option<IdleEntry>,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<Option<Uuid>>,
) {
    let run_id = context.run_id;
    let session_id = context.session_id().map(String::from);
    let vcpu = job_profile.vcpu;
    let memory_mb = job_profile.memory_mb;
    let profile_name = job_profile.profile_name;
    let factory = job_profile.factory;
    let job_cancel = job_profile.cancel;
    let params = executor::JobParams {
        vcpu,
        memory_mb,
        use_snapshot: job_profile.use_snapshot,
    };

    let provider = Arc::clone(&ctx.provider);
    let exec_config = Arc::clone(&ctx.exec_config);
    let budget = Arc::clone(&ctx.budget);
    let status = Arc::clone(&ctx.status);
    let idle_pool = Arc::clone(&ctx.idle_pool);
    let park_notify = Arc::clone(&ctx.park_notify);
    let mode = ctx.mode;
    let factory_for_cleanup = Arc::clone(&factory);

    jobs.spawn(async move {
        // Inner spawn isolates panics: if execute_job panics, the outer task
        // still reports completion and releases budget.
        let cancel = job_cancel.clone();

        let inner = tokio::spawn(async move {
            if let Some(idle_entry) = reuse_entry {
                executor::execute_job_reuse(idle_entry, context, &exec_config, cancel).await
            } else {
                executor::execute_job(&**factory, context, &exec_config, &params, cancel).await
            }
        });

        let (exit_code, err, sandbox, source_ip, guest_session_id) = match inner.await {
            Ok(outcome) => {
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
                )
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "executor task panicked");
                (
                    1,
                    Some(format!("internal error: {e}")),
                    None,
                    String::new(),
                    None,
                )
            }
        };

        // Decide: park sandbox for keep-alive, or stop + destroy.
        let parked = if let Some(sandbox) = sandbox {
            let parkable_session =
                if exit_code == 0 && !job_cancel.is_cancelled() && mode == RunnerMode::Running {
                    // Prefer context session_id (from resume_session), fall back to
                    // guest-reported session ID (first run — CLI generated it).
                    session_id.as_deref().or(guest_session_id.as_deref())
                } else {
                    None
                };

            if let Some(session_id) = parkable_session {
                let mut pool = idle_pool.lock().await;
                let idle_timeout = pool.default_timeout();
                let entry = IdleEntry {
                    sandbox,
                    factory: factory_for_cleanup,
                    session_id: session_id.to_string(),
                    profile_name,
                    vcpu,
                    memory_mb,
                    source_ip,
                    parked_at: std::time::Instant::now(),
                    idle_timeout,
                };
                match pool.park(session_id.to_string(), entry) {
                    ParkResult::Parked => {
                        info!(run_id = %run_id, session_id, "VM parked for keep-alive");
                        drop(pool);
                        park_notify.notify_one();
                        true
                    }
                    ParkResult::Evicted(evicted) => {
                        info!(run_id = %run_id, session_id, "VM parked, evicting previous");
                        drop(pool);
                        // Notify immediately — session is already in pool.
                        // Don't wait for stop_and_destroy which can be slow.
                        park_notify.notify_one();
                        let evict_vcpu = evicted.vcpu;
                        let evict_mem = evicted.memory_mb;
                        evicted.stop_and_destroy().await;
                        budget.release(evict_vcpu, evict_mem);
                        true
                    }
                    ParkResult::PoolFull(rejected) => {
                        info!(run_id = %run_id, session_id, "idle pool full, destroying VM");
                        drop(pool);
                        rejected.stop_and_destroy().await;
                        false
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
        provider.complete(run_id, exit_code, err.as_deref()).await;
        status.remove_run(run_id).await;

        // Release budget only if sandbox was NOT parked (parked VMs hold their budget).
        if !parked {
            budget.release(vcpu, memory_mb);
        }

        Some(run_id)
    });
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
    result: Option<Result<Option<Uuid>, tokio::task::JoinError>>,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<Uuid, CancellationToken>>>,
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

/// Await a signal if registered, or pend forever if registration failed.
async fn recv_signal(sig: &mut Option<tokio::signal::unix::Signal>) {
    match sig {
        Some(s) => {
            s.recv().await;
        }
        None => std::future::pending().await,
    }
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
            RunnerMode::Draining | RunnerMode::Stopped => "draining".to_string(),
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
                snapshot_hash: None,
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
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 4096,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: Duration::from_secs(300),
        }
    }

    #[test]
    fn heartbeat_running_count_no_idle() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        budget.try_reserve(2, 4096);
        budget.try_reserve(2, 4096);
        let pool = IdlePool::new(IdlePoolConfig {
            enabled: true,
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
            enabled: true,
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
            enabled: true,
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
            enabled: true,
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
}
