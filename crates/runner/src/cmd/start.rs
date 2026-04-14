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

    // Shared lock on image per profile — allows `runner gc` to detect in-use resources.
    let mut _resource_locks = Vec::new();
    for profile in runner_config.profiles.values() {
        let lock = lock::acquire_shared(home.image_lock(&profile.image_hash)).await?;
        touch_mtime(&home.images_dir().join(&profile.image_hash));
        _resource_locks.push(lock);
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
        let path = home
            .images_dir()
            .join(&profile.image_hash)
            .join("memory.bin");
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
        mode_rx: None,
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
    /// External mode channel. When `Some`, the signal handler is not spawned
    /// and the caller controls mode transitions directly.
    mode_rx: Option<tokio::sync::watch::Receiver<RunnerMode>>,
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
        mode_rx: external_mode_rx,
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
    // Signal handling / mode channel
    // -----------------------------------------------------------------------
    let mut mode_rx = external_mode_rx.unwrap_or_else(|| setup_signal_handler(cancel.clone()));

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
                // Only attempt reuse when the per-job sandboxReuse flag is on.
                let reuse_enabled = context.feature_enabled(crate::types::feature_flags::SANDBOX_REUSE);
                let reuse_entry = if reuse_enabled
                    && let Some(session_id) = context.session_id()
                {
                    // Take the entry under the pool lock, then drop the lock
                    // before any awaits — the unpark HTTP call below must not
                    // block other take/park operations.
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
                                    Some(entry)
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
                                    None
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
                    restore_guest_state: *restore_guest_state,
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

    // Drop the pinned discover future so it releases the discovery Mutex.
    // Without this, provider.shutdown() deadlocks trying to acquire the
    // same Mutex that the still-alive discover_fut holds.
    drop(discover_fut);

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
    job_profile: JobProfile,
    reuse_entry: Option<IdleEntry>,
    ctx: &SpawnContext,
    jobs: &mut JoinSet<Option<Uuid>>,
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
                            // The rejected sandbox was just park()ed above;
                            // destroying a parked sandbox is safe — see Evicted
                            // arm for rationale.
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

/// Spawn a signal-handler task and return the mode-change receiver.
///
/// When SIGTERM, SIGINT, or SIGUSR1 arrives the handler sends
/// [`RunnerMode::Draining`] and cancels the shared token.
fn setup_signal_handler(cancel: CancellationToken) -> tokio::sync::watch::Receiver<RunnerMode> {
    let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
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
        cancel.cancel();
    });
    mode_rx
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
                image_hash: "hash".into(),
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
        cancel: CancellationToken,
        _temp_dir: tempfile::TempDir,
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
        )
    }

    fn build_mock_run_config_with_runtime(
        profiles: BTreeMap<String, config::ProfileConfig>,
        budget_vcpu: u32,
        budget_memory_mb: u32,
        max_concurrent: usize,
        make_provider: impl FnOnce(CancellationToken) -> (Arc<MockJobProvider>, MockProviderHandle),
        runtime: Box<dyn sandbox::SandboxRuntime>,
    ) -> (RunConfig, MockRunEnv) {
        let temp_dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let (provider, handle) = make_provider(cancel.clone());
        let provider_ref = Arc::clone(&provider);

        let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);

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
            cancel_tokens: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel: cancel.clone(),
            exec_config: Arc::new(executor::ExecutorConfig {
                api_url: "http://localhost:0".into(),
                registry,
                http: crate::http::HttpClient::new("http://localhost:0".into()).unwrap(),
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
            mode_rx: Some(mode_rx),
        };

        let env = MockRunEnv {
            handle,
            provider: provider_ref,
            idle_pool,
            mode_tx,
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

    fn minimal_context(run_id: Uuid) -> crate::types::ExecutionContext {
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
        }
    }

    /// Push a job to the mock provider and pre-configure its claim result.
    fn push_job(
        env: &MockRunEnv,
        run_id: Uuid,
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

        let run_id = Uuid::new_v4();
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
        let run_id = Uuid::new_v4();
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

        // Only send Draining — do NOT cancel. discover_fut remains suspended
        // holding the discovery Mutex. The main loop breaks at the top-of-loop
        // mode check, then `drop(discover_fut)` releases the Mutex before
        // `provider.shutdown()`. Without that drop → deadlock.
        let _ = env.mode_tx.send(RunnerMode::Draining);

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
    // Test 4: Claim failure (409) rolls back budget
    // -----------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn claim_failure_rolls_back_budget() {
        // Budget for exactly 1 job (2 vcpu, 4096 MB matches the test profile).
        let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
        let run_handle = tokio::spawn(run(config));

        // First job: claim returns None (409 conflict)
        let run_id_1 = Uuid::new_v4();
        push_job(&env, run_id_1, "vm0/default", None);

        // Give main loop time to process the failed claim and release budget.
        tokio::time::advance(Duration::from_millis(100)).await;
        tokio::task::yield_now().await;

        // Second job: claim succeeds — budget should have been freed.
        let run_id_2 = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
        let bad_id = Uuid::new_v4();
        push_job(
            &env,
            bad_id,
            "vm0/nonexistent",
            Some(minimal_context(bad_id)),
        );

        // Give main loop time to skip the bad job.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Push a valid job — it should succeed despite the earlier bad one.
        let good_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
        let id1 = Uuid::new_v4();
        push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
        let c1 = env
            .handle
            .wait_completion(id1, Duration::from_secs(5))
            .await;
        assert!(c1.is_some(), "first job should complete");
        assert_eq!(c1.unwrap().exit_code, 0);

        // Second job — exercises the recreated discover_fut path
        let id2 = Uuid::new_v4();
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
        run_id: Uuid,
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

        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
        let id1 = Uuid::new_v4();
        push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));

        // Wait for job 1 to be claimed (budget now full).
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Second job: pushed while budget is full. try_reserve fails →
        // the job is skipped without claim. But it remains in the channel.
        let id2 = Uuid::new_v4();
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
    fn context_with_session(run_id: Uuid, session_id: &str) -> crate::types::ExecutionContext {
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
                image_hash: "hash".into(),
                vcpu: 2,
                memory_mb: 4096,
                disk_mb: 10240,
            },
        );
        m.insert(
            "vm0/large".to_string(),
            config::ProfileConfig {
                image_hash: "hash2".into(),
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
            profile_name: profile_name.into(),
            vcpu,
            memory_mb,
            source_ip: "10.0.0.1".into(),
            parked_at,
            idle_timeout,
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        }
    }

    /// Pre-populate idle pool with an entry and reserve its budget.
    async fn seed_idle_pool(
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
            std::time::Instant::now(),
            Duration::from_secs(300),
        );
        let mut guard = pool.lock().await;
        let result = guard.park(session_id.into(), entry);
        assert!(matches!(result, ParkResult::Parked));
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

        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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

        // Wait for the first heartbeat tick to fire (initial interval fires
        // immediately, but give the loop time to process it).
        tokio::time::sleep(Duration::from_millis(100)).await;
        let before = env.handle.heartbeat_count();

        let run_id = Uuid::new_v4();
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
        seed_idle_pool(&idle_pool, &budget, "sess-reuse", "vm0/default", 2, 4096).await;
        assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

        let run_handle = tokio::spawn(run(config));

        // Push job for same session — should reuse the idle VM.
        let run_id = Uuid::new_v4();
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
        assert_eq!(completion.unwrap().exit_code, 0);

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
        let run_id = Uuid::new_v4();
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
        assert_eq!(completion.unwrap().exit_code, 0);

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
        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
        let id1 = Uuid::new_v4();
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
        let id2 = Uuid::new_v4();
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
        )
    }

    async fn wait_cancel_token(
        tokens: &Arc<tokio::sync::Mutex<HashMap<Uuid, CancellationToken>>>,
        run_id: Uuid,
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

        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
        let run_id = Uuid::new_v4();
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
        let id1 = Uuid::new_v4();
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
        let id2 = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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

        let run_id = Uuid::new_v4();
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
                    id: Uuid::new_v4(),
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
        let run_id = Uuid::new_v4();
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
        assert!(c.is_some(), "fresh-create job should still complete");
        assert_eq!(c.unwrap().exit_code, 0);

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
}
